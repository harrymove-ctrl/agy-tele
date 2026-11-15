import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { TranscriptCursor } from "./state.ts";

export type ConversationSummary = {
  conversationId: string;
  title: string;
  preview: string;
  stepCount: number;
  lastModifiedTime: string;
  workspaces: string[];
  primaryWorkspace: string;
  status: string;
  notFullyIdle: boolean;
};

export type QuestionChoice = {
  question: string;
  options: string[];
};

export type TranscriptEvent =
  | {
      kind: "desktop_user";
      stepIndex: number;
      text: string;
      createdAt: string;
    }
  | {
      kind: "assistant_reply";
      stepIndex: number;
      text: string;
      questions: QuestionChoice[];
      imagePaths: string[];
      createdAt: string;
    };

export type TranscriptDeltaResult = {
  cursor: TranscriptCursor;
  events: TranscriptEvent[];
};

type RawToolCall = {
  name?: string;
  args?: Record<string, unknown>;
};

type RawTranscriptStep = {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  tool_calls?: RawToolCall[];
  truncated_fields?: string[];
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function parseWorkspaceUris(rawJson: string): string[] {
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((uri) => {
        if (uri.startsWith("file://")) {
          return decodeURIComponent(uri.slice("file://".length));
        }
        return uri;
      });
  } catch {
    return [];
  }
}

function formatWorkspaceLabel(paths: string[]): string {
  if (paths.length === 0) return "workspace";
  return path.basename(paths[0]) || paths[0];
}

function buildSafeFtsQuery(query: string): string {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((tok) => tok.replace(/"/g, "").trim())
    .filter((tok) => tok.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((tok) => `"${tok}"*`).join(" ");
}

/**
 * Query top-level Antigravity Desktop threads from conversation_summaries.db in read-only mode.
 */
export function listConversations(
  dataDir: string,
  options: { limit?: number; query?: string } = {}
): ConversationSummary[] {
  const dbPath = path.join(dataDir, "conversation_summaries.db");
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Antigravity database not found at ${dbPath}`);
  }

  const limit = Math.max(1, Math.min(50, options.limit ?? 10));
  const safeFts = options.query ? buildSafeFtsQuery(options.query) : "";
  const db = new Database(dbPath, { readonly: true });

  try {
    type Row = {
      conversation_id: string;
      title: string;
      preview: string;
      step_count: number;
      last_modified_time: string;
      workspace_uris: string;
      status: string;
      not_fully_idle: number;
    };

    let rows: Row[];
    if (safeFts) {
      rows = db
        .query<Row, [string, number]>(
          `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, not_fully_idle
           FROM conversation_summaries
           WHERE nesting_depth = 0
             AND killed = 0
             AND conversation_id IN (
               SELECT DISTINCT conversation_id FROM conversations_fts WHERE conversations_fts MATCH ?
             )
           ORDER BY last_modified_time DESC
           LIMIT ?`
        )
        .all(safeFts, limit);
    } else {
      rows = db
        .query<Row, [number]>(
          `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, not_fully_idle
           FROM conversation_summaries
           WHERE nesting_depth = 0 AND killed = 0
           ORDER BY last_modified_time DESC
           LIMIT ?`
        )
        .all(limit);
    }

    return rows.map((row) => {
      const workspaces = parseWorkspaceUris(row.workspace_uris);
      return {
        conversationId: row.conversation_id,
        title: row.title || "Untitled",
        preview: row.preview || "",
        stepCount: row.step_count,
        lastModifiedTime: row.last_modified_time,
        workspaces,
        primaryWorkspace: formatWorkspaceLabel(workspaces),
        status: row.status,
        notFullyIdle: Boolean(row.not_fully_idle),
      };
    });
  } finally {
    db.close();
  }
}

/**
 * Resolve a full conversation ID from an exact ID or unique prefix match.
 */
export function resolveConversationByPrefix(
  dataDir: string,
  idOrPrefix: string
): ConversationSummary | null {
  const needle = idOrPrefix.trim();
  if (!needle) return null;
  const recent = listConversations(dataDir, { limit: 50 });
  const exact = recent.find((item) => item.conversationId === needle);
  if (exact) return exact;
  const prefixMatches = recent.filter((item) =>
    item.conversationId.startsWith(needle)
  );
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(
      `Prefix "${needle}" matched ${prefixMatches.length} threads; pass more characters`
    );
  }
  return null;
}

async function runAgentApi(
  agentApiBin: string,
  args: string[],
  cwd?: string,
  timeoutMs = 15000
): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn([agentApiBin, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) {
      throw new Error(`agentapi ${args[0]} timed out after ${timeoutMs}ms`);
    }
    if (exitCode !== 0) {
      throw new Error(
        `agentapi ${args[0]} exited ${exitCode}: ${(stderr || stdout).trim()}`
      );
    }
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch live conversation metadata through the local agentapi IPC daemon.
 */
export async function getConversationMetadata(
  agentApiBin: string,
  conversationId: string
): Promise<Record<string, unknown>> {
  const { stdout } = await runAgentApi(agentApiBin, [
    "get-conversation-metadata",
    conversationId,
  ]);
  return JSON.parse(stdout) as Record<string, unknown>;
}

/**
 * Inject a user prompt into an active Antigravity Desktop conversation via agentapi.
 */
export async function sendMessageToDesktop(
  agentApiBin: string,
  conversationId: string,
  content: string,
  title?: string
): Promise<void> {
  const args = ["send-message"];
  if (title && title.trim()) {
    args.push(`--title=${title.trim()}`);
  }
  args.push(conversationId, content);
  await runAgentApi(agentApiBin, args);
}

/**
 * Start a brand new Desktop conversation scoped to the given workspace directory.
 */
export async function startDesktopConversation(
  agentApiBin: string,
  options: {
    prompt: string;
    title?: string;
    model?: string | null;
    cwd?: string;
  }
): Promise<string> {
  const args = ["new-conversation"];
  if (options.model && options.model.trim()) {
    args.push(`--model=${options.model.trim()}`);
  }
  if (options.title && options.title.trim()) {
    args.push(`--title=${options.title.trim()}`);
  }
  args.push("--", options.prompt);

  const { stdout } = await runAgentApi(agentApiBin, args, options.cwd);
  const parsed = JSON.parse(stdout) as {
    conversationId?: string;
    response?: { newConversation?: { conversationId?: string } };
  };
  const cid =
    parsed.response?.newConversation?.conversationId ?? parsed.conversationId;
  if (!cid) {
    throw new Error(`agentapi new-conversation returned no conversationId: ${stdout}`);
  }
  return cid;
}

function extractUserRequestText(raw: string): string {
  const match = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  if (match) return match[1].trim();
  return raw.trim();
}

function extractAskQuestions(toolCalls: RawToolCall[] | undefined): QuestionChoice[] {
  if (!Array.isArray(toolCalls)) return [];
  const results: QuestionChoice[] = [];

  for (const call of toolCalls) {
    if (call.name !== "ask_question" || !call.args) continue;
    let rawQuestions = call.args.questions;
    if (typeof rawQuestions === "string") {
      try {
        rawQuestions = JSON.parse(rawQuestions);
      } catch {
        continue;
      }
    }
    if (!Array.isArray(rawQuestions)) continue;
    for (const item of rawQuestions) {
      if (!item || typeof item !== "object") continue;
      const obj = item as { question?: unknown; options?: unknown };
      if (typeof obj.question !== "string" || !obj.question.trim()) continue;
      const options = Array.isArray(obj.options)
        ? obj.options.filter((opt): opt is string => typeof opt === "string")
        : [];
      results.push({ question: obj.question.trim(), options });
    }
  }

  return results;
}

function extractExistingImagePaths(content: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const matches = content.matchAll(
    /(?:file:\/\/)?(\/[^\s)`"'>]+\.(?:png|jpg|jpeg|webp))/gi
  );
  for (const match of matches) {
    const candidate = decodeURIComponent(match[1]);
    const ext = path.extname(candidate).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext) || seen.has(candidate)) continue;
    if (fs.existsSync(candidate)) {
      seen.add(candidate);
      found.push(candidate);
      if (found.length >= 2) break;
    }
  }
  return found;
}

function loadFullStep(
  fullLogPath: string,
  targetStepIndex: number
): RawTranscriptStep | null {
  if (!fs.existsSync(fullLogPath)) return null;
  const raw = fs.readFileSync(fullLogPath, "utf8");
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as RawTranscriptStep;
      if (parsed.step_index === targetStepIndex) {
        return parsed;
      }
    } catch {
      // Skip malformed lines in append-only logs.
    }
  }
  return null;
}

function parseStepToEvent(
  step: RawTranscriptStep,
  fullLogPath: string
): TranscriptEvent | null {
  const stepIndex = step.step_index;
  if (typeof stepIndex !== "number") return null;

  if (
    step.source === "USER_EXPLICIT" &&
    step.type === "USER_INPUT" &&
    step.status === "DONE"
  ) {
    const text = extractUserRequestText(step.content ?? "");
    if (!text) return null;
    return {
      kind: "desktop_user",
      stepIndex,
      text,
      createdAt: step.created_at ?? "",
    };
  }

  if (
    step.source === "MODEL" &&
    step.type === "PLANNER_RESPONSE" &&
    step.status === "DONE"
  ) {
    let resolved = step;
    if (
      Array.isArray(step.truncated_fields) &&
      step.truncated_fields.includes("content")
    ) {
      resolved = loadFullStep(fullLogPath, stepIndex) ?? step;
    }
    const text = (resolved.content ?? "").trim();
    const questions = extractAskQuestions(resolved.tool_calls);
    const imagePaths = extractExistingImagePaths(text);
    if (!text && questions.length === 0 && imagePaths.length === 0) {
      return null;
    }
    return {
      kind: "assistant_reply",
      stepIndex,
      text,
      questions,
      imagePaths,
      createdAt: resolved.created_at ?? step.created_at ?? "",
    };
  }

  return null;
}

/**
 * Incrementally read newly finalized JSONL entries from transcript.jsonl using exact byte offsets.
 */
export async function readTranscriptDelta(
  brainDir: string,
  conversationId: string,
  cursor: TranscriptCursor
): Promise<TranscriptDeltaResult> {
  const logsDir = path.join(brainDir, conversationId, ".system_generated", "logs");
  const logPath = path.join(logsDir, "transcript.jsonl");
  const fullLogPath = path.join(logsDir, "transcript_full.jsonl");

  if (!fs.existsSync(logPath)) {
    return { cursor, events: [] };
  }

  const file = Bun.file(logPath);
  const size = file.size;
  let startOffset = cursor.byteOffset;
  let lastStepIndex = cursor.lastStepIndex;

  if (size < startOffset) {
    startOffset = 0;
    lastStepIndex = -1;
  }

  if (size === startOffset) {
    return { cursor: { byteOffset: startOffset, lastStepIndex }, events: [] };
  }

  const chunkBuf = new Uint8Array(await file.slice(startOffset, size).arrayBuffer());
  let lastNewline = -1;
  for (let i = chunkBuf.length - 1; i >= 0; i--) {
    if (chunkBuf[i] === 0x0a) {
      lastNewline = i;
      break;
    }
  }

  if (lastNewline < 0) {
    return { cursor: { byteOffset: startOffset, lastStepIndex }, events: [] };
  }

  const completeSlice = chunkBuf.subarray(0, lastNewline + 1);
  const text = new TextDecoder().decode(completeSlice);
  const lines = text.split("\n");
  const events: TranscriptEvent[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let parsed: RawTranscriptStep;
    try {
      parsed = JSON.parse(trimmed) as RawTranscriptStep;
    } catch {
      continue;
    }
    if (typeof parsed.step_index !== "number" || parsed.step_index <= lastStepIndex) {
      continue;
    }
    lastStepIndex = parsed.step_index;
    const event = parseStepToEvent(parsed, fullLogPath);
    if (event) {
      events.push(event);
    }
  }

  return {
    cursor: {
      byteOffset: startOffset + lastNewline + 1,
      lastStepIndex,
    },
    events,
  };
}

/**
 * Read the most recent finalized desktop user and assistant events for /tail inspection.
 */
export async function readRecentTranscriptEvents(
  brainDir: string,
  conversationId: string,
  limit = 6
): Promise<TranscriptEvent[]> {
  const result = await readTranscriptDelta(brainDir, conversationId, {
    byteOffset: 0,
    lastStepIndex: -1,
  });
  if (result.events.length <= limit) return result.events;
  return result.events.slice(-limit);
}

/**
 * Split long responses on line or space boundaries so Telegram never rejects >4096-char messages.
 */
export function chunkTelegramText(text: string, maxChars = 3900): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const chunks: string[] = [];
  let remaining = clean;

  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf("\n", maxChars);
    if (splitAt < maxChars * 0.5) {
      splitAt = remaining.lastIndexOf(" ", maxChars);
    }
    if (splitAt <= 0) {
      splitAt = maxChars;
    }
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

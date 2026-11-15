import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TranscriptCursor } from "./state.ts";

export type SessionFolder = {
  id: string;
  name: string;
  workspaces: string[];
  primaryWorkspace: string;
  activeThreadCount: number;
  latestThreadTime: string | null;
};

export type AnnotationMeta = {
  archived: boolean;
  pinned: boolean;
  title?: string;
};

export type ConversationSummary = {
  conversationId: string;
  projectId: string | null;
  folderName: string | null;
  title: string;
  preview: string;
  stepCount: number;
  lastModifiedTime: string;
  workspaces: string[];
  primaryWorkspace: string;
  status: string;
  notFullyIdle: boolean;
  pinned: boolean;
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

function decodeFileUri(uri: string): string {
  if (uri.startsWith("file://")) {
    return decodeURIComponent(uri.slice("file://".length));
  }
  return uri;
}

function parseWorkspaceUris(rawJson: string): string[] {
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map(decodeFileUri);
  } catch {
    return [];
  }
}

function pickPrimaryWorkspacePath(paths: string[]): string {
  if (paths.length === 0) return "";
  return paths.find((item) => !item.includes("/.agents/")) ?? paths[0] ?? "";
}

function formatWorkspaceLabel(paths: string[]): string {
  const primary = pickPrimaryWorkspacePath(paths);
  if (!primary) return "workspace";
  return path.basename(primary) || primary;
}

function defaultProjectsDir(): string {
  return path.join(os.homedir(), ".gemini", "config", "projects");
}

/**
 * Parse Antigravity sidebar annotation metadata (archived, pinned, custom title).
 */
export function readAnnotationMeta(
  dataDir: string,
  conversationId: string
): AnnotationMeta {
  const pbtxtPath = path.join(dataDir, "annotations", `${conversationId}.pbtxt`);
  if (!fs.existsSync(pbtxtPath)) {
    return { archived: false, pinned: false };
  }

  try {
    const raw = fs.readFileSync(pbtxtPath, "utf8");
    const archived = /^\s*archived\s*:\s*true\b/m.test(raw);
    const pinned = /^\s*pinned\s*:\s*true\b/m.test(raw);
    const titleMatch = raw.match(/^\s*title\s*:\s*"((?:[^"\\]|\\.)*)"/m);
    const title = titleMatch
      ? titleMatch[1].replace(/\\(.)/g, (_all, ch: string) => {
          if (ch === "n") return "\n";
          if (ch === "t") return "\t";
          return ch;
        })
      : undefined;
    return { archived, pinned, title };
  } catch {
    return { archived: false, pinned: false };
  }
}

type ProjectFolderDef = {
  id: string;
  name: string;
  workspaces: string[];
  primaryWorkspace: string;
};

type RawProjectResource = {
  folderUri?: unknown;
  gitFolder?: { folderUri?: unknown };
};

type RawProjectJson = {
  id?: unknown;
  name?: unknown;
  projectResources?: {
    resources?: RawProjectResource[];
  };
};

function loadProjectFolderDefs(projectsDir?: string): ProjectFolderDef[] {
  const dir = projectsDir ?? defaultProjectsDir();
  if (!fs.existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }

  const folders: ProjectFolderDef[] = [];
  for (const filename of entries) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(dir, filename), "utf8")
      ) as RawProjectJson;
      const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
      const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
      if (!id || !name) continue;

      const seen = new Set<string>();
      const workspaces: string[] = [];
      const resources = parsed.projectResources?.resources ?? [];
      if (Array.isArray(resources)) {
        for (const item of resources) {
          const rawUri =
            typeof item?.folderUri === "string"
              ? item.folderUri
              : typeof item?.gitFolder?.folderUri === "string"
                ? item.gitFolder.folderUri
                : "";
          if (!rawUri) continue;
          const decoded = decodeFileUri(rawUri);
          if (!seen.has(decoded)) {
            seen.add(decoded);
            workspaces.push(decoded);
          }
        }
      }

      folders.push({
        id,
        name,
        workspaces,
        primaryWorkspace: pickPrimaryWorkspacePath(workspaces),
      });
    } catch {
      // Ignore malformed project JSON files outside valid Desktop folder metadata.
    }
  }

  return folders;
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
 * List Antigravity Desktop Session Folders enriched with active non-archived thread counts.
 */
export function listSessionFolders(
  dataDir: string,
  options: { projectsDir?: string } = {}
): SessionFolder[] {
  const defs = loadProjectFolderDefs(options.projectsDir);
  if (defs.length === 0) return [];

  const counts = new Map<string, number>();
  const latestTimes = new Map<string, string>();
  const dbPath = path.join(dataDir, "conversation_summaries.db");

  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const cols = db
        .query<{ name: string }, []>("PRAGMA table_info(conversation_summaries)")
        .all();
      const hasProjectId = cols.some((col) => col.name === "project_id");
      if (hasProjectId) {
        type FolderRow = {
          conversation_id: string;
          project_id: string;
          last_modified_time: string;
        };
        const rows = db
          .query<FolderRow, []>(
            `SELECT conversation_id, project_id, last_modified_time
             FROM conversation_summaries
             WHERE nesting_depth = 0
               AND killed = 0
               AND project_id != ''
             ORDER BY last_modified_time DESC`
          )
          .all();

        for (const row of rows) {
          if (readAnnotationMeta(dataDir, row.conversation_id).archived) {
            continue;
          }
          counts.set(row.project_id, (counts.get(row.project_id) ?? 0) + 1);
          if (!latestTimes.has(row.project_id)) {
            latestTimes.set(row.project_id, row.last_modified_time);
          }
        }
      }
    } finally {
      db.close();
    }
  }

  return defs
    .map((def) => ({
      ...def,
      activeThreadCount: counts.get(def.id) ?? 0,
      latestThreadTime: latestTimes.get(def.id) ?? null,
    }))
    .sort((a, b) => {
      if (a.latestThreadTime && b.latestThreadTime) {
        const cmp = b.latestThreadTime.localeCompare(a.latestThreadTime);
        if (cmp !== 0) return cmp;
      } else if (a.latestThreadTime || b.latestThreadTime) {
        return a.latestThreadTime ? -1 : 1;
      }
      if (b.activeThreadCount !== a.activeThreadCount) {
        return b.activeThreadCount - a.activeThreadCount;
      }
      return a.name.localeCompare(b.name);
    });
}

/**
 * Resolve an Antigravity Session Folder by exact name, UUID, or unique prefix.
 */
export function resolveSessionFolder(
  dataDir: string,
  nameOrIdOrPrefix: string,
  options: { projectsDir?: string } = {}
): SessionFolder | null {
  const needle = nameOrIdOrPrefix.trim();
  if (!needle) return null;

  const folders = listSessionFolders(dataDir, options);
  const lower = needle.toLowerCase();

  const exactId = folders.find((item) => item.id === needle);
  if (exactId) return exactId;

  const exactNames = folders.filter((item) => item.name.toLowerCase() === lower);
  if (exactNames.length === 1) return exactNames[0];
  if (exactNames.length > 1) {
    throw new Error(
      `Folder name "${needle}" matched ${exactNames.length} folders; pass its UUID prefix`
    );
  }

  const idPrefixes = folders.filter((item) => item.id.startsWith(needle));
  if (idPrefixes.length === 1) return idPrefixes[0];
  if (idPrefixes.length > 1) {
    throw new Error(
      `Folder ID prefix "${needle}" matched ${idPrefixes.length} folders; pass more characters`
    );
  }

  const namePrefixes = folders.filter((item) =>
    item.name.toLowerCase().startsWith(lower)
  );
  if (namePrefixes.length === 1) return namePrefixes[0];
  if (namePrefixes.length > 1) {
    throw new Error(
      `Folder "${needle}" matched ${namePrefixes.length} folders: ${namePrefixes
        .map((item) => item.name)
        .join(", ")}`
    );
  }

  const nameIncludes = folders.filter((item) =>
    item.name.toLowerCase().includes(lower)
  );
  if (nameIncludes.length === 1) return nameIncludes[0];
  if (nameIncludes.length > 1) {
    throw new Error(
      `Folder "${needle}" matched ${nameIncludes.length} folders: ${nameIncludes
        .map((item) => item.name)
        .join(", ")}`
    );
  }

  return null;
}

/**
 * Query top-level Antigravity Desktop threads from conversation_summaries.db in read-only mode.
 */
export function listConversations(
  dataDir: string,
  options: {
    limit?: number;
    query?: string;
    folderId?: string | null;
    projectsDir?: string;
    includeArchived?: boolean;
  } = {}
): ConversationSummary[] {
  const dbPath = path.join(dataDir, "conversation_summaries.db");
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Antigravity database not found at ${dbPath}`);
  }

  const limit = Math.max(1, Math.min(200, options.limit ?? 10));
  const fetchLimit = options.includeArchived
    ? limit
    : Math.min(500, Math.max(limit * 6, 80));
  const safeFts = options.query ? buildSafeFtsQuery(options.query) : "";
  const folderNameById = new Map(
    loadProjectFolderDefs(options.projectsDir).map((folder) => [
      folder.id,
      folder.name,
    ])
  );
  const db = new Database(dbPath, { readonly: true });

  try {
    const hasProjectId = db
      .query<{ name: string }, []>("PRAGMA table_info(conversation_summaries)")
      .all()
      .some((col) => col.name === "project_id");

    type Row = {
      conversation_id: string;
      project_id: string;
      title: string;
      preview: string;
      step_count: number;
      last_modified_time: string;
      workspace_uris: string;
      status: string;
      not_fully_idle: number;
    };

    const projectSelect = hasProjectId ? "project_id" : "'' AS project_id";
    const whereClauses = ["nesting_depth = 0", "killed = 0"];
    const params: Array<string | number> = [];

    if (options.folderId && hasProjectId) {
      whereClauses.push("project_id = ?");
      params.push(options.folderId);
    }
    if (safeFts) {
      whereClauses.push(
        "conversation_id IN (SELECT DISTINCT conversation_id FROM conversations_fts WHERE conversations_fts MATCH ?)"
      );
      params.push(safeFts);
    }

    params.push(fetchLimit);
    const sql = `SELECT conversation_id, ${projectSelect}, title, preview, step_count, last_modified_time, workspace_uris, status, not_fully_idle
       FROM conversation_summaries
       WHERE ${whereClauses.join(" AND ")}
       ORDER BY last_modified_time DESC
       LIMIT ?`;

    const rows = db.query<Row, Array<string | number>>(sql).all(...params);
    const results: ConversationSummary[] = [];

    for (const row of rows) {
      const meta = readAnnotationMeta(dataDir, row.conversation_id);
      if (!options.includeArchived && meta.archived) {
        continue;
      }

      const workspaces = parseWorkspaceUris(row.workspace_uris);
      const projectId = row.project_id?.trim() || null;
      results.push({
        conversationId: row.conversation_id,
        projectId,
        folderName: projectId ? (folderNameById.get(projectId) ?? null) : null,
        title: meta.title?.trim() || row.title || "Untitled",
        preview: row.preview || "",
        stepCount: row.step_count,
        lastModifiedTime: row.last_modified_time,
        workspaces,
        primaryWorkspace: formatWorkspaceLabel(workspaces),
        status: row.status,
        notFullyIdle: Boolean(row.not_fully_idle),
        pinned: meta.pinned,
      });

      if (results.length >= limit) {
        break;
      }
    }

    return results;
  } finally {
    db.close();
  }
}

/**
 * Resolve a full conversation ID from an exact ID or unique prefix match.
 */
export function resolveConversationByPrefix(
  dataDir: string,
  idOrPrefix: string,
  options: { folderId?: string | null; projectsDir?: string } = {}
): ConversationSummary | null {
  const needle = idOrPrefix.trim();
  if (!needle) return null;
  const recent = listConversations(dataDir, {
    limit: 200,
    includeArchived: true,
    projectsDir: options.projectsDir,
  });
  const exact = recent.find((item) => item.conversationId === needle);
  if (exact) return exact;
  const prefixMatches = recent.filter((item) =>
    item.conversationId.startsWith(needle)
  );
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1 && options.folderId) {
    const inFolder = prefixMatches.filter(
      (item) => item.projectId === options.folderId
    );
    if (inFolder.length === 1) {
      return inFolder[0];
    }
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
  options: {
    cwd?: string;
    projectId?: string | null;
    timeoutMs?: number;
  } = {}
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const projectId = options.projectId?.trim();
  const env = projectId
    ? { ...process.env, ANTIGRAVITY_PROJECT_ID: projectId }
    : process.env;

  const proc = Bun.spawn([agentApiBin, ...args], {
    cwd: options.cwd,
    env,
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
  title?: string,
  projectId?: string | null
): Promise<void> {
  const args = ["send-message"];
  if (title && title.trim()) {
    args.push(`--title=${title.trim()}`);
  }
  args.push(conversationId, content);
  await runAgentApi(agentApiBin, args, { projectId });
}

/**
 * Start a brand new Desktop conversation scoped to the given workspace and optional Session Folder.
 */
export async function startDesktopConversation(
  agentApiBin: string,
  options: {
    prompt: string;
    title?: string;
    model?: string | null;
    cwd?: string;
    projectId?: string | null;
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

  const { stdout } = await runAgentApi(agentApiBin, args, {
    cwd: options.cwd,
    projectId: options.projectId,
  });
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

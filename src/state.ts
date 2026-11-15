import fs from "node:fs";
import path from "node:path";
import type { ComposeMode } from "./composer.ts";

export type ThreadBinding = {
  chatKey: string;
  chatId: number;
  messageThreadId?: number;
  conversationId: string;
  title: string;
  workspace: string;
  flowGenEn: ComposeMode;
  updatedAt: string;
};

export type TranscriptCursor = {
  byteOffset: number;
  lastStepIndex: number;
};

export type PersistedState = {
  version: 1;
  telegramOffset: number;
  bindings: Record<string, ThreadBinding>;
  cursors: Record<string, TranscriptCursor>;
};

/**
 * Build a deterministic map key for a Telegram DM, group, or forum topic.
 */
export function makeChatKey(chatId: number, messageThreadId?: number): string {
  return messageThreadId ? `${chatId}:${messageThreadId}` : `${chatId}:main`;
}

/**
 * Create an empty persisted state structure.
 */
export function createEmptyState(): PersistedState {
  return {
    version: 1,
    telegramOffset: 0,
    bindings: {},
    cursors: {},
  };
}

/**
 * Load persisted daemon state from disk, returning empty defaults when missing or corrupt.
 */
export function loadState(statePath: string): PersistedState {
  if (!fs.existsSync(statePath)) {
    return createEmptyState();
  }
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      version: 1,
      telegramOffset:
        typeof parsed.telegramOffset === "number" ? parsed.telegramOffset : 0,
      bindings:
        parsed.bindings && typeof parsed.bindings === "object"
          ? parsed.bindings
          : {},
      cursors:
        parsed.cursors && typeof parsed.cursors === "object"
          ? parsed.cursors
          : {},
    };
  } catch {
    return createEmptyState();
  }
}

/**
 * Atomically write persisted state via a temp file rename to avoid torn JSON on crashes.
 */
export function saveState(statePath: string, state: PersistedState): void {
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmpPath, statePath);
}

/**
 * Compute current EOF byte offset and highest step_index for an existing conversation
 * so binding an active thread skips replaying stale history.
 */
export function initCursorAtEof(
  brainDir: string,
  conversationId: string
): TranscriptCursor {
  const logPath = path.join(
    brainDir,
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl"
  );
  if (!fs.existsSync(logPath)) {
    return { byteOffset: 0, lastStepIndex: -1 };
  }

  const stat = fs.statSync(logPath);
  const size = stat.size;
  if (size === 0) {
    return { byteOffset: 0, lastStepIndex: -1 };
  }

  const tailBytes = Math.min(size, 65536);
  const start = size - tailBytes;
  const fd = fs.openSync(logPath, "r");
  try {
    const buf = Buffer.allocUnsafe(tailBytes);
    fs.readSync(fd, buf, 0, tailBytes, start);
    const text = buf.toString("utf8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    let lastStepIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as { step_index?: unknown };
        if (typeof parsed.step_index === "number") {
          lastStepIndex = parsed.step_index;
          break;
        }
      } catch {
        // Ignore partial first line if tail slice landed mid-JSON.
      }
    }
    return { byteOffset: size, lastStepIndex };
  } finally {
    fs.closeSync(fd);
  }
}

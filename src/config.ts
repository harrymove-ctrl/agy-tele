import os from "node:os";
import path from "node:path";
import type { ComposeMode } from "./composer.ts";

export type AppConfig = {
  telegramBotToken: string;
  allowedUserIds: number[];
  defaultChatId: string | null;
  agyDataDir: string;
  agyBrainDir: string;
  agentApiBin: string;
  defaultWorkspace: string;
  defaultModel: string | null;
  flowGenEn: ComposeMode;
  pollMs: number;
  statePath: string;
};

/**
 * Expand leading tilde and $HOME placeholders in filesystem paths from env files.
 */
export function expandHomePath(raw: string): string {
  const home = os.homedir();
  const withEnv = raw.replace(/\$HOME\b/g, home);
  if (withEnv === "~") return home;
  if (withEnv.startsWith("~/")) {
    return path.join(home, withEnv.slice(2));
  }
  return path.resolve(withEnv);
}

function parseComposeMode(raw: string | undefined): ComposeMode {
  if (raw === "always" || raw === "off" || raw === "auto") {
    return raw;
  }
  return "auto";
}

function parseAllowedUsers(raw: string | undefined): number[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((id) => Number.isFinite(id) && id > 0);
}

/**
 * Load runtime configuration from environment variables with safe local defaults.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  requireBotAuth = false
): AppConfig {
  const home = os.homedir();
  const agyDataDir = env.AGY_DATA_DIR?.trim()
    ? expandHomePath(env.AGY_DATA_DIR.trim())
    : path.join(home, ".gemini", "antigravity");

  const agentApiBin = env.AGY_AGENTAPI_BIN?.trim()
    ? expandHomePath(env.AGY_AGENTAPI_BIN.trim())
    : path.join(agyDataDir, "bin", "agentapi");

  const defaultWorkspace = env.AGY_DEFAULT_WORKSPACE?.trim()
    ? expandHomePath(env.AGY_DEFAULT_WORKSPACE.trim())
    : "/Volumes/Dev";

  const statePath = env.AGY_STATE_PATH?.trim()
    ? expandHomePath(env.AGY_STATE_PATH.trim())
    : path.resolve(process.cwd(), ".state", "agy-tele-state.json");

  const parsedPoll = Number.parseInt(env.AGY_POLL_MS ?? "650", 10);
  const pollMs = Number.isFinite(parsedPoll) ? Math.max(200, parsedPoll) : 650;

  const telegramBotToken = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const allowedUserIds = parseAllowedUsers(env.TELEGRAM_ALLOWED_USER_IDS);

  if (requireBotAuth) {
    if (!telegramBotToken || telegramBotToken.includes("replace-with-your")) {
      throw new Error("TELEGRAM_BOT_TOKEN is missing or still set to placeholder");
    }
    if (allowedUserIds.length === 0) {
      throw new Error(
        "TELEGRAM_ALLOWED_USER_IDS must contain at least one numeric Telegram user ID"
      );
    }
  }

  return {
    telegramBotToken,
    allowedUserIds,
    defaultChatId: env.TELEGRAM_CHAT_ID?.trim() || null,
    agyDataDir,
    agyBrainDir: path.join(agyDataDir, "brain"),
    agentApiBin,
    defaultWorkspace,
    defaultModel: env.AGY_DEFAULT_MODEL?.trim() || null,
    flowGenEn: parseComposeMode(env.AGY_FLOW_GEN_EN?.trim()),
    pollMs,
    statePath,
  };
}

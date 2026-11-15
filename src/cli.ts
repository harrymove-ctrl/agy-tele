#!/usr/bin/env bun
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConversationMetadata, listConversations } from "./antigravity.ts";
import { composeEnglishPrompt, type ComposeMode } from "./composer.ts";
import { loadConfig } from "./config.ts";
import { AgyTeleDaemon } from "./daemon.ts";
import { HttpTelegramClient } from "./telegram.ts";

const LAUNCHD_LABEL = "com.commandoss.agy-tele";

function getPlistPath(): string {
  return path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${LAUNCHD_LABEL}.plist`
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildLaunchdPlist(
  bunBin: string,
  repoDir: string,
  cliEntry: string,
  logDir: string
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(bunBin)}</string>
    <string>run</string>
    <string>${escapeXml(cliEntry)}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(repoDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir, "launchd-stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir, "launchd-stderr.log"))}</string>
</dict>
</plist>
`;
}

function printUsage(): void {
  console.log(
    [
      "Usage: agy-tele <command> [options]",
      "",
      "Commands:",
      "  start                                    Run two-way Telegram and Antigravity daemon",
      "  doctor                                   Verify agentapi, SQLite index, and env setup",
      "  threads [--search <q>] [--limit <n>]     List recent top-level Desktop threads",
      "  compose [--offline] [--mode <m>] <text>  Run Flow-Gen-EN + No-AI-Slop prompt composer",
      "  install-launchd [--load]                 Write macOS LaunchAgent plist for 24/7 daemon",
      "  uninstall-launchd                        Unload and remove LaunchAgent plist",
    ].join("\n")
  );
}

async function runDoctor(): Promise<number> {
  const cfg = loadConfig(process.env, false);
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  const agentApiExists = fs.existsSync(cfg.agentApiBin);
  checks.push({
    name: "agentapi binary",
    ok: agentApiExists,
    detail: agentApiExists ? cfg.agentApiBin : `missing at ${cfg.agentApiBin}`,
  });

  const dbPath = path.join(cfg.agyDataDir, "conversation_summaries.db");
  let recentCid = "";
  let threadCount = 0;
  let dbDetail = `missing at ${dbPath}`;
  let dbOk = false;

  if (fs.existsSync(dbPath)) {
    try {
      const startMs = performance.now();
      const threads = listConversations(cfg.agyDataDir, { limit: 10 });
      const elapsedMs = (performance.now() - startMs).toFixed(1);
      threadCount = threads.length;
      recentCid = threads[0]?.conversationId ?? "";
      dbOk = true;
      dbDetail = `readable in ${elapsedMs}ms (${threadCount} recent top-level threads)`;
    } catch (err) {
      dbDetail = err instanceof Error ? err.message : String(err);
    }
  }
  checks.push({ name: "conversation_summaries.db", ok: dbOk, detail: dbDetail });

  if (agentApiExists && recentCid) {
    try {
      const startMs = performance.now();
      await getConversationMetadata(cfg.agentApiBin, recentCid);
      const elapsedMs = (performance.now() - startMs).toFixed(1);
      checks.push({
        name: "agentapi IPC ping",
        ok: true,
        detail: `metadata lookup succeeded in ${elapsedMs}ms (${recentCid.slice(0, 8)})`,
      });
    } catch (err) {
      checks.push({
        name: "agentapi IPC ping",
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const brainOk = fs.existsSync(cfg.agyBrainDir);
  checks.push({
    name: "brain log root",
    ok: brainOk,
    detail: brainOk ? cfg.agyBrainDir : `missing at ${cfg.agyBrainDir}`,
  });

  const tokenConfigured =
    cfg.telegramBotToken.length > 0 &&
    !cfg.telegramBotToken.includes("replace-with-your");
  checks.push({
    name: "telegram auth env",
    ok: tokenConfigured && cfg.allowedUserIds.length > 0,
    detail:
      tokenConfigured && cfg.allowedUserIds.length > 0
        ? `token present, ${cfg.allowedUserIds.length} allowed user(s)`
        : "configure TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_IDS in .env before start",
  });

  for (const item of checks) {
    const label = item.ok ? "PASS" : "WARN";
    console.log(`[${label}] ${item.name}: ${item.detail}`);
  }

  const coreReady = checks
    .slice(0, 4)
    .every((item) => item.ok);
  return coreReady ? 0 : 1;
}

async function runThreads(args: string[]): Promise<number> {
  let limit = 10;
  let query = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      limit = Number.parseInt(args[++i], 10) || 10;
    } else if (args[i] === "--search" && args[i + 1]) {
      query = args[++i];
    }
  }

  const cfg = loadConfig(process.env, false);
  const startMs = performance.now();
  const rows = listConversations(cfg.agyDataDir, { limit, query });
  const elapsedMs = (performance.now() - startMs).toFixed(1);

  console.log(`Found ${rows.length} thread(s) in ${elapsedMs}ms:`);
  for (const item of rows) {
    const state = item.status.includes("RUNNING") ? "running" : "idle";
    console.log(
      `${item.conversationId.slice(0, 8)} | ${item.primaryWorkspace} | ${state} | ${item.stepCount} steps | ${item.title}`
    );
  }
  return 0;
}

async function runCompose(args: string[]): Promise<number> {
  let offline = false;
  let mode: ComposeMode = "auto";
  const words: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--offline") {
      offline = true;
    } else if (args[i] === "--mode" && args[i + 1]) {
      const candidate = args[++i];
      if (candidate === "auto" || candidate === "always" || candidate === "off") {
        mode = candidate;
      }
    } else {
      words.push(args[i]);
    }
  }

  const input = words.join(" ").trim();
  if (!input) {
    console.error("Usage: agy-tele compose [--offline] [--mode auto|always|off] <text>");
    return 2;
  }

  const result = await composeEnglishPrompt(input, { mode, offline });
  console.log(result.text);
  if (result.warnings.length > 0) {
    console.error(`[warnings] ${result.warnings.join("; ")}`);
  }
  return 0;
}

async function runStart(): Promise<number> {
  const cfg = loadConfig(process.env, true);
  const telegram = new HttpTelegramClient(cfg.telegramBotToken);
  const bot = await telegram.getMe();
  console.log(
    `agy-tele connected as @${bot.username ?? "unknown"} (poll=${cfg.pollMs}ms, flowGenEn=${cfg.flowGenEn})`
  );

  const daemon = new AgyTeleDaemon(cfg, telegram);
  const shutdown = () => {
    daemon.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await daemon.start();
  return 0;
}

function runInstallLaunchd(args: string[]): number {
  const shouldLoad = args.includes("--load");
  const repoDir = path.resolve(import.meta.dir, "..");
  const cliEntry = path.resolve(import.meta.dir, "cli.ts");
  const logDir = path.join(repoDir, ".state");
  fs.mkdirSync(logDir, { recursive: true });

  const plistPath = getPlistPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(
    plistPath,
    buildLaunchdPlist(process.execPath, repoDir, cliEntry, logDir),
    "utf8"
  );
  console.log(`Wrote LaunchAgent plist: ${plistPath}`);

  if (shouldLoad) {
    const uid = process.getuid ? process.getuid() : 501;
    Bun.spawnSync(["launchctl", "bootout", `gui/${uid}`, plistPath]);
    const res = Bun.spawnSync([
      "launchctl",
      "bootstrap",
      `gui/${uid}`,
      plistPath,
    ]);
    if (res.exitCode !== 0) {
      console.error(new TextDecoder().decode(res.stderr).trim());
      return res.exitCode;
    }
    console.log(`Loaded LaunchAgent gui/${uid}/${LAUNCHD_LABEL}`);
  } else {
    console.log(`Run: launchctl bootstrap gui/$(id -u) ${plistPath}`);
  }
  return 0;
}

function runUninstallLaunchd(): number {
  const plistPath = getPlistPath();
  const uid = process.getuid ? process.getuid() : 501;
  Bun.spawnSync(["launchctl", "bootout", `gui/${uid}`, plistPath]);
  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath);
    console.log(`Removed LaunchAgent plist: ${plistPath}`);
  } else {
    console.log(`LaunchAgent plist not present: ${plistPath}`);
  }
  return 0;
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  let code = 0;

  switch (subcommand) {
    case "start":
      code = await runStart();
      break;
    case "doctor":
      code = await runDoctor();
      break;
    case "threads":
      code = await runThreads(rest);
      break;
    case "compose":
      code = await runCompose(rest);
      break;
    case "install-launchd":
      code = runInstallLaunchd(rest);
      break;
    case "uninstall-launchd":
      code = runUninstallLaunchd();
      break;
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      code = 0;
      break;
    default:
      console.error(`Unknown command: ${subcommand}`);
      printUsage();
      code = 2;
      break;
  }

  process.exit(code);
}

await main();

# agy-tele

![Bun >= 1.3](https://img.shields.io/badge/bun-%3E%3D1.3-black) ![TypeScript 5.8](https://img.shields.io/badge/typescript-5.8-black) ![Platform macOS](https://img.shields.io/badge/platform-macOS%2024%2F7-black) ![Runtime Deps 0](https://img.shields.io/badge/runtime%20deps-0-black) ![License MIT](https://img.shields.io/badge/license-MIT-black)

**Drive Antigravity Desktop from Telegram.**

Antigravity Desktop runs fast when you sit in front of your Mac, yet away from your keyboard the official Remote Control feels slow over cellular networks because it mirrors the full desktop UI state over a web relay. When your Mac already stays online 24/7, sending a short text update should take milliseconds rather than seconds of web relay hydration.

`agy-tele` runs locally on your Mac as a small Bun daemon (`0` third-party runtime dependencies). It queries Antigravity Desktop's SQLite index in read-only mode, translates casual Vietnamese or Vietlish notes into clean zero-dash English (`Flow-Gen-EN` and `No-AI-Slop`), injects prompts directly via the local `agentapi` IPC binary, watches `transcript.jsonl` for finalized agent turns, and streams replies, interactive `ask_question` buttons, and proof screenshots straight to Telegram.

## Why not Remote Control, CDP bots, or raw SSH?

Every mobile workflow involves a tradeoff between latency, setup friction, and thread control. `agy-tele` avoids Electron UI scraping and Chromium remote debugging ports by speaking directly to the same local IPC daemon (`agentapi`) and append-only transcript logs that Antigravity Desktop already writes on disk.

| Capability | `agy-tele` | Official Remote Control | CDP UI Bots (Remoat) | MCP Chat Bridges | SSH + tmux (Termius) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Transport** | Telegram Bot API + local `agentapi` IPC | Web UI state relay | Chrome DevTools Protocol DOM scripting | MCP tool calls inside an agent turn | Interactive terminal over SSH |
| **Cellular Latency** | Sub-second text and button delivery | Slow initial UI state sync on LTE/5G | Fast text, fragile after UI updates | Fast inside active turns only | Smooth text, heavy mobile typing |
| **Start or Switch Threads Anytime** | `/threads`, `/bind`, and `/new` 24/7 | Supported via relay UI | Limited to open window state | Fails when agent is idle | Manual CLI invocations |
| **Desktop GUI Coexistence** | Simultaneous phone and Desktop edits | Mirrors Desktop session | Competes for UI focus | Agent waits for blocking tool | Separate CLI session |
| **Chromium Debug Port Required** | None | None | Requires `--remote-debugging-port` | None | None |
| **Vietlish and Anti-Slop Composer** | Built in (`Flow-Gen-EN` + `No-AI-Slop`) | Sends text as typed | Sends text as typed | Sends text as typed | Sends text as typed |
| **Inline `ask_question` Buttons** | Automatic option keyboard mapping | Native UI modal | Not mapped natively | Manual prompt text | Not supported |
| **Inbound Open Ports** | `0` (outbound HTTPS long-polling) | Hosted relay account | Localhost CDP socket | Local or hosted server | SSH port (`22`) + Tailscale |
| **Runtime Dependencies** | `0` (native Bun APIs and `bun:sqlite`) | Built into Antigravity | Node + Playwright/WebSocket libs | Node/Python + MCP SDK | SSH client + tmux |

## Pick your workflow

| What you want to do | Start here |
| :--- | :--- |
| Install prerequisites, configure `.env`, and bind your first thread | [Quick Start](#quick-start) |
| Map each `/Volumes/Dev` repository to its own Telegram Forum Topic | [One Forum Topic per Repository](#one-forum-topic-per-repository) |
| Switch quickly between active Desktop conversations from one DM chat | [Single DM Thread Switching](#single-dm-thread-switching) |
| Tap `ask_question` choices and fetch screenshots from your Mac | [Answering Questions and Pulling Screenshots](#answering-questions-and-pulling-screenshots) |
| Keep the daemon running across logins and reboots on a 24/7 Mac | [Running 24/7 with macOS launchd](#running-247-with-macos-launchd) |
| Tune Vietnamese/Vietlish translation, token masking, and dash scrubbing | [Composer Pipeline](#composer-pipeline) |
| Look up every Telegram slash command and button behavior | [Telegram Commands](#telegram-commands) |
| Inspect host health, search FTS5 threads, or test prompts from terminal | [CLI Reference](#cli-reference) |
| Import `composeEnglishPrompt`, SQLite readers, or `AgyTeleDaemon` in TypeScript | [Programmatic API](#programmatic-api) |
| Fix missing permissions, offline translation warnings, or `agentapi` errors | [Troubleshooting](#troubleshooting) |

## How It Works Locally

Both directions share local Antigravity Desktop state without scraping desktop windows or opening inbound firewall ports.

```text
+------------------------------ [ AGY-TELE DATA FLOW ] ------------------------------+
|                                                                                    |
|  Telegram App (Phone)                                                              |
|     |                                                                              |
|     |  1. Outbound HTTPS getUpdates / sendMessage / sendPhoto                      |
|     v                                                                              |
|  AgyTeleDaemon (src/daemon.ts)                                                     |
|     |                                                                              |
|     +---> Inbound prompt ---> src/composer.ts                                      |
|     |        Mask ZXQTOK -> zh-CN pivot (or offline) -> scrubNoAiSlop -> parity    |
|     |        |                                                                     |
|     |        v                                                                     |
|     |     agentapi send-message / new-conversation                                 |
|     |        | (Desktop records prompt as source=SYSTEM_SDK)                       |
|     |        v                                                                     |
|     |     Antigravity Desktop (agent loop runs locally on Mac)                     |
|     |        | (appends USER_EXPLICIT + MODEL PLANNER_RESPONSE)                    |
|     |        v                                                                     |
|     +---> Outbound watcher ---> fs.watch + 650ms delta reader (src/antigravity.ts) |
|              Read [byteOffset, size) up to 0x0a -> ignore SYSTEM_SDK               |
|              Resolve truncated content from transcript_full.jsonl                  |
|              Chunk <= 3900 chars + map ask_question + upload file:// images        |
|                                                                                    |
|  SQLite Index (conversation_summaries.db)                                          |
|     Opened strictly { readonly: true } for /threads and FTS5 prefix search         |
+------------------------------------------------------------------------------------+
```

1. **Thread discovery stays read-only**: `src/antigravity.ts` opens `$HOME/.gemini/antigravity/conversation_summaries.db` with `{ readonly: true }` in `bun:sqlite`, filters `nesting_depth = 0 AND killed = 0`, and closes the handle in a `finally` block so Antigravity Desktop WAL writes never block.
2. **Inbound prompts run through a local IPC hop**: `agentapi send-message <cid> <prompt>` and `agentapi new-conversation` inject prompts directly into Antigravity's background daemon even when no Desktop window is focused.
3. **Echo loops are blocked by step `source`**: `agentapi send-message` writes entries to `transcript.jsonl` with `source: "SYSTEM_SDK"`. `readTranscriptDelta` ignores `SYSTEM_SDK` rows and emits only `USER_EXPLICIT` turns (typed at the Mac) and finalized `MODEL` (`PLANNER_RESPONSE`) turns.
4. **Byte-offset tailing avoids resending partial writes**: Every poll cycle (triggered by `fs.watch` or the `AGY_POLL_MS` timer) reads only bytes `[byteOffset, size)` ending at a newline byte (`0x0a`). If a log rotates or shrinks (`size < byteOffset`), the cursor resets cleanly to byte `0` and step `-1`.
5. **Truncated long replies fall back automatically**: When Antigravity marks `"content"` in `truncated_fields` inside compact `transcript.jsonl`, `loadFullStep` scans `transcript_full.jsonl` in reverse to recover the full Markdown response before chunking into `<= 3900` character Telegram messages.

## Installation

### Requirements

1. **macOS host** running Antigravity Desktop (providing `$HOME/.gemini/antigravity/bin/agentapi` and `$HOME/.gemini/antigravity/conversation_summaries.db`).
2. **Bun `>= 1.3`** (`bun --version`) for TypeScript execution, `bun:sqlite`, and tests.
3. **Telegram bot token** created via `@BotFather` (`/newbot`).
4. **Numeric Telegram user ID** retrieved from `@userinfobot` so the fail-closed allowlist accepts only your account.

### Clone and verify host readiness

```sh
git clone https://github.com/harrymove-ctrl/agy-tele.git
cd agy-tele
bun install
cp .env.example .env
```

Edit `.env` with your bot token, numeric user ID, and default workspace root (see [Configuration](#configuration) for each variable):

```sh
TELEGRAM_BOT_TOKEN=123456789:your-botfather-token
TELEGRAM_ALLOWED_USER_IDS=123456789
AGY_DEFAULT_WORKSPACE=/Volumes/Dev
AGY_FLOW_GEN_EN=auto
```

Run host diagnostics before starting the daemon:

```sh
bun run doctor
```

Expected healthy output when `.env` is configured and Antigravity Desktop is running:

```text
[PASS] agentapi binary: $HOME/.gemini/antigravity/bin/agentapi
[PASS] conversation_summaries.db: readable in 2.8ms (10 recent top-level threads)
[PASS] agentapi IPC ping: metadata lookup succeeded in 308.6ms (ad5d9922)
[PASS] brain log root: $HOME/.gemini/antigravity/brain
[PASS] telegram auth env: token present, 1 allowed user(s)
```

## Quick Start

Start the foreground daemon from `/Volumes/Dev/agy-tele`:

```sh
bun run start
```

Open Telegram (your bot DM or a Supergroup Forum Topic) and bind a conversation in 3 steps:

1. Send `/threads` to list your `8` most recent top-level Desktop conversations with tap-to-bind buttons (or `/threads video` to run an FTS5 search).
2. Tap one inline button (or send `/bind ad5d9922`). `agy-tele` seeks the cursor to the current end of `transcript.jsonl` so older history never floods your phone.
3. Type a normal message in plain English, Vietnamese, or Vietlish (for example `check lại ENG-2716 bên ai-video-maker giúp @ducnmm`). If rewritten, the bot previews `[EN] ...` and streams Antigravity's finalized reply back to the same chat or topic.

## Daily Workflows

### One Forum Topic per Repository

Using a private Telegram Supergroup with **Topics** enabled is the cleanest way to manage parallel Antigravity Desktop threads across multiple repositories without constantly switching bindings.

1. Create a private Telegram group and enable **Topics** in group settings (`Edit -> Topics -> On`).
2. Add your bot to the group and promote it to **Admin** with permission to **Manage Topics** (or disable privacy mode via `@BotFather` `/setprivacy` -> `Disable` so the bot sees plain text messages, not just slash commands).
3. Create one Topic per workspace (for example `#ai-video-maker`, `#near-hackathon`, `#ops`).
4. Inside each Topic, either bind an existing Desktop thread with `/threads` or start a dedicated conversation scoped to that repo:

```text
/new /Volumes/Dev/ai-video-maker :: fix audio sync drift on remotion export ENG-2716
```

Each Telegram Topic maps to a separate key (`${chatId}:${messageThreadId}`) inside `.state/agy-tele-state.json`. Every Topic keeps its own bound `conversationId`, `workspace`, and `/mode` (`auto`, `always`, or `off`) independently.

### Single DM Thread Switching

If you prefer to chat one-on-one with a bot:

1. Run `/threads` to inspect your latest active threads across all workspaces, or `/threads <keyword>` to search titles and previews using SQLite `conversations_fts`.
2. Tap an inline bind button or type `/bind <prefix>` (4 to 8 hex characters are usually unique; if ambiguous, `resolveConversationByPrefix` asks for more characters).
3. Run `/tail 6` right after binding when you want to read the last 6 finalized Desktop turns without scrolling through the whole log.
4. Run `/status` before walking away from your desk to confirm `agentapi: connected`, current cursor `step_index`, and active compose mode.

### Answering Questions and Pulling Screenshots

When Antigravity calls `ask_question` during a planning or execution turn, `AgyTeleDaemon` renders each question's choices as vertical inline buttons in Telegram:

```text
[Question] Merge PR now?
Options: Merge to dev | Hold

Reply with an option for: Merge PR now?
[ Merge to dev ]
[ Hold         ]
```

Tapping `[ Merge to dev ]` dispatches callback `q:<stepIndex>:<idx>`, resolves the exact original option string from memory, and sends `"Merge to dev"` into Antigravity Desktop immediately via `agentapi send-message`.

Visual proof goes in two directions:

1. **Automatic attachment**: Whenever a `PLANNER_RESPONSE` mentions up to `2` local image paths (`file:///.../shot.png` or `/.../preview.webp`) that exist on disk (`.png`, `.jpg`, `.jpeg`, `.webp`), the daemon automatically uploads them via `sendPhoto`.
2. **On-demand pull**: Send `/shot /Volumes/Dev/repo/artifacts/check.png` anytime to upload a local image file from the Mac to your phone.

### Running 24/7 with macOS launchd

Install the built-in LaunchAgent (`com.commandoss.agy-tele`) so that the daemon starts on login and automatically restarts on exit:

```sh
# Generate ~/Library/LaunchAgents/com.commandoss.agy-tele.plist and bootstrap it now
bun run install:launchd -- --load
```

LaunchAgent daily management commands:

```sh
# Inspect live process PID, exit status, and environment
launchctl print gui/$(id -u)/com.commandoss.agy-tele

# Tail stdout and stderr logs written under .state/
tail -f .state/launchd-stdout.log .state/launchd-stderr.log

# Restart after pulling updates or changing .env
launchctl kickstart -k gui/$(id -u)/com.commandoss.agy-tele

# Unload and delete the LaunchAgent plist cleanly
bun run uninstall:launchd
```

Mac 24/7 Reliability Tips:

1. Keep your Mac awake on AC power (`System Settings -> Energy -> Prevent automatic sleeping when the display is off`, or run `caffeinate -s` if the Mac works headless).
2. After editing `.env`, use `launchctl kickstart -k gui/$(id -u)/com.commandoss.agy-tele` to restart LaunchAgent.
3. `buildLaunchdPlist` dynamically resolves the `bun`, repository path and `$HOME/Library/LaunchAgents` at install time, so nothing user-specific is committed to Git.

## Composer Pipeline

Fast phone messages often mix Vietnamese phrasing, Vietlish shorthand, ticket numbers, and file paths. Leaving raw mobile notes unedited wastes Desktop agent turns; blind translation corrupts code spans, repo slugs, and `@mentions`. `src/composer.ts` solves both problems in four deterministic stages:

1. **Mask (`maskProtectedTokens`)**: Replaces code blocks, links, URLs, paths, ticket keys, mentions, and kebab-case slugs with `ZXQTOK000X` placeholders.
2. **Detect (`detectNeedsEnglishCompose`)**: Inspects only unmasked prose for Vietnamese diacritics, Vietlish shorthand (`khong`, `ko`, `dc`, `cham`, `nhan`, `giup`, `sua`, `loi`, `luon`, `nhe`, `xem`), prohibited dashes, or AI-slop verbs. Clean English passes through unchanged (`modeUsed: "raw"`, zero network calls).
3. **Translate and Scrub (`googleTranslateGtx` + `scrubNoAiSlop`)**: Routes masked Vietnamese/Vietlish through Chinese pivot normalization (`auto -> zh-CN -> en`, `2500ms` timeout) or deterministic Unicode-aware offline normalization (`applyOfflineVietlishNormalization`), then converts dash bullets (`"- "`) to numbered lists, removes em-dashes and spaced hyphens, drops throat-clearing openers, and swaps slop words (`"utilize"` to `"use"`, `"streamline"` to `"simplify"`, `"seamlessly"` to `"smoothly"`).
4. **Restore and Parity Check (`restoreProtectedTokens` + `checkSemanticDrift`)**: Restores every `ZXQTOK000X` token with whitespace padding if NMT removed surrounding spaces, then compares numeric literals, `[A-Z]{2,10}-\d+` ticket IDs, `@mentions`, and token presence against the original prompt. If any token was dropped or translated, it automatically reverts to offline normalization (`warnings` explains why).

### Protected Token Classes (`maskProtectedTokens`)

| Protection Priority | Regex / Pattern Class | Example Preserved Verbatim |
| :--- | :--- | :--- |
| `1` | Fenced code blocks | `` ```ts\nconst x = 1 - 2;\n``` `` |
| `2` | Inline code spans | `` `src/daemon.ts` `` |
| `3` | Markdown links | `` `[repo](https://github.com/harrymove-ctrl/agy-tele)` `` |
| `4` | HTTP, HTTPS, and `file://` URLs | `` `https://api.telegram.org` `` |
| `5` | Absolute `/Volumes`, `/Users`, `/tmp`, `~/`, `./` paths | `` `/Volumes/Dev/ai-video-maker` `` |
| `6` | Relative `dir/file` repository paths | `` `src/composer.ts` `` |
| `7` | Issue tracker keys (`[A-Z]{2,10}-\d+`) | `` `ENG-2716` ``, `` `WALM-950` `` |
| `8` | Mentions (`@handle`, excluding email addresses) | `` `@ducnmm` `` |
| `9` | Multi-hyphen kebab project slugs | `` `ai-video-maker` `` |

### Compose Modes (`AGY_FLOW_GEN_EN` and `/mode`)

| Mode | Trigger Condition | Behavior |
| :--- | :--- | :--- |
| `auto` (default) | Runs composer only when Vietnamese, Vietlish, dashes, or slop are detected | Plain English passes untouched (`modeUsed: "raw"`); rough or Vietnamese drafts get `[EN]` rewrite |
| `always` | Runs full translation pivot and `scrubNoAiSlop` on every prompt | Useful when dictating voice notes or forcing uniform English phrasing across a thread |
| `off` | Skips composition completely | Sends every message verbatim (`modeUsed: "raw"`); same behavior per message via `/raw <text>` |

### Real Input vs Output Examples

| Raw Input | Flags / Mode | Composed Output | `modeUsed` |
| :--- | :--- | :--- | :--- |
| `` `Run bun test cleanly.` `` | `auto` | `` `Run bun test cleanly.` `` | `raw` |
| `` `check lại ENG-2716 bên ai-video-maker giúp @ducnmm` `` | `auto --offline` | `` `Check recheck ENG-2716 in ai-video-maker please @ducnmm` `` | `offline-fallback` |
| `` `We should utilize \`bun:sqlite\` — it will seamlessly streamline queries - fast.` `` | `auto` | `` `We should use \`bun:sqlite\`, it will smoothly simplify queries: fast.` `` | `slop-scrub` |
| `` `check lại PR ENG-2716 giúp @ducnmm` `` | `always` (online) | Rewritten clean English preserving `ENG-2716` and `@ducnmm` | `translate-pivot` |

Test the composition from the command line without sending anything to Antigravity Desktop:

```sh
# Test offline deterministic fallback
bun run compose -- --offline "check lại PR ENG-2716 bên ai-video-maker giúp @ducnmm"

# Force online translation pivot + anti-slop scrubbing
bun run compose -- --mode always "ê check lại auth callback bên ai-video-maker xem lỗi gì nhé"
```

## Safety Gates and Loop Prevention

1. **Fail-closed user allowlist**: `loadConfig(..., true)` refuses to boot `start` if `TELEGRAM_BOT_TOKEN` is blank/placeholder or `TELEGRAM_ALLOWED_USER_IDS` has zero valid numeric IDs. Every incoming `message` and `callback_query` checks `this.config.allowedUserIds.includes(userId)` before touching any command or disk state.
2. **Zero open inbound ports**: `HttpTelegramClient` communicates exclusively over outbound HTTPS `getUpdates` long-polling (`25s` timeout) to `api.telegram.org`. No local HTTP server, ngrok tunnel, or webhook port is opened on your Mac.
3. **`SYSTEM_SDK` echo suppression**: Whenever `agy-tele` calls `agentapi send-message`, Antigravity logs that injected prompt with `source: "SYSTEM_SDK"`. `parseStepToEvent` forwards only `USER_EXPLICIT` (`USER_INPUT`) and `MODEL` (`PLANNER_RESPONSE`) rows where `status === "DONE"`, preventing feedback loops completely.
4. **Atomic state persistence and newline cursors**: `saveState` writes JSON to `${statePath}.${pid}.tmp` and renames it atomically so power loss never leaves half-written JSON. Transcript cursors advance strictly to the last `0x0a` newline byte, never splitting an in-flight JSONL line.
5. **Markdown parse retry and message chunking**: `HttpTelegramClient.sendMessage` automatically retries without `parse_mode` if Telegram rejects malformed formatting, and `chunkTelegramText` splits replies over `3900` characters on newline or space boundaries below Telegram's `4096` character limit.

## Telegram Commands

| Command | Arguments | Behavior and State Effect |
| :--- | :--- | :--- |
| `/start`, `/help` | None | Shows current chat or Topic binding, active `flowGenEn` mode, and command list |
| `/threads` | `[query]` | Lists up to `8` recent top-level Desktop threads (or runs SQLite `conversations_fts` search) with `bind:<uuid>` inline buttons |
| `/bind` | `<id-or-prefix>` | Binds current DM or Forum Topic to the matched thread and sets initial cursor to current `transcript.jsonl` EOF |
| `/new` | `[dir ::] <prompt>` | Starts a new Desktop conversation in `dir` (or `AGY_DEFAULT_WORKSPACE`), binds current chat/Topic at step `0`, and sends prompt |
| `/en` | `<draft>` | Runs `composeEnglishPrompt(draft, { mode: "always" })` and replies with `[EN <modeUsed>] ...` without sending to Desktop |
| `/raw` | `<text>` | Sends `<text>` verbatim to the bound Desktop thread (or starts a new thread), bypassing `Flow-Gen-EN` |
| `/mode` | `[auto\|always\|off]` | Prints active compose mode or saves a per-thread override inside `.state/agy-tele-state.json` |
| `/tail` | `[count]` | Prints `1` to `12` recent finalized `USER_EXPLICIT` and `PLANNER_RESPONSE` turns (default `4`) |
| `/shot` | `<abs-or-rel-path>` | Validates `.png`, `.jpg`, `.jpeg`, `.webp` on disk and uploads it via Telegram `sendPhoto` |
| `/status` | None | Reports bound thread title, full UUID, workspace path, compose mode, cursor offset/step, and live `agentapi` ping status |

Typical Telegram topic conversation:

```text
You:  /threads video
Bot:  1. [9174a368] AI Video Maker 2h Grill Reviewer (ai-video-maker, running, 786 steps)
      [ 9174a3 ] (tap)
Bot:  Bound to [9174a368] AI Video Maker 2h Grill Reviewer (ai-video-maker). Send a message or run /tail.

You:  check lại ENG-2716 bên ai-video-maker giúp @ducnmm
Bot:  [EN] Check ENG-2716 in ai-video-maker for @ducnmm.
Bot:  Verified ENG-2716 on dev and ran bun test (14 passed). Commit ready for @ducnmm.
```

## CLI Reference

Run commands via `bun run src/cli.ts <command>`, `package.json` scripts (`bun run <script>`), or the `agy-tele` bin entry if linked globally (`bun link`).

| Subcommand / Script | Flags & Arguments | Purpose |
| :--- | :--- | :--- |
| `start` (`bun run start`) | Reads `.env` | Validates bot auth, registers `BOT_COMMANDS`, and starts Telegram + transcript loops |
| `doctor` (`bun run doctor`) | None | Checks `agentapi` binary, read-only SQLite access, live IPC ping, brain dir, and `.env` auth; exits `0` when core host checks pass |
| `threads` (`bun run threads`) | `[--search <q>] [--limit <n>]` | Prints recent top-level conversations (or FTS5 matches) with short ID, workspace, run state, step count, and elapsed ms |
| `compose` (`bun run compose`) | `[--offline] [--mode auto\|always\|off] <text>` | Runs `composeEnglishPrompt` in terminal and prints drift warnings to `stderr` |
| `install-launchd` (`bun run install:launchd`) | `[--load]` | Writes `~/Library/LaunchAgents/com.commandoss.agy-tele.plist`; adds `--load` to run `launchctl bootstrap` right away |
| `uninstall-launchd` (`bun run uninstall:launchd`) | None | Runs `launchctl bootout` and deletes the LaunchAgent plist |

Common terminal examples:

```sh
# Search recent threads mentioning "remotion" (top 5)
bun run threads -- --search remotion --limit 5

# Check offline English normalization without hitting Desktop
bun run compose -- --offline "sửa lỗi build bên agy-tele giúp nhé"

# Install and start the 24/7 LaunchAgent immediately
bun run install:launchd -- --load
```

## Configuration

`src/config.ts` loads configuration from environment variables (`Bun` automatically reads `.env` from the working directory) and expands the `$HOME` and `~/` prefixes in the file system path.

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | Yes (for `start`) | None | Bot token issued by `@BotFather` |
| `TELEGRAM_ALLOWED_USER_IDS` | Yes (for `start`) | None | Comma-separated numeric Telegram user IDs allowed to run commands and tap buttons |
| `TELEGRAM_CHAT_ID` | No | Empty (`null`) | Optional default chat ID reserved for proactive notifications |
| `AGY_DATA_DIR` | No | `$HOME/.gemini/antigravity` | Root Antigravity Desktop data directory holding `conversation_summaries.db` and `brain/` |
| `AGY_AGENTAPI_BIN` | No | `$HOME/.gemini/antigravity/bin/agentapi` | Path to local `agentapi` IPC binary |
| `AGY_DEFAULT_WORKSPACE` | No | `/Volumes/Dev` | Default workspace directory passed to `agentapi new-conversation` when `/new` omits `dir ::` |
| `AGY_DEFAULT_MODEL` | No | Empty (`null`) | Optional `--model=<id>` override passed when creating new Desktop conversations |
| `AGY_FLOW_GEN_EN` | No | `auto` | Default compose mode for unbound chats (`auto`, `always`, or `off`) |
| `AGY_POLL_MS` | No | `650` | Maximum interval in milliseconds between transcript scans (`Math.max(200, value)` floor) |
| `AGY_STATE_PATH` | No | `.state/agy-tele-state.json` | JSON file storing `telegramOffset`, per-chat/topic `bindings`, and transcript byte `cursors` |

### Persistent State Schema (`.state/agy-tele-state.json`)

```json
{
  "version": 1,
  "telegramOffset": 81492011,
  "bindings": {
    "-1001987654321:55": {
      "chatKey": "-1001987654321:55",
      "chatId": -1001987654321,
      "messageThreadId": 55,
      "conversationId": "ad5d9922-1111-2222-3333-444455556666",
      "title": "AI Video Maker 2h Grill Reviewer",
      "workspace": "/Volumes/Dev/ai-video-maker",
      "flowGenEn": "auto",
      "updatedAt": "2026-11-15T07:10:00.000Z"
    }
  },
  "cursors": {
    "ad5d9922-1111-2222-3333-444455556666": {
      "byteOffset": 48219,
      "lastStepIndex": 177
    }
  }
}
```

### Repository Map

| Path | Role |
| :--- | :--- |
| `src/index.ts` | Public TypeScript barrel exporting daemon, composer, SQLite/IPC, config, state, and Telegram types |
| `src/cli.ts` | CLI entry point for `start`, `doctor`, `threads`, `compose`, `install-launchd`, and `uninstall-launchd` |
| `src/daemon.ts` | `AgyTeleDaemon` update router, allowlist guard, command dispatch, and `fs.watch` transcript loop |
| `src/antigravity.ts` | Read-only SQLite + FTS5 queries, `agentapi` wrapper, incremental delta tailer, and message chunker |
| `src/composer.ts` | Token masking (`ZXQTOK000X`), `zh-CN` translation pivot, `scrubNoAiSlop`, offline Vietlish rules, drift checks |
| `src/telegram.ts` | Native `fetch` and `FormData` `HttpTelegramClient` implementation of `TelegramClient` |
| `src/state.ts` | Atomic JSON persistence and EOF cursor computation on bind |
| `src/config.ts` | `.env` loader, `$HOME` / `~` expansion, and startup auth validation |
| `docs/ARCHITECTURE.md` | Concise module breakdown and cursor safety invariants |

## Programmatic API

All core modules are re-exported from `./src/index.ts` (and exposed via `"exports"` in `package.json`) for automation scripts, custom bridges, or scheduled checks.

### Prompt Composer (`composeEnglishPrompt`, `scrubNoAiSlop`)

```ts
import {
  checkSemanticDrift,
  composeEnglishPrompt,
  scrubNoAiSlop,
} from "./src/index.ts";

const raw =
  "check lại ENG-2716 bên ai-video-maker giúp @ducnmm, leverage cache to streamline it";

const composed = await composeEnglishPrompt(raw, {
  mode: "auto",
  offline: true,
});

console.log(composed.text);
console.log("Mode:", composed.modeUsed, "Warnings:", composed.warnings);

// Direct zero-dash anti-slop cleanup on English prose:
const clean = scrubNoAiSlop("Utilize cache — it seamlessly helps.");
console.log(clean, checkSemanticDrift(raw, composed.text));
```

#### `ComposeOptions` and `ComposeResult`

| Field | Type | Description |
| :--- | :--- | :--- |
| `options.mode` | `"auto" \| "always" \| "off"` | Controls whether plain English passes untouched (`"auto"` default) |
| `options.offline` | `boolean` | Uses deterministic local normalization without calling Google Translate (`false` default) |
| `options.timeoutMs` | `number` | HTTP timeout per translation hop in milliseconds (`2500` default) |
| `result.text` | `string` | Final normalized prompt ready for Antigravity Desktop |
| `result.changed` | `boolean` | `true` when `result.text !== raw` |
| `result.modeUsed` | `"raw" \| "translate-pivot" \| "slop-scrub" \| "offline-fallback"` | Indicates which pipeline branch produced `result.text` |
| `result.warnings` | `string[]` | Semantic drift or network fallback notes reported by `checkSemanticDrift` |

### Desktop Threads and Incremental Transcript Tailing

```ts
import {
  chunkTelegramText,
  listConversations,
  loadConfig,
  readTranscriptDelta,
  resolveConversationByPrefix,
} from "./src/index.ts";

const cfg = loadConfig(process.env, false);

// Read-only SQLite query (top 5 active threads matching "video")
const threads = listConversations(cfg.agyDataDir, {
  limit: 5,
  query: "video",
});

const target = resolveConversationByPrefix(
  cfg.agyDataDir,
  threads[0]?.conversationId ?? ""
);

if (target) {
  const delta = await readTranscriptDelta(cfg.agyBrainDir, target.conversationId, {
    byteOffset: 0,
    lastStepIndex: -1,
  });
  for (const event of delta.events) {
    if (event.kind === "assistant_reply") {
      for (const chunk of chunkTelegramText(event.text)) {
        console.log(`[step ${event.stepIndex}]`, chunk);
      }
    }
  }
}
```

### Customizing `AgyTeleDaemon` or `DesktopBridge`

Pass a custom `TelegramClient` or `DesktopBridge` implementation to `AgyTeleDaemon` when embedding inside another supervisor or writing deterministic integration tests:

```ts
import {
  AgyTeleDaemon,
  HttpTelegramClient,
  loadConfig,
} from "./src/index.ts";

const cfg = loadConfig(process.env, true);
const telegram = new HttpTelegramClient(cfg.telegramBotToken);
const daemon = new AgyTeleDaemon(cfg, telegram);

process.on("SIGINT", () => daemon.stop());
await daemon.start();
```

## Troubleshooting

| Symptom | Likely Cause | Fix |
| :--- | :--- | :--- |
| `TELEGRAM_BOT_TOKEN is missing or still set to placeholder` | `.env` still has default `replace-with-your-bot-token` value or was not copied | Copy `.env.example` to `.env`, set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_IDS`, then re-run `bun run doctor` |
| Bot answers `/threads` in a Supergroup Topic, but ignores normal messages | Telegram Group Privacy mode blocks non-command text for non-admin bots | Promote the bot to **Admin** with **Manage Topics**, or run `/setprivacy` -> `Disable` in `@BotFather` |
| `agentapi send-message` exits non-zero or times out after `15000ms` | Antigravity Desktop app or background language server is stopped or updating | Launch Antigravity Desktop on the Mac, wait a few seconds, and check `[PASS] agentapi IPC ping` via `bun run doctor` |
| `/bind ab` says `Prefix "ab" matched N threads` | Short prefix collided across multiple recent UUIDs | Pass 6 to 8 hex characters (copied from `/threads`) or tap the inline button instead |
| Composer appends `translate fallback:` warnings | Mac has no internet access or Google Translate timed out (`2500ms`) | Local `offline-fallback` still normalized Vietlish and preserved tokens safely; check Wi-Fi or run `/en` to inspect |
| `/shot` says `Image not found or unsupported format` | Relative path missed working directory or extension is not `.png`/`.jpg`/`.jpeg`/`.webp` | Pass the full `/Volumes/Dev/.../image.png` path produced on the Mac |

## Verification

| Verified Scenario and Invariants | Command | Observed Result |
| :--- | :--- | :--- |
| **Public barrel and README code snippet parity**: Confirms `src/index.ts` exports all documented functions/classes and the programmatic `composeEnglishPrompt` example preserves `ENG-2716`, `ai-video-maker`, and `@ducnmm` cleanly. | `bun test tests/index.test.ts` | `2` passed, `0` failed |
| **Composer masking, zero-dash scrubbing, and offline fallback**: Verifies all `9` protected token patterns, Unicode word boundaries for Vietnamese diacritics, anti-slop swaps, and semantic parity checks. | `bun test tests/composer.test.ts` | `5` passed, `0` failed |
| **SQLite FTS5 index and transcript delta cursoring**: Tests `{ readonly: true }` filtering (`nesting_depth = 0`), trailing newline buffering, `SYSTEM_SDK` suppression, `transcript_full.jsonl` fallback, and chunking. | `bun test tests/antigravity.test.ts` | `3` passed, `0` failed |
| **End-to-end daemon round-trip and full TypeScript check**: Verifies unauthorized user rejection, inline bind buttons, Vietlish rewrite, `PLANNER_RESPONSE` push, and `ask_question` callbacks under strict `tsc`. | `bun test && bun run typecheck` | `11` passed, `0` failed (`101` assertions across `4` files); `0` TS errors |
| **Live macOS host IPC and SQLite read check**: Executed directly against the running macOS Antigravity Desktop `conversation_summaries.db` and `agentapi` daemon. | `bun run doctor && bun run threads -- --limit 5` | `conversation_summaries.db` read in `2.8ms`; `5` threads queried in `1.9ms`; `agentapi` IPC ping in `308.6ms` |

## Limitations

1. Live Telegram Bot API long-polling (`getUpdates`) and file uploads (`sendPhoto`) require a real token from `@BotFather` in `.env`. Automated suite coverage exercises daemon routing against a typed mock `TelegramClient`.
2. Outbound delivery streams finalized `DONE` steps from `transcript.jsonl` (typically within a second of step completion) rather than streaming token-by-token partial deltas mid-generation.

## License

MIT

# agy-tele

![Bun >= 1.3](https://img.shields.io/badge/bun-%3E%3D1.3-black) ![TypeScript 5.8](https://img.shields.io/badge/typescript-5.8-black) ![Platform macOS](https://img.shields.io/badge/platform-macOS%2024%2F7-black) ![Runtime Deps 0](https://img.shields.io/badge/runtime%20deps-0-black) ![License MIT](https://img.shields.io/badge/license-MIT-black)

**Drive Antigravity Desktop from Telegram.**

Antigravity Desktop runs fast when you sit in front of your Mac, but away from your desk the official Remote Control feels slow on mobile data because it loads the full desktop UI over a web relay. When your Mac stays online 24/7, sending a short update should take milliseconds instead of seconds.

`agy-tele` runs on your Mac as a small Bun daemon with `0` third-party runtime dependencies. It reads Antigravity Desktop's SQLite index in read-only mode, turns casual Vietnamese or Vietlish notes into clean plain English (`Flow-Gen-EN` and `No-AI-Slop`), sends prompts straight to the local `agentapi` service, watches `transcript.jsonl` for finished replies, and forwards answers, choice buttons, and screenshots to Telegram.

## Why not Remote Control, CDP bots, or raw SSH?

Every phone workflow weighs speed, setup effort, and thread control. `agy-tele` avoids Electron UI scraping and the Chromium debug port by communicating directly with the same local `agentapi` service and log files that Antigravity Desktop has written to disk.

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
| Install prerequisites, configure `.env`, and sync your first folder or thread | [Quick Start](#quick-start) |
| Sync one Telegram chat or DM with an Antigravity Session Folder (`my-working-daily`) | [Syncing a Telegram Chat with an Antigravity Session Folder](#syncing-a-telegram-chat-with-an-antigravity-session-folder) |
| Switch quickly between active Desktop conversations from one DM chat | [Single DM Thread Switching](#single-dm-thread-switching) |
| Tap `ask_question` choices and fetch screenshots from your Mac | [Answering Questions and Pulling Screenshots](#answering-questions-and-pulling-screenshots) |
| Keep the daemon running across logins and reboots on a 24/7 Mac | [Running 24/7 with macOS launchd](#running-247-with-macos-launchd) |
| Tune Vietnamese/Vietlish translation, token masking, and dash scrubbing | [Composer Pipeline](#composer-pipeline) |
| Look up every Telegram slash command and button behavior | [Telegram Commands](#telegram-commands) |
| Inspect host health, search FTS5 threads, or test prompts from terminal | [CLI Reference](#cli-reference) |
| Import `composeEnglishPrompt`, SQLite readers, or `AgyTeleDaemon` in TypeScript | [Programmatic API](#programmatic-api) |
| Fix missing permissions, offline translation warnings, or `agentapi` errors | [Troubleshooting](#troubleshooting) |

## How It Works Locally

Both sides share local Antigravity Desktop files on disk without touching desktop windows or opening network ports.

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
|     |     ANTIGRAVITY_PROJECT_ID=<folderId> agentapi send-message / new-conv       |
|     |        | (Desktop places thread in Session Folder; source=SYSTEM_SDK)        |
|     |        v                                                                     |
|     |     Antigravity Desktop (agent loop runs locally on Mac)                     |
|     |        | (appends USER_EXPLICIT + MODEL PLANNER_RESPONSE)                    |
|     |        v                                                                     |
|     +---> Outbound watcher ---> fs.watch + 650ms delta reader (src/antigravity.ts) |
|              Active thread + watched sibling threads in synced Session Folder      |
|              Read [byteOffset, size) up to 0x0a -> ignore SYSTEM_SDK               |
|              Resolve truncated content from transcript_full.jsonl                  |
|              Chunk <= 3900 chars + map ask_question + upload file:// images        |
|                                                                                    |
|  Session Folders & Annotations + SQLite Index                                      |
|     projects/*.json (folder UUIDs) + annotations/*.pbtxt (skip archived)           |
|     conversation_summaries.db opened { readonly: true } for /folders & /threads    |
+------------------------------------------------------------------------------------+
```

1. **Reads folders and threads safely**: `src/antigravity.ts` reads Session Folders from `$HOME/.gemini/config/projects/*.json`, skips `archived:true` threads in `annotations/*.pbtxt`, and opens `conversation_summaries.db` in read-only mode so Desktop writes never wait.
2. **Sends messages straight to Desktop**: `agentapi send-message` and `agentapi new-conversation` talk to the local Antigravity background service even when the app window is closed or minimized. When a chat is synced to a folder, `agy-tele` sets `ANTIGRAVITY_PROJECT_ID` so new chats open right inside that sidebar folder.
3. **Stops echo loops**: Messages sent from Telegram are saved in `transcript.jsonl` with `source: "SYSTEM_SDK"`. `agy-tele` skips `SYSTEM_SDK` lines and only forwards messages you type on your Mac (`USER_EXPLICIT`) and completed model replies (`PLANNER_RESPONSE`).
4. **Reads only finished log lines**: On each file change or `650ms` check, the reader scans new bytes up to the last newline (`0x0a`). Half-written lines wait for the next check, and rotated or smaller files reset cleanly to byte `0`.
5. **Keeps long replies complete**: When `transcript.jsonl` shortens a long answer (`truncated_fields` includes `"content"`), `agy-tele` reads the full reply from `transcript_full.jsonl` and splits it into Telegram messages of `<= 3900` characters.

## Installation

### Requirements

1. **A Mac running Antigravity Desktop**: Gives `agy-tele` the local `agentapi` binary (`$HOME/.gemini/antigravity/bin/agentapi`) and the local chat database (`$HOME/.gemini/antigravity/conversation_summaries.db`).
2. **Bun `>= 1.3`**: Check with `bun --version`. Bun runs the TypeScript daemon, `bun:sqlite`, and tests without extra packages.
3. **A Telegram bot token**: Open `@BotFather` in Telegram, send `/newbot`, and copy your bot token.
4. **Your numeric Telegram user ID**: Open `@userinfobot` in Telegram and copy your ID. `agy-tele` ignores messages from any user ID not listed in `.env`.

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
AGY_DEFAULT_FOLDER=my-working-daily
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
[PASS] conversation_summaries.db: readable in 9.7ms (10 recent top-level threads)
[PASS] agentapi IPC ping: metadata lookup succeeded in 200.9ms (3ccece75)
[PASS] brain log root: $HOME/.gemini/antigravity/brain
[PASS] session folders: 27 folder(s) loaded in 15.6ms
[PASS] telegram auth env: token present, 1 allowed user(s)
```

## Quick Start

Start the foreground daemon from `/Volumes/Dev/agy-tele`:

```sh
bun run start
```

Open Telegram in your bot DM or a private group and connect a folder or thread in 3 steps:

1. Send `/folders` and tap `[ Sync my-working-daily ]` (or send `/folder my-working-daily`). If `AGY_DEFAULT_FOLDER=my-working-daily` is already set in `.env`, the first message syncs that folder for you.
2. Send `/threads` to see the active threads in your synced folder (or `/threads all` for every folder), then tap a thread if you want to switch where your next reply goes.
3. Write a normal message in English, Vietnamese, or Vietlish (for example `check giúp hackathon mới hôm nay, note lại flow này vào workflow`). If the composer rewrites it, the bot previews `[EN] ...`, routes it into your folder via `ANTIGRAVITY_PROJECT_ID`, and sends the Desktop reply back to Telegram.

## Daily Workflows

### Syncing a Telegram Chat with an Antigravity Session Folder

If you keep daily automations, hackathon scouts, notes, and new workflows inside one Antigravity Desktop folder such as `my-working-daily`, you can sync a single Telegram chat directly with that folder.

How folder sync works each day:

1. **Sync from `.env` or Telegram**: Set `AGY_DEFAULT_FOLDER=my-working-daily` in `.env` for automatic sync on first message, or send `/folders` in Telegram to pick any folder from `$HOME/.gemini/config/projects/*.json`.
2. **Matches your Desktop sidebar**: `agy-tele` reads `$HOME/.gemini/antigravity/annotations/*.pbtxt`, so archived threads (`archived:true`) stay hidden in `/folders` and `/threads`, while renamed or active threads appear just like on Desktop.
3. **Watches every active and new automation in the folder**: With `watchFolder` on, whenever any thread in `my-working-daily` finishes a turn (including twice-daily cron runs or newly started tasks), Telegram shows `[my-working-daily | Thread Title]` with an inline `[ Reply: Thread Title ]` button.
4. **One-tap switching and folder-scoped `/new`**: Tap `[ Reply: Thread Title ]` on any message to send your next reply straight to that thread while still watching the rest of the folder. Run `/new <prompt>` (or send plain text when the folder has no active thread yet) and `agy-tele` passes `ANTIGRAVITY_PROJECT_ID=<folderId>` so the new conversation saves right inside `my-working-daily` on Desktop.
5. **Folder filtering and clean detach**: `/threads` shows only threads inside your synced folder by default (run `/threads all [query]` to search all folders), and `/folder off` stops watching the folder while keeping your current thread bound.

Example daily flow in `my-working-daily`:

```text
You:  /folder my-working-daily
Bot:  Synced folder "my-working-daily" (27 active thread(s)).
      Active reply target: [c7462c96] Remove Old Working Daily Sessions

Bot:  [my-working-daily | Automated Daily Hackathon Research And Tracking]

      Found 1 new Solana deadline on Nov 28. Added summary to HACKATHON_WIN_TIMELINE.md.
      [ Reply: Automated Daily Hack ] (tap)

You:  (tap Reply button)
Bot:  Bound to [4948fd44] Automated Daily Hackathon Research And Tracking (my-working-daily). Send a message or run /tail.

You:  lưu flow scout hackathon theo deadline mới thảo luận vào workflow nhé
Bot:  [EN] Save the deadline-based hackathon scouting flow we discussed into the workflow.
Bot:  Updated .agents/skills/hackathon-architect/SKILL.md and logged the change in Desktop.
```

### Single DM Thread Switching

If you want to manually switch between threads in direct chat:

1. Send `/threads` to list your recent threads, or `/threads <keyword>` to search titles and previews using SQLite `conversations_fts`.
2. Tap an inline button or run `/bind <prefix>`. Four to eight hex characters are usually unique; if not, `resolveConversationByPrefix` asks for a longer prefix.
3. Run `/tail 6` right after binding to read the last 6 finished Desktop turns without opening your Mac.
4. Run `/status` before leaving your desk to confirm `agentapi: connected`, the current log step, and your compose mode.

### Answering Questions and Pulling Screenshots

When Antigravity asks a multiple choice question (`ask_question`), `AgyTeleDaemon` sends the options as clickable buttons in Telegram:

```text
[Question] Merge PR now?
Options: Merge to dev | Hold

Reply with an option for: Merge PR now?
[ Merge to dev ]
[ Hold         ]
```

Tapping `[ Merge to dev ]` looks up the exact option label from memory and sends `"Merge to dev"` to Antigravity Desktop right away through `agentapi send-message`.

Images move in two ways:

1. **Sent automatically**: When a model reply (`PLANNER_RESPONSE`) points to up to `2` existing local image files (`.png`, `.jpg`, `.jpeg`, `.webp`), the daemon uploads them to Telegram via `sendPhoto`.
2. **Requested anytime**: Send `/shot /Volumes/Dev/repo/artifacts/check.png` from Telegram to upload a local screenshot from your Mac.

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

Quick phone messages often mix Vietnamese, Vietlish shorthand, ticket numbers, and file paths. Raw mobile notes waste agent turns, while blind translation breaks code spans, repo names, and `@mentions`. `src/composer.ts` handles both problems in four steps:

1. **Mask (`maskProtectedTokens`)**: Hides code blocks, links, URLs, file paths, ticket keys, mentions, and hyphenated slugs behind `ZXQTOK000X` placeholders.
2. **Detect (`detectNeedsEnglishCompose`)**: Checks the remaining text for Vietnamese diacritics, Vietlish words (`khong`, `ko`, `dc`, `cham`, `nhan`, `giup`, `sua`, `loi`, `luon`, `nhe`, `xem`), banned dashes, or AI slop words. Clean English passes through with no network call (`modeUsed: "raw"`).
3. **Translate and Scrub (`googleTranslateGtx` + `scrubNoAiSlop`)**: Translates masked Vietnamese or Vietlish through a Chinese pivot (`auto -> zh-CN -> en`, `2500ms` timeout) or falls back to local offline rules. Next, `scrubNoAiSlop` turns dash bullets into numbered items, removes em-dashes and spaced hyphens, drops filler openers, and swaps slop words (`"utilize"` to `"use"`, `"streamline"` to `"simplify"`, `"seamlessly"` to `"smoothly"`).
4. **Restore and Check Parity (`restoreProtectedTokens` + `checkSemanticDrift`)**: Puts every `ZXQTOK000X` token back with clean spacing, then verifies that every number, `[A-Z]{2,10}-\d+` ticket key, and `@mention` matches the original note. If any protected item was dropped or altered, it falls back to safe offline normalization and notes the reason in `warnings`.

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

1. **Strict user allowlist**: `loadConfig(..., true)` stops `start` right away if `TELEGRAM_BOT_TOKEN` is missing or `TELEGRAM_ALLOWED_USER_IDS` is empty. Every incoming `message` and `callback_query` checks `this.config.allowedUserIds.includes(userId)` before running any command.
2. **Zero open ports**: `HttpTelegramClient` only makes outbound HTTPS `getUpdates` requests (`25s` timeout) to `api.telegram.org`. Your Mac never opens a webhook port or tunnel.
3. **`SYSTEM_SDK` loop guard**: When `agy-tele` runs `agentapi send-message`, Antigravity saves that message with `source: "SYSTEM_SDK"`. `parseStepToEvent` ignores `SYSTEM_SDK` lines and only forwards completed `USER_EXPLICIT` (`USER_INPUT`) and `MODEL` (`PLANNER_RESPONSE`) turns.
4. **Safe state saves and newline cursors**: `saveState` writes JSON to `${statePath}.${pid}.tmp` and renames it in one step so crashes never corrupt state. Log cursors move only to the last `0x0a` newline byte so half-written lines are never read early.
5. **Markdown fallback and message splitting**: `HttpTelegramClient.sendMessage` retries as plain text if Telegram rejects Markdown formatting, and `chunkTelegramText` splits long replies at `3900` characters on clean line or word breaks.

## Telegram Commands

| Command | Arguments | Behavior and State Effect |
| :--- | :--- | :--- |
| `/start`, `/help` | None | Auto-syncs `AGY_DEFAULT_FOLDER` if configured, shows current folder/thread binding, active `flowGenEn` mode, and command list |
| `/folders` | None | Lists Desktop Session Folders from `$HOME/.gemini/config/projects/*.json` with active non-archived counts and `folder:<id>` tap-to-sync buttons |
| `/folder` | `[name\|id\|off]` | Shows current folder sync status, attaches `watchFolder` to the matching Session Folder, or passes `off` to detach folder watching |
| `/threads` | `[all] [query]` | Lists up to `8` active threads in the synced Session Folder (or across all folders when `all` is given) with `bind:<uuid>` buttons |
| `/bind` | `<id-or-prefix>` | Binds current chat or optional topic to the matched thread and sets initial cursor to current `transcript.jsonl` EOF |
| `/new` | `[dir ::] <prompt>` | Starts a new Desktop conversation in `dir` (or active folder/default workspace) passing `ANTIGRAVITY_PROJECT_ID` when synced |
| `/en` | `<draft>` | Runs `composeEnglishPrompt(draft, { mode: "always" })` and replies with `[EN <modeUsed>] ...` without sending to Desktop |
| `/raw` | `<text>` | Sends `<text>` verbatim to the bound Desktop thread (or starts a new thread), bypassing `Flow-Gen-EN` |
| `/mode` | `[auto\|always\|off]` | Prints active compose mode or saves a per-thread override inside `.state/agy-tele-state.json` |
| `/tail` | `[count]` | Prints `1` to `12` recent finalized `USER_EXPLICIT` and `PLANNER_RESPONSE` turns (default `4`) |
| `/shot` | `<abs-or-rel-path>` | Validates `.png`, `.jpg`, `.jpeg`, `.webp` on disk and uploads it via Telegram `sendPhoto` |
| `/status` | None | Reports synced Session Folder, watch mode, active thread title/UUID, workspace, compose mode, cursor offset, and live `agentapi` ping status |

Typical Telegram thread conversation:

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
| `doctor` (`bun run doctor`) | None | Checks `agentapi` binary, read-only SQLite access, live IPC ping, brain dir, session folders, and `.env` auth |
| `folders` (`bun run folders`) | None | Lists Antigravity Session Folders with UUID prefix, active non-archived thread count, and primary workspace |
| `threads` (`bun run threads`) | `[--folder <f>] [--search <q>] [--limit <n>]` | Prints recent top-level conversations (optionally filtered by Session Folder or FTS5 search) |
| `compose` (`bun run compose`) | `[--offline] [--mode auto\|always\|off] <text>` | Runs `composeEnglishPrompt` in terminal and prints drift warnings to `stderr` |
| `install-launchd` (`bun run install:launchd`) | `[--load]` | Writes `~/Library/LaunchAgents/com.commandoss.agy-tele.plist`; adds `--load` to run `launchctl bootstrap` right away |
| `uninstall-launchd` (`bun run uninstall:launchd`) | None | Runs `launchctl bootout` and deletes the LaunchAgent plist |

Common terminal examples:

```sh
# List Antigravity Session Folders and non-archived thread counts
bun run folders

# Inspect the newest 8 active threads inside "my-working-daily"
bun run threads -- --folder my-working-daily --limit 8

# Search threads mentioning "hackathon" inside "my-working-daily"
bun run threads -- --folder my-working-daily --search hackathon --limit 5

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
| `AGY_DATA_DIR` | No | `$HOME/.gemini/antigravity` | Root Antigravity Desktop data directory holding `conversation_summaries.db`, `annotations/`, and `brain/` |
| `AGY_PROJECTS_DIR` | No | `$HOME/.gemini/config/projects` | Directory containing Antigravity Session Folder JSON definitions |
| `AGY_DEFAULT_FOLDER` | No | Empty (`null`) | Optional Session Folder name or UUID prefix (such as `my-working-daily`) synced automatically on first chat interaction |
| `AGY_AGENTAPI_BIN` | No | `$HOME/.gemini/antigravity/bin/agentapi` | Path to local `agentapi` IPC binary |
| `AGY_DEFAULT_WORKSPACE` | No | `/Volumes/Dev` | Default workspace directory passed to `agentapi new-conversation` when `/new` omits `dir ::` |
| `AGY_DEFAULT_MODEL` | No | Empty (`null`) | Optional `--model=<id>` override passed when creating new Desktop conversations |
| `AGY_FLOW_GEN_EN` | No | `auto` | Default compose mode for unbound chats (`auto`, `always`, or `off`) |
| `AGY_POLL_MS` | No | `650` | Maximum interval in milliseconds between transcript scans (`Math.max(200, value)` floor) |
| `AGY_STATE_PATH` | No | `.state/agy-tele-state.json` | JSON file storing `telegramOffset`, per-chat/folder `bindings`, and transcript byte `cursors` |

### Persistent State Schema (`.state/agy-tele-state.json`)

```json
{
  "version": 1,
  "telegramOffset": 81492011,
  "bindings": {
    "777:main": {
      "chatKey": "777:main",
      "chatId": 777,
      "conversationId": "c7462c96-1111-2222-3333-444455556666",
      "title": "Remove Old Working Daily Sessions",
      "workspace": "/Volumes/Dev/gemma-4-developer-agent",
      "folderId": "325113ab-f784-4fd3-87dc-e1a8d67576af",
      "folderName": "my-working-daily",
      "watchFolder": true,
      "folderSyncedAt": "2026-11-15T07:10:00.000Z",
      "flowGenEn": "auto",
      "updatedAt": "2026-11-15T07:10:00.000Z"
    }
  },
  "cursors": {
    "c7462c96-1111-2222-3333-444455556666": {
      "byteOffset": 48219,
      "lastStepIndex": 259
    }
  }
}
```

### Repository Map

| Path | Role |
| :--- | :--- |
| `src/index.ts` | Public TypeScript barrel exporting daemon, composer, folder/SQLite/IPC helpers, config, state, and Telegram types |
| `src/cli.ts` | CLI entry point for `start`, `doctor`, `folders`, `threads`, `compose`, `install-launchd`, and `uninstall-launchd` |
| `src/daemon.ts` | `AgyTeleDaemon` update router, Session Folder sync/watch loop, allowlist guard, command dispatch, and `fs.watch` transcript loop |
| `src/antigravity.ts` | Session Folder discovery (`projects/*.json`), annotation filtering (`annotations/*.pbtxt`), read-only SQLite + FTS5 queries, `ANTIGRAVITY_PROJECT_ID` `agentapi` wrapper, incremental delta tailer, and message chunker |
| `src/composer.ts` | Token masking (`ZXQTOK000X`), `zh-CN` translation pivot, `scrubNoAiSlop`, offline Vietlish rules, drift checks |
| `src/telegram.ts` | Native `fetch` and `FormData` `HttpTelegramClient` implementation of `TelegramClient` |
| `src/state.ts` | Atomic JSON persistence and EOF cursor computation on bind and folder sync |
| `src/config.ts` | `.env` loader, `$HOME` / `~` expansion, folder config loading, and startup auth validation |
| `docs/ARCHITECTURE.md` | Concise module breakdown, cursor safety invariants, and Session Folder routing design |

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

### Session Folders, Desktop Threads, and Incremental Transcript Tailing

```ts
import {
  chunkTelegramText,
  listConversations,
  listSessionFolders,
  loadConfig,
  readTranscriptDelta,
  resolveConversationByPrefix,
  resolveSessionFolder,
} from "./src/index.ts";

const cfg = loadConfig(process.env, false);

// Discover Session Folders and resolve "my-working-daily"
const folders = listSessionFolders(cfg.agyDataDir, {
  projectsDir: cfg.agyProjectsDir,
});
const dailyFolder = resolveSessionFolder(cfg.agyDataDir, "my-working-daily", {
  projectsDir: cfg.agyProjectsDir,
});

// Read-only SQLite query scoped to non-archived threads inside that folder
const threads = listConversations(cfg.agyDataDir, {
  limit: 8,
  folderId: dailyFolder?.id,
  projectsDir: cfg.agyProjectsDir,
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
        console.log(`[folder=${folders.length} step=${event.stepIndex}]`, chunk);
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
| Bot answers `/threads` or `/folders` in a private group, but ignores normal messages | Telegram Group Privacy mode blocks non-command text for non-admin bots | Promote the bot to **Admin** or run `/setprivacy` -> `Disable` in `@BotFather` |
| `/folder` says `Session Folder "..." not found` | Folder JSON is outside `$HOME/.gemini/config/projects` or name was misspelled | Run `bun run folders` locally or `/folders` in Telegram to copy the exact name or UUID prefix |
| `agentapi send-message` exits non-zero or times out after `15000ms` | Antigravity Desktop app or background language server is stopped or updating | Launch Antigravity Desktop on the Mac, wait a few seconds, and check `[PASS] agentapi IPC ping` via `bun run doctor` |
| `/bind ab` says `Prefix "ab" matched N threads` | Short prefix collided across multiple recent UUIDs | Pass 6 to 8 hex characters (copied from `/threads`) or tap the inline button instead |
| Composer appends `translate fallback:` warnings | Mac has no internet access or Google Translate timed out (`2500ms`) | Local `offline-fallback` still normalized Vietlish and preserved tokens safely; check Wi-Fi or run `/en` to inspect |
| `/shot` says `Image not found or unsupported format` | Relative path missed working directory or extension is not `.png`/`.jpg`/`.jpeg`/`.webp` | Pass the full `/Volumes/Dev/.../image.png` path produced on the Mac |

## Verification

| Verified Scenario and Invariants | Command | Observed Result |
| :--- | :--- | :--- |
| **Public barrel and README code snippet parity**: Confirms `src/index.ts` exports all folder, composer, SQLite, IPC, and daemon symbols and the `composeEnglishPrompt` example preserves `ENG-2716`, `ai-video-maker`, and `@ducnmm` cleanly. | `bun test tests/index.test.ts` | `2` passed, `0` failed |
| **Composer masking, zero-dash scrubbing, and offline fallback**: Verifies all `9` protected token patterns, Unicode word boundaries for Vietnamese diacritics, anti-slop swaps, and semantic parity checks. | `bun test tests/composer.test.ts` | `5` passed, `0` failed |
| **Session Folder discovery, annotation filtering, SQLite FTS5, and transcript delta cursoring**: Tests `projects/*.json` parsing, `archived:true` filtering, sidebar title overrides, `ANTIGRAVITY_PROJECT_ID` propagation, trailing newline buffering, and `SYSTEM_SDK` suppression. | `bun test tests/antigravity.test.ts` | `4` passed, `0` failed |
| **End-to-end daemon round-trip, Session Folder watch/switch flow, and strict TypeScript check**: Verifies unauthorized user rejection, `AGY_DEFAULT_FOLDER` auto-sync, sibling automation notifications with 1-tap `bind:` switching, `ANTIGRAVITY_PROJECT_ID` routing on `/new`, `/folder off`, and `ask_question` callbacks. | `bun test && bun run typecheck` | `13` passed, `0` failed (`138` assertions across `4` files); `0` TS errors |
| **Live macOS host IPC, Session Folder, and SQLite read check**: Executed directly against the running macOS Antigravity Desktop database, `$HOME/.gemini/config/projects`, and `agentapi` daemon. | `bun run doctor && bun run folders && bun run threads -- --folder my-working-daily --limit 8` | `27` folders loaded (`8.1ms`); `8` active threads in `my-working-daily` (`2.5ms`); `agentapi` IPC ping in `200.9ms` |

## Limitations

1. Live Telegram polling (`getUpdates`) and photo uploads (`sendPhoto`) require a real token from `@BotFather` in `.env`. Automated tests verify daemon routing against a mock `TelegramClient`.
2. Replies appear in Telegram once each `DONE` step finishes in `transcript.jsonl` (usually within one second) instead of streaming partial tokens while the model is still typing.

## License

MIT

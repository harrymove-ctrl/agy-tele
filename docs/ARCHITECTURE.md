# Architecture and Data Flow

`agy-tele` connects Telegram chats (DMs, private groups, or optional Forum Topics) directly to local Antigravity Desktop state and Session Folders without opening inbound network ports or scraping Electron UI windows.

## 1. Module Responsibilities

| Module | Entry Point | Responsibility |
| :--- | :--- | :--- |
| **CLI and LaunchAgent** | `src/cli.ts` | Runs `start`, `doctor`, `folders`, `threads`, `compose`, `install-launchd`, and `uninstall-launchd` using dynamic `os.homedir()` resolution. |
| **Configuration** | `src/config.ts` | Validates `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, poll interval (`AGY_POLL_MS`), `AGY_PROJECTS_DIR`, `AGY_DEFAULT_FOLDER`, default workspace, and `$HOME` path expansion. |
| **Desktop IPC and Logs** | `src/antigravity.ts` | Reads Session Folders (`projects/*.json`), sidebar annotations (`annotations/*.pbtxt`), and `conversation_summaries.db` in read-only mode; spawns `agentapi` with `ANTIGRAVITY_PROJECT_ID` when synced to a folder; tails `transcript.jsonl` deltas and recovers truncated replies from `transcript_full.jsonl`. |
| **Prompt Composer** | `src/composer.ts` | Masks protected code spans, links, paths, tickets, mentions, and multi-hyphen slugs; runs Chinese round-trip translation or offline fallback; enforces zero-dash anti-slop rules; verifies semantic parity. |
| **State Store** | `src/state.ts` | Atomically saves chat/folder bindings (`folderId`, `folderName`, `watchFolder`, `folderSyncedAt`), `telegramOffset`, and transcript cursors (`tmp` + `rename`) and computes initial EOF cursors on `/bind` and `/folder`. |
| **Telegram Transport** | `src/telegram.ts` | Calls Telegram Bot API (`getUpdates`, `sendMessage`, `sendPhoto`, `answerCallbackQuery`, `createForumTopic`, `setMyCommands`) with plain-text fallback on Markdown parse errors. |
| **Sync Daemon** | `src/daemon.ts` | Authorizes senders, auto-syncs `AGY_DEFAULT_FOLDER`, routes slash commands (`/folders`, `/folder`, `/threads`, `/bind`, `/new`, etc.) and button callbacks, fans out transcript updates from both the active thread and watched sibling folder threads via `fs.watch` plus polling, and renders `ask_question` choices as inline Telegram buttons. |
| **Public SDK Barrel** | `src/index.ts` | Re-exports typed configuration, composer, folder/SQLite/IPC helpers, cursor state, Telegram client, and `AgyTeleDaemon` for programmatic scripts. |

## 2. Transcript Cursor and Loop Prevention

1. When a user binds an existing conversation via `/bind` or syncs a Session Folder via `/folder`, `initCursorAtEof` records the current byte length of `transcript.jsonl` and the last finalized `step_index` so stale history does not flood Telegram. Users can inspect earlier turns anytime with `/tail [count]`.
2. Each poll tick reads only bytes `[byteOffset, size)` up to the last newline byte (`0x0a`). Incomplete trailing lines leave `byteOffset` unchanged until Antigravity finishes flushing the line.
3. If `size < byteOffset`, the reader resets `byteOffset` to `0` and `lastStepIndex` to `-1` to handle rotated or truncated logs safely.
4. Steps containing `source: "MODEL"` and `"content"` in `truncated_fields` trigger a targeted reverse scan of `transcript_full.jsonl` in the same logs directory so long responses reach Telegram intact and split cleanly into messages of `<= 3900` characters.

## 3. Session Folder Sync and `ANTIGRAVITY_PROJECT_ID`

1. Antigravity Desktop stores sidebar Session Folders under `$HOME/.gemini/config/projects/<uuid>.json`, each holding folder `id`, display `name`, and `projectResources.resources`. Every row in `conversation_summaries` records its parent folder UUID in `project_id`.
2. Sidebar visibility and renames live in `$HOME/.gemini/antigravity/annotations/<conversationId>.pbtxt` (`archived:true`, `pinned:true`, `title:"..."`). Filtering `archived:true` keeps Telegram `/folders` and `/threads` lists aligned with the Desktop sidebar.
3. Passing `ANTIGRAVITY_PROJECT_ID=<folderId>` in the environment of `agentapi new-conversation` or `agentapi send-message` routes new Telegram threads directly into that Session Folder (for example `my-working-daily`) inside Antigravity Desktop.
4. When `watchFolder` is enabled on a chat binding, `syncTranscriptsOnce` monitors every non-archived sibling thread inside that `project_id`, initializing cursors at step `0` for newly spawned automations so new runs push live updates to Telegram with a one-tap `Reply: <Title>` button.

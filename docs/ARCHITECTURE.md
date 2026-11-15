# Architecture and Data Flow

`agy-tele` links Telegram chats (direct messages, private groups, or optional Forum Topics) straight to local Antigravity Desktop files and Session Folders without opening network ports or scraping UI windows.

## 1. Module Responsibilities

| Module | Entry Point | Responsibility |
| :--- | :--- | :--- |
| **CLI and LaunchAgent** | `src/cli.ts` | Runs `start`, `doctor`, `folders`, `threads`, `compose`, `install-launchd`, and `uninstall-launchd` using dynamic `os.homedir()` resolution. |
| **Configuration** | `src/config.ts` | Checks `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, poll interval (`AGY_POLL_MS`), `AGY_PROJECTS_DIR`, `AGY_DEFAULT_FOLDER`, default workspace, and `$HOME` path expansion. |
| **Desktop IPC and Logs** | `src/antigravity.ts` | Reads Session Folders (`projects/*.json`), sidebar annotations (`annotations/*.pbtxt`), and `conversation_summaries.db` in read-only mode; runs `agentapi` with `ANTIGRAVITY_PROJECT_ID` when synced; reads new `transcript.jsonl` lines and recovers long replies from `transcript_full.jsonl`. |
| **Prompt Composer** | `src/composer.ts` | Hides protected code spans, links, paths, tickets, mentions, and hyphenated slugs; runs Chinese round-trip translation or offline rules; strips banned dashes and AI slop words; checks parity before sending. |
| **State Store** | `src/state.ts` | Safely saves chat and folder bindings (`folderId`, `folderName`, `watchFolder`, `folderSyncedAt`), `telegramOffset`, and log cursors (`tmp` + `rename`) and sets starting EOF cursors on `/bind` and `/folder`. |
| **Telegram Transport** | `src/telegram.ts` | Calls Telegram Bot API (`getUpdates`, `sendMessage`, `sendPhoto`, `answerCallbackQuery`, `createForumTopic`, `setMyCommands`) with a plain-text retry on Markdown errors. |
| **Sync Daemon** | `src/daemon.ts` | Checks allowed users, auto-syncs `AGY_DEFAULT_FOLDER`, handles slash commands (`/folders`, `/folder`, `/threads`, `/bind`, `/new`, etc.) and button clicks, watches both active and sibling folder threads with `fs.watch` plus polling, and sends `ask_question` choices as Telegram buttons. |
| **Public SDK Barrel** | `src/index.ts` | Re-exports typed configuration, composer, folder/SQLite/IPC helpers, cursor state, Telegram client, and `AgyTeleDaemon` for scripts. |

## 2. Transcript Cursor and Loop Prevention

1. When you bind an active thread with `/bind` or sync a Session Folder with `/folder`, `initCursorAtEof` records the current byte size of `transcript.jsonl` and the last completed `step_index` so old history does not spam Telegram. Run `/tail [count]` anytime to read earlier turns.
2. Each check reads only new bytes `[byteOffset, size)` ending at a newline (`0x0a`). If a line is still half-written, `byteOffset` stays put until Antigravity finishes writing it.
3. If `size < byteOffset`, the reader resets `byteOffset` to `0` and `lastStepIndex` to `-1` so log rotations never get stuck.
4. When a `MODEL` step has `"content"` inside `truncated_fields`, `loadFullStep` scans `transcript_full.jsonl` from the bottom to recover the complete reply and splits it into `<= 3900` character Telegram messages.

## 3. Session Folder Sync and `ANTIGRAVITY_PROJECT_ID`

1. Antigravity Desktop stores sidebar Session Folders in `$HOME/.gemini/config/projects/<uuid>.json`, with each file holding folder `id`, `name`, and `projectResources.resources`. Each row in `conversation_summaries` keeps its parent folder UUID in `project_id`.
2. Sidebar hide and rename settings live in `$HOME/.gemini/antigravity/annotations/<conversationId>.pbtxt` (`archived:true`, `pinned:true`, `title:"..."`). Skipping `archived:true` keeps Telegram `/folders` and `/threads` clean and in sync with the Desktop sidebar.
3. Setting `ANTIGRAVITY_PROJECT_ID=<folderId>` in the environment of `agentapi new-conversation` or `agentapi send-message` creates and updates threads straight inside that Session Folder (such as `my-working-daily`) on Desktop.
4. When `watchFolder` is active on a chat binding, `syncTranscriptsOnce` watches every active thread inside that `project_id`. Newly started automation runs get a cursor starting at step `0` so new updates stream to Telegram with a one-tap `Reply: <Title>` button.

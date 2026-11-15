# Architecture and Data Flow

`agy-tele` connects Telegram chats and Forum Topics directly to local Antigravity Desktop state without opening inbound network ports or scraping Electron UI windows.

## 1. Module Responsibilities

| Module | Entry Point | Responsibility |
| :--- | :--- | :--- |
| **CLI and LaunchAgent** | `src/cli.ts` | Runs `start`, `doctor`, `threads`, `compose`, `install-launchd`, and `uninstall-launchd` using dynamic `os.homedir()` resolution. |
| **Configuration** | `src/config.ts` | Validates `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, poll interval (`AGY_POLL_MS`), default workspace, and `$HOME` path expansion. |
| **Desktop IPC and Logs** | `src/antigravity.ts` | Queries `conversation_summaries.db` read-only, spawns `agentapi` (`new-conversation`, `send-message`, `get-conversation-metadata`), reads byte-offset deltas from `transcript.jsonl`, and recovers truncated responses from `transcript_full.jsonl`. |
| **Prompt Composer** | `src/composer.ts` | Masks protected code spans, links, paths, tickets, mentions, and multi-hyphen slugs; runs Chinese round-trip translation or offline fallback; enforces zero-dash anti-slop rules; verifies semantic parity. |
| **State Store** | `src/state.ts` | Atomically saves chat bindings, `telegramOffset`, and transcript cursors (`tmp` + `rename`) and computes initial EOF cursors on `/bind`. |
| **Telegram Transport** | `src/telegram.ts` | Calls Telegram Bot API (`getUpdates`, `sendMessage`, `sendPhoto`, `answerCallbackQuery`, `createForumTopic`, `setMyCommands`) with plain-text fallback on Markdown parse errors. |
| **Sync Daemon** | `src/daemon.ts` | Authorizes senders, routes slash commands and button callbacks, fans out transcript updates via `fs.watch` plus polling, and renders `ask_question` choices as inline Telegram buttons. |
| **Public SDK Barrel** | `src/index.ts` | Re-exports typed configuration, composer, SQLite/IPC helpers, cursor state, Telegram client, and `AgyTeleDaemon` for programmatic scripts. |

## 2. Transcript Cursor and Loop Prevention

1. When a user binds an existing conversation via `/bind` or an inline button, `initCursorAtEof` records the current byte length of `transcript.jsonl` and the last finalized `step_index` so stale history does not flood Telegram. Users can inspect earlier turns anytime with `/tail [count]`.
2. Each poll tick reads only bytes `[byteOffset, size)` up to the last newline byte (`0x0a`). Incomplete trailing lines leave `byteOffset` unchanged until Antigravity finishes flushing the line.
3. If `size < byteOffset`, the reader resets `byteOffset` to `0` and `lastStepIndex` to `-1` to handle rotated or truncated logs safely.
4. Steps containing `source: "MODEL"` and `"content"` in `truncated_fields` trigger a targeted reverse scan of `transcript_full.jsonl` in the same logs directory so long responses reach Telegram intact and split cleanly into messages of `<= 3900` characters.

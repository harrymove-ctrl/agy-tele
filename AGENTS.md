# agy-tele Repository Rules

Read `README.md` and `docs/ARCHITECTURE.md` before editing source files or documentation.

## 1. Runtime and Security Invariants

1. Open `conversation_summaries.db` strictly with `{ readonly: true }` in `bun:sqlite` and close the handle inside a `finally` block so Antigravity Desktop WAL writes never block.
2. Never echo `source === "SYSTEM_SDK"` transcript rows back to Telegram because `agentapi send-message` records injected prompts as `SYSTEM_SDK`. Mirror only `source === "USER_EXPLICIT"` and `source === "MODEL"` (`PLANNER_RESPONSE`) rows.
3. Keep `TELEGRAM_ALLOWED_USER_IDS` fail-closed on startup (`requireBotAuth = true` in `loadConfig`) and reject unauthorized message or callback senders before running commands or touching disk state.
4. Keep `.env` and `.state/` gitignored and never embed machine-specific home paths, bot tokens, or personal user IDs in committed files or `launchd` templates.

## 2. Writing and Git Identity Gate

1. Write 100% plain English across all documentation, commit messages, and comments. Never use em-dashes, en-dashes, spaced hyphens, horizontal rules, or unordered dash bullets.
2. Validate documentation updates with `node ~/.agents/skills/human-composer-writing/scripts/audit-human-writing.mjs` and `node ~/.agents/skills/docs-first-authoring/scripts/audit-prose-and-pr.mjs`.
3. Enforce `harrymove-ctrl` (`harry.phan@commandoss.com`) before every commit and push.

import fs from "node:fs";
import path from "node:path";
import {
  chunkTelegramText,
  getConversationMetadata,
  listConversations,
  readRecentTranscriptEvents,
  readTranscriptDelta,
  resolveConversationByPrefix,
  sendMessageToDesktop,
  startDesktopConversation,
  type ConversationSummary,
  type TranscriptDeltaResult,
  type TranscriptEvent,
} from "./antigravity.ts";
import {
  composeEnglishPrompt,
  type ComposeMode,
  type ComposeOptions,
  type ComposeResult,
} from "./composer.ts";
import type { AppConfig } from "./config.ts";
import {
  initCursorAtEof,
  loadState,
  makeChatKey,
  saveState,
  type PersistedState,
  type ThreadBinding,
  type TranscriptCursor,
} from "./state.ts";
import type {
  BotCommandSpec,
  InlineKeyboardButton,
  TelegramCallbackQuery,
  TelegramClient,
  TelegramMessage,
  TelegramUpdate,
} from "./telegram.ts";

export interface DesktopBridge {
  listConversations(
    dataDir: string,
    options?: { limit?: number; query?: string }
  ): ConversationSummary[];
  resolveConversationByPrefix(
    dataDir: string,
    idOrPrefix: string
  ): ConversationSummary | null;
  getConversationMetadata(
    agentApiBin: string,
    conversationId: string
  ): Promise<Record<string, unknown>>;
  sendMessageToDesktop(
    agentApiBin: string,
    conversationId: string,
    content: string,
    title?: string
  ): Promise<void>;
  startDesktopConversation(
    agentApiBin: string,
    options: {
      prompt: string;
      title?: string;
      model?: string | null;
      cwd?: string;
    }
  ): Promise<string>;
  readTranscriptDelta(
    brainDir: string,
    conversationId: string,
    cursor: TranscriptCursor
  ): Promise<TranscriptDeltaResult>;
  readRecentTranscriptEvents(
    brainDir: string,
    conversationId: string,
    limit?: number
  ): Promise<TranscriptEvent[]>;
  initCursorAtEof(brainDir: string, conversationId: string): TranscriptCursor;
  composeEnglishPrompt(
    raw: string,
    options?: ComposeOptions
  ): Promise<ComposeResult>;
}

const DEFAULT_BRIDGE: DesktopBridge = {
  listConversations,
  resolveConversationByPrefix,
  getConversationMetadata,
  sendMessageToDesktop,
  startDesktopConversation,
  readTranscriptDelta,
  readRecentTranscriptEvents,
  initCursorAtEof,
  composeEnglishPrompt,
};

export const BOT_COMMANDS: BotCommandSpec[] = [
  { command: "threads", description: "List or search Desktop conversations" },
  { command: "bind", description: "Bind chat or topic to conversation ID" },
  { command: "new", description: "Start a new Antigravity conversation" },
  { command: "en", description: "Preview English prompt without sending" },
  { command: "raw", description: "Send raw prompt bypassing EN composer" },
  { command: "mode", description: "Set composer mode: auto, always, off" },
  { command: "tail", description: "Show recent Desktop conversation turns" },
  { command: "shot", description: "Send a local screenshot file to Telegram" },
  { command: "status", description: "Show bound Desktop thread and daemon state" },
];

const ALLOWED_SHOT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function parseCommand(raw: string): { command: string; arg: string } | null {
  const match = raw.trim().match(/^\/([a-zA-Z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    command: match[1].toLowerCase(),
    arg: (match[2] ?? "").trim(),
  };
}

function formatThreadLine(item: ConversationSummary, idx: number): string {
  const shortId = item.conversationId.slice(0, 8);
  const stateLabel = item.status.includes("RUNNING") ? "running" : "idle";
  return `${idx + 1}. [${shortId}] ${item.title} (${item.primaryWorkspace}, ${stateLabel}, ${item.stepCount} steps)`;
}

function formatTranscriptEvent(event: TranscriptEvent): string {
  if (event.kind === "desktop_user") {
    return `[Desktop] ${event.text}`;
  }
  const sections: string[] = [];
  if (event.text) {
    sections.push(event.text);
  }
  for (const q of event.questions) {
    const opts = q.options.length > 0 ? `\nOptions: ${q.options.join(" | ")}` : "";
    sections.push(`[Question] ${q.question}${opts}`);
  }
  return sections.join("\n\n").trim();
}

/**
 * Coordinates two-way updates between Telegram chats/topics and Antigravity Desktop.
 */
export class AgyTeleDaemon {
  private readonly config: AppConfig;
  private readonly telegram: TelegramClient;
  private readonly bridge: DesktopBridge;
  private state: PersistedState;
  private running = false;
  private readonly questionOptions = new Map<string, string>();
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private wakeupResolver: (() => void) | null = null;

  constructor(
    config: AppConfig,
    telegram: TelegramClient,
    bridge: DesktopBridge = DEFAULT_BRIDGE
  ) {
    this.config = config;
    this.telegram = telegram;
    this.bridge = bridge;
    this.state = loadState(config.statePath);
  }

  getState(): PersistedState {
    return this.state;
  }

  private persist(): void {
    saveState(this.config.statePath, this.state);
  }

  private isAuthorized(userId: number | undefined): boolean {
    if (!userId) return false;
    return this.config.allowedUserIds.includes(userId);
  }

  private rememberQuestionOption(key: string, value: string): void {
    this.questionOptions.set(key, value);
    if (this.questionOptions.size > 120) {
      const oldest = this.questionOptions.keys().next().value;
      if (oldest) this.questionOptions.delete(oldest);
    }
  }

  private bindChat(
    chatId: number,
    messageThreadId: number | undefined,
    conversation: {
      conversationId: string;
      title: string;
      workspace: string;
    },
    skipExisting = true
  ): ThreadBinding {
    const key = makeChatKey(chatId, messageThreadId);
    const existing = this.state.bindings[key];
    const binding: ThreadBinding = {
      chatKey: key,
      chatId,
      messageThreadId,
      conversationId: conversation.conversationId,
      title: conversation.title,
      workspace: conversation.workspace,
      flowGenEn: existing?.flowGenEn ?? this.config.flowGenEn,
      updatedAt: new Date().toISOString(),
    };
    this.state.bindings[key] = binding;

    if (!this.state.cursors[conversation.conversationId]) {
      this.state.cursors[conversation.conversationId] = skipExisting
        ? this.bridge.initCursorAtEof(
            this.config.agyBrainDir,
            conversation.conversationId
          )
        : { byteOffset: 0, lastStepIndex: -1 };
    }

    this.persist();
    this.refreshLogWatchers();
    return binding;
  }

  private refreshLogWatchers(): void {
    const activeIds = new Set(
      Object.values(this.state.bindings).map((b) => b.conversationId)
    );

    for (const [cid, watcher] of this.watchers.entries()) {
      if (!activeIds.has(cid)) {
        watcher.close();
        this.watchers.delete(cid);
      }
    }

    for (const cid of activeIds) {
      if (this.watchers.has(cid)) continue;
      const logsDir = path.join(
        this.config.agyBrainDir,
        cid,
        ".system_generated",
        "logs"
      );
      if (!fs.existsSync(logsDir)) continue;
      try {
        const watcher = fs.watch(logsDir, () => {
          this.wakeTranscriptLoop();
        });
        this.watchers.set(cid, watcher);
      } catch {
        // Polling remains active as the authoritative fallback.
      }
    }
  }

  private wakeTranscriptLoop(): void {
    if (this.wakeupResolver) {
      const resolve = this.wakeupResolver;
      this.wakeupResolver = null;
      resolve();
    }
  }

  private waitPollInterval(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.wakeupResolver === done) {
          this.wakeupResolver = null;
        }
        resolve();
      }, this.config.pollMs);

      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.wakeupResolver = done;
    });
  }

  private async sendChunked(
    chatId: number,
    text: string,
    messageThreadId?: number
  ): Promise<void> {
    const chunks = chunkTelegramText(text);
    for (const chunk of chunks) {
      await this.telegram.sendMessage({
        chatId,
        text: chunk,
        messageThreadId,
      });
    }
  }

  /**
   * Process one Telegram update (message or inline button click).
   */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.update_id >= this.state.telegramOffset) {
      this.state.telegramOffset = update.update_id + 1;
      this.persist();
    }

    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

    if (update.message) {
      await this.handleMessage(update.message);
    }
  }

  private async handleCallbackQuery(
    query: TelegramCallbackQuery
  ): Promise<void> {
    if (!this.isAuthorized(query.from.id)) {
      await this.telegram.answerCallbackQuery(query.id, "Unauthorized user");
      return;
    }

    const msg = query.message;
    const data = query.data ?? "";
    if (!msg) {
      await this.telegram.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith("bind:")) {
      const cid = data.slice("bind:".length);
      const summary = this.bridge.resolveConversationByPrefix(
        this.config.agyDataDir,
        cid
      );
      if (!summary) {
        await this.telegram.answerCallbackQuery(query.id, "Thread not found");
        return;
      }
      const binding = this.bindChat(
        msg.chat.id,
        msg.message_thread_id,
        {
          conversationId: summary.conversationId,
          title: summary.title,
          workspace: summary.workspaces[0] ?? this.config.defaultWorkspace,
        },
        true
      );
      await this.telegram.answerCallbackQuery(query.id, `Bound ${summary.title}`);
      await this.telegram.sendMessage({
        chatId: msg.chat.id,
        messageThreadId: msg.message_thread_id,
        text: `Bound to [${binding.conversationId.slice(0, 8)}] ${binding.title} (${path.basename(binding.workspace)}). Send a message or run /tail.`,
      });
      return;
    }

    if (data.startsWith("q:") || data.startsWith("opt:")) {
      const answer = data.startsWith("q:")
        ? this.questionOptions.get(data)
        : data.slice("opt:".length);
      const key = makeChatKey(msg.chat.id, msg.message_thread_id);
      const binding = this.state.bindings[key];

      if (!answer || !binding) {
        await this.telegram.answerCallbackQuery(
          query.id,
          "Option expired or chat unbound"
        );
        return;
      }

      await this.bridge.sendMessageToDesktop(
        this.config.agentApiBin,
        binding.conversationId,
        answer,
        binding.title
      );
      await this.telegram.answerCallbackQuery(query.id, `Sent: ${answer}`);
      await this.telegram.sendMessage({
        chatId: msg.chat.id,
        messageThreadId: msg.message_thread_id,
        text: `[Option sent] ${answer}`,
      });
      return;
    }

    await this.telegram.answerCallbackQuery(query.id);
  }

  private async handleMessage(msg: TelegramMessage): Promise<void> {
    if (!this.isAuthorized(msg.from?.id)) {
      return;
    }

    const rawText = (msg.text ?? msg.caption ?? "").trim();
    if (!rawText) return;

    const chatId = msg.chat.id;
    const threadId = msg.message_thread_id;
    const key = makeChatKey(chatId, threadId);
    const cmd = parseCommand(rawText);

    if (cmd) {
      await this.handleCommand(chatId, threadId, key, cmd.command, cmd.arg);
      return;
    }

    await this.forwardPrompt(chatId, threadId, key, rawText, false);
  }

  private async handleCommand(
    chatId: number,
    threadId: number | undefined,
    key: string,
    command: string,
    arg: string
  ): Promise<void> {
    if (command === "start" || command === "help") {
      const binding = this.state.bindings[key];
      const statusLine = binding
        ? `Bound: [${binding.conversationId.slice(0, 8)}] ${binding.title} (mode: ${binding.flowGenEn})`
        : "Not bound yet. Send /threads to pick an active Desktop thread or /new <prompt>.";
      await this.telegram.sendMessage({
        chatId,
        messageThreadId: threadId,
        text: [
          "agy-tele two-way Antigravity Desktop sync",
          statusLine,
          "Commands: /threads [query], /bind <id>, /new [dir ::] <prompt>, /en <draft>, /raw <text>, /mode [auto|always|off], /tail [n], /shot <path>, /status",
        ].join("\n\n"),
      });
      return;
    }

    if (command === "threads") {
      const items = this.bridge.listConversations(this.config.agyDataDir, {
        limit: 8,
        query: arg,
      });
      if (items.length === 0) {
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: arg ? `No Desktop threads matched "${arg}".` : "No Desktop threads found.",
        });
        return;
      }
      const lines = items.map(formatThreadLine);
      const keyboard: InlineKeyboardButton[][] = [];
      for (let i = 0; i < items.length; i += 2) {
        const row: InlineKeyboardButton[] = [];
        for (const item of items.slice(i, i + 2)) {
          row.push({
            text: `${item.conversationId.slice(0, 6)} ${item.title.slice(0, 18)}`,
            callback_data: `bind:${item.conversationId}`,
          });
        }
        keyboard.push(row);
      }
      await this.telegram.sendMessage({
        chatId,
        messageThreadId: threadId,
        text: lines.join("\n"),
        replyMarkup: { inline_keyboard: keyboard },
      });
      return;
    }

    if (command === "bind") {
      if (!arg) {
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: "Usage: /bind <conversation-id-or-prefix>",
        });
        return;
      }
      const summary = this.bridge.resolveConversationByPrefix(
        this.config.agyDataDir,
        arg
      );
      if (!summary) {
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: `No thread found matching "${arg}".`,
        });
        return;
      }
      const binding = this.bindChat(
        chatId,
        threadId,
        {
          conversationId: summary.conversationId,
          title: summary.title,
          workspace: summary.workspaces[0] ?? this.config.defaultWorkspace,
        },
        true
      );
      await this.telegram.sendMessage({
        chatId,
        messageThreadId: threadId,
        text: `Bound to [${binding.conversationId.slice(0, 8)}] ${binding.title} (${path.basename(binding.workspace)}).`,
      });
      return;
    }

    if (command === "new") {
      if (!arg) {
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: "Usage: /new [/Volumes/Dev/repo ::] <prompt>",
        });
        return;
      }
      let workspace = this.config.defaultWorkspace;
      let rawPrompt = arg;
      const splitIdx = arg.indexOf("::");
      if (splitIdx > 0) {
        const candidateDir = arg.slice(0, splitIdx).trim();
        const rest = arg.slice(splitIdx + 2).trim();
        if (candidateDir && rest) {
          workspace = candidateDir;
          rawPrompt = rest;
        }
      }

      const mode = this.state.bindings[key]?.flowGenEn ?? this.config.flowGenEn;
      const composed = await this.bridge.composeEnglishPrompt(rawPrompt, { mode });
      if (composed.changed) {
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: `[EN] ${composed.text}`,
        });
      }

      const title = composed.text.slice(0, 56);
      const cid = await this.bridge.startDesktopConversation(
        this.config.agentApiBin,
        {
          prompt: composed.text,
          title,
          model: this.config.defaultModel,
          cwd: workspace,
        }
      );
      const binding = this.bindChat(
        chatId,
        threadId,
        { conversationId: cid, title, workspace },
        false
      );
      await this.telegram.sendMessage({
        chatId,
        messageThreadId: threadId,
        text: `Started [${binding.conversationId.slice(0, 8)}] in ${path.basename(workspace)}.`,
      });
      return;
    }

    if (command === "en") {
      if (!arg) {
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: "Usage: /en <Vietnamese or rough English draft>",
        });
        return;
      }
      const composed = await this.bridge.composeEnglishPrompt(arg, {
        mode: "always",
      });
      const warnSuffix =
        composed.warnings.length > 0
          ? `\nWarnings: ${composed.warnings.join("; ")}`
          : "";
      await this.telegram.sendMessage({
        chatId,
        messageThreadId: threadId,
        text: `[EN ${composed.modeUsed}] ${composed.text}${warnSuffix}`,
      });
      return;
    }

    if (command === "raw") {
      if (!arg) {
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: "Usage: /raw <exact text sent without Flow-Gen-EN>",
        });
        return;
      }
      await this.forwardPrompt(chatId, threadId, key, arg, true);
      return;
    }

    if (command === "mode") {
      const binding = this.state.bindings[key];
      if (!arg) {
        const current = binding?.flowGenEn ?? this.config.flowGenEn;
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: `Flow-Gen-EN mode: ${current} (options: auto, always, off).`,
        });
        return;
      }
      if (arg !== "auto" && arg !== "always" && arg !== "off") {
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: "Invalid mode. Choose auto, always, or off.",
        });
        return;
      }
      if (!binding) {
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: "Bind a thread first via /bind or /new before saving per-thread mode.",
        });
        return;
      }
      binding.flowGenEn = arg as ComposeMode;
      binding.updatedAt = new Date().toISOString();
      this.persist();
      await this.telegram.sendMessage({
        chatId,
        messageThreadId: threadId,
        text: `Updated Flow-Gen-EN mode to ${arg} for ${binding.title}.`,
      });
      return;
    }

    if (command === "tail") {
      const binding = this.state.bindings[key];
      if (!binding) {
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: "This chat is not bound yet. Run /threads or /bind first.",
        });
        return;
      }
      const count = Math.max(
        1,
        Math.min(12, Number.parseInt(arg || "4", 10) || 4)
      );
      const events = await this.bridge.readRecentTranscriptEvents(
        this.config.agyBrainDir,
        binding.conversationId,
        count
      );
      if (events.length === 0) {
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: "No finalized transcript turns recorded yet.",
        });
        return;
      }
      const rendered = events
        .map(formatTranscriptEvent)
        .filter(Boolean)
        .join("\n\n");
      await this.sendChunked(chatId, rendered, threadId);
      return;
    }

    if (command === "shot") {
      if (!arg) {
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: "Usage: /shot </path/to/screenshot.png>",
        });
        return;
      }
      const resolved = path.resolve(arg);
      const ext = path.extname(resolved).toLowerCase();
      if (!ALLOWED_SHOT_EXTENSIONS.has(ext) || !fs.existsSync(resolved)) {
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: `Image not found or unsupported format: ${resolved}`,
        });
        return;
      }
      await this.telegram.sendPhoto({
        chatId,
        filePath: resolved,
        caption: path.basename(resolved),
        messageThreadId: threadId,
      });
      return;
    }

    if (command === "status") {
      const binding = this.state.bindings[key];
      if (!binding) {
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: `Unbound chat. Default workspace: ${this.config.defaultWorkspace}, Flow-Gen-EN: ${this.config.flowGenEn}.`,
        });
        return;
      }
      const cursor = this.state.cursors[binding.conversationId];
      let liveStatus = "unreachable";
      try {
        await this.bridge.getConversationMetadata(
          this.config.agentApiBin,
          binding.conversationId
        );
        liveStatus = "connected";
      } catch (err) {
        liveStatus = err instanceof Error ? err.message : String(err);
      }
      await this.telegram.sendMessage({
        chatId,
        messageThreadId: threadId,
        text: [
          `Thread: ${binding.title} [${binding.conversationId}]`,
          `Workspace: ${binding.workspace}`,
          `Flow-Gen-EN: ${binding.flowGenEn}`,
          `Cursor: step ${cursor?.lastStepIndex ?? -1} (${cursor?.byteOffset ?? 0} bytes)`,
          `agentapi: ${liveStatus}`,
        ].join("\n"),
      });
      return;
    }

    await this.telegram.sendMessage({
      chatId,
      messageThreadId: threadId,
      text: `Unknown command /${command}. Send /help for available commands.`,
    });
  }

  private async forwardPrompt(
    chatId: number,
    threadId: number | undefined,
    key: string,
    rawText: string,
    bypassComposer: boolean
  ): Promise<void> {
    const existing = this.state.bindings[key];
    const mode: ComposeMode = bypassComposer
      ? "off"
      : existing?.flowGenEn ?? this.config.flowGenEn;

    const composed = await this.bridge.composeEnglishPrompt(rawText, { mode });
    if (composed.changed) {
      await this.telegram.sendMessage({
        chatId,
        messageThreadId: threadId,
        text: `[EN] ${composed.text}`,
      });
    }

    if (existing) {
      await this.bridge.sendMessageToDesktop(
        this.config.agentApiBin,
        existing.conversationId,
        composed.text,
        existing.title
      );
      this.wakeTranscriptLoop();
      return;
    }

    const title = composed.text.slice(0, 56);
    const cid = await this.bridge.startDesktopConversation(
      this.config.agentApiBin,
      {
        prompt: composed.text,
        title,
        model: this.config.defaultModel,
        cwd: this.config.defaultWorkspace,
      }
    );
    const binding = this.bindChat(
      chatId,
      threadId,
      {
        conversationId: cid,
        title,
        workspace: this.config.defaultWorkspace,
      },
      false
    );
    await this.telegram.sendMessage({
      chatId,
      messageThreadId: threadId,
      text: `Started [${binding.conversationId.slice(0, 8)}] in ${path.basename(binding.workspace)}.`,
    });
  }

  /**
   * Poll all bound Desktop transcripts once and push new turns to Telegram.
   */
  async syncTranscriptsOnce(): Promise<number> {
    const bindingsByCid = new Map<string, ThreadBinding[]>();
    for (const binding of Object.values(this.state.bindings)) {
      const list = bindingsByCid.get(binding.conversationId) ?? [];
      list.push(binding);
      bindingsByCid.set(binding.conversationId, list);
    }

    let delivered = 0;

    for (const [cid, bindings] of bindingsByCid.entries()) {
      const currentCursor = this.state.cursors[cid] ?? {
        byteOffset: 0,
        lastStepIndex: -1,
      };
      const delta = await this.bridge.readTranscriptDelta(
        this.config.agyBrainDir,
        cid,
        currentCursor
      );

      const cursorChanged =
        delta.cursor.byteOffset !== currentCursor.byteOffset ||
        delta.cursor.lastStepIndex !== currentCursor.lastStepIndex;

      if (cursorChanged) {
        this.state.cursors[cid] = delta.cursor;
        this.persist();
      }

      for (const event of delta.events) {
        const rendered = formatTranscriptEvent(event);
        for (const binding of bindings) {
          if (rendered) {
            await this.sendChunked(
              binding.chatId,
              rendered,
              binding.messageThreadId
            );
          }

          if (event.kind === "assistant_reply") {
            for (const q of event.questions) {
              if (q.options.length === 0) continue;
              const buttons: InlineKeyboardButton[][] = q.options.map(
                (opt, idx) => {
                  const optKey = `q:${event.stepIndex}:${idx}`;
                  this.rememberQuestionOption(optKey, opt);
                  return [{ text: opt.slice(0, 48), callback_data: optKey }];
                }
              );
              await this.telegram.sendMessage({
                chatId: binding.chatId,
                messageThreadId: binding.messageThreadId,
                text: `Reply with an option for: ${q.question}`,
                replyMarkup: { inline_keyboard: buttons },
              });
            }

            for (const imgPath of event.imagePaths) {
              await this.telegram.sendPhoto({
                chatId: binding.chatId,
                filePath: imgPath,
                caption: path.basename(imgPath),
                messageThreadId: binding.messageThreadId,
              });
            }
          }

          delivered += 1;
        }
      }
    }

    return delivered;
  }

  /**
   * Start concurrent Telegram long-polling and transcript sync loops until stop() is called.
   */
  async start(): Promise<void> {
    this.running = true;
    this.refreshLogWatchers();

    try {
      await this.telegram.setMyCommands(BOT_COMMANDS);
    } catch (err) {
      console.error("Warning: failed to register Telegram commands:", err);
    }

    const telegramLoop = (async () => {
      while (this.running) {
        try {
          const updates = await this.telegram.getUpdates(
            this.state.telegramOffset,
            25
          );
          for (const update of updates) {
            if (!this.running) break;
            await this.handleUpdate(update);
          }
        } catch (err) {
          if (!this.running) break;
          console.error("Telegram poll error:", err);
          await Bun.sleep(1500);
        }
      }
    })();

    const transcriptLoop = (async () => {
      while (this.running) {
        try {
          await this.syncTranscriptsOnce();
        } catch (err) {
          console.error("Transcript sync error:", err);
        }
        if (!this.running) break;
        await this.waitPollInterval();
      }
    })();

    await Promise.all([telegramLoop, transcriptLoop]);
  }

  stop(): void {
    this.running = false;
    this.wakeTranscriptLoop();
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }
}

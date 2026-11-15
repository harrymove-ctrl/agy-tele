import fs from "node:fs";
import path from "node:path";
import {
  chunkTelegramText,
  getConversationMetadata,
  listConversations,
  listSessionFolders,
  readRecentTranscriptEvents,
  readTranscriptDelta,
  resolveConversationByPrefix,
  resolveSessionFolder,
  sendMessageToDesktop,
  startDesktopConversation,
  type ConversationSummary,
  type SessionFolder,
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
  listSessionFolders(
    dataDir: string,
    options?: { projectsDir?: string }
  ): SessionFolder[];
  resolveSessionFolder(
    dataDir: string,
    nameOrIdOrPrefix: string,
    options?: { projectsDir?: string }
  ): SessionFolder | null;
  listConversations(
    dataDir: string,
    options?: {
      limit?: number;
      query?: string;
      folderId?: string | null;
      projectsDir?: string;
      includeArchived?: boolean;
    }
  ): ConversationSummary[];
  resolveConversationByPrefix(
    dataDir: string,
    idOrPrefix: string,
    options?: { folderId?: string | null; projectsDir?: string }
  ): ConversationSummary | null;
  getConversationMetadata(
    agentApiBin: string,
    conversationId: string
  ): Promise<Record<string, unknown>>;
  sendMessageToDesktop(
    agentApiBin: string,
    conversationId: string,
    content: string,
    title?: string,
    projectId?: string | null
  ): Promise<void>;
  startDesktopConversation(
    agentApiBin: string,
    options: {
      prompt: string;
      title?: string;
      model?: string | null;
      cwd?: string;
      projectId?: string | null;
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
  listSessionFolders,
  resolveSessionFolder,
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
  { command: "folders", description: "List Antigravity Desktop Session Folders" },
  { command: "folder", description: "Sync Telegram chat to a Session Folder" },
  { command: "threads", description: "List or search Desktop conversations" },
  { command: "bind", description: "Bind chat or topic to conversation ID" },
  { command: "new", description: "Start a new Antigravity conversation" },
  { command: "en", description: "Preview English prompt without sending" },
  { command: "raw", description: "Send raw prompt bypassing EN composer" },
  { command: "mode", description: "Set composer mode: auto, always, off" },
  { command: "tail", description: "Show recent Desktop conversation turns" },
  { command: "shot", description: "Send a local screenshot file to Telegram" },
  { command: "status", description: "Show synced folder, thread, and daemon state" },
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

function formatFolderLine(folder: SessionFolder, idx: number): string {
  const shortId = folder.id.slice(0, 8);
  const wsLabel = folder.primaryWorkspace
    ? path.basename(folder.primaryWorkspace) || folder.primaryWorkspace
    : "workspace";
  return `${idx + 1}. ${folder.name} [${shortId}] (${folder.activeThreadCount} active, ${wsLabel})`;
}

function formatThreadLine(item: ConversationSummary, idx: number): string {
  const shortId = item.conversationId.slice(0, 8);
  const stateLabel = item.status.includes("RUNNING") ? "running" : "idle";
  const folderTag = item.folderName ? ` [${item.folderName}]` : "";
  return `${idx + 1}. [${shortId}]${folderTag} ${item.title} (${item.primaryWorkspace}, ${stateLabel}, ${item.stepCount} steps)`;
}

function parseTimestampMs(raw: string | undefined): number {
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
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
      folderId?: string | null;
      folderName?: string | null;
    },
    skipExisting = true
  ): ThreadBinding {
    const key = makeChatKey(chatId, messageThreadId);
    const existing = this.state.bindings[key];
    const resolvedFolderId =
      conversation.folderId !== undefined
        ? conversation.folderId ?? undefined
        : existing?.folderId;
    const resolvedFolderName =
      conversation.folderName !== undefined
        ? conversation.folderName ?? undefined
        : existing?.folderName;
    const keepWatchFolder = Boolean(
      existing?.watchFolder &&
        resolvedFolderId &&
        existing.folderId === resolvedFolderId
    );

    const binding: ThreadBinding = {
      chatKey: key,
      chatId,
      messageThreadId,
      conversationId: conversation.conversationId,
      title: conversation.title,
      workspace: conversation.workspace,
      folderId: resolvedFolderId,
      folderName: resolvedFolderName,
      watchFolder: keepWatchFolder || undefined,
      folderSyncedAt: keepWatchFolder ? existing?.folderSyncedAt : undefined,
      flowGenEn: existing?.flowGenEn ?? this.config.flowGenEn,
      updatedAt: new Date().toISOString(),
    };
    this.state.bindings[key] = binding;

    if (
      conversation.conversationId &&
      !this.state.cursors[conversation.conversationId]
    ) {
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

  private syncChatToFolder(
    chatId: number,
    messageThreadId: number | undefined,
    folder: SessionFolder,
    skipExisting = true
  ): { binding: ThreadBinding; threads: ConversationSummary[] } {
    const key = makeChatKey(chatId, messageThreadId);
    const existing = this.state.bindings[key];
    const threads = this.bridge.listConversations(this.config.agyDataDir, {
      limit: 25,
      folderId: folder.id,
      projectsDir: this.config.agyProjectsDir,
    });

    for (const item of threads) {
      if (!this.state.cursors[item.conversationId]) {
        this.state.cursors[item.conversationId] = skipExisting
          ? this.bridge.initCursorAtEof(
              this.config.agyBrainDir,
              item.conversationId
            )
          : { byteOffset: 0, lastStepIndex: -1 };
      }
    }

    const chosen =
      threads.find((item) => existing?.conversationId === item.conversationId) ??
      threads[0];
    const workspace =
      chosen?.workspaces[0] ??
      (folder.primaryWorkspace || existing?.workspace || this.config.defaultWorkspace);
    const folderSyncedAt =
      existing?.folderId === folder.id && existing.folderSyncedAt
        ? existing.folderSyncedAt
        : new Date().toISOString();

    const binding: ThreadBinding = {
      chatKey: key,
      chatId,
      messageThreadId,
      conversationId: chosen?.conversationId ?? "",
      title: chosen?.title ?? `Folder: ${folder.name}`,
      workspace,
      folderId: folder.id,
      folderName: folder.name,
      watchFolder: true,
      folderSyncedAt,
      flowGenEn: existing?.flowGenEn ?? this.config.flowGenEn,
      updatedAt: new Date().toISOString(),
    };
    this.state.bindings[key] = binding;
    this.persist();
    this.refreshLogWatchers();
    return { binding, threads };
  }

  private ensureDefaultFolderBinding(
    chatId: number,
    messageThreadId: number | undefined,
    key: string
  ): ThreadBinding | undefined {
    const existing = this.state.bindings[key];
    if (existing) return existing;
    if (!this.config.defaultFolder) return undefined;

    try {
      const folder = this.bridge.resolveSessionFolder(
        this.config.agyDataDir,
        this.config.defaultFolder,
        { projectsDir: this.config.agyProjectsDir }
      );
      if (!folder) return undefined;
      return this.syncChatToFolder(chatId, messageThreadId, folder, true).binding;
    } catch {
      return undefined;
    }
  }

  private collectWatchedConversationIds(): Set<string> {
    const activeIds = new Set<string>();
    const checkedFolders = new Set<string>();

    for (const binding of Object.values(this.state.bindings)) {
      if (binding.conversationId) {
        activeIds.add(binding.conversationId);
      }
      if (
        binding.watchFolder &&
        binding.folderId &&
        !checkedFolders.has(binding.folderId)
      ) {
        checkedFolders.add(binding.folderId);
        try {
          const threads = this.bridge.listConversations(this.config.agyDataDir, {
            limit: 25,
            folderId: binding.folderId,
            projectsDir: this.config.agyProjectsDir,
          });
          for (const item of threads) {
            activeIds.add(item.conversationId);
          }
        } catch {
          // Database may not exist in isolated unit tests; keep explicit bindings active.
        }
      }
    }

    return activeIds;
  }

  private refreshLogWatchers(): void {
    const activeIds = this.collectWatchedConversationIds();

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
    messageThreadId?: number,
    replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] }
  ): Promise<void> {
    const chunks = chunkTelegramText(text);
    for (let i = 0; i < chunks.length; i++) {
      await this.telegram.sendMessage({
        chatId,
        text: chunks[i],
        messageThreadId,
        replyMarkup: i === chunks.length - 1 ? replyMarkup : undefined,
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

    if (data.startsWith("folder:")) {
      const folderId = data.slice("folder:".length);
      const folder = this.bridge.resolveSessionFolder(
        this.config.agyDataDir,
        folderId,
        { projectsDir: this.config.agyProjectsDir }
      );
      if (!folder) {
        await this.telegram.answerCallbackQuery(query.id, "Folder not found");
        return;
      }
      const { binding, threads } = this.syncChatToFolder(
        msg.chat.id,
        msg.message_thread_id,
        folder,
        true
      );
      await this.telegram.answerCallbackQuery(query.id, `Synced ${folder.name}`);
      const activeLine = binding.conversationId
        ? `Active reply target: [${binding.conversationId.slice(0, 8)}] ${binding.title}`
        : "No active threads in this folder yet; send a message or /new <prompt> to start one.";
      await this.telegram.sendMessage({
        chatId: msg.chat.id,
        messageThreadId: msg.message_thread_id,
        text: `Synced folder "${folder.name}" (${threads.length} active thread(s)).\n${activeLine}`,
      });
      return;
    }

    if (data.startsWith("bind:")) {
      const cid = data.slice("bind:".length);
      const summary = this.bridge.resolveConversationByPrefix(
        this.config.agyDataDir,
        cid,
        { projectsDir: this.config.agyProjectsDir }
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
          folderId: summary.projectId,
          folderName: summary.folderName,
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

      if (!answer || !binding || !binding.conversationId) {
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
        binding.title,
        binding.folderId
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
      const binding = this.ensureDefaultFolderBinding(chatId, threadId, key);
      const statusParts: string[] = [];
      if (binding?.folderName) {
        statusParts.push(`Folder: ${binding.folderName}`);
      }
      if (binding?.conversationId) {
        statusParts.push(
          `Thread: [${binding.conversationId.slice(0, 8)}] ${binding.title} (mode: ${binding.flowGenEn})`
        );
      }
      const statusLine =
        statusParts.length > 0
          ? statusParts.join(" | ")
          : "Not synced yet. Send /folders to sync a Session Folder, /threads to pick a thread, or /new <prompt>.";
      await this.telegram.sendMessage({
        chatId,
        messageThreadId: threadId,
        text: [
          "agy-tele two-way Antigravity Desktop sync",
          statusLine,
          "Commands: /folders, /folder [name|off], /threads [all] [query], /bind <id>, /new [dir ::] <prompt>, /en <draft>, /raw <text>, /mode [auto|always|off], /tail [n], /shot <path>, /status",
        ].join("\n\n"),
      });
      return;
    }

    if (command === "folders") {
      const folders = this.bridge.listSessionFolders(this.config.agyDataDir, {
        projectsDir: this.config.agyProjectsDir,
      });
      if (folders.length === 0) {
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: `No Antigravity Session Folders found in ${this.config.agyProjectsDir}.`,
        });
        return;
      }
      const lines = folders.map(formatFolderLine);
      const keyboard: InlineKeyboardButton[][] = [];
      for (let i = 0; i < folders.length; i += 2) {
        const row: InlineKeyboardButton[] = [];
        for (const folder of folders.slice(i, i + 2)) {
          row.push({
            text: `Sync ${folder.name.slice(0, 22)}`,
            callback_data: `folder:${folder.id}`,
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

    if (command === "folder") {
      const existing = this.ensureDefaultFolderBinding(chatId, threadId, key);
      if (!arg) {
        if (existing?.folderName) {
          const activeLabel = existing.conversationId
            ? `[${existing.conversationId.slice(0, 8)}] ${existing.title}`
            : "none yet";
          await this.telegram.sendMessage({
            chatId,
            messageThreadId: threadId,
            text: [
              `Synced folder: ${existing.folderName} [${existing.folderId?.slice(0, 8) ?? ""}]`,
              `Watch all folder threads: ${existing.watchFolder ? "on" : "off"}`,
              `Active reply target: ${activeLabel}`,
              "Use /folder <name>, /folder off, or /folders.",
            ].join("\n"),
          });
        } else {
          await this.telegram.sendMessage({
            chatId,
            messageThreadId: threadId,
            text: "No Session Folder synced for this chat. Send /folders to choose one (for example: /folder my-working-daily).",
          });
        }
        return;
      }

      if (arg.toLowerCase() === "off") {
        if (!existing?.folderId) {
          await this.telegram.sendMessage({
            chatId,
            messageThreadId: threadId,
            text: "No Session Folder sync is active for this chat.",
          });
          return;
        }
        if (!existing.conversationId) {
          delete this.state.bindings[key];
          this.persist();
          this.refreshLogWatchers();
          await this.telegram.sendMessage({
            chatId,
            messageThreadId: threadId,
            text: "Stopped Session Folder sync for this chat.",
          });
          return;
        }
        existing.folderId = undefined;
        existing.folderName = undefined;
        existing.watchFolder = undefined;
        existing.folderSyncedAt = undefined;
        existing.updatedAt = new Date().toISOString();
        this.persist();
        this.refreshLogWatchers();
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: `Detached Session Folder watch while keeping [${existing.conversationId.slice(0, 8)}] ${existing.title} bound.`,
        });
        return;
      }

      const folder = this.bridge.resolveSessionFolder(
        this.config.agyDataDir,
        arg,
        { projectsDir: this.config.agyProjectsDir }
      );
      if (!folder) {
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: `Session Folder "${arg}" not found. Send /folders to list available folders.`,
        });
        return;
      }

      const { binding, threads } = this.syncChatToFolder(
        chatId,
        threadId,
        folder,
        true
      );
      const activeLine = binding.conversationId
        ? `Active reply target: [${binding.conversationId.slice(0, 8)}] ${binding.title}`
        : "No active threads in this folder yet; send a message or /new <prompt> to start one.";
      await this.telegram.sendMessage({
        chatId,
        messageThreadId: threadId,
        text: `Synced folder "${folder.name}" (${threads.length} active thread(s)).\n${activeLine}`,
      });
      return;
    }

    if (command === "threads") {
      const binding = this.ensureDefaultFolderBinding(chatId, threadId, key);
      const lowerArg = arg.toLowerCase();
      const includeAll = lowerArg === "all" || lowerArg.startsWith("all ");
      const query = includeAll ? arg.slice(3).trim() : arg;
      const folderId = includeAll ? undefined : binding?.folderId;

      const items = this.bridge.listConversations(this.config.agyDataDir, {
        limit: 8,
        query,
        folderId,
        projectsDir: this.config.agyProjectsDir,
      });
      if (items.length === 0) {
        const scopeLabel =
          !includeAll && binding?.folderName
            ? ` in folder "${binding.folderName}"`
            : "";
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: query
            ? `No Desktop threads matched "${query}"${scopeLabel}.`
            : `No Desktop threads found${scopeLabel}.`,
        });
        return;
      }
      const header =
        !includeAll && binding?.folderName
          ? `Folder: ${binding.folderName} (send "/threads all" for all folders)\n`
          : "";
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
        text: `${header}${lines.join("\n")}`,
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
      const existing = this.state.bindings[key];
      const summary = this.bridge.resolveConversationByPrefix(
        this.config.agyDataDir,
        arg,
        {
          folderId: existing?.folderId,
          projectsDir: this.config.agyProjectsDir,
        }
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
          folderId: summary.projectId,
          folderName: summary.folderName,
        },
        true
      );
      const folderSuffix = binding.folderName ? ` [${binding.folderName}]` : "";
      await this.telegram.sendMessage({
        chatId,
        messageThreadId: threadId,
        text: `Bound to [${binding.conversationId.slice(0, 8)}] ${binding.title}${folderSuffix} (${path.basename(binding.workspace)}).`,
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
      const existingBinding = this.ensureDefaultFolderBinding(chatId, threadId, key);
      let workspace = existingBinding?.workspace || this.config.defaultWorkspace;
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

      const mode = existingBinding?.flowGenEn ?? this.config.flowGenEn;
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
          projectId: existingBinding?.folderId ?? null,
        }
      );
      const binding = this.bindChat(
        chatId,
        threadId,
        {
          conversationId: cid,
          title,
          workspace,
          folderId: existingBinding?.folderId ?? null,
          folderName: existingBinding?.folderName ?? null,
        },
        false
      );
      const folderNote = binding.folderName
        ? ` inside folder "${binding.folderName}"`
        : "";
      await this.telegram.sendMessage({
        chatId,
        messageThreadId: threadId,
        text: `Started [${binding.conversationId.slice(0, 8)}]${folderNote} in ${path.basename(workspace)}.`,
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
      if (!binding || !binding.conversationId) {
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: "No active Desktop thread yet. Run /threads, /folder <name>, or /new <prompt> first.",
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
      const binding = this.ensureDefaultFolderBinding(chatId, threadId, key);
      if (!binding) {
        await this.telegram.sendMessage({
          chatId,
          messageThreadId: threadId,
          text: `Unbound chat. Default workspace: ${this.config.defaultWorkspace}, Default folder: ${this.config.defaultFolder ?? "none"}, Flow-Gen-EN: ${this.config.flowGenEn}.`,
        });
        return;
      }
      const lines: string[] = [];
      if (binding.folderName) {
        lines.push(
          `Folder: ${binding.folderName} [${binding.folderId?.slice(0, 8) ?? ""}] (watch: ${binding.watchFolder ? "on" : "off"})`
        );
      }
      if (!binding.conversationId) {
        lines.push("Thread: (none active yet in folder)");
        lines.push(`Workspace: ${binding.workspace}`);
        lines.push(`Flow-Gen-EN: ${binding.flowGenEn}`);
        lines.push("agentapi: idle (send a message or /new <prompt>)");
      } else {
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
        lines.push(`Thread: ${binding.title} [${binding.conversationId}]`);
        lines.push(`Workspace: ${binding.workspace}`);
        lines.push(`Flow-Gen-EN: ${binding.flowGenEn}`);
        lines.push(
          `Cursor: step ${cursor?.lastStepIndex ?? -1} (${cursor?.byteOffset ?? 0} bytes)`
        );
        lines.push(`agentapi: ${liveStatus}`);
      }
      await this.telegram.sendMessage({
        chatId,
        messageThreadId: threadId,
        text: lines.join("\n"),
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
    const existing =
      this.ensureDefaultFolderBinding(chatId, threadId, key) ??
      this.state.bindings[key];
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

    if (existing && existing.conversationId) {
      await this.bridge.sendMessageToDesktop(
        this.config.agentApiBin,
        existing.conversationId,
        composed.text,
        existing.title,
        existing.folderId
      );
      this.wakeTranscriptLoop();
      return;
    }

    const targetWorkspace = existing?.workspace || this.config.defaultWorkspace;
    const title = composed.text.slice(0, 56);
    const cid = await this.bridge.startDesktopConversation(
      this.config.agentApiBin,
      {
        prompt: composed.text,
        title,
        model: this.config.defaultModel,
        cwd: targetWorkspace,
        projectId: existing?.folderId ?? null,
      }
    );
    const binding = this.bindChat(
      chatId,
      threadId,
      {
        conversationId: cid,
        title,
        workspace: targetWorkspace,
        folderId: existing?.folderId ?? null,
        folderName: existing?.folderName ?? null,
      },
      false
    );
    const folderNote = binding.folderName
      ? ` inside folder "${binding.folderName}"`
      : "";
    await this.telegram.sendMessage({
      chatId,
      messageThreadId: threadId,
      text: `Started [${binding.conversationId.slice(0, 8)}]${folderNote} in ${path.basename(binding.workspace)}.`,
    });
  }

  /**
   * Poll all bound Desktop threads and watched Session Folder threads once.
   */
  async syncTranscriptsOnce(): Promise<number> {
    type DeliveryTarget = {
      binding: ThreadBinding;
      isSibling: boolean;
      threadTitle: string;
      folderName?: string;
    };

    const targetsByCid = new Map<string, DeliveryTarget[]>();
    const folderThreadsCache = new Map<string, ConversationSummary[]>();
    let discoveredNewSibling = false;

    const addTarget = (cid: string, target: DeliveryTarget) => {
      const list = targetsByCid.get(cid) ?? [];
      list.push(target);
      targetsByCid.set(cid, list);
    };

    for (const binding of Object.values(this.state.bindings)) {
      if (binding.conversationId) {
        addTarget(binding.conversationId, {
          binding,
          isSibling: false,
          threadTitle: binding.title,
          folderName: binding.folderName,
        });
      }

      if (binding.watchFolder && binding.folderId) {
        let folderThreads = folderThreadsCache.get(binding.folderId);
        if (!folderThreads) {
          try {
            folderThreads = this.bridge.listConversations(this.config.agyDataDir, {
              limit: 25,
              folderId: binding.folderId,
              projectsDir: this.config.agyProjectsDir,
            });
          } catch {
            folderThreads = [];
          }
          folderThreadsCache.set(binding.folderId, folderThreads);
        }

        const syncedMs = parseTimestampMs(binding.folderSyncedAt);
        for (const item of folderThreads) {
          if (item.conversationId === binding.conversationId) continue;

          if (!this.state.cursors[item.conversationId]) {
            const itemMs = parseTimestampMs(item.lastModifiedTime);
            const isNewSinceSync =
              !syncedMs || (itemMs > 0 && itemMs >= syncedMs - 5000);
            this.state.cursors[item.conversationId] = isNewSinceSync
              ? { byteOffset: 0, lastStepIndex: -1 }
              : this.bridge.initCursorAtEof(
                  this.config.agyBrainDir,
                  item.conversationId
                );
            discoveredNewSibling = true;
          }

          addTarget(item.conversationId, {
            binding,
            isSibling: true,
            threadTitle: item.title,
            folderName: binding.folderName ?? item.folderName ?? undefined,
          });
        }
      }
    }

    if (discoveredNewSibling) {
      this.persist();
      this.refreshLogWatchers();
    }

    let delivered = 0;

    for (const [cid, targets] of targetsByCid.entries()) {
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
        for (const target of targets) {
          const { binding, isSibling, threadTitle, folderName } = target;
          const siblingKeyboard = isSibling
            ? {
                inline_keyboard: [
                  [
                    {
                      text: `Reply: ${threadTitle.slice(0, 24)}`,
                      callback_data: `bind:${cid}`,
                    },
                  ],
                ],
              }
            : undefined;

          if (rendered) {
            const payload = isSibling
              ? `[${folderName ?? "folder"} | ${threadTitle}]\n\n${rendered}`
              : rendered;
            await this.sendChunked(
              binding.chatId,
              payload,
              binding.messageThreadId,
              siblingKeyboard
            );
          }

          if (event.kind === "assistant_reply") {
            if (!isSibling) {
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
            }

            for (const imgPath of event.imagePaths) {
              await this.telegram.sendPhoto({
                chatId: binding.chatId,
                filePath: imgPath,
                caption: isSibling
                  ? `[${threadTitle}] ${path.basename(imgPath)}`
                  : path.basename(imgPath),
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

export {
  expandHomePath,
  loadConfig,
  type AppConfig,
} from "./config.ts";

export {
  maskProtectedTokens,
  restoreProtectedTokens,
  detectNeedsEnglishCompose,
  scrubNoAiSlop,
  checkSemanticDrift,
  composeEnglishPrompt,
  type ComposeMode,
  type ComposeOptions,
  type ComposeResult,
} from "./composer.ts";

export {
  listSessionFolders,
  resolveSessionFolder,
  readAnnotationMeta,
  listConversations,
  resolveConversationByPrefix,
  getConversationMetadata,
  sendMessageToDesktop,
  startDesktopConversation,
  readTranscriptDelta,
  readRecentTranscriptEvents,
  chunkTelegramText,
  type SessionFolder,
  type AnnotationMeta,
  type ConversationSummary,
  type QuestionChoice,
  type TranscriptEvent,
  type TranscriptDeltaResult,
} from "./antigravity.ts";

export {
  makeChatKey,
  createEmptyState,
  loadState,
  saveState,
  initCursorAtEof,
  type ThreadBinding,
  type TranscriptCursor,
  type PersistedState,
} from "./state.ts";

export {
  HttpTelegramClient,
  type TelegramUser,
  type TelegramChat,
  type TelegramMessage,
  type TelegramCallbackQuery,
  type TelegramUpdate,
  type InlineKeyboardButton,
  type InlineKeyboardMarkup,
  type SendMessageParams,
  type SendPhotoParams,
  type BotCommandSpec,
  type TelegramClient,
} from "./telegram.ts";

export {
  AgyTeleDaemon,
  BOT_COMMANDS,
  type DesktopBridge,
} from "./daemon.ts";

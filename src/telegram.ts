export type TelegramUser = {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
};

export type TelegramChat = {
  id: number;
  type: string;
  title?: string;
  is_forum?: boolean;
};

export type TelegramMessage = {
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
};

export type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

export type InlineKeyboardButton = {
  text: string;
  callback_data: string;
};

export type InlineKeyboardMarkup = {
  inline_keyboard: InlineKeyboardButton[][];
};

export type SendMessageParams = {
  chatId: number;
  text: string;
  messageThreadId?: number;
  replyMarkup?: InlineKeyboardMarkup;
  parseMode?: "Markdown" | "HTML";
};

export type SendPhotoParams = {
  chatId: number;
  filePath: string;
  caption?: string;
  messageThreadId?: number;
};

export type BotCommandSpec = {
  command: string;
  description: string;
};

export interface TelegramClient {
  getMe(): Promise<TelegramUser>;
  getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]>;
  sendMessage(params: SendMessageParams): Promise<void>;
  sendPhoto(params: SendPhotoParams): Promise<void>;
  createForumTopic(chatId: number, name: string): Promise<number>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  setMyCommands(commands: BotCommandSpec[]): Promise<void>;
}

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

/**
 * Lightweight Telegram Bot API client using native fetch and FormData.
 */
export class HttpTelegramClient implements TelegramClient {
  private readonly baseUrl: string;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  private async callJson<T>(
    method: string,
    payload?: Record<string, unknown>,
    timeoutMs = 15000
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: payload ? "POST" : "GET",
      headers: payload ? { "content-type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const data = (await response.json()) as TelegramApiResponse<T>;
    if (!response.ok || !data.ok || data.result === undefined) {
      throw new Error(
        `Telegram ${method} failed (${response.status}): ${data.description ?? "unknown error"}`
      );
    }
    return data.result;
  }

  async getMe(): Promise<TelegramUser> {
    return this.callJson<TelegramUser>("getMe");
  }

  async getUpdates(
    offset: number,
    timeoutSec: number
  ): Promise<TelegramUpdate[]> {
    return this.callJson<TelegramUpdate[]>(
      "getUpdates",
      {
        offset,
        timeout: timeoutSec,
        allowed_updates: ["message", "callback_query"],
      },
      (timeoutSec + 10) * 1000
    );
  }

  async sendMessage(params: SendMessageParams): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: params.chatId,
      text: params.text,
    };
    if (params.messageThreadId !== undefined) {
      body.message_thread_id = params.messageThreadId;
    }
    if (params.replyMarkup) {
      body.reply_markup = params.replyMarkup;
    }
    if (params.parseMode) {
      body.parse_mode = params.parseMode;
    }

    try {
      await this.callJson("sendMessage", body);
    } catch (err) {
      if (params.parseMode) {
        delete body.parse_mode;
        await this.callJson("sendMessage", body);
        return;
      }
      throw err;
    }
  }

  async sendPhoto(params: SendPhotoParams): Promise<void> {
    const form = new FormData();
    form.set("chat_id", String(params.chatId));
    if (params.messageThreadId !== undefined) {
      form.set("message_thread_id", String(params.messageThreadId));
    }
    if (params.caption) {
      form.set("caption", params.caption.slice(0, 1024));
    }
    form.set("photo", Bun.file(params.filePath));

    const response = await fetch(`${this.baseUrl}/sendPhoto`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    const data = (await response.json()) as TelegramApiResponse<unknown>;
    if (!response.ok || !data.ok) {
      throw new Error(
        `Telegram sendPhoto failed (${response.status}): ${data.description ?? "unknown error"}`
      );
    }
  }

  async createForumTopic(chatId: number, name: string): Promise<number> {
    const result = await this.callJson<{ message_thread_id: number }>(
      "createForumTopic",
      {
        chat_id: chatId,
        name: name.slice(0, 128),
      }
    );
    return result.message_thread_id;
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string
  ): Promise<void> {
    await this.callJson("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  async setMyCommands(commands: BotCommandSpec[]): Promise<void> {
    await this.callJson("setMyCommands", { commands });
  }
}

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readRecentTranscriptEvents,
  readTranscriptDelta,
  type ConversationSummary,
} from "../src/antigravity.ts";
import { composeEnglishPrompt } from "../src/composer.ts";
import type { AppConfig } from "../src/config.ts";
import { AgyTeleDaemon, type DesktopBridge } from "../src/daemon.ts";
import { initCursorAtEof } from "../src/state.ts";
import type {
  BotCommandSpec,
  SendMessageParams,
  SendPhotoParams,
  TelegramClient,
  TelegramUpdate,
} from "../src/telegram.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tele-daemon-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

class MockTelegramClient implements TelegramClient {
  public sentMessages: SendMessageParams[] = [];
  public sentPhotos: SendPhotoParams[] = [];
  public callbackAnswers: Array<{ id: string; text?: string }> = [];

  async getMe() {
    return { id: 1, is_bot: true, username: "agy_tele_test_bot" };
  }
  async getUpdates(_offset: number, _timeoutSec: number): Promise<TelegramUpdate[]> {
    return [];
  }
  async sendMessage(params: SendMessageParams): Promise<void> {
    this.sentMessages.push(params);
  }
  async sendPhoto(params: SendPhotoParams): Promise<void> {
    this.sentPhotos.push(params);
  }
  async createForumTopic(): Promise<number> {
    return 77;
  }
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    this.callbackAnswers.push({ id: callbackQueryId, text });
  }
  async setMyCommands(_commands: BotCommandSpec[]): Promise<void> {}
}

describe("daemon: Telegram <-> Antigravity Desktop sync", () => {
  test("blocks unauthorized users, binds via inline button, composes Vietlish prompts, and streams Desktop replies", async () => {
    const root = makeTempDir();
    const brainDir = path.join(root, "brain");
    const cid = "deadbeef-1111-2222-3333-444455556666";
    const logsDir = path.join(brainDir, cid, ".system_generated", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const transcriptPath = path.join(logsDir, "transcript.jsonl");
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        content: "<USER_REQUEST>\nOld thread prompt\n</USER_REQUEST>",
      })}\n`,
      "utf8"
    );

    const threads: ConversationSummary[] = [
      {
        conversationId: cid,
        title: "AVM Studio Polish",
        preview: "Liquid glass",
        stepCount: 1,
        lastModifiedTime: "2026-11-15T06:00:00Z",
        workspaces: ["/Volumes/Dev/ai-video-maker"],
        primaryWorkspace: "ai-video-maker",
        status: "CASCADE_RUN_STATUS_IDLE",
        notFullyIdle: false,
      },
    ];

    const injectedPrompts: Array<{ cid: string; content: string }> = [];

    const bridge: DesktopBridge = {
      listConversations: () => threads,
      resolveConversationByPrefix: (_dir, prefix) =>
        threads.find((t) => t.conversationId.startsWith(prefix)) ?? null,
      getConversationMetadata: async () => ({ status: "ok" }),
      sendMessageToDesktop: async (_bin, targetCid, content) => {
        injectedPrompts.push({ cid: targetCid, content });
      },
      startDesktopConversation: async () => cid,
      readTranscriptDelta,
      readRecentTranscriptEvents,
      initCursorAtEof,
      composeEnglishPrompt: (raw, opts) =>
        composeEnglishPrompt(raw, { ...opts, offline: true }),
    };

    const cfg: AppConfig = {
      telegramBotToken: "test-token",
      allowedUserIds: [4242],
      defaultChatId: null,
      agyDataDir: root,
      agyBrainDir: brainDir,
      agentApiBin: "/usr/bin/true",
      defaultWorkspace: "/Volumes/Dev",
      defaultModel: null,
      flowGenEn: "auto",
      pollMs: 200,
      statePath: path.join(root, "state.json"),
    };

    const telegram = new MockTelegramClient();
    const daemon = new AgyTeleDaemon(cfg, telegram, bridge);

    // 1. Unauthorized user is ignored completely.
    await daemon.handleUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        from: { id: 9999, username: "intruder" },
        chat: { id: -1001, type: "supergroup" },
        text: "/threads",
      },
    });
    expect(telegram.sentMessages).toHaveLength(0);

    // 2. Authorized user requests /threads and receives inline bind buttons.
    await daemon.handleUpdate({
      update_id: 2,
      message: {
        message_id: 11,
        message_thread_id: 55,
        from: { id: 4242, username: "harry" },
        chat: { id: -1001, type: "supergroup" },
        text: "/threads",
      },
    });
    expect(telegram.sentMessages).toHaveLength(1);
    expect(
      telegram.sentMessages[0].replyMarkup?.inline_keyboard[0][0].callback_data
    ).toBe(`bind:${cid}`);

    // 3. Tapping inline button binds topic -1001:55 to thread deadbeef... at current EOF.
    await daemon.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "cb-1",
        from: { id: 4242, username: "harry" },
        data: `bind:${cid}`,
        message: {
          message_id: 12,
          message_thread_id: 55,
          chat: { id: -1001, type: "supergroup" },
        },
      },
    });
    expect(daemon.getState().bindings["-1001:55"]?.conversationId).toBe(cid);
    expect(daemon.getState().cursors[cid]?.lastStepIndex).toBe(0);

    // 4. Sending Vietlish message transforms via Flow-Gen-EN + No-AI-Slop and calls agentapi send-message.
    await daemon.handleUpdate({
      update_id: 4,
      message: {
        message_id: 13,
        message_thread_id: 55,
        from: { id: 4242, username: "harry" },
        chat: { id: -1001, type: "supergroup" },
        text: "ê check lại ENG-2716 bên ai-video-maker giúp @ducnmm",
      },
    });
    expect(injectedPrompts).toHaveLength(1);
    expect(injectedPrompts[0].cid).toBe(cid);
    expect(injectedPrompts[0].content).toContain("ENG-2716");
    expect(injectedPrompts[0].content).toContain("ai-video-maker");
    expect(injectedPrompts[0].content).toContain("@ducnmm");
    expect(
      telegram.sentMessages.some((m) => m.text.startsWith("[EN] "))
    ).toBe(true);

    // 5. Desktop logs SYSTEM_SDK echo (ignored) + MODEL reply with ask_question -> pushed to topic 55.
    const countBeforeSync = telegram.sentMessages.length;
    fs.appendFileSync(
      transcriptPath,
      [
        JSON.stringify({
          step_index: 1,
          source: "SYSTEM_SDK",
          type: "SYSTEM_MESSAGE",
          status: "DONE",
          content: injectedPrompts[0].content,
        }),
        JSON.stringify({
          step_index: 2,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "Fixed ENG-2716 and ran cargo test.",
          tool_calls: [
            {
              name: "ask_question",
              args: {
                questions: [
                  {
                    question: "Merge PR now?",
                    options: ["Merge to dev", "Hold"],
                  },
                ],
              },
            },
          ],
        }),
      ].join("\n") + "\n",
      "utf8"
    );

    const delivered = await daemon.syncTranscriptsOnce();
    expect(delivered).toBe(1);
    const newMsgs = telegram.sentMessages.slice(countBeforeSync);
    expect(newMsgs[0].messageThreadId).toBe(55);
    expect(newMsgs[0].text).toContain("Fixed ENG-2716 and ran cargo test.");
    expect(newMsgs[1].replyMarkup?.inline_keyboard[0][0].text).toBe("Merge to dev");

    // 6. Tapping option button sends exact option label back into Desktop thread.
    const optCallback =
      newMsgs[1].replyMarkup?.inline_keyboard[0][0].callback_data ?? "";
    await daemon.handleUpdate({
      update_id: 5,
      callback_query: {
        id: "cb-2",
        from: { id: 4242, username: "harry" },
        data: optCallback,
        message: {
          message_id: 14,
          message_thread_id: 55,
          chat: { id: -1001, type: "supergroup" },
        },
      },
    });
    expect(injectedPrompts).toHaveLength(2);
    expect(injectedPrompts[1].content).toBe("Merge to dev");
  });
});

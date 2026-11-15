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
        projectId: null,
        folderName: null,
        title: "AVM Studio Polish",
        preview: "Liquid glass",
        stepCount: 1,
        lastModifiedTime: "2026-11-15T06:00:00Z",
        workspaces: ["/Volumes/Dev/ai-video-maker"],
        primaryWorkspace: "ai-video-maker",
        status: "CASCADE_RUN_STATUS_IDLE",
        notFullyIdle: false,
        pinned: false,
      },
    ];

    const injectedPrompts: Array<{ cid: string; content: string; projectId?: string | null }> = [];

    const bridge: DesktopBridge = {
      listSessionFolders: () => [],
      resolveSessionFolder: () => null,
      listConversations: () => threads,
      resolveConversationByPrefix: (_dir, prefix) =>
        threads.find((t) => t.conversationId.startsWith(prefix)) ?? null,
      getConversationMetadata: async () => ({ status: "ok" }),
      sendMessageToDesktop: async (_bin, targetCid, content, _title, projectId) => {
        injectedPrompts.push({ cid: targetCid, content, projectId });
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
      agyProjectsDir: path.join(root, "projects"),
      defaultFolder: null,
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

  test("syncs a Telegram chat with an Antigravity Session Folder, watches sibling automations, and switches target on button tap", async () => {
    const root = makeTempDir();
    const brainDir = path.join(root, "brain");
    const folderId = "325113ab-f784-4fd3-87dc-e1a8d67576af";
    const cidA = "daily-aaaa-1111-2222-333344445555";
    const cidB = "daily-bbbb-1111-2222-333344445555";

    for (const cid of [cidA, cidB]) {
      const logsDir = path.join(brainDir, cid, ".system_generated", "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(
        path.join(logsDir, "transcript.jsonl"),
        `${JSON.stringify({
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          content: "<USER_REQUEST>\nInitial task\n</USER_REQUEST>",
        })}\n`,
        "utf8"
      );
    }

    const folderThreads: ConversationSummary[] = [
      {
        conversationId: cidA,
        projectId: folderId,
        folderName: "my-working-daily",
        title: "Winning NASA Competition Guide",
        preview: "Checked space apps",
        stepCount: 1,
        lastModifiedTime: "2026-11-15T07:00:00Z",
        workspaces: ["/Volumes/Dev/nasa-space-apps-2026"],
        primaryWorkspace: "nasa-space-apps-2026",
        status: "CASCADE_RUN_STATUS_IDLE",
        notFullyIdle: false,
        pinned: false,
      },
      {
        conversationId: cidB,
        projectId: folderId,
        folderName: "my-working-daily",
        title: "Automated Daily Hackathon",
        preview: "Found new hackathon",
        stepCount: 1,
        lastModifiedTime: "2026-11-15T06:50:00Z",
        workspaces: ["/Volumes/Dev/hackathon-registry"],
        primaryWorkspace: "hackathon-registry",
        status: "CASCADE_RUN_STATUS_IDLE",
        notFullyIdle: false,
        pinned: false,
      },
    ];

    const startedCalls: Array<{ prompt: string; cwd?: string; projectId?: string | null }> = [];
    const sentCalls: Array<{ cid: string; content: string; projectId?: string | null }> = [];

    const folderDef = {
      id: folderId,
      name: "my-working-daily",
      workspaces: ["/Volumes/Dev/nasa-space-apps-2026"],
      primaryWorkspace: "/Volumes/Dev/nasa-space-apps-2026",
      activeThreadCount: 2,
      latestThreadTime: "2026-11-15T07:00:00Z",
    };

    const bridge: DesktopBridge = {
      listSessionFolders: () => [folderDef],
      resolveSessionFolder: (_dir, needle) =>
        needle === "my-working-daily" || needle === folderId ? folderDef : null,
      listConversations: (_dir, opts) => {
        if (opts?.folderId && opts.folderId !== folderId) return [];
        return folderThreads;
      },
      resolveConversationByPrefix: (_dir, prefix) =>
        folderThreads.find((t) => t.conversationId.startsWith(prefix)) ?? null,
      getConversationMetadata: async () => ({ status: "ok" }),
      sendMessageToDesktop: async (_bin, targetCid, content, _title, projectId) => {
        sentCalls.push({ cid: targetCid, content, projectId });
      },
      startDesktopConversation: async (_bin, opts) => {
        startedCalls.push({
          prompt: opts.prompt,
          cwd: opts.cwd,
          projectId: opts.projectId,
        });
        return "daily-cccc-new";
      },
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
      agyProjectsDir: path.join(root, "projects"),
      defaultFolder: "my-working-daily",
      agentApiBin: "/usr/bin/true",
      defaultWorkspace: "/Volumes/Dev",
      defaultModel: null,
      flowGenEn: "auto",
      pollMs: 200,
      statePath: path.join(root, "state.json"),
    };

    const telegram = new MockTelegramClient();
    const daemon = new AgyTeleDaemon(cfg, telegram, bridge);

    // 1. /status auto-syncs the default folder and binds its newest thread cleanly.
    await daemon.handleUpdate({
      update_id: 10,
      message: {
        message_id: 20,
        from: { id: 4242, username: "harry" },
        chat: { id: 777, type: "private" },
        text: "/status",
      },
    });
    expect(telegram.sentMessages[0].text).toContain("Folder: my-working-daily");
    expect(daemon.getState().bindings["777:main"]?.folderId).toBe(folderId);
    expect(daemon.getState().bindings["777:main"]?.watchFolder).toBe(true);
    expect(daemon.getState().bindings["777:main"]?.conversationId).toBe(cidA);

    // 2. Sibling automation (cidB) in the same folder posts an update -> streamed with switch button.
    const countBeforeSibling = telegram.sentMessages.length;
    fs.appendFileSync(
      path.join(brainDir, cidB, ".system_generated", "logs", "transcript.jsonl"),
      `${JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "Scouted 2 new AI hackathons closing Nov 28.",
      })}\n`,
      "utf8"
    );

    const siblingDelivered = await daemon.syncTranscriptsOnce();
    expect(siblingDelivered).toBe(1);
    const siblingMsg = telegram.sentMessages[countBeforeSibling];
    expect(siblingMsg.text).toContain("[my-working-daily | Automated Daily Hackathon]");
    expect(siblingMsg.text).toContain("Scouted 2 new AI hackathons closing Nov 28.");
    expect(
      siblingMsg.replyMarkup?.inline_keyboard[0][0].callback_data
    ).toBe(`bind:${cidB}`);

    // 3. Tapping the inline button switches active reply target to cidB while keeping folder watch active.
    await daemon.handleUpdate({
      update_id: 11,
      callback_query: {
        id: "cb-folder-switch",
        from: { id: 4242, username: "harry" },
        data: `bind:${cidB}`,
        message: {
          message_id: 21,
          chat: { id: 777, type: "private" },
        },
      },
    });
    expect(daemon.getState().bindings["777:main"]?.conversationId).toBe(cidB);
    expect(daemon.getState().bindings["777:main"]?.watchFolder).toBe(true);

    // 4. Plain message forwards into cidB with ANTIGRAVITY_PROJECT_ID (folderId).
    await daemon.handleUpdate({
      update_id: 12,
      message: {
        message_id: 22,
        from: { id: 4242, username: "harry" },
        chat: { id: 777, type: "private" },
        text: "/raw Save that workflow to hackathon-architect",
      },
    });
    expect(sentCalls).toHaveLength(1);
    expect(sentCalls[0].cid).toBe(cidB);
    expect(sentCalls[0].projectId).toBe(folderId);

    // 5. /new starts a conversation inside the synced folder with ANTIGRAVITY_PROJECT_ID set.
    await daemon.handleUpdate({
      update_id: 13,
      message: {
        message_id: 23,
        from: { id: 4242, username: "harry" },
        chat: { id: 777, type: "private" },
        text: "/new Track Solana Radar hackathon deadlines",
      },
    });
    expect(startedCalls).toHaveLength(1);
    expect(startedCalls[0].projectId).toBe(folderId);
    expect(daemon.getState().bindings["777:main"]?.folderId).toBe(folderId);

    // 6. /folders renders Session Folder buttons and /threads respects folder scope.
    const countBeforeFolders = telegram.sentMessages.length;
    await daemon.handleUpdate({
      update_id: 14,
      message: {
        message_id: 24,
        from: { id: 4242, username: "harry" },
        chat: { id: 777, type: "private" },
        text: "/folders",
      },
    });
    expect(telegram.sentMessages[countBeforeFolders].text).toContain("my-working-daily");
    expect(
      telegram.sentMessages[countBeforeFolders].replyMarkup?.inline_keyboard[0][0].callback_data
    ).toBe(`folder:${folderId}`);

    const countBeforeScopedThreads = telegram.sentMessages.length;
    await daemon.handleUpdate({
      update_id: 15,
      message: {
        message_id: 25,
        from: { id: 4242, username: "harry" },
        chat: { id: 777, type: "private" },
        text: "/threads",
      },
    });
    expect(telegram.sentMessages[countBeforeScopedThreads].text).toContain(
      "Folder: my-working-daily"
    );

    // 7. /folder off detaches the folder watch cleanly while keeping the thread bound.
    await daemon.handleUpdate({
      update_id: 16,
      message: {
        message_id: 26,
        from: { id: 4242, username: "harry" },
        chat: { id: 777, type: "private" },
        text: "/folder off",
      },
    });
    expect(daemon.getState().bindings["777:main"]?.watchFolder).toBeUndefined();
    expect(daemon.getState().bindings["777:main"]?.folderId).toBeUndefined();
  });
});

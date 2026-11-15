import { describe, expect, test } from "bun:test";
import {
  AgyTeleDaemon,
  BOT_COMMANDS,
  HttpTelegramClient,
  checkSemanticDrift,
  chunkTelegramText,
  composeEnglishPrompt,
  listConversations,
  loadConfig,
  readTranscriptDelta,
  resolveConversationByPrefix,
  scrubNoAiSlop,
  sendMessageToDesktop,
  startDesktopConversation,
} from "../src/index.ts";

describe("index: public barrel exports", () => {
  test("exposes typed composer, desktop IPC, config, and daemon primitives", () => {
    expect(typeof composeEnglishPrompt).toBe("function");
    expect(typeof scrubNoAiSlop).toBe("function");
    expect(typeof checkSemanticDrift).toBe("function");
    expect(typeof listConversations).toBe("function");
    expect(typeof resolveConversationByPrefix).toBe("function");
    expect(typeof readTranscriptDelta).toBe("function");
    expect(typeof sendMessageToDesktop).toBe("function");
    expect(typeof startDesktopConversation).toBe("function");
    expect(typeof chunkTelegramText).toBe("function");
    expect(typeof loadConfig).toBe("function");
    expect(typeof AgyTeleDaemon).toBe("function");
    expect(typeof HttpTelegramClient).toBe("function");
    expect(Array.isArray(BOT_COMMANDS)).toBe(true);
    expect(BOT_COMMANDS.length).toBeGreaterThanOrEqual(9);
  });

  test("runs the README programmatic composeEnglishPrompt snippet cleanly offline", async () => {
    const raw =
      "check lại ENG-2716 bên ai-video-maker giúp @ducnmm, leverage cache to streamline it";
    const result = await composeEnglishPrompt(raw, {
      mode: "auto",
      offline: true,
    });

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.text).toContain("ENG-2716");
    expect(result.text).toContain("ai-video-maker");
    expect(result.text).toContain("@ducnmm");
    expect(result.text.toLowerCase()).not.toContain("leverage");
    expect(result.text.toLowerCase()).not.toContain("streamline");
  });
});

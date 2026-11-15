import { describe, expect, test } from "bun:test";
import {
  checkSemanticDrift,
  composeEnglishPrompt,
  detectNeedsEnglishCompose,
  maskProtectedTokens,
  restoreProtectedTokens,
  scrubNoAiSlop,
} from "../src/composer.ts";

describe("composer: Flow-Gen-EN and No-AI-Slop", () => {
  test("detects Vietnamese diacritics, Vietlish shorthand, dashes, and AI slop", () => {
    expect(detectNeedsEnglishCompose("Run bun test cleanly.")).toBe(false);
    expect(detectNeedsEnglishCompose("Check `src/cli.ts` for ENG-12 errors.")).toBe(false);
    expect(detectNeedsEnglishCompose("kiểm tra lại lỗi build")).toBe(true);
    expect(detectNeedsEnglishCompose("check cai nay giup minh khong")).toBe(true);
    expect(detectNeedsEnglishCompose("Update the config — quickly")).toBe(true);
    expect(detectNeedsEnglishCompose("Please leverage cache to streamline builds")).toBe(true);
  });

  test("preserves fenced code, inline code, links, paths, tickets, mentions, and kebab slugs", () => {
    const input =
      "Check `src/cli.ts` in [repo](https://github.com/harrymove-ctrl/agy-tele) for ENG-2716 and WALM-950 inside ai-video-maker with @ducnmm\n```ts\nconst x = 1 - 2;\n```";
    const { masked, tokens } = maskProtectedTokens(input);
    expect(masked).not.toContain("ENG-2716");
    expect(masked).not.toContain("@ducnmm");
    expect(masked).not.toContain("ai-video-maker");
    expect(masked).not.toContain("const x = 1 - 2;");
    const restored = restoreProtectedTokens(masked, tokens);
    expect(restored).toBe(input);
  });

  test("strips em-dashes, spaced hyphens, dash bullets, and AI slop verbs without breaking code", () => {
    const input = [
      "Here's the thing: we should utilize `bun:sqlite` — it will seamlessly streamline queries - fast.",
      "- First item with ENG-2716",
      "- Second item for @ducnmm",
    ].join("\n");

    const cleaned = scrubNoAiSlop(input);
    expect(cleaned).not.toContain("\u2014");
    expect(cleaned).not.toContain(" - ");
    expect(cleaned).not.toMatch(/^-\s+/m);
    expect(cleaned.toLowerCase()).not.toContain("here's the thing");
    expect(cleaned.toLowerCase()).not.toContain("utilize");
    expect(cleaned.toLowerCase()).not.toContain("seamlessly");
    expect(cleaned.toLowerCase()).not.toContain("streamline");
    expect(cleaned).toContain("use `bun:sqlite`");
    expect(cleaned).toContain("1. First item with ENG-2716");
    expect(cleaned).toContain("2. Second item for @ducnmm");
  });

  test("offline fallback normalizes Vietlish while keeping ticket keys, mentions, and numbers", async () => {
    const raw =
      "ê check lại cái PR ENG-2716 bên ai-video-maker sao chạy chậm á, leverage cache để streamline nó giúp @ducnmm (2 tests)";
    const res = await composeEnglishPrompt(raw, {
      mode: "auto",
      offline: true,
    });

    expect(res.changed).toBe(true);
    expect(res.modeUsed).toBe("offline-fallback");
    expect(res.text).toContain("ENG-2716");
    expect(res.text).toContain("ai-video-maker");
    expect(res.text).toContain("@ducnmm");
    expect(res.text).toContain("2");
    expect(res.text.toLowerCase()).not.toContain("leverage");
    expect(res.text.toLowerCase()).not.toContain("streamline");
    expect(checkSemanticDrift(raw, res.text)).toEqual([]);
  });

  test("keeps raw input untouched when mode is off or English is already clean", async () => {
    const clean = "Inspect src/daemon.ts and run bun test.";
    const resAuto = await composeEnglishPrompt(clean, { mode: "auto" });
    expect(resAuto.changed).toBe(false);
    expect(resAuto.modeUsed).toBe("raw");
    expect(resAuto.text).toBe(clean);

    const viet = "sửa lỗi này — giúp nhé";
    const resOff = await composeEnglishPrompt(viet, { mode: "off" });
    expect(resOff.changed).toBe(false);
    expect(resOff.text).toBe(viet);
  });
});

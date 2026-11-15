export type ComposeMode = "auto" | "always" | "off";

export type ComposeResult = {
  text: string;
  changed: boolean;
  modeUsed: "raw" | "translate-pivot" | "slop-scrub" | "offline-fallback";
  warnings: string[];
};

export type ComposeOptions = {
  mode?: ComposeMode;
  offline?: boolean;
  timeoutMs?: number;
};

type MaskedPayload = {
  masked: string;
  tokens: string[];
};

const VIETNAMESE_DIACRITICS_RE =
  /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

const VIETLISH_SHORTHAND_RE =
  /\b(?:khong|ko|dc|cham|nhan|giup|kiem\s*tra|sua|loi|luon|nhe|nha|duoc|chua|gium|xong|sao|cai|nay|chay|toi|minh|thu|xem|oi|ê)\b/i;

const PROHIBITED_DASH_RE = /[\u2014\u2013\u2015]|\s-\s|^\s*-\s+|^\s*---+\s*$/m;

const SLOP_DETECT_RE =
  /\b(?:delve(?:s|d|ing)?|tapestry|leverage(?:s|d|ing)?|utilize(?:s|d|ing)?|streamline(?:s|d|ing)?|seamless(?:ly)?|autonomously|foster(?:s|ed|ing)?|empower(?:s|ed|ing)?|paradigm shift|game[- ]changer|testament to|it['’]s worth noting|it is important to note|let['’]s unpack|let['’]s dive in|here['’]s the thing|what most people get wrong|the part everyone misses|at the end of the day|when the dust settles|now more than ever|in order to|prior to)\b/i;

const PROTECTED_PATTERNS: RegExp[] = [
  /```[\s\S]*?```/g,
  /`[^`\n]+`/g,
  /\[[^\]]+\]\([^)]+\)/g,
  /(?:https?|file):\/\/[^\s<>()]+/g,
  /(?:\/Volumes|\/Users|\/tmp|~\/|\.\.?\/)[A-Za-z0-9_./-]+/g,
  /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\b/g,
  /\b[A-Z]{2,10}-\d+\b/g,
  /(?<![A-Za-z0-9._%+-])@[A-Za-z0-9_-]+/g,
  /\b[a-z][a-z0-9]*(?:-[a-z0-9]+){2,}\b/g,
];

const SLOP_SWAPS: Array<[RegExp, string]> = [
  [/\bdelve into\b/gi, "explore"],
  [/\bdelves into\b/gi, "explores"],
  [/\bdelved into\b/gi, "explored"],
  [/\bdelving into\b/gi, "exploring"],
  [/\bdelve\b/gi, "dig"],
  [/\bdelves\b/gi, "digs"],
  [/\bdelved\b/gi, "dug"],
  [/\bdelving\b/gi, "digging"],
  [/\btapestry\b/gi, "mix"],
  [/\butilize\b/gi, "use"],
  [/\butilizes\b/gi, "uses"],
  [/\butilized\b/gi, "used"],
  [/\butilizing\b/gi, "using"],
  [/\bleverage\b/gi, "use"],
  [/\bleverages\b/gi, "uses"],
  [/\bleveraged\b/gi, "used"],
  [/\bleveraging\b/gi, "using"],
  [/\bstreamline\b/gi, "simplify"],
  [/\bstreamlines\b/gi, "simplifies"],
  [/\bstreamlined\b/gi, "simplified"],
  [/\bstreamlining\b/gi, "simplifying"],
  [/\bfoster\b/gi, "build"],
  [/\bfosters\b/gi, "builds"],
  [/\bfostered\b/gi, "built"],
  [/\bfostering\b/gi, "building"],
  [/\bempower\b/gi, "help"],
  [/\bempowers\b/gi, "helps"],
  [/\bempowered\b/gi, "helped"],
  [/\bempowering\b/gi, "helping"],
  [/\bseamlessly\b/gi, "smoothly"],
  [/\bseamless\b/gi, "smooth"],
  [/\bautonomously\b/gi, "automatically"],
  [/\bmulti-?faceted\b/gi, "varied"],
  [/\bright out of the box\b/gi, "immediately"],
  [/\bout[- ]of[- ]the[- ]box\b/gi, "built in"],
  [/\bfirst[- ]class\b/gi, "solid"],
  [/\bgame[- ]changers\b/gi, "major upgrades"],
  [/\bgame[- ]changer\b/gi, "major upgrade"],
  [/\bparadigm shift\b/gi, "shift"],
  [/\bwhich is a (?:beacon|testament) (?:of|to)\b/gi, "proving"],
  [/\bthat['’]s a (?:beacon|testament) (?:of|to)\b/gi, "proving"],
  [/\bstands as a (?:beacon|testament) (?:of|to)\b/gi, "shows"],
  [/\ba testament to\b/gi, "proof of"],
  [/\bprior to\b/gi, "before"],
  [/\bin order to\b/gi, "to"],
];

const uWord = (pattern: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`, "giu");

const VIETLISH_OFFLINE_PHRASES: Array<[RegExp, string]> = [
  [uWord("ê|ơi"), ""],
  [uWord("kiểm\\s*tra\\s*lại|check\\s*lại"), "recheck"],
  [uWord("kiểm\\s*tra"), "check"],
  [uWord("chạy\\s*chậm"), "runs slowly"],
  [uWord("chậm"), "slowly"],
  [uWord("sao\\s+chạy"), "why does it run"],
  [uWord("sửa\\s*lỗi"), "fix the bug"],
  [uWord("sửa"), "fix"],
  [uWord("lỗi"), "error"],
  [uWord("giúp|giùm"), "please"],
  [uWord("nhắn"), "message"],
  [uWord("có\\s*cách\\s*nào"), "is there any way to"],
  [uWord("được\\s*không"), "if possible"],
  [uWord("không|khong|ko"), "not"],
  [uWord("chưa|chua"), "not yet"],
  [uWord("để"), "to"],
  [uWord("bên"), "in"],
  [uWord("cái"), "the"],
  [uWord("nó"), "it"],
  [uWord("nhé|nha|á"), ""],
];

/**
 * Mask code blocks, links, URLs, paths, ticket keys, mentions, and multi-hyphen slugs
 * so translation and prose scrubbing never alter machine identifiers.
 */
export function maskProtectedTokens(text: string): MaskedPayload {
  const tokens: string[] = [];
  let masked = text;

  for (const pattern of PROTECTED_PATTERNS) {
    masked = masked.replace(pattern, (match) => {
      if (/^ZXQTOK\d+X$/.test(match)) {
        return match;
      }
      const id = tokens.length;
      tokens.push(match);
      return `ZXQTOK${String(id).padStart(3, "0")}X`;
    });
  }

  return { masked, tokens };
}

/**
 * Restore masked tokens back into translated or scrubbed text with spacing guardrails.
 */
export function restoreProtectedTokens(text: string, tokens: string[]): string {
  if (tokens.length === 0) return text;
  return text.replace(
    /([A-Za-z0-9])?ZXQTOK\s*(\d+)\s*X([A-Za-z0-9])?/gi,
    (_m, left, idxStr, right) => {
      const idx = Number.parseInt(idxStr, 10);
      const value = tokens[idx] ?? `ZXQTOK${idxStr}X`;
      const prefix = left ? `${left} ` : "";
      const suffix = right ? ` ${right}` : "";
      return `${prefix}${value}${suffix}`;
    }
  );
}

/**
 * Detect whether a draft needs Vietnamese-to-English normalization, dash cleanup, or anti-slop edits.
 */
export function detectNeedsEnglishCompose(text: string): boolean {
  if (!text.trim()) return false;
  const { masked } = maskProtectedTokens(text);
  return (
    VIETNAMESE_DIACRITICS_RE.test(masked) ||
    VIETLISH_SHORTHAND_RE.test(masked) ||
    PROHIBITED_DASH_RE.test(masked) ||
    SLOP_DETECT_RE.test(masked)
  );
}

function detectNeedsTranslation(maskedText: string): boolean {
  return (
    VIETNAMESE_DIACRITICS_RE.test(maskedText) ||
    VIETLISH_SHORTHAND_RE.test(maskedText)
  );
}

function convertDashBulletsToNumbered(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let counter = 0;

  for (const line of lines) {
    if (/^\s*---+\s*$/.test(line)) {
      counter = 0;
      continue;
    }
    const bulletMatch = line.match(/^(\s*)-\s+(.*)$/);
    if (bulletMatch) {
      counter += 1;
      out.push(`${bulletMatch[1]}${counter}. ${bulletMatch[2]}`);
      continue;
    }
    if (line.trim() !== "") {
      counter = 0;
    }
    out.push(line);
  }

  return out.join("\n");
}

/**
 * Apply anti-slop word swaps, throat-clearing removal, and zero-dash formatting on plain prose.
 */
export function scrubNoAiSlop(text: string): string {
  const { masked, tokens } = maskProtectedTokens(text);
  let out = convertDashBulletsToNumbered(masked);

  out = out
    .replace(/\s*[\u2014\u2013\u2015]\s*/g, ", ")
    .replace(/\s-\s/g, ": ")
    .replace(/,\s*,+/g, ",")
    .replace(/\s+,/g, ",");

  out = out
    .replace(
      /^In today['’]s (?:rapidly (?:evolving|changing)|fast-moving) [^,]+,\s*/gim,
      ""
    )
    .replace(
      /\b(?:It is|It['’]s) (?:worth|important to) (?:noting|note) (?:that\s+)?/gi,
      ""
    )
    .replace(/\bLet['’]s (?:unpack this|dive in)[,:]?\s*/gi, "")
    .replace(/^Here['’]s the thing[,:]?\s*/gim, "")
    .replace(/\bwhat most people get wrong is (?:that\s*)?/gi, "")
    .replace(/\bwhat most people get wrong[,:]?\s*/gi, "")
    .replace(/\bthe part everyone misses[,:]?\s*/gi, "")
    .replace(/,?\s*at the end of the day\b/gi, "")
    .replace(/,?\s*when the dust settles\b/gi, "")
    .replace(/\bnow more than ever\b/gi, "")
    .replace(/\bthe stakes (?:couldn['’]t|have never) been higher\b/gi, "");

  for (const [regex, replacement] of SLOP_SWAPS) {
    out = out.replace(regex, replacement);
  }

  out = out
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\s+([.,!?;:])/g, "$1")
        .replace(/,\s*\./g, ".")
        .replace(/^\s*[,;:]\s*/, "")
        .trimEnd()
    )
    .join("\n")
    .trim();

  out = out.replace(/(^|[.!?]\s+|\n+)([a-z])/g, (_m, prefix, ch: string) => {
    return `${prefix}${ch.toUpperCase()}`;
  });

  return restoreProtectedTokens(out, tokens);
}

function applyOfflineVietlishNormalization(masked: string): string {
  let out = masked;
  for (const [regex, replacement] of VIETLISH_OFFLINE_PHRASES) {
    out = out.replace(regex, replacement);
  }
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

async function googleTranslateGtx(
  text: string,
  sl: string,
  tl: string,
  timeoutMs: number
): Promise<string> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(
    sl
  )}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Translate HTTP ${response.status} (${sl} -> ${tl})`);
  }
  const data = (await response.json()) as unknown;
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error(`Unexpected translate payload (${sl} -> ${tl})`);
  }
  return (data[0] as unknown[])
    .map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : ""))
    .join("");
}

function extractNumbers(text: string): string[] {
  return [...text.matchAll(/\b\d+(?:\.\d+)?%?\b/g)].map((m) => m[0]);
}

function extractTicketIds(text: string): string[] {
  return [...text.matchAll(/\b[A-Z]{2,10}-\d+\b/g)].map((m) => m[0]);
}

function extractMentions(text: string): string[] {
  return [...text.matchAll(/(?<![A-Za-z0-9._%+-])@[A-Za-z0-9_-]+/g)].map(
    (m) => m[0]
  );
}

/**
 * Verify that numeric literals, ticket IDs, @mentions, and protected tokens survived composition.
 */
export function checkSemanticDrift(
  original: string,
  composed: string
): string[] {
  const warnings: string[] = [];

  if (/ZXQTOK\s*\d+\s*X/i.test(composed)) {
    warnings.push("unrestored placeholder token detected");
  }

  const origNums = extractNumbers(original);
  const newNums = extractNumbers(composed);
  if (JSON.stringify(origNums) !== JSON.stringify(newNums)) {
    warnings.push(
      `numbers shifted (${origNums.join(",")} -> ${newNums.join(",")})`
    );
  }

  const origTickets = extractTicketIds(original);
  const newTickets = extractTicketIds(composed);
  if (JSON.stringify(origTickets) !== JSON.stringify(newTickets)) {
    warnings.push(
      `ticket IDs shifted (${origTickets.join(",")} -> ${newTickets.join(",")})`
    );
  }

  const origMentions = extractMentions(original);
  const newMentions = extractMentions(composed);
  if (JSON.stringify(origMentions) !== JSON.stringify(newMentions)) {
    warnings.push(
      `mentions shifted (${origMentions.join(",")} -> ${newMentions.join(",")})`
    );
  }

  return warnings;
}

/**
 * Convert casual Vietnamese, Vietlish, or sloppy English prompts into plain zero-dash English
 * while preserving ticket IDs, code spans, URLs, paths, and @mentions verbatim.
 */
export async function composeEnglishPrompt(
  raw: string,
  options: ComposeOptions = {}
): Promise<ComposeResult> {
  const mode = options.mode ?? "auto";
  const offline = options.offline ?? false;
  const timeoutMs = options.timeoutMs ?? 2500;

  if (!raw.trim() || mode === "off") {
    return { text: raw, changed: false, modeUsed: "raw", warnings: [] };
  }

  const { masked, tokens } = maskProtectedTokens(raw);
  const needsCompose = mode === "always" || detectNeedsEnglishCompose(raw);

  if (!needsCompose) {
    return { text: raw, changed: false, modeUsed: "raw", warnings: [] };
  }

  const needsTranslate =
    mode === "always" || detectNeedsTranslation(masked);

  if (!needsTranslate) {
    const scrubbed = scrubNoAiSlop(raw);
    const warnings = checkSemanticDrift(raw, scrubbed);
    return {
      text: scrubbed,
      changed: scrubbed !== raw,
      modeUsed: "slop-scrub",
      warnings,
    };
  }

  if (!offline) {
    try {
      const zh = await googleTranslateGtx(masked, "auto", "zh-CN", timeoutMs);
      const en = await googleTranslateGtx(zh, "zh-CN", "en", timeoutMs);
      const restored = restoreProtectedTokens(en, tokens);
      const scrubbed = scrubNoAiSlop(restored);
      const warnings = checkSemanticDrift(raw, scrubbed);
      const lostProtected =
        /ZXQTOK\s*\d+\s*X/i.test(scrubbed) ||
        tokens.some((tok) => !scrubbed.includes(tok));

      if (!lostProtected && scrubbed.trim().length > 0) {
        return {
          text: scrubbed,
          changed: scrubbed !== raw,
          modeUsed: "translate-pivot",
          warnings,
        };
      }

      const fallbackMasked = applyOfflineVietlishNormalization(masked);
      const fallbackRestored = restoreProtectedTokens(fallbackMasked, tokens);
      const fallbackScrubbed = scrubNoAiSlop(fallbackRestored);
      return {
        text: fallbackScrubbed,
        changed: fallbackScrubbed !== raw,
        modeUsed: "offline-fallback",
        warnings: [...warnings, "reverted to offline fallback to preserve tokens"],
      };
    } catch (err) {
      const fallbackMasked = applyOfflineVietlishNormalization(masked);
      const fallbackRestored = restoreProtectedTokens(fallbackMasked, tokens);
      const fallbackScrubbed = scrubNoAiSlop(fallbackRestored);
      const warnings = checkSemanticDrift(raw, fallbackScrubbed);
      const reason = err instanceof Error ? err.message : String(err);
      return {
        text: fallbackScrubbed,
        changed: fallbackScrubbed !== raw,
        modeUsed: "offline-fallback",
        warnings: [...warnings, `translate fallback: ${reason}`],
      };
    }
  }

  const fallbackMasked = applyOfflineVietlishNormalization(masked);
  const fallbackRestored = restoreProtectedTokens(fallbackMasked, tokens);
  const fallbackScrubbed = scrubNoAiSlop(fallbackRestored);
  const warnings = checkSemanticDrift(raw, fallbackScrubbed);
  return {
    text: fallbackScrubbed,
    changed: fallbackScrubbed !== raw,
    modeUsed: "offline-fallback",
    warnings,
  };
}

// change_voice_style: when the viewer asks for a different voice (温柔一点, 换回原来的), the LLM
// names a style and the session's TTS switches to that style's voice mid-call.
import {
  activePersona,
  cpSlice,
  envEntries,
  logger,
  pyRepr,
  pyStr,
  pyStrip,
  sortedPy,
} from "@eidolon/config";
import type { LlmTool, ToolSchema } from "@eidolon/core";
import {
  LEGACY_VOICE_STYLE_PREFIX,
  trySelect,
  VOICE_STYLE_PREFIX,
  voiceOf,
} from "@eidolon/providers";

export const VOICE_TOOL_NAME = "change_voice_style";

/** The persona's own voice's style; the LLM passes it to switch back. */
export const DEFAULT_STYLE = "default";

// A style with no entry here still works; the LLM infers from the bare name.
export const STYLE_HINTS: Readonly<Record<string, string>> = {
  default: "默认/原来的/正常的声音",
  gentle: "温柔/温和/轻柔/温暖/柔一点",
  lively: "活泼/精神/有活力/欢快/明亮/营业声线",
  calm: "平静/冷静/沉稳",
  sweet: "甜美/可爱/软糯",
  playful: "俏皮/调皮/调侃",
};

const description = (fans: string): string =>
  `切换主播声线风格。**只在${fans}明确要求换声音时调用** —— ` +
  "例如『声音温柔一点』『换个活泼的』『换回原来的声音』。" +
  "不要主动切换，不要在打招呼时切换；只在用户表达想换声音时调用。" +
  "切换后用一两句话自然回应（『嗯，这样可以嘛』），不要照念工具名。";

/** Style name → the TTS provider's voice id: `default` the persona's voice, others its styles. */
export type VoiceStyles = ReadonlyMap<string, string>;

/**
 * Every configured voice, in environment order: `TTS_VOICE_ID_GENTLE` becomes style `gentle`,
 * and while Fish speaks, so does Fish's `FISH_VOICE_ID_GENTLE`, which the former overrides. A
 * blank one counts as "not configured" rather than as an empty voice id.
 */
export function loadVoiceStyles(
  env: Readonly<Record<string, string | undefined>> = Object.fromEntries(envEntries()),
): Map<string, string> {
  const read = (name: string) => env[name] || undefined;
  const styles = new Map<string, string>();
  // A voice provider that doesn't exist fails the call where its TTS is built.
  const selection = trySelect("voice", read);
  if (selection === null) return styles;
  const base = voiceOf(selection, read);
  if (base) styles.set(DEFAULT_STYLE, base);
  const prefixes =
    selection.provider.id === "fish"
      ? [LEGACY_VOICE_STYLE_PREFIX, VOICE_STYLE_PREFIX]
      : [VOICE_STYLE_PREFIX];
  for (const prefix of prefixes) {
    for (const [key, value] of Object.entries(env)) {
      if (!key.startsWith(prefix)) continue;
      const cleaned = pyStrip(value ?? "");
      const suffix = key.slice(prefix.length).toLowerCase();
      if (cleaned && suffix) styles.set(suffix, cleaned);
    }
  }
  return styles;
}

/** The configured styles other than `default`, sorted. */
export function alternativeStyleNames(styles: VoiceStyles): string[] {
  return sortedPy([...styles.keys()].filter((style) => style !== DEFAULT_STYLE));
}

/** The enum covers exactly the configured styles, so the model can't ask for one that isn't wired. */
export function voiceToolSchema(styles: VoiceStyles): ToolSchema {
  const styleNames = sortedPy(styles.keys());
  // Own keys only: a style named `constructor` must not pick up Object.prototype's.
  const hints = styleNames.map(
    (style) => `\`${style}\` (${Object.hasOwn(STYLE_HINTS, style) ? STYLE_HINTS[style] : style})`,
  );
  return {
    name: VOICE_TOOL_NAME,
    description: description(activePersona().identity.fans),
    properties: {
      style: { type: "string", description: `声线名称。${hints.join("; ")}。`, enum: styleNames },
    },
    required: ["style"],
  };
}

/**
 * The tool, or null when only `default` is configured — a one-value enum wastes tokens and draws
 * spurious no-op calls, so nothing is offered at all.
 */
export function createVoiceTool(styles: VoiceStyles): LlmTool | null {
  const alternatives = alternativeStyleNames(styles);
  if (alternatives.length === 0) {
    logger.info("[voice] Voice switching disabled (no TTS_VOICE_ID_<STYLE> voices set).");
    return null;
  }
  const schema = voiceToolSchema(styles);
  logger.info(
    `[voice] Voice switching enabled. Default=${pyRepr(DEFAULT_STYLE)}, alternatives=${pyRepr(alternatives)}.`,
  );
  return {
    schema,
    cancelOnInterruption: true,
    timeoutSecs: null,
    async run({ arguments: args }, effects) {
      const raw = args.style;
      const style = raw === undefined || raw === null ? "" : pyStrip(pyStr(raw)).toLowerCase();
      const voiceId = styles.get(style);
      if (!voiceId) {
        const available = sortedPy(styles.keys());
        logger.warning(
          `[voice] LLM requested unknown style ${pyRepr(raw)}; configured: ${pyRepr(available)}`,
        );
        return { ok: false, error: `unknown style ${pyRepr(raw)}`, available };
      }
      logger.info(
        `[voice] Switching style → ${pyRepr(style)} (reference_id=${cpSlice(voiceId, 0, 8)}…)`,
      );
      // Before the result: both leave through the LLM's downstream queue, so FIFO gets the new voice
      // to TTS ahead of the first text token of its acknowledgment.
      await effects.switchVoice(voiceId);
      return { ok: true, style };
    },
  };
}

/** The persona-prefix line naming the styles, or "" when the tool is not offered. */
export function voicePromptHint(styles: VoiceStyles): string {
  const alternatives = alternativeStyleNames(styles);
  if (alternatives.length === 0) return "";
  return (
    `如果${activePersona().identity.fans}明确要求换声音（『温柔一点』『换个声音』『换回原来的』之类），` +
    `调用 ${VOICE_TOOL_NAME} 工具，参数 style 可选：` +
    [DEFAULT_STYLE, ...alternatives].join("、") +
    "。不要主动切换；平时保持默认声线。"
  );
}

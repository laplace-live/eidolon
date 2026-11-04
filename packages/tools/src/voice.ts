// change_voice_style: when the viewer asks for a different voice (温柔一点, 换回原来的), the LLM
// names a style and the session's Fish TTS switches to that style's reference id mid-call.
import { cpSlice, logger, pyRepr, pyStr, pyStrip, sortedPy } from "@eidolon/config";
import type { LlmTool, ToolSchema } from "@eidolon/core";

export const VOICE_TOOL_NAME = "change_voice_style";

/** FISH_VOICE_ID's style, the persona's own voice; the LLM passes it to switch back. */
export const DEFAULT_STYLE = "default";

/** `FISH_VOICE_ID_GENTLE` becomes style `gentle`, `FISH_VOICE_ID_NAI_HEI` style `nai_hei`. */
export const VOICE_ENV_PREFIX = "FISH_VOICE_ID_";

// A style with no entry here still works; the LLM infers from the bare name.
export const STYLE_HINTS: Readonly<Record<string, string>> = {
  default: "默认/原来的/正常的声音",
  gentle: "温柔/温和/轻柔/温暖/柔一点",
  lively: "活泼/精神/有活力/欢快/明亮/营业声线",
  calm: "平静/冷静/沉稳",
  sweet: "甜美/可爱/软糯",
  playful: "俏皮/调皮/调侃",
};

const DESCRIPTION =
  "切换主播声线风格。**只在奶糖花明确要求换声音时调用** —— " +
  "例如『声音温柔一点』『换个活泼的』『换回原来的声音』。" +
  "不要主动切换，不要在打招呼时切换；只在用户表达想换声音时调用。" +
  "切换后用一两句话自然回应（『嗯，这样可以嘛』），不要照念工具名。";

/** Style name → Fish Audio reference id: `default` from FISH_VOICE_ID, others FISH_VOICE_ID_<STYLE>. */
export type VoiceStyles = ReadonlyMap<string, string>;

/**
 * Every configured voice, in environment order. A blank `FISH_VOICE_ID_GENTLE=` counts as "not
 * configured" rather than as an empty voice id.
 */
export function loadVoiceStyles(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Map<string, string> {
  const styles = new Map<string, string>();
  const base = pyStrip(env.FISH_VOICE_ID ?? "");
  if (base) styles.set(DEFAULT_STYLE, base);
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(VOICE_ENV_PREFIX)) continue;
    const cleaned = pyStrip(value ?? "");
    const suffix = key.slice(VOICE_ENV_PREFIX.length).toLowerCase();
    if (cleaned && suffix) styles.set(suffix, cleaned);
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
    description: DESCRIPTION,
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
    logger.info("[voice] Voice switching disabled (no FISH_VOICE_ID_<STYLE> env vars set).");
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
    "如果奶糖花明确要求换声音（『温柔一点』『换个声音』『换回原来的』之类），" +
    `调用 ${VOICE_TOOL_NAME} 工具，参数 style 可选：` +
    [DEFAULT_STYLE, ...alternatives].join("、") +
    "。不要主动切换；平时保持默认声线。"
  );
}

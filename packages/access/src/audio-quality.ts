// The per-session Opus bitrate a viewer picks with the offer's `requestData.audioQuality`.
import { envInt, logger, pyRepr, pyStrip, pyStrRepr } from "@eidolon/config";

/** Best to lowest. */
export const AUDIO_QUALITIES = ["best", "medium", "low", "lowest"] as const;
export type AudioQuality = (typeof AUDIO_QUALITIES)[number];

export interface AudioQualitySettings {
  readonly presetsBps: Readonly<Record<AudioQuality, number>>;
  /** EIDOLON_OPUS_BITRATE_BPS, defaulting to the resolved medium preset. */
  readonly defaultBitrateBps: number;
}

/** Read from the env on every call; values are not clamped. */
export function audioQualitySettingsFromEnv(): AudioQualitySettings {
  // `lowest` sits under Opus's ~16 kbps wideband floor: still intelligible, but the persona's
  // timbre audibly degrades. It's for connections where the alternative is a dropped call.
  const presetsBps = Object.freeze({
    best: envInt("EIDOLON_OPUS_BITRATE_BEST_BPS", 192000),
    medium: envInt("EIDOLON_OPUS_BITRATE_MEDIUM_BPS", 96000),
    low: envInt("EIDOLON_OPUS_BITRATE_LOW_BPS", 64000),
    lowest: envInt("EIDOLON_OPUS_BITRATE_LOWEST_BPS", 8000),
  });
  // The medium preset, including any override of it, so a client that omits the field encodes
  // identically to one that asks for medium.
  const defaultBitrateBps = envInt("EIDOLON_OPUS_BITRATE_BPS", presetsBps.medium);
  return Object.freeze({ presetsBps, defaultBitrateBps });
}

let processSettings: AudioQualitySettings | undefined;

/** The process's settings, read once on first use (after the .env load). */
export function audioQualitySettings(): AudioQualitySettings {
  processSettings ??= audioQualitySettingsFromEnv();
  return processSettings;
}

export function qualityChoices(): AudioQuality[] {
  return [...AUDIO_QUALITIES];
}

function isAudioQuality(name: string): name is AudioQuality {
  return (AUDIO_QUALITIES as readonly string[]).includes(name);
}

const kbps = (bps: number): number => Math.floor(bps / 1000);

/**
 * A preset's bitrate, or null for anything that isn't a preset name. The body is
 * user-controlled, so non-strings arrive here too.
 */
export function resolveQualityBitrate(
  quality: unknown,
  settings: AudioQualitySettings = audioQualitySettings(),
): number | null {
  if (typeof quality !== "string") return null;
  const name = pyStrip(quality).toLowerCase();
  return isAudioQuality(name) ? settings.presetsBps[name] : null;
}

/**
 * The bitrate a new connection encodes at. Missing or blank keeps the default silently; anything
 * but a preset name keeps it with a warning. Only named presets are accepted: arbitrary integers
 * would let a client pin 1 Mbps per session and saturate uplink.
 */
export function sessionBitrateFor(
  raw: unknown,
  settings: AudioQualitySettings = audioQualitySettings(),
): number {
  if (raw === undefined || raw === null || (typeof raw === "string" && !pyStrip(raw))) {
    return settings.defaultBitrateBps;
  }
  const bitrate = resolveQualityBitrate(raw, settings);
  if (bitrate === null) {
    logger.warning(
      `[offer-middleware] Unknown audioQuality=${pyRepr(raw)}; ` +
        `valid choices: ${pyRepr(qualityChoices())}. ` +
        `Falling back to default ${kbps(settings.defaultBitrateBps)} kbps.`,
    );
    return settings.defaultBitrateBps;
  }
  logger.info(
    `[offer-middleware] audioQuality=${pyStrRepr(pyStrip(String(raw)).toLowerCase())} ` +
      `→ Opus bitrate ${kbps(bitrate)} kbps for this session`,
  );
  return bitrate;
}

/** The boot log line bot.py printed: `[WebRTC] Opus encoder bitrate: default …, presets …`. */
export function describeOpusBitrates(settings: AudioQualitySettings): string {
  const presets = AUDIO_QUALITIES.map((name) => `${name}=${kbps(settings.presetsBps[name])}kbps`);
  return (
    `[WebRTC] Opus encoder bitrate: default ${kbps(settings.defaultBitrateBps)} kbps, ` +
    `presets ${presets.join(", ")}`
  );
}

// What a call's speech recognition and synthesis use, reported to the usage ledger. LLM requests
// report themselves from their HTTP client; audio and spoken text are counted here, as each
// service takes them, and reported in batches so a long call writes a handful of records.
import { priceOf, reportUsage, type Selection, textUnits, type Units } from "@eidolon/providers";
import { type Frame, InputAudioRawFrame } from "@pipedog/core/frames/frames";
import type { LLMTokenUsage } from "@pipedog/core/metrics/metrics";
import type { FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import type { LLMService } from "@pipedog/core/services/llm_service";
import type { TTSService } from "@pipedog/core/services/tts_service";

/** Report once this much audio, or text, has piled up, and at the end of the call. */
const AUDIO_BATCH_SECONDS = 300;
const TEXT_BATCH_CHARACTERS = 2000;

class Meter {
  #units: { audioSeconds: number; characters: number; bytes: number } = {
    audioSeconds: 0,
    characters: 0,
    bytes: 0,
  };
  readonly #selection: Selection;

  constructor(selection: Selection) {
    this.#selection = selection;
  }

  add(units: Pick<Units, "audioSeconds" | "characters" | "bytes">): void {
    this.#units.audioSeconds += units.audioSeconds ?? 0;
    this.#units.characters += units.characters ?? 0;
    this.#units.bytes += units.bytes ?? 0;
    if (
      this.#units.audioSeconds >= AUDIO_BATCH_SECONDS ||
      this.#units.characters >= TEXT_BATCH_CHARACTERS
    ) {
      this.flush();
    }
  }

  flush(): void {
    const { audioSeconds, characters, bytes } = this.#units;
    if (audioSeconds === 0 && characters === 0) return;
    this.#units = { audioSeconds: 0, characters: 0, bytes: 0 };
    const { role, provider, model } = this.#selection;
    reportUsage({
      role: role.id,
      provider: provider.id,
      model,
      units: audioSeconds > 0 ? { audioSeconds } : { characters, bytes },
    });
  }
}

/** Counts the audio `processor` hears, once as it arrives: a reconnect replays what it buffered. */
export function meterAudio<T extends FrameProcessor>(processor: T, selection: Selection): T {
  const meter = new Meter(selection);
  const receive = processor.processFrame.bind(processor);
  processor.processFrame = (frame: Frame, direction: FrameDirection) => {
    if (frame instanceof InputAudioRawFrame) {
      const bytesPerSecond = frame.sampleRate * frame.numChannels * 2;
      if (bytesPerSecond > 0) meter.add({ audioSeconds: frame.audio.byteLength / bytesPerSecond });
    }
    return receive(frame, direction);
  };
  const cleanup = processor.cleanup.bind(processor);
  processor.cleanup = async () => {
    meter.flush();
    await cleanup();
  };
  return processor;
}

/** Counts the text `tts` speaks, as it goes out after the text filters. */
export function meterTts<T extends TTSService>(tts: T, selection: Selection): T {
  const meter = new Meter(selection);
  const speak = tts.runTts.bind(tts);
  tts.runTts = (text: string, contextId: string) => {
    meter.add(textUnits(text));
    return speak(text, contextId);
  };
  const cleanup = tts.cleanup.bind(tts);
  tts.cleanup = async () => {
    meter.flush();
    await cleanup();
  };
  return tts;
}

/**
 * A realtime model's usage: the audio it hears, for a model priced by the hour, else the tokens
 * each response reports.
 */
export function meterRealtime<T extends LLMService<any>>(llm: T, selection: Selection): T {
  const price = priceOf(selection.provider.id, "realtime", selection.model);
  if (price?.unit === "audio-hours") return meterAudio(llm, selection);
  const started = llm.startLlmUsageMetrics.bind(llm);
  llm.startLlmUsageMetrics = (tokens: LLMTokenUsage) => {
    const cached = tokens.cacheReadInputTokens ?? 0;
    reportUsage({
      role: "realtime",
      provider: selection.provider.id,
      model: selection.model,
      units: {
        inputTokens: Math.max(0, tokens.promptTokens - cached),
        cachedTokens: cached,
        outputTokens: tokens.completionTokens,
      },
    });
    return started(tokens);
  };
  return llm;
}

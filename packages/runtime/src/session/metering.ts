// What a call's speech recognition and synthesis use, reported to the usage ledger. LLM requests
// report themselves from their HTTP client; audio and spoken text are counted here, as each
// service takes them, through a `Meter`.
import { Meter, priceOf, reportUsage, type Selection, textUnits } from "@eidolon/providers";
import { type Frame, InputAudioRawFrame } from "@pipedog/core/frames/frames";
import type { LLMTokenUsage } from "@pipedog/core/metrics/metrics";
import type { FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import type { LLMService } from "@pipedog/core/services/llm_service";
import type { TTSService } from "@pipedog/core/services/tts_service";

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

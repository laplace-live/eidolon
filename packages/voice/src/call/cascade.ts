// A call that hears through her hearing role, thinks through the engine and speaks through her
// voice role: the Ear, the Floor, her Mouth and the Speaker around one mailbox, from the client's
// connection to the call's end.
import { joinSegments } from "@eidolon/chat";
import { errorText, logger, withPersona } from "@eidolon/config";
import { INTERRUPTED_EMPTY_TURN_PROMPT } from "@eidolon/context";
import { selectRequired } from "@eidolon/providers";
import type { SttStream } from "@eidolon/providers/stt";
import { runEar } from "../input/ear.ts";
import { sharedSession } from "../input/onnx.ts";
import { SmartTurn } from "../input/smart_turn.ts";
import { Vad } from "../input/vad.ts";
import { Mouth, voiceTraits } from "../output/mouth.ts";
import { createSpeaker } from "../output/speaker.ts";
import { readRtvi } from "../rtvi/codec.ts";
import { RtviEmitter } from "../rtvi/emitter.ts";
import type {
  CallDeps,
  CallPlan,
  CallTransport,
  Clock,
  CloseReason,
  EarEvent,
  Pcm,
} from "../types.ts";
import { Floor } from "./floor.ts";
import { CallKit } from "./kit.ts";

/** Hears the caller until `signal` aborts, posting her turns. */
export type Ear = (
  audio: AsyncIterable<Pcm>,
  stt: SttStream,
  post: (event: EarEvent) => void,
  signal: AbortSignal,
) => Promise<void>;

/** The Ear on the VAD and Smart Turn models, once both have loaded. */
async function modelEar(models: CallDeps["models"], clock: Clock): Promise<Ear> {
  const vad = new Vad(models.silero);
  await Promise.all([vad.ready(), sharedSession(models.smartTurn)]);
  const turn = new SmartTurn(models.smartTurn, clock);
  return (audio, stt, post, signal) =>
    runEar(audio, { stt, vad, turn, clock, join: joinSegments }, post, signal);
}

/**
 * Runs the call on `transport` until it ends. Rejects when it can't start: a role with no key, a
 * recognizer that can't connect, a model that can't load; what it opened is closed by then.
 */
export async function runCascadeCall(
  transport: CallTransport,
  plan: CallPlan,
  deps: CallDeps,
  signal: AbortSignal,
  options: { readonly ear?: Ear } = {},
): Promise<CloseReason> {
  const kit = new CallKit(deps.clock);
  const listening = new AbortController();
  let closed: Promise<void> | null = null;
  const close = (): Promise<void> => {
    listening.abort();
    closed ??= kit.close();
    return closed;
  };
  const onShutdown = (): void => kit.post({ source: "shutdown" });
  try {
    const speaker = createSpeaker((event) => kit.post({ source: "speaker", event }));
    const { stt, mouth } = await withPersona(plan.host, async () => {
      const traits = voiceTraits(selectRequired("voice"));
      const mouth = new Mouth({
        persona: plan.host,
        speech: deps.openSpeech(),
        ...traits,
        speaker,
        join: joinSegments,
        clock: deps.clock,
        post: (event) => kit.post({ source: "mouth", event }),
      });
      kit.own("her voice", mouth);
      const stt = await deps.openStt(listening.signal);
      kit.own("her hearing", stt);
      return { stt, mouth };
    });
    const ear = options.ear ?? (await modelEar(deps.models, deps.clock));
    const floor = new Floor({
      plan,
      kit,
      emitter: new RtviEmitter((message) => transport.send(message), deps.about),
      speaker,
      mouth,
      turn: (request) => deps.runTurn(request, deps.engine),
      nudge: INTERRUPTED_EMPTY_TURN_PROMPT,
      newId: () => Bun.randomUUIDv7(),
      onEnding: () => void close(),
    });

    void (async () => {
      for await (const message of transport.messages) {
        kit.post({ source: "rtvi", message: readRtvi(message) });
      }
    })().catch((error: unknown) => {
      logger.error(`[voice] The client's messages failed: ${errorText(error)}`, error);
    });
    void transport.closed.then(() => kit.post({ source: "transport" }));
    signal.addEventListener("abort", onShutdown, { once: true });
    if (signal.aborted) onShutdown();
    transport.attachSpeaker(speaker);
    await transport.connect();
    logger.info("Client connected");

    kit.active();
    ear(
      transport.audioIn,
      stt,
      (event) => kit.post({ source: "ear", event }),
      listening.signal,
    ).catch((error: unknown) => {
      logger.error(`[voice] Hearing failed: ${errorText(error)}`, error);
      const event: EarEvent = { type: "stt-error", message: errorText(error), fatal: true };
      kit.post({ source: "ear", event });
    });
    for await (const event of kit.events) {
      floor.handle(event);
      if (floor.finished !== null) break;
    }
    const reason = floor.finished ?? "shutdown";
    kit.stop();
    await close();
    await plan.log.flush();
    if (reason !== "client") {
      await transport.disconnect().catch((error: unknown) => {
        logger.warning(`[voice] Disconnecting the client failed: ${errorText(error)}`);
      });
    }
    logger.info(reason === "client" ? "Client disconnected" : `Call ended: ${reason}`);
    return reason;
  } finally {
    signal.removeEventListener("abort", onShutdown);
    kit.stop();
    await close();
  }
}

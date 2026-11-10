// A call that hears through her hearing role, thinks through the engine and speaks through her
// voice role: the Ear, the Floor, her Mouth and the Speaker around one mailbox, from the client's
// connection to the call's end.
import { joinSegments } from "@eidolon/chat";
import { errorText, logger, withPersona } from "@eidolon/config";
import { INTERRUPTED_EMPTY_TURN_PROMPT } from "@eidolon/context";
import type { SttStream } from "@eidolon/providers/stt";
import { runEar } from "../input/ear.ts";
import { sharedSession } from "../input/onnx.ts";
import { SmartTurn } from "../input/smart_turn.ts";
import { Vad } from "../input/vad.ts";
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
import { groupOf, openGroup, openMouth } from "./group.ts";
import { runCall } from "./kit.ts";

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
export function runCascadeCall(
  transport: CallTransport,
  plan: CallPlan,
  deps: CallDeps,
  signal: AbortSignal,
  options: { readonly ear?: Ear } = {},
): Promise<CloseReason> {
  return runCall(
    transport,
    plan,
    deps.clock,
    signal,
    async ({ kit, speaker, listening, close }) => {
      // A group's Mouths, each in her own persona scope; the host hears for all of them.
      const group = plan.group
        ? openGroup(groupOf(plan.log.snapshot()), { kit, speaker, deps })
        : null;
      const { stt, mouth } = await withPersona(plan.host, async () => {
        const mouth =
          group?.mouthOf(plan.host) ?? openMouth(plan.host, { kit, speaker, deps }, "her voice");
        // Made here as pipedog's session makes its LLM, so a mind role with no key fails the call
        // before it connects.
        deps.engine.createMind();
        const stt = await deps.openStt(listening);
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
        ...(group === null ? {} : { group }),
      });
      const listen = (): void => {
        ear(transport.audioIn, stt, (event) => kit.post({ source: "ear", event }), listening).catch(
          (error: unknown) => {
            logger.error(`[voice] Hearing failed: ${errorText(error)}`, error);
            const event: EarEvent = { type: "stt-error", message: errorText(error), fatal: true };
            kit.post({ source: "ear", event });
          },
        );
      };
      return { floor, listen };
    },
  );
}

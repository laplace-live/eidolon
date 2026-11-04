import type { ContextProvider, ConversationContext, FrameMetadata } from "@eidolon/core";
import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import { type Frame, LLMContextFrame } from "@pipedog/core/frames/frames";
import type { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { type FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";

const instances = new Map<string, number>();

/** `label#n`, numbered per label the way Pipecat numbers a class's instances in its logs. */
function processorName(label: string): string {
  const n = instances.get(label) ?? 0;
  instances.set(label, n + 1);
  return `${label}#${n}`;
}

export type ConversationOf = (context: LLMContext) => ConversationContext;

/** Runs a ContextProvider on each LLMContextFrame, then passes the frame downstream. */
export class ContextProviderProcessor extends FrameProcessor {
  readonly #provider: ContextProvider;
  readonly #conversation: ConversationOf;

  constructor(provider: ContextProvider, options: { label: string; conversation: ConversationOf }) {
    super({ name: processorName(options.label) });
    this.#provider = provider;
    this.#conversation = options.conversation;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (!(frame instanceof LLMContextFrame)) {
      await this.pushFrame(frame, direction);
      return;
    }
    try {
      // pipedog cancels only at its own awaits; abortable makes the provider's foreign I/O one,
      // so an interruption doesn't outlive the 1 s cancel timeout.
      await abortable(
        this.#provider.onContext({
          context: this.#conversation(frame.context),
          metadata: frame.metadata,
          signal: currentSignal(),
          spawn: (name, job) => {
            this.createTask(job, name);
          },
        }),
      );
      await this.pushFrame(frame);
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(this.#provider.errorMessage(e), { exception: e });
      await this.pushFrame(frame);
    }
  }
}

/** The retrieval gate as the processor sees it. */
export interface TurnGate {
  attach(messages: readonly unknown[], metadata: FrameMetadata): void;
}

/** Attaches the gate's decision for the current user turn to every context frame of that turn. */
export class RetrievalGateProcessor extends FrameProcessor {
  readonly #gate: TurnGate;

  constructor(gate: TurnGate) {
    super({ name: processorName("RetrievalGate") });
    this.#gate = gate;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof LLMContextFrame) {
      this.#gate.attach(frame.context.getMessages(), frame.metadata);
    }
    await this.pushFrame(frame, direction);
  }
}

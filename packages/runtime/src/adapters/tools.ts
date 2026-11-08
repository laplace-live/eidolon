import type { ConversationContext, LlmTool, ToolEffects } from "@eidolon/core";
import { currentSignal } from "@pipedog/asyncio";
import { FunctionSchema } from "@pipedog/core/adapters/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/schemas/tools_schema";
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import type {
  LLMContext,
  LLMContextMessage,
} from "@pipedog/core/processors/aggregators/llm_context";
import type { FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { RTVIServerMessageFrame } from "@pipedog/core/processors/frameworks/rtvi/frames";
import type { FunctionCallParams, LLMService } from "@pipedog/core/services/llm_service";
import { TTSSettings } from "@pipedog/core/services/settings";

/** A settings delta of the TTS service's own class, the one its update applies. */
function voiceDelta(tts: FrameProcessor, voice: string): TTSSettings {
  const own = (tts.constructor as { Settings?: new (o: object) => TTSSettings }).Settings;
  return new (own ?? TTSSettings)({ voice });
}

/** The session's LLM tools, advertised in the order they were registered. */
export class SessionTools {
  readonly #llm: LLMService<any>;
  readonly #tts: FrameProcessor | null;
  readonly #schemas: FunctionSchema[] = [];

  /** `tts` is null under a realtime model, which no tool can switch the voice of. */
  constructor(llm: LLMService<any>, tts: FrameProcessor | null) {
    this.#llm = llm;
    this.#tts = tts;
  }

  get size(): number {
    return this.#schemas.length;
  }

  register(tool: LlmTool): void {
    const { name, description, properties, required } = tool.schema;
    // No `handler` here: pipedog auto-registers a schema's handler and unregisters it whenever
    // the tool stops being advertised, as setHiddenTools does to recall_streams.
    this.#schemas.push(
      new FunctionSchema({
        name,
        description,
        properties: { ...properties },
        required: [...required],
      }),
    );
    this.#llm.registerFunction(
      name,
      async (params) => {
        // Awaited in the function-call task itself: the effects push from it, and its
        // cancellation (interruption or timeout) aborts the signal.
        const result = await tool.run(
          {
            arguments: params.arguments,
            context: this.conversation(params.context),
            signal: currentSignal(),
          },
          this.#effects(params),
        );
        await params.resultCallback(result);
      },
      { cancelOnInterruption: tool.cancelOnInterruption, timeoutSecs: tool.timeoutSecs },
    );
  }

  /** Every registered tool but `hidden`. An empty schema is no tools at all to LLMContext. */
  toolsSchema(hidden: readonly string[] = []): ToolsSchema {
    return new ToolsSchema({
      standardTools: this.#schemas.filter((schema) => !hidden.includes(schema.name)),
    });
  }

  conversation(context: LLMContext): ConversationContext {
    return {
      getMessages: () => context.getMessages(),
      setMessages: (messages) => context.setMessages(messages as LLMContextMessage[]),
      setHiddenTools: (names) => context.setTools(this.toolsSchema(names)),
    };
  }

  // Both push downstream from the LLM, into the same queue as the reply's text, so the voice
  // change reaches TTS and the server-message reaches the RTVI observer ahead of the result.
  #effects(params: FunctionCallParams): ToolEffects {
    return {
      switchVoice: async (voice) => {
        const tts = this.#tts;
        if (tts === null) throw new Error("A realtime model's voice can't change mid-call");
        await params.llm.pushFrame(
          new TTSUpdateSettingsFrame({ delta: voiceDelta(tts, voice), service: tts }),
        );
      },
      sendServerMessage: (data) => params.llm.pushFrame(new RTVIServerMessageFrame({ data })),
    };
  }
}

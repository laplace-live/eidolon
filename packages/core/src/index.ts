// The extension contracts. Context providers and LLM tools implement these; @eidolon/engine's turn
// runs them, in a chat and in a call alike.

/** A turn's LLM conversation, as the engine keeps it. */
export interface ConversationContext {
  /** The live message list. Messages are OpenAI-shaped objects, but check before trusting it. */
  getMessages(): unknown[];
  setMessages(messages: unknown[]): void;
  /**
   * Advertise every registered tool except `names`. `[]` restores the full set. The engine owns
   * the full list, so callers never need to snapshot it.
   */
  setHiddenTools(names: readonly string[]): void;
  /**
   * The user turn's id, from a caller that knows its turns: a chat's windowed view can repeat the
   * last turn's messages exactly, so a new id is a new turn even then.
   */
  readonly turn?: string;
}

/** A turn's metadata, shared by its providers, e.g. the retrieval gate's decision. */
export type FrameMetadata = Record<string, unknown>;

export interface ContextTurn {
  readonly context: ConversationContext;
  readonly metadata: FrameMetadata;
  /** Aborts when the turn is interrupted. Never mutate `context` after it aborts. */
  readonly signal: AbortSignal;
  /** Run `job` past this turn; it is not cancelled by `signal`. Rejections are logged. */
  spawn(name: string, job: () => Promise<void>): void;
}

/** Enriches the LLM context before each inference: RAG blocks, recalled memories. */
export interface ContextProvider {
  /**
   * Rejecting reports a non-fatal error (the turn logs `errorMessage(e)`, and a call shows it as a
   * notice) and the turn continues without this provider. An aborted turn rejects with
   * `signal.reason`.
   */
  onContext(turn: ContextTurn): Promise<void>;
  /** The error text for a rejection. */
  errorMessage(error: unknown): string;
}

/** The retrieval gate as a turn sees it: it attaches its decision to the turn's metadata. */
export interface TurnGate {
  /** `turn` is `ConversationContext.turn`, from a caller that knows its turns. */
  attach(messages: readonly unknown[], metadata: FrameMetadata, turn?: string): void;
}

/** An OpenAI function schema, without the `type: "object"` wrapper. */
export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: readonly string[];
}

export type ToolResult = Readonly<Record<string, unknown>>;

export interface ToolCall {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly context: ConversationContext;
  /** Aborts when the call is cancelled (interruption when `cancelOnInterruption`, or timeout). */
  readonly signal: AbortSignal;
}

/** Side effects a tool may cause. */
export interface ToolEffects {
  /** Switch the TTS voice (the TTS provider's voice id) for the rest of the session. */
  switchVoice(referenceId: string): Promise<void>;
  /** Send an RTVI `server-message` with `data` to the client. */
  sendServerMessage(data: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface LlmTool {
  readonly schema: ToolSchema;
  readonly cancelOnInterruption: boolean;
  /** `null` runs the tool with no timeout. */
  readonly timeoutSecs: number | null;
  /**
   * Resolves with the result the LLM sees. Awaited directly inside the function-call task, so
   * every effect must resolve before this does. Rejects only with `call.signal.reason`.
   */
  run(call: ToolCall, effects: ToolEffects): Promise<ToolResult>;
}

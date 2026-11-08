import type { AllowedOffer, UserContext } from "@eidolon/access";
import { cpLen, errorText, logger, pyRepr } from "@eidolon/config";
import type { ContextProvider, LlmTool } from "@eidolon/core";
import { withUsageScope } from "@eidolon/providers";
import { ingestHint, PERSONA_FACTS, STREAM_ARCHIVE } from "@eidolon/retrieval";
import type { VoiceStyles } from "@eidolon/tools";
import { rethrowIfCancelled } from "@pipedog/asyncio";
import { LLMRunFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import {
  LLMContextAggregatorPair,
  LLMUserAggregatorParams,
} from "@pipedog/core/processors/aggregators/llm_response_universal";
import type { FrameProcessor } from "@pipedog/core/processors/frame_processor";
import type { LLMService } from "@pipedog/core/services/llm_service";
import { type BaseTransport, TransportParams } from "@pipedog/core/transports/base_transport";
import { EmptyUserTurnConfig } from "@pipedog/core/turns/empty_user_turn";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import type { OnnxBackend } from "@pipedog/onnx";
import type { SmallWebRTCConnection } from "@pipedog/transport-smallwebrtc/connection";
import { SmallWebRTCTransport } from "@pipedog/transport-smallwebrtc/transport";
import {
  ContextProviderProcessor,
  RetrievalGateProcessor,
  type TurnGate,
} from "../adapters/context.ts";
import { SessionTools } from "../adapters/tools.ts";
import { createUserTurnStrategies, createVadAnalyzer } from "../audio.ts";
import { LaplaceRTVIProcessor } from "../rtvi.ts";

/** The stream archive: a context provider that may also offer recall_streams. */
export interface ArchiveProvider extends ContextProvider {
  recallTool(): Promise<LlmTool | null>;
}

/** A logged-in viewer's Mem0 provider. */
export interface SessionMemory extends ContextProvider {
  newestFirst(): Promise<readonly { readonly memory?: unknown }[]>;
}

/** Everything a session takes from the other packages, so tests can stand in for any of it. */
export interface SessionDeps {
  /** One realtime model hears, thinks and speaks, in place of the three below. */
  isRealtime(): boolean;
  createRealtime(systemInstruction: string): LLMService<any>;
  createStt(): FrameProcessor;
  createTts(): FrameProcessor;
  createLlm(systemInstruction: string): LLMService<any>;
  loadVoiceStyles(): VoiceStyles;
  createVoiceTool(styles: VoiceStyles): LlmTool | null;
  voicePromptHint(styles: VoiceStyles): string;
  createSelfieTool(): LlmTool | null;
  selfiePromptHint(): string;
  buildSystemInstruction(input: {
    viewer: UserContext;
    voiceHint: string;
    selfieHint: string;
    realtime?: boolean;
  }): Promise<string>;
  readonly interruptedEmptyTurnPrompt: string;
  buildGreetingKickoff(memories: readonly { readonly memory?: unknown }[]): string;
  dbPath(): string;
  dbPathExists(path: string): Promise<boolean>;
  openArchive(dbPath: string): Promise<ArchiveProvider>;
  openFacts(dbPath: string): Promise<ContextProvider>;
  retrievalGateFromEnv(): TurnGate | null;
  isMemoryConfigured(): boolean;
  createMemoryProvider(options: { userId: string }): Promise<SessionMemory>;
  audioBackend(): Promise<OnnxBackend>;
}

export interface PipelineParts {
  readonly input: FrameProcessor;
  /** null for a realtime model, which hears for itself. */
  readonly stt: FrameProcessor | null;
  readonly user: FrameProcessor;
  readonly gate: FrameProcessor | null;
  readonly memory: FrameProcessor | null;
  readonly archive: FrameProcessor | null;
  readonly facts: FrameProcessor | null;
  readonly llm: FrameProcessor;
  /** null for a realtime model, which speaks for itself. */
  readonly tts: FrameProcessor | null;
  readonly output: FrameProcessor;
  readonly assistant: FrameProcessor;
}

export function assembleProcessors(parts: PipelineParts): FrameProcessor[] {
  // The gate's decision and archive recaps reach the RAG services through
  // frame metadata; the gate goes first so its call overlaps Mem0's search.
  const enrichment = [parts.gate, parts.memory, parts.archive, parts.facts].filter(
    (processor): processor is FrameProcessor => processor !== null,
  );
  return [
    parts.input,
    parts.stt,
    parts.user,
    ...enrichment,
    parts.llm,
    parts.tts,
    parts.output,
    parts.assistant,
  ].filter((processor): processor is FrameProcessor => processor !== null);
}

async function optionalProvider<T>(
  label: string,
  ingestCommand: string,
  dbPath: string,
  deps: Pick<SessionDeps, "dbPathExists">,
  open: (dbPath: string) => Promise<T>,
): Promise<T | null> {
  if (!(await deps.dbPathExists(dbPath))) {
    logger.info(
      `${label} disabled: no LanceDB index at ${dbPath}. Run \`${ingestHint(ingestCommand)}\` to build it.`,
    );
    return null;
  }
  try {
    return await open(dbPath);
  } catch (e) {
    rethrowIfCancelled(e);
    logger.warning(`${label} disabled: ${errorText(e)}`);
    return null;
  }
}

async function sessionMemory(
  user: UserContext,
  deps: Pick<SessionDeps, "isMemoryConfigured" | "createMemoryProvider">,
): Promise<SessionMemory | null> {
  // Keyed on Bilibili UID. Anonymous viewers skip Mem0 rather than share a
  // `default-user` bucket, where their memories would cross-pollute every
  // other anonymous conversation.
  if (!user.isLoggedIn) {
    logger.info("Mem0 skipped: anonymous viewer (no loginSyncToken / validation failed)");
    return null;
  }
  if (!deps.isMemoryConfigured()) {
    logger.info("Mem0 skipped: MEM0_QDRANT_HOST is unset, so there is no vector store");
    return null;
  }
  try {
    const memory = await deps.createMemoryProvider({ userId: String(user.mid) });
    logger.info(`Mem0 long-term memory enabled for user_id=${user.mid} (${pyRepr(user.uname)})`);
    return memory;
  } catch (e) {
    rethrowIfCancelled(e);
    // Constructing the engine reaches Qdrant to create the collection,
    // so an unreachable vector store surfaces here rather than at boot.
    logger.warning(`Mem0 unavailable, continuing without memory: ${errorText(e)}`);
    return null;
  }
}

export interface Session {
  readonly worker: PipelineWorker;
  readonly context: LLMContext;
  readonly memory: SessionMemory | null;
  readonly tools: SessionTools;
  readonly processors: readonly FrameProcessor[];
}

/** bot.py's `run_bot` up to the worker: services, tools, prompt, providers, pipeline. */
export async function buildSession(
  transport: BaseTransport,
  user: UserContext,
  deps: SessionDeps,
): Promise<Session> {
  const realtime = deps.isRealtime();
  const stt = realtime ? null : deps.createStt();
  const tts = realtime ? null : deps.createTts();
  const styles = realtime ? new Map<string, string>() : deps.loadVoiceStyles();
  // A realtime model's voice is fixed for the session: there is nothing to switch to.
  const voiceTool = realtime ? null : deps.createVoiceTool(styles);
  const selfieTool = deps.createSelfieTool();
  const systemInstruction = await deps.buildSystemInstruction({
    viewer: user,
    voiceHint: voiceTool ? deps.voicePromptHint(styles) : "",
    selfieHint: selfieTool ? deps.selfiePromptHint() : "",
    ...(realtime ? { realtime: true } : {}),
  });
  const llm = realtime ? deps.createRealtime(systemInstruction) : deps.createLlm(systemInstruction);

  const tools = new SessionTools(llm, tts);
  if (voiceTool) tools.register(voiceTool);
  if (selfieTool) tools.register(selfieTool);
  const dbPath = deps.dbPath();
  const archive = await optionalProvider(
    "Stream archive",
    STREAM_ARCHIVE.ingestCommand,
    dbPath,
    deps,
    deps.openArchive,
  );
  const recallTool = archive ? await archive.recallTool() : null;
  if (recallTool) tools.register(recallTool);

  const context =
    tools.size > 0 ? new LLMContext({ tools: tools.toolsSchema() }) : new LLMContext();
  const emptyUserTurn = new EmptyUserTurnConfig({
    interruptedPrompt: deps.interruptedEmptyTurnPrompt,
  });
  // A realtime model detects turns on its side and announces itself to the aggregator; a local
  // VAD beside it would end every turn twice.
  const backend = realtime ? null : await deps.audioBackend();
  const aggregators = new LLMContextAggregatorPair(context, {
    userParams: new LLMUserAggregatorParams({
      ...(backend === null
        ? {}
        : {
            vadAnalyzer: createVadAnalyzer(backend),
            userTurnStrategies: createUserTurnStrategies(backend),
          }),
      emptyUserTurn,
    }),
  });

  const memory = await sessionMemory(user, deps);
  const facts = await optionalProvider(
    "Persona facts",
    PERSONA_FACTS.ingestCommand,
    dbPath,
    deps,
    deps.openFacts,
  );
  const gate = archive || facts ? deps.retrievalGateFromEnv() : null;

  const conversation = tools.conversation.bind(tools);
  const processors = assembleProcessors({
    input: transport.input(),
    stt,
    user: aggregators.user(),
    gate: gate && new RetrievalGateProcessor(gate),
    memory:
      memory &&
      new ContextProviderProcessor(memory, { label: "LaplaceMem0MemoryService", conversation }),
    archive:
      archive &&
      new ContextProviderProcessor(archive, { label: "StreamArchiveService", conversation }),
    facts:
      facts && new ContextProviderProcessor(facts, { label: "PersonaFactsService", conversation }),
    llm,
    tts,
    output: transport.output(),
    assistant: aggregators.assistant(),
  });
  const worker = new PipelineWorker(new Pipeline(processors), {
    params: new PipelineParams({ enableMetrics: true, enableUsageMetrics: true }),
    observers: [],
    rtviProcessor: new LaplaceRTVIProcessor(),
  });
  return { worker, context, memory, tools, processors };
}

/** Kicks off the conversation once the client is ready, hinting at a few remembered things. */
export function installGreeting(
  worker: PipelineWorker,
  context: LLMContext,
  memory: Pick<SessionMemory, "newestFirst"> | null,
  buildKickoff: SessionDeps["buildGreetingKickoff"],
): void {
  worker.rtvi.eventHandler("on_client_ready", async () => {
    let memories: readonly { readonly memory?: unknown }[] = [];
    if (memory !== null) {
      try {
        memories = await memory.newestFirst();
      } catch (e) {
        rethrowIfCancelled(e);
        logger.warning(`Could not load Mem0 memories for greeting: ${errorText(e)}`);
      }
    }
    context.addMessage({ role: "user", content: buildKickoff(memories) });
    await worker.queueFrames([new LLMRunFrame()]);
  });
}

/** One session on `transport`, until its worker finishes. Rejects if setup fails. */
export async function runTransportSession(
  transport: BaseTransport,
  admission: Pick<AllowedOffer, "user" | "token" | "requestData">,
  deps: SessionDeps,
): Promise<void> {
  // Everything the call spends is recorded against it, whichever task spends it.
  return withUsageScope({ source: "call", session: crypto.randomUUID() }, () =>
    runScopedSession(transport, admission, deps),
  );
}

async function runScopedSession(
  transport: BaseTransport,
  admission: Pick<AllowedOffer, "user" | "token" | "requestData">,
  deps: SessionDeps,
): Promise<void> {
  // Logged either way: the "anonymous everywhere" failure mode is
  // otherwise silent, and this makes it one grep.
  if (admission.token) {
    logger.info(`[bot] Session start with loginSyncToken (len=${cpLen(admission.token)})`);
  } else {
    logger.info(
      `[bot] Session start without loginSyncToken; runner_args.body=${pyRepr(admission.requestData)}`,
    );
  }
  logger.info("Starting bot");
  const session = await buildSession(transport, admission.user, deps);
  installGreeting(session.worker, session.context, session.memory, deps.buildGreetingKickoff);
  transport.eventHandler("on_client_connected", async () => {
    logger.info("Client connected");
  });
  transport.eventHandler("on_client_disconnected", async () => {
    logger.info("Client disconnected");
    await session.worker.cancel();
  });
  const runner = new WorkerRunner({ handleSigint: false });
  await runner.addWorkers(session.worker);
  await runner.run();
}

export async function runSession(
  connection: SmallWebRTCConnection,
  admission: AllowedOffer,
  deps: SessionDeps,
): Promise<void> {
  const transport = new SmallWebRTCTransport(
    connection,
    new TransportParams({ audioInEnabled: true, audioOutEnabled: true }),
  );
  await runTransportSession(transport, admission, deps);
}

/** runSession for the background: never rejects. */
export async function runSessionSafely(
  connection: SmallWebRTCConnection,
  admission: AllowedOffer,
  deps: SessionDeps,
): Promise<void> {
  try {
    await runSession(connection, admission, deps);
  } catch (e) {
    logger.error(`Bot session failed: ${errorText(e)}`, e);
    // The client already has its answer: left open, the call would connect to no bot.
    await connection.disconnect().catch((error: unknown) => {
      logger.warning(`Closing the failed session's connection failed: ${errorText(error)}`);
    });
  }
}

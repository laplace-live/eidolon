// The TS ports of the Python CLIs: the query side (laplace-search, laplace-eval-retrieval,
// laplace-generate-image, the retrieval-gate benchmark) and the offline chain that builds an index.
export {
  type ActionKind,
  type ArgAction,
  ArgparseExit,
  type ArgType,
  ArgumentTypeError,
  commandPersona,
  FROMISOFORMAT,
  INT,
  type Namespace,
  PATH,
  type ParserSpec,
  parseArgs,
  parserError,
} from "./argparse.ts";
export { buildStreamCatalogMain } from "./build_stream_catalog.ts";
export { CLI_USAGE, COMMANDS, cleanupLimitMs, runCli } from "./cli.ts";
export { downloadMain } from "./download.ts";
export {
  ALL_MODES,
  aggregate,
  benchmarkMeanMs,
  benchmarkMedianMs,
  benchmarkP95Ms,
  benchmarkRerankerModels,
  defaultQueriesPath,
  EVAL_PARSER,
  type EvalArgs,
  type EvalDeps,
  type EvalQuery,
  evalRetrievalMain,
  evaluateQuery,
  fmtPct,
  K_VALUES,
  loadQueries,
  type ModeReport,
  matches,
  namedReranker,
  parseEvalArgs,
  printBenchmarkReport,
  printComparison,
  printPerQueryBreakdown,
  printTableReport,
  type QueryResult,
  type RerankerBenchmark,
  rowTextForMatch,
  toJsonBlob,
} from "./eval_retrieval.ts";
export { extractUsersMain } from "./extract_users.ts";
export {
  ask,
  BENCHMARK_DIR,
  decisionsResult,
  type GateDecisionsOptions,
  type GateRow,
  type GateSummary,
  type GateTurnSpec,
  gateDecisionsMain,
  runGateDecisions,
  summarize,
  turnMessages,
} from "./gate_decisions.ts";
export {
  DEFAULT_OUT_PATH,
  type GenerateImageArgs,
  type GenerateImageDeps,
  generateImageMain,
  generateImageParser,
  outPath,
  parseGenerateImageArgs,
} from "./generate_image.ts";
export { ingestFactsMain } from "./ingest_facts.ts";
export { ingestStreamsMain } from "./ingest_streams.ts";
export { type CliIo, type CommandDeps, printer, resolveIo } from "./io.ts";
export { CLI_ENTRY, jobArgv } from "./job.ts";
export { personaArg } from "./persona-arg.ts";
export { pipelineMain } from "./pipeline.ts";
export { prepareBatchMain } from "./prepare_batch.ts";
export {
  mean,
  median,
  numOf,
  type PyNumber,
  quantilesExclusive,
  textwrapIndent,
} from "./py.ts";
export { refineMain } from "./refine.ts";
export {
  parseSearchArgs,
  SEARCH_PARSER,
  type SearchArgs,
  type SearchDeps,
  searchMain,
  UNRESOLVED_PERIOD_NOTE,
} from "./search.ts";
export { transcribeMain } from "./transcribe.ts";

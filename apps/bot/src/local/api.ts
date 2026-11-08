// The local web app's admin API on the wire, under /api/local: what apps/bot/src/local serves and
// apps/web imports with `import type`. Keep this module import-free, so the SPA's typecheck sees no
// Bun or Node.

/** Every route the local router serves, as `<METHOD> <path>`; `:name` is one path segment. */
export const LOCAL_ROUTES = [
  "POST /api/local/session",
  "GET /api/local/session",
  "GET /api/local/status",
  "POST /api/local/restart",
  "GET /api/local/settings",
  "PUT /api/local/settings",
  "GET /api/local/credentials",
  "PUT /api/local/credentials",
  "POST /api/local/credentials/check",
  "GET /api/local/accounts",
  "POST /api/local/accounts",
  "POST /api/local/accounts/check",
  "PUT /api/local/accounts/:id",
  "DELETE /api/local/accounts/:id",
  "GET /api/local/accounts/:id/models",
  "GET /api/local/personas",
  "POST /api/local/personas",
  "PUT /api/local/personas/active",
  "GET /api/local/personas/:id/prompt",
  "PUT /api/local/personas/:id/prompt",
  "GET /api/local/personas/:id/glossary",
  "PUT /api/local/personas/:id/glossary",
  "GET /api/local/personas/:id/identity",
  "PUT /api/local/personas/:id/identity",
  "GET /api/local/personas/:id/references",
  "GET /api/local/personas/:id/references/:kind/:name",
  "POST /api/local/personas/:id/references/:kind/:name",
  "DELETE /api/local/personas/:id/references/:kind/:name",
  "GET /api/local/personas/:id/avatar",
  "PUT /api/local/personas/:id/avatar",
  "DELETE /api/local/personas/:id/avatar",
  "GET /api/local/personas/:id/facts",
  "GET /api/local/personas/:id/facts/:file",
  "PUT /api/local/personas/:id/facts/:file",
  "DELETE /api/local/personas/:id/facts/:file",
  "GET /api/local/personas/:id/index",
  "POST /api/local/personas/:id/batches",
  "GET /api/local/voices/search",
  "POST /api/local/jobs",
  "GET /api/local/jobs",
  "GET /api/local/jobs/:id",
  "GET /api/local/jobs/:id/events",
  "GET /api/local/jobs/:id/log",
  "DELETE /api/local/jobs/:id",
  "POST /api/local/jobs/:id/resume",
  "GET /api/local/memories",
  "DELETE /api/local/memories",
  "GET /api/local/usage",
] as const satisfies readonly (keyof LocalApi)[];

export type LocalRoute = (typeof LOCAL_ROUTES)[number];

/**
 * Why a request failed, in every error body: the SPA shows its own string for the code and the
 * message only as detail. Messages never echo what the request sent.
 */
export const ERROR_CODES = [
  "bad-json",
  "bad-request",
  "unauthorized",
  "link-expired",
  "proof-missing",
  "forbidden",
  "misdirected",
  "not-found",
  "method-not-allowed",
  "conflict",
  "payload-too-large",
  "unsupported-media-type",
  "unavailable",
  "upstream-failed",
  "internal",
  "invalid-persona-id",
  "unknown-persona",
  "persona-exists",
  "call-active",
  "unknown-setting",
  "invalid-setting",
  "read-only-setting",
  "invalid-path",
  "unknown-credential",
  "unknown-account",
  "account-in-use",
  "invalid-file-name",
  "template-file",
  "invalid-toml",
  "invalid-url",
  "unknown-command",
  "invalid-option",
  "unknown-job",
  "job-not-running",
  "job-not-resumable",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * The body of every 4xx and 5xx the local API sends. A 5xx's message is fixed: what went wrong is
 * in the terminal's log line that `id` names.
 */
export interface ErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly id?: string;
  };
}

/** A body or response that is not JSON: an upload's bytes, a job's NDJSON events, a log's text. */
export interface Raw<Kind extends "image" | "ndjson" | "text"> {
  readonly raw: Kind;
}

/** One route's request and response, keyed by the route in LocalApi. */
export interface Endpoint<Body, Response, Query = undefined> {
  readonly body: Body;
  readonly query: Query;
  readonly response: Response;
}

export interface Ok {
  readonly ok: true;
}

/** POST session: the link code from the URL the terminal printed, `<unix seconds>.<signature>`. */
export interface SessionRequest {
  readonly code: string;
}

/**
 * The header every API request from the app's pages carries the proof in. Cookies ignore ports,
 * so a service on another localhost port receives the session cookie too; only the app's own
 * pages hold the proof.
 */
export const PROOF_HEADER = "X-Eidolon-Proof";

/** POST session's answer beside the cookie: the proof to send as PROOF_HEADER. */
export interface SessionGrant {
  readonly ok: true;
  readonly proof: string;
}

/** GET session with `probe`: whether this server holds the token another start would use. */
export interface SessionProbe {
  readonly proof: string;
}

/** An account the active persona's calls need, and whether its key is set. */
export interface KeyStatus {
  /** The account's id. */
  readonly account: string;
  /** Its name, as Settings shows it. */
  readonly name: string;
  /** Its provider's catalog id. */
  readonly provider: string;
  /** The roles it serves: hearing, mind, voice, realtime. */
  readonly roles: readonly string[];
  readonly set: boolean;
}

/** Where an account's key, API base or setting comes from. */
export type AccountValueSource = "account" | "env" | "credentials" | "settings" | "default";

/** A value an account has, and which layer gives it; the key's never goes out. */
export interface AccountValue {
  /** null for the key, and wherever nothing sets it. */
  readonly value: string | null;
  readonly source: AccountValueSource | null;
}

/** A persona role, or the install's embeddings, that names an account in a settings file. */
export interface AccountUse {
  /** null for the install's settings.yaml. */
  readonly persona: string | null;
  readonly role: string;
}

export interface AccountView {
  readonly id: string;
  /** Its provider's catalog id. */
  readonly provider: string;
  readonly name: string;
  /** Its id is its provider's: the provider's variables configure it too. */
  readonly isDefault: boolean;
  /** credentials.json holds it. */
  readonly saved: boolean;
  readonly key: AccountValue;
  readonly baseUrl: AccountValue;
  /** The provider's own settings, by field key. */
  readonly options: Readonly<Record<string, AccountValue>>;
  readonly uses: readonly AccountUse[];
  /** The active persona's calls run on it. */
  readonly needed: boolean;
}

export interface AccountsResponse {
  readonly accounts: readonly AccountView[];
}

/**
 * POST accounts adds one, PUT accounts/:id edits one. A field left out keeps its value; null
 * removes it. The key never comes back.
 */
export interface AccountUpdate {
  readonly name?: string | null;
  readonly apiKey?: string | null;
  readonly baseUrl?: string | null;
  readonly options?: Readonly<Record<string, string | null>>;
}

export interface AccountCreate extends AccountUpdate {
  /** The catalog id of its provider. */
  readonly provider: string;
}

/** POST accounts/check: a saved account, or a provider with what was typed for a new one. */
export interface AccountCheckRequest {
  readonly account?: string;
  readonly provider?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/** GET accounts/:id/models: what the provider lists for one kind of model. */
export interface ModelsQuery {
  readonly category: string;
}

export interface ModelsResponse {
  /**
   * `ok` with the provider's list; `unlisted` where it has none; `no-key` while the account has
   * no key; `refused` when the provider refused that key; `failed` when it didn't answer, with its
   * reason in English.
   */
  readonly status: "ok" | "unlisted" | "no-key" | "refused" | "failed";
  readonly models: readonly { readonly id: string; readonly name?: string }[];
  readonly message?: string;
}

/** A role a call runs on, as her settings fill it. */
export interface CallRole {
  readonly role: string;
  /** null when the settings name no provider Eidolon knows. */
  readonly provider: string | null;
  readonly model: string | null;
  /** What is wrong with the settings, in English: an unknown provider, a missing model. */
  readonly problem: string | null;
}

export interface VoiceStatus {
  /** The voice as the bot reads it (TTS_VOICE_ID, or Fish's FISH_VOICE_ID); null when unset. */
  readonly id: string | null;
  /**
   * "persona" when her persona.yaml sets the voice, even with one in the environment; "env" when
   * she inherits the environment's; "default" when neither sets one.
   */
  readonly source: "default" | "persona" | "env";
  /** Whether Fish knows the voice: null until checked, and for another provider's voice. */
  readonly ok: boolean | null;
  /** The voice provider's catalog id; null when her settings name none Eidolon knows. */
  readonly provider: string | null;
  /** The account that speaks for her, whose key a check of the voice uses. */
  readonly account: string | null;
}

export interface IndexTable {
  readonly table: "stream_chunks" | "persona_facts";
  /** The table exists, whatever built it. */
  readonly built: boolean;
  /**
   * From the table's `<table>.meta.json`: null without one, as for a table never built or one the
   * Python tools built.
   */
  readonly rows: number | null;
  readonly builtAt: string | null;
  readonly model: string | null;
  readonly dim: number | null;
  /** Built with an embedding model or dimension other than the current settings': re-ingest. */
  readonly stale: boolean;
}

export interface IndexStatus {
  readonly tables: readonly IndexTable[];
  /** stream_catalog.json's `built_at`. */
  readonly catalogBuiltAt: string | null;
}

export type YtDlpStatus =
  | { readonly state: "installed"; readonly tag: string }
  | { readonly state: "installs-on-first-download" }
  | { readonly state: "unavailable"; readonly reason: string };

export interface MemoryStatus {
  /** MEM0_QDRANT_HOST is set. */
  readonly configured: boolean;
  /** The last probe's answer; null when never probed. */
  readonly reachable: boolean | null;
}

/**
 * GET status, which the home page polls: cheap. It never waits on a remote probe; Qdrant and the
 * voice are checked in the background and reported from the last answer.
 */
export interface Status {
  readonly version: string;
  /**
   * A setting or credential that calls read once changed since: at boot, or when memory or
   * retrieval first ran. It stays set until POST restart, even if the value is set back: a
   * reader may hold the changed one.
   */
  readonly restartRequired: boolean;
  /** Only the MCP server keeps what it read at boot, such as which persona's index it serves. */
  readonly mcpRestartRequired: boolean;
  /** The keys her calls need, one per account. */
  readonly keys: readonly KeyStatus[];
  /** Whether a realtime model runs her calls, and the roles they run on. */
  readonly call: { readonly realtime: boolean; readonly roles: readonly CallRole[] };
  readonly persona: {
    readonly id: string;
    readonly name: string;
    readonly shortName: string;
    /** As PersonaSummary's. */
    readonly avatar: boolean;
    readonly voice: VoiceStatus;
  };
  readonly index: IndexStatus;
  /** Outfit references the selfie tool can redraw; 0 turns the tool off. */
  readonly selfieReferences: number;
  readonly memory: MemoryStatus;
  readonly ytDlp: YtDlpStatus;
  /** Needed only for videos over 5 hours. */
  readonly ffmpeg: boolean;
  /** Free space on the data home's volume; null when unknown. */
  readonly freeBytes: number | null;
  /** The last call that failed after it was answered, for the call page to explain a hang-up. */
  readonly lastSessionError: { readonly message: string; readonly at: string } | null;
  readonly activeCalls: number;
}

export type SettingScope = "app" | "persona";
export type SettingKind = "string" | "int" | "float" | "flag" | "list" | "path" | "paths";

/** One SETTINGS row for a settings form: its metadata, its file value, and what overrides it. */
export interface SettingRow {
  readonly path: string;
  readonly env: string;
  readonly scope: SettingScope;
  readonly kind: SettingKind;
  /** English; the SPA shows its own `settings.<path>` string. */
  readonly title: string;
  /** The file's own value; null when no file sets it. */
  readonly value: unknown;
  readonly source: "default" | "app" | "persona";
  /**
   * The environment's non-empty value of `env`, or of the provider-named variable that set it
   * before (`envName`), or null: always for a production-only row, which the local app hides, and
   * for a value that belongs to another provider than hers. Settings hold no secrets.
   */
  readonly envValue: string | null;
  /** The variable `envValue` comes from: `env`, or its provider-named predecessor. */
  readonly envName: string | null;
  /**
   * The environment's value is used instead of the file's: an app row with envValue set. A persona
   * row is never overridden: her file wins, and without a file value the environment's is the
   * default she inherits.
   */
  readonly envOverride: boolean;
  /** Only a public deployment reads it; the local app hides it. */
  readonly productionOnly: boolean;
  /** Shown, never written through the API. */
  readonly readOnly: boolean;
}

export interface SettingsResponse {
  readonly persona: string;
  readonly settings: readonly SettingRow[];
  /** What the files hold that the bot ignores, in English. */
  readonly warnings: readonly string[];
  /** As in GET status: a saved value waits for POST restart. */
  readonly restartRequired: boolean;
}

/** PUT settings: dotted paths → new values in one scope's file; null removes a key. */
export interface SettingsUpdate {
  readonly scope: SettingScope;
  /** Required for scope "persona". */
  readonly persona?: string;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface CredentialState {
  readonly set: boolean;
  /** Where the bot reads it from; null when unset. */
  readonly source: "credentials" | "env" | null;
}

/** GET credentials, and PUT's answer: never a value. */
export type CredentialsResponse = Readonly<Record<string, CredentialState>>;

/** PUT credentials: a value to save, or null to remove it from credentials.json. */
export type CredentialsUpdate = Readonly<Record<string, string | null>>;

/**
 * What a check can ask about: a role's endpoint and key (`embeddings`, `rerank`, `refine`),
 * Qdrant, or a provider's key by its catalog id.
 */
export const CHECK_PROVIDERS = [
  "soniox",
  "openrouter",
  "fish",
  "embeddings",
  "rerank",
  "refine",
  "qdrant",
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "xai",
  "qwen",
  "moonshot",
  "zhipu",
  "openai-compatible",
  "elevenlabs",
  "deepgram",
  "cartesia",
  "minimax",
  "cohere",
] as const;

export type CheckProvider = (typeof CHECK_PROVIDERS)[number];

export interface CheckRequest {
  readonly provider: CheckProvider;
  /**
   * A value typed but not saved yet; without it the check reads the saved, effective one. A key,
   * or for qdrant `host` or `host:port`.
   */
  readonly value?: string;
}

/** A check's verdict. Each comes from the provider's HTTP status, never from its wording. */
export const CHECK_CODES = [
  "ok",
  /** Nothing to check: no key saved, or no Qdrant host. */
  "missing",
  /** 401. For Soniox, also a key from an EU, JP or IN project, which Eidolon can't use. */
  "invalid-key",
  /** OpenRouter: a management key, which can't run models. */
  "management-key",
  "no-credit",
  "forbidden",
  "not-found",
  "rate-limited",
  /** No answer, a timeout, or a 5xx. */
  "unreachable",
  /** An answer the check can't place. */
  "unexpected",
  /** Something other than Qdrant answers there. */
  "not-qdrant",
  /** This Qdrant wants an API key, which Eidolon doesn't send. */
  "needs-api-key",
  /** Qdrant answered 503: it is still starting. */
  "starting",
] as const;
export type CheckCode = (typeof CHECK_CODES)[number];

/** Why a check that passed still needs a look. */
export const CHECK_WARNINGS = [
  /** Soniox: the key works, but may not list models. */
  "cannot-list-models",
  /** A configured model the provider doesn't list. */
  "unknown-model",
  /** Fish: s1, which retires on 2026-12-31. */
  "deprecated-model",
  /** OpenRouter: the account never bought credits. */
  "free-tier",
  /** OpenRouter: the key's own spending limit is used up. */
  "key-limit-reached",
  /** OpenRouter: a budget the key falls under is used up. */
  "budget-exhausted",
  "key-expired",
  /** Within 14 days. */
  "key-expiring",
  /** Fish: no API credit, and the model bills. */
  "no-credit",
  /** Fish: the persona's voice doesn't exist. */
  "voice-unknown",
  /** Fish: the persona's voice belongs to another account. */
  "voice-private",
  /** A provider other than OpenRouter that offers nothing to check the key against. */
  "cannot-verify",
  /** Qdrant more than one minor version from the client Eidolon uses. */
  "version-mismatch",
] as const;
export type CheckWarningCode = (typeof CHECK_WARNINGS)[number];

export interface CheckWarning {
  readonly code: CheckWarningCode;
  readonly message: string;
}

/** A provider check's verdict; `code` names it for the SPA, `message` is English detail. */
export interface CheckResult {
  readonly ok: boolean;
  readonly code: CheckCode;
  readonly message: string;
  readonly warnings: readonly CheckWarning[];
  /** A non-empty environment variable overrides the saved value. */
  readonly envOverride: boolean;
  /** Credit left in USD, where the provider tells: OpenRouter's key limit, Fish's API credit. */
  readonly credit: number | null;
}

export interface PersonaSummary {
  readonly id: string;
  readonly name: string;
  readonly shortName: string;
  /** Ships with the code under personas/. */
  readonly template: boolean;
  /** Has a folder in the data home. */
  readonly own: boolean;
  /** Has an avatar picture; without one the pages show her monogram and request none. */
  readonly avatar: boolean;
}

export interface PersonasResponse {
  readonly active: string;
  readonly personas: readonly PersonaSummary[];
}

export interface PersonaIdentityFields {
  readonly name: string;
  readonly shortName: string;
  readonly fans: string;
  /** One English sentence. */
  readonly summary: string;
  readonly timezone: string;
}

/** PUT identity: the fields to change; one left out stays as it is. */
export type IdentityUpdate = Partial<PersonaIdentityFields>;

/** POST personas. The id is a slug, `^[a-z0-9][a-z0-9_-]{0,63}$`. */
export interface CreatePersonaRequest extends PersonaIdentityFields {
  readonly id: string;
  readonly voiceId: string;
}

export interface ActivePersonaRequest {
  readonly id: string;
}

/** A persona's text file: the user's copy when there is one, else the template's. */
export interface PersonaText {
  readonly text: string;
  readonly source: "own" | "template" | null;
}

export interface GlossaryResponse extends PersonaText {
  /** TOML parse errors; empty when it parses. */
  readonly errors: readonly string[];
}

export interface TextUpdate {
  readonly text: string;
}

export const REFERENCE_KINDS = ["outfits", "friends"] as const;

export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export interface ReferenceImage {
  readonly name: string;
  readonly source: "own" | "template";
  readonly size: number;
}

export interface ReferencesResponse {
  readonly outfits: readonly ReferenceImage[];
  readonly friends: readonly ReferenceImage[];
  readonly avatar: ReferenceImage | null;
}

export interface FactFile {
  readonly name: string;
  readonly size: number;
  readonly mtime: string;
  /** knowledge.facts.files picks it. */
  readonly matched: boolean;
  /** Differs from what persona_facts was last built from. */
  readonly changed: boolean;
}

export interface FactsResponse {
  readonly patterns: readonly string[];
  readonly files: readonly FactFile[];
  /** Files persona_facts was last built from that are gone, or no longer picked. */
  readonly removed: readonly string[];
}

export interface VoiceSample {
  readonly title: string;
  readonly text: string;
  readonly audioUrl: string;
}

/** A Fish public voice, with absolute https URLs. */
export interface Voice {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly coverUrl: string | null;
  readonly languages: readonly string[];
  readonly tags: readonly string[];
  readonly samples: readonly VoiceSample[];
  readonly author: string;
  readonly likeCount: number;
  readonly taskCount: number;
}

export interface VoiceSearchQuery {
  readonly q?: string;
  /** zh, en or ja. */
  readonly language?: string;
  readonly page?: number;
}

export interface VoiceSearchResponse {
  /** Fish caps what a search can page to; `totalIsExact` false shows "1000+". */
  readonly total: number;
  readonly totalIsExact: boolean;
  readonly hasMore: boolean;
  readonly items: readonly Voice[];
}

/** POST personas/:id/batches: video URLs, as an `expand` job's entries name them. */
export interface BatchRequest {
  readonly urls: readonly string[];
}

export interface BatchResponse {
  /** The new batch's id, which jobs name it by; null when every URL was listed already. */
  readonly batch: string | null;
  /** URLs the batch holds: those none of the persona's lists or batches had yet. */
  readonly count: number;
  /** URLs a list or batch already had, left out. */
  readonly known: number;
}

export const JOB_COMMANDS = [
  "pipeline",
  "download",
  "expand",
  "transcribe",
  "refine",
  "ingest-streams",
  "ingest-facts",
  "build-stream-catalog",
  "plan",
] as const;

export type JobCommand = (typeof JOB_COMMANDS)[number];

/** What a `pipeline` job runs, always in this order. */
export const PIPELINE_STAGES = ["download", "transcribe", "refine", "ingest"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** The options of a command that takes none: any key is refused. */
export type NoOptions = Readonly<Record<string, never>>;

/**
 * Each command's options, which the server maps to a fixed set of flags. A batch is named by the
 * id POST batches answered, a video by its id (the audio's stem, as a plan names it).
 */
export interface JobOptions {
  /**
   * The batch's videos through `stages`, all four by default; billed past download. Only the
   * download stage reads the batch: the later stages take every video the persona has.
   */
  readonly pipeline: {
    readonly abortOnError?: boolean;
    /** Transcriptions in flight at once, 1 to 25; the CLI's default is 1. */
    readonly transcribeConcurrency?: number;
  } & (
    | { readonly batch: string; readonly stages?: readonly PipelineStage[] }
    | {
        readonly batch?: undefined;
        readonly stages: readonly Exclude<PipelineStage, "download">[];
      }
  );
  readonly download: { readonly batch: string };
  /** One `entry` event per video a playlist, channel or series lists. */
  readonly expand: { readonly url: string };
  /** A downloaded video without an upload date, transcribed as streamed on `date`, YYYY-MM-DD. */
  readonly transcribe: { readonly video: string; readonly date: string };
  readonly refine: NoOptions;
  readonly "ingest-streams": NoOptions;
  readonly "ingest-facts": NoOptions;
  readonly "build-stream-catalog": NoOptions;
  /**
   * `pipeline --dry-run` over every video the persona's lists know. A running or finished plan
   * is reused until a job that changes her sources ends, a batch is written or one of
   * PLAN_SETTINGS changes; `refresh` plans anew.
   */
  readonly plan: { readonly refresh?: boolean };
}

/** The settings a plan reads besides her files: the models it prices and the index it checks. */
export const PLAN_SETTINGS = [
  "transcription.provider",
  "transcription.model",
  "refine.provider",
  "refine.model",
  "knowledge.index",
] as const;

/** POST jobs: a command for one persona. An unknown key, or a string starting with `-`, is a 400. */
export type JobRequest = {
  readonly [C in JobCommand]: {
    readonly command: C;
    readonly persona: string;
  } & (NoOptions extends JobOptions[C]
    ? { readonly options?: JobOptions[C] }
    : { readonly options: JobOptions[C] });
}[JobCommand];

export const JOB_STATUSES = ["running", "succeeded", "failed", "cancelled", "interrupted"] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** What the server keeps of a job it spawned, in `<data home>/jobs/<id>.json`. */
export interface JobRecord {
  /** Minted by the server: `<YYYYMMDDTHHMMSS>-<6 base32>`, in UTC. */
  readonly id: string;
  readonly command: JobCommand;
  readonly persona: string;
  /** JobOptions[command], as validated. */
  readonly options: Readonly<Record<string, unknown>>;
  /**
   * `cancelled`: stopped by a DELETE. `interrupted`: stopped by the server's own stop or restart,
   * or by a signal from elsewhere, or it ended while no server watched; it resumes. `failed`
   * includes a run that died without its summary.
   */
  readonly status: JobStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** null while it runs, and for one that ended unseen. */
  readonly exitCode: number | null;
  /** Plan and expand jobs: outside the last 50 kept, and only the newest of each per persona. */
  readonly ephemeral: boolean;
  /** The job this one reran. */
  readonly resumedFrom: string | null;
  /** The job that reran this one: a job resumes once. */
  readonly resumedBy: string | null;
}

/** One stage's progress, from the job's events; `stage` is @eidolon/ingest/progress's Stage. */
export interface JobStage {
  readonly stage: string;
  /** Its last stage event's: "start" while it runs. */
  readonly status: "start" | "done" | "failed" | "skipped" | "cancelled";
  /** Items that ended each way, each counted once. */
  readonly done: number;
  readonly failed: number;
  readonly skipped: number;
  readonly total: number | null;
  /** What the stage reports as a whole, such as rows embedded; `unit` is a progress event's. */
  readonly progress: {
    readonly done: number;
    readonly total: number | null;
    readonly unit: string;
  } | null;
}

/** An item, or a whole stage, that failed; `code` is @eidolon/ingest/progress's EventCode. */
export interface JobFailure {
  readonly stage: string;
  /** null when the stage failed as a whole. */
  readonly item: string | null;
  readonly video: string | null;
  readonly code: string | null;
  /** Whose key, credit or quota `code` is about: soniox, refine or embeddings. */
  readonly provider: string | null;
  readonly message: string | null;
}

/** GET jobs/:id: the record, reduced from its events. */
export interface JobSnapshot extends JobRecord {
  readonly stages: readonly JobStage[];
  /** Spent so far, by its summaries, else its items; null until anything reported a cost. */
  readonly costUsd: number | null;
  /** Failed stages, and items whose last end was a failure: the first 100; stages count all. */
  readonly failures: readonly JobFailure[];
  /** The end of its stderr, which explains a run that ended without a summary. */
  readonly stderrTail: string;
  /** Bytes of events so far: `events?after=` resumes from here. */
  readonly eventsSize: number;
  /** The run's own summary arrived; a run that ended without it crashed or was killed. */
  readonly summarySeen: boolean;
  /** Told to stop, and not exited yet: it may be finishing an index rebuild first. */
  readonly stopping: boolean;
  /**
   * This server spawned it and still holds its process, so a DELETE can signal it. False once it
   * has ended, and for a job an earlier server started, which a DELETE answers with 409.
   */
  readonly signalable: boolean;
}

export interface JobEventsQuery {
  /** A byte offset into the events file. */
  readonly after?: number;
}

/**
 * DELETE jobs/:id sends the job SIGTERM, which it answers by cancelling its run once any index
 * rebuild it is in has finished; a repeat sends nothing more.
 */
export interface JobCancelQuery {
  /**
   * 1, on a job already stopping: SIGKILL for its whole process group, at once, which can leave an
   * index without its table or its full-text index until the next ingest.
   */
  readonly force?: 1;
}

/** One memory as Mem0 keeps it, in the field names /api/memories uses. */
export interface Memory {
  readonly id: string | null;
  readonly memory: string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
  readonly categories: readonly string[] | null;
}

export interface MemoriesQuery {
  /** Default: the active persona. */
  readonly persona?: string;
}

export interface MemoriesResponse {
  readonly persona: string;
  readonly count: number;
  readonly memories: readonly Memory[];
}

export interface LocalApi {
  "POST /api/local/session": Endpoint<SessionRequest, SessionGrant>;
  "GET /api/local/session": Endpoint<undefined, Ok | SessionProbe, { readonly probe?: string }>;
  "GET /api/local/status": Endpoint<undefined, Status>;
  "POST /api/local/restart": Endpoint<undefined, Ok>;
  "GET /api/local/settings": Endpoint<undefined, SettingsResponse, { readonly persona?: string }>;
  "PUT /api/local/settings": Endpoint<SettingsUpdate, SettingsResponse>;
  "GET /api/local/credentials": Endpoint<undefined, CredentialsResponse>;
  "PUT /api/local/credentials": Endpoint<CredentialsUpdate, CredentialsResponse>;
  "POST /api/local/credentials/check": Endpoint<CheckRequest, CheckResult>;
  "GET /api/local/accounts": Endpoint<undefined, AccountsResponse>;
  "POST /api/local/accounts": Endpoint<AccountCreate, AccountView>;
  "POST /api/local/accounts/check": Endpoint<AccountCheckRequest, CheckResult>;
  "PUT /api/local/accounts/:id": Endpoint<AccountUpdate, AccountView>;
  "DELETE /api/local/accounts/:id": Endpoint<undefined, Ok>;
  "GET /api/local/accounts/:id/models": Endpoint<undefined, ModelsResponse, ModelsQuery>;
  "GET /api/local/personas": Endpoint<undefined, PersonasResponse>;
  "POST /api/local/personas": Endpoint<CreatePersonaRequest, PersonaSummary>;
  "PUT /api/local/personas/active": Endpoint<ActivePersonaRequest, PersonasResponse>;
  "GET /api/local/personas/:id/prompt": Endpoint<undefined, PersonaText>;
  "PUT /api/local/personas/:id/prompt": Endpoint<TextUpdate, PersonaText>;
  "GET /api/local/personas/:id/glossary": Endpoint<undefined, GlossaryResponse>;
  "PUT /api/local/personas/:id/glossary": Endpoint<TextUpdate, GlossaryResponse>;
  "GET /api/local/personas/:id/identity": Endpoint<undefined, PersonaIdentityFields>;
  "PUT /api/local/personas/:id/identity": Endpoint<IdentityUpdate, PersonaIdentityFields>;
  "GET /api/local/personas/:id/references": Endpoint<undefined, ReferencesResponse>;
  "GET /api/local/personas/:id/references/:kind/:name": Endpoint<undefined, Raw<"image">>;
  "POST /api/local/personas/:id/references/:kind/:name": Endpoint<Raw<"image">, ReferenceImage>;
  "DELETE /api/local/personas/:id/references/:kind/:name": Endpoint<undefined, Ok>;
  "GET /api/local/personas/:id/avatar": Endpoint<undefined, Raw<"image">>;
  "PUT /api/local/personas/:id/avatar": Endpoint<Raw<"image">, ReferenceImage>;
  "DELETE /api/local/personas/:id/avatar": Endpoint<undefined, Ok>;
  "GET /api/local/personas/:id/facts": Endpoint<undefined, FactsResponse>;
  "GET /api/local/personas/:id/facts/:file": Endpoint<undefined, TextUpdate>;
  "PUT /api/local/personas/:id/facts/:file": Endpoint<TextUpdate, FactFile>;
  "DELETE /api/local/personas/:id/facts/:file": Endpoint<undefined, Ok>;
  "GET /api/local/personas/:id/index": Endpoint<undefined, IndexStatus>;
  "POST /api/local/personas/:id/batches": Endpoint<BatchRequest, BatchResponse>;
  "GET /api/local/voices/search": Endpoint<undefined, VoiceSearchResponse, VoiceSearchQuery>;
  "POST /api/local/jobs": Endpoint<JobRequest, JobSnapshot>;
  "GET /api/local/jobs": Endpoint<undefined, readonly JobSnapshot[]>;
  "GET /api/local/jobs/:id": Endpoint<undefined, JobSnapshot>;
  "GET /api/local/jobs/:id/events": Endpoint<undefined, Raw<"ndjson">, JobEventsQuery>;
  "GET /api/local/jobs/:id/log": Endpoint<undefined, Raw<"text">>;
  "DELETE /api/local/jobs/:id": Endpoint<undefined, JobSnapshot, JobCancelQuery>;
  "POST /api/local/jobs/:id/resume": Endpoint<undefined, JobSnapshot>;
  "GET /api/local/memories": Endpoint<undefined, MemoriesResponse, MemoriesQuery>;
  "DELETE /api/local/memories": Endpoint<undefined, Ok, MemoriesQuery>;
  "GET /api/local/usage": Endpoint<undefined, UsageSummary, UsageQuery>;
}

/** One day's spend for one persona, role and model, summed. */
export interface UsageRow {
  /** The local calendar day of the machine that keeps the ledger, YYYY-MM-DD. */
  readonly day: string;
  readonly persona: string;
  readonly provider: string;
  readonly category: string;
  readonly role: string;
  readonly model: string;
  /** Records summed: a request each, or a batch of a call's audio or speech. */
  readonly records: number;
  /** USD, reported and estimated together. */
  readonly costUsd: number;
  /** The part of `costUsd` that is the catalog's estimate, not the provider's figure. */
  readonly estimatedUsd: number;
  /** Records no price covers, whose usage is counted but not costed. */
  readonly unpriced: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly characters: number;
  readonly audioSeconds: number;
  readonly images: number;
}

export interface UsageSummary {
  /** The range asked for, ms since the epoch; null for unbounded. */
  readonly from: number | null;
  readonly to: number | null;
  /** Whose rows these are; null for every persona. */
  readonly persona: string | null;
  readonly rows: readonly UsageRow[];
  /** Every persona with a record in the ledger, whatever the filter. */
  readonly personas: readonly string[];
  /** Every provider with a record in the ledger, whatever the filter. */
  readonly providers: readonly string[];
  /** The ledger's file; `recording` is false when it can't be opened, so nothing is recorded. */
  readonly path: string;
  readonly recording: boolean;
}

/** GET usage: the ledger's spend in a range, for one persona or all. */
export interface UsageQuery {
  /** ms since the epoch, inclusive; the ledger's start when absent. */
  readonly from?: number;
  /** ms since the epoch, exclusive; now when absent. */
  readonly to?: number;
  /** Every persona's when absent. */
  readonly persona?: string;
}

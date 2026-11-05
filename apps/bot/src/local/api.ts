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
  "forbidden",
  "misdirected",
  "not-found",
  "method-not-allowed",
  "conflict",
  "payload-too-large",
  "unsupported-media-type",
  "not-implemented",
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

/** The body of every 4xx and 5xx the local API sends. */
export interface ErrorBody {
  readonly error: { readonly code: ErrorCode; readonly message: string };
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

/** GET session with `probe`: whether this server holds the token another start would use. */
export interface SessionProbe {
  readonly proof: string;
}

/** The keys a call cannot start without. */
export const REQUIRED_KEYS = ["SONIOX_API_KEY", "OPENROUTER_API_KEY", "FISH_API_KEY"] as const;
export type RequiredKey = (typeof REQUIRED_KEYS)[number];

/** Which file sets a value, as @eidolon/config's readSettingsLayers reports it, or the env. */
export type ValueSource = "default" | "app" | "persona" | "credentials" | "env";

export interface VoiceStatus {
  /** FISH_VOICE_ID as the bot reads it; null when unset (a call needs one). */
  readonly id: string | null;
  readonly source: ValueSource;
  /** Whether Fish knows the voice: null until checked. */
  readonly ok: boolean | null;
}

export interface IndexTable {
  readonly table: "stream_chunks" | "persona_facts";
  /** null when the table was never built. */
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

/** GET status, which the home page polls: cheap, and probes nothing remote. */
export interface Status {
  readonly version: string;
  /** A setting or credential the running server read at boot changed since. */
  readonly restartRequired: boolean;
  readonly keys: Readonly<Record<RequiredKey, boolean>>;
  readonly persona: {
    readonly id: string;
    readonly name: string;
    readonly shortName: string;
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
  /** A non-empty environment variable wins over the file. */
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

export type CheckProvider = "soniox" | "openrouter" | "fish" | "embeddings" | "rerank" | "qdrant";

export interface CheckRequest {
  readonly provider: CheckProvider;
  /** A value typed but not saved yet; without it the check reads the saved, effective one. */
  readonly value?: string;
}

export interface CheckWarning {
  readonly code: string;
  readonly message: string;
}

/** A provider check's verdict; `code` names it for the SPA, `message` is English detail. */
export interface CheckResult {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
  readonly warnings: readonly CheckWarning[];
  /** A non-empty environment variable overrides the saved value. */
  readonly envOverride: boolean;
}

export interface PersonaSummary {
  readonly id: string;
  readonly name: string;
  readonly shortName: string;
  /** Ships with the code under personas/. */
  readonly template: boolean;
  /** Has a folder in the data home. */
  readonly own: boolean;
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

export type ReferenceKind = "outfits" | "friends";

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

export interface BatchRequest {
  readonly urls: readonly string[];
}

export interface BatchResponse {
  /** The batch's id, which jobs name it by. */
  readonly batch: string;
  readonly count: number;
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
  "ytdlp-install",
] as const;

export type JobCommand = (typeof JOB_COMMANDS)[number];

/** POST jobs. `options` is typed per command; an unknown key is a 400. */
export interface JobRequest {
  readonly command: JobCommand;
  readonly persona: string;
  readonly options?: Readonly<Record<string, unknown>>;
}

export type JobStatus = "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

/** What the server keeps of a job it spawned, in `<data home>/jobs/<id>.json`. */
export interface JobRecord {
  /** Minted by the server: `<YYYYMMDDTHHMMSS>-<6 base32>`. */
  readonly id: string;
  readonly command: JobCommand;
  readonly persona: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly status: JobStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  /** Plan and expand jobs, which retention drops first. */
  readonly ephemeral: boolean;
}

/** One stage's progress, from the job's events; `stage` is @eidolon/ingest/progress's Stage. */
export interface JobStage {
  readonly stage: string;
  readonly done: number;
  readonly total: number | null;
  readonly failed: number;
  readonly skipped: number;
}

/** One item that failed; `code` is @eidolon/ingest/progress's EventCode. */
export interface JobFailure {
  readonly stage: string;
  readonly item: string;
  readonly code: string | null;
  readonly message: string;
}

/** GET jobs/:id: the record, reduced from its events. */
export interface JobSnapshot extends JobRecord {
  readonly stages: readonly JobStage[];
  readonly costUsd: number | null;
  readonly failures: readonly JobFailure[];
  /** The end of its stderr, shown when it ends without a summary. */
  readonly stderrTail: string;
  /** Bytes of events so far: `events?after=` resumes from here. */
  readonly eventsSize: number;
}

export interface JobEventsQuery {
  /** A byte offset into the events file. */
  readonly after?: number;
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
  "POST /api/local/session": Endpoint<SessionRequest, Ok>;
  "GET /api/local/session": Endpoint<undefined, Ok | SessionProbe, { readonly probe?: string }>;
  "GET /api/local/status": Endpoint<undefined, Status>;
  "POST /api/local/restart": Endpoint<undefined, Ok>;
  "GET /api/local/settings": Endpoint<undefined, SettingsResponse, { readonly persona?: string }>;
  "PUT /api/local/settings": Endpoint<SettingsUpdate, SettingsResponse>;
  "GET /api/local/credentials": Endpoint<undefined, CredentialsResponse>;
  "PUT /api/local/credentials": Endpoint<CredentialsUpdate, CredentialsResponse>;
  "POST /api/local/credentials/check": Endpoint<CheckRequest, CheckResult>;
  "GET /api/local/personas": Endpoint<undefined, PersonasResponse>;
  "POST /api/local/personas": Endpoint<CreatePersonaRequest, PersonaSummary>;
  "PUT /api/local/personas/active": Endpoint<ActivePersonaRequest, PersonasResponse>;
  "GET /api/local/personas/:id/prompt": Endpoint<undefined, PersonaText>;
  "PUT /api/local/personas/:id/prompt": Endpoint<TextUpdate, PersonaText>;
  "GET /api/local/personas/:id/glossary": Endpoint<undefined, GlossaryResponse>;
  "PUT /api/local/personas/:id/glossary": Endpoint<TextUpdate, GlossaryResponse>;
  "GET /api/local/personas/:id/identity": Endpoint<undefined, PersonaIdentityFields>;
  "PUT /api/local/personas/:id/identity": Endpoint<PersonaIdentityFields, PersonaIdentityFields>;
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
  "DELETE /api/local/jobs/:id": Endpoint<undefined, JobSnapshot>;
  "POST /api/local/jobs/:id/resume": Endpoint<undefined, JobSnapshot>;
  "GET /api/local/memories": Endpoint<undefined, MemoriesResponse, MemoriesQuery>;
  "DELETE /api/local/memories": Endpoint<undefined, Ok, MemoriesQuery>;
}

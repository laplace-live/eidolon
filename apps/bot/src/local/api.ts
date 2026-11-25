// The local web app's admin API on the wire, under /api/local: what apps/bot/src/local serves and
// apps/web imports with `import type`. Its only import is @eidolon/chat's types, which are
// browser-safe and erased, so the SPA's typecheck sees no Node.
import type {
  Attachment,
  ChatDisplay,
  ChatEvent,
  ChatHeader,
  ChatSummary,
  ParticipantId,
  PermissionLevel,
  ReplyMode,
} from "@eidolon/chat";

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
  "GET /api/local/accounts/:id/voices",
  "GET /api/local/personas",
  "POST /api/local/personas",
  "PUT /api/local/personas/active",
  "GET /api/local/personas/:id/prompt",
  "PUT /api/local/personas/:id/prompt",
  "GET /api/local/personas/:id/glossary",
  "PUT /api/local/personas/:id/glossary",
  "GET /api/local/personas/:id/identity",
  "PUT /api/local/personas/:id/identity",
  "PUT /api/local/personas/:id/voice-styles",
  "GET /api/local/personas/:id/references",
  "GET /api/local/personas/:id/references/:kind/:name",
  "POST /api/local/personas/:id/references/:kind/:name",
  "DELETE /api/local/personas/:id/references/:kind/:name",
  "GET /api/local/personas/:id/avatar",
  "PUT /api/local/personas/:id/avatar",
  "DELETE /api/local/personas/:id/avatar",
  "GET /api/local/personas/:id/models",
  "POST /api/local/personas/:id/models",
  "PUT /api/local/personas/:id/models/:model/file",
  "PATCH /api/local/personas/:id/models/:model",
  "DELETE /api/local/personas/:id/models/:model",
  "GET /api/local/personas/:id/models/:model/file",
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
  "GET /api/local/chats",
  "POST /api/local/chats",
  "GET /api/local/chats/:id",
  "PATCH /api/local/chats/:id",
  "DELETE /api/local/chats/:id",
  "POST /api/local/chats/:id/files",
  "POST /api/local/chats/:id/messages",
  "POST /api/local/chats/:id/voice",
  "GET /api/local/chats/:id/live",
  "POST /api/local/chats/:id/stop",
  "POST /api/local/chats/:id/participants",
  "GET /api/local/chats/:id/files/:name",
  "GET /api/local/tasks",
  "GET /api/local/tasks/:id",
  "GET /api/local/tasks/:id/events",
  "POST /api/local/tasks/:id/approve",
  "POST /api/local/tasks/:id/continue",
  "DELETE /api/local/tasks/:id",
  "GET /api/local/assistant/commands",
  "DELETE /api/local/assistant/commands/:id",
  "GET /api/local/mcp",
  "PUT /api/local/mcp/servers/:name",
  "GET /api/local/skills",
  "POST /api/local/skills",
  "PUT /api/local/skills/:name",
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
  "unknown-chat",
  "missing-key",
  "chat-in-call",
  "realtime-in-group",
  "assistant-off",
  "assistant-not-ready",
  "unknown-task",
  "task-locked",
  "nothing-pending",
  "not-paused",
  "pending",
  "range-not-satisfiable",
  "unknown-mcp-server",
  "invalid-mcp-config",
  "linked-mcp-config",
  "unknown-skill",
  "skill-exists",
  "invalid-model",
  "unknown-model",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * The body of every 4xx and 5xx the local API sends. A 5xx's message is fixed: what went wrong is
 * in the server log's line that `id` names.
 */
export interface ErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly id?: string;
  };
}

/**
 * A body or response that is not JSON: an upload's bytes, a job's NDJSON events, a log's text, a
 * character model's file.
 */
export interface Raw<Kind extends "image" | "audio" | "ndjson" | "text" | "model"> {
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
   * From the table's `<table>.meta.json`: null without one, as for a table never built or one
   * built without it.
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

/** Assistant Mode: tasks she runs on the owner's computer. */
export interface AssistantStatus {
  /** `assistant.enabled`. Off, no task starts and the Tasks page is hidden. */
  readonly enabled: boolean;
  /** A task can start: the assistant role's account and model are set, and its key is there. */
  readonly ready: boolean;
  /** Why it isn't ready, in English: no account or model chosen, or no key; null when ready. */
  readonly problem: string | null;
  /** Tasks whose status is `running`. */
  readonly running: number;
  /**
   * Tasks' web_search: on once the search role's account is chosen and has its key. `problem`,
   * in English, says why a chosen one can't search; null when none is chosen, or it can.
   */
  readonly search: { readonly on: boolean; readonly problem: string | null };
  /**
   * For each kind whose own account or model is set but can't run, why, in English: its tasks run
   * on Assistant Mode's own until it can. Null for a kind that runs, or follows Assistant Mode's;
   * all null while tasks aren't ready.
   */
  readonly kinds: Readonly<Record<TaskProfile, string | null>>;
}

/**
 * GET status, which the home page polls: cheap. It never waits on a remote probe; Qdrant and the
 * voice are checked in the background and reported from the last answer.
 */
export interface Status {
  readonly version: string;
  /**
   * A setting or credential that calls read once changed since: at boot, or when retrieval first
   * embedded. It stays set until POST restart, even if the value is set back: a reader may hold
   * the changed one.
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
    /** As PersonaSummary's, from the settings the server runs with. */
    readonly appearance: PersonaAppearance;
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
  readonly assistant: AssistantStatus;
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

/** A voice of hers that change_voice_style switches to when a viewer asks for it. */
export interface VoiceStyle {
  /** As change_voice_style passes it. */
  readonly name: string;
  /** One of her voice provider's voices. */
  readonly voiceId: string;
  /** What a viewer says to ask for it; "" leaves that to the built-in words, else the name. */
  readonly hint: string;
}

/** A voice style the environment sets. */
export interface EnvironmentVoiceStyle {
  readonly name: string;
  readonly voiceId: string;
  /** The variable that sets it. */
  readonly env: string;
  /**
   * `inherited`: she has it too. `replaced`: a style of hers takes its name. `ignored`: it goes
   * with the environment's voice, which she doesn't use.
   */
  readonly state: "inherited" | "replaced" | "ignored";
}

export interface VoiceStyles {
  /** Her persona.yaml's, in its order. */
  readonly own: readonly VoiceStyle[];
  /** By name. */
  readonly environment: readonly EnvironmentVoiceStyle[];
  /** The words the model knows a style by when it has no hint of its own, by name. */
  readonly builtInHints: Readonly<Record<string, string>>;
}

export interface SettingsResponse {
  readonly persona: string;
  readonly settings: readonly SettingRow[];
  /** `persona`'s. */
  readonly voiceStyles: VoiceStyles;
  /** What the files hold that the bot ignores, in English. */
  readonly warnings: readonly string[];
  /** As in GET status: a saved value waits for POST restart. */
  readonly restartRequired: boolean;
}

/** PUT personas/:id/voice-styles: all her styles, in order, replacing her persona.yaml's. */
export interface VoiceStylesUpdate {
  readonly styles: readonly VoiceStyle[];
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
  readonly appearance: PersonaAppearance;
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

export const CHARACTER_MODEL_KINDS = ["psd2live"] as const;
export type CharacterModelKind = (typeof CHARACTER_MODEL_KINDS)[number];

/** The most a model upload may be. */
export const MAX_MODEL_BYTES = 209_715_200;

/** A region of the rig's canvas, in its pixels (y down). */
export interface ModelBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ModelClip {
  readonly id: string;
  readonly name: string;
  readonly group: string;
  readonly duration: number;
  readonly looping: boolean;
}

export interface ModelNamed {
  readonly id: string;
  readonly name: string;
}

export interface ModelParameter {
  readonly id: string;
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

/** What the runtime read from the file at import. */
export interface ModelInventory {
  /** p2l_version() of the runtime that read it. */
  readonly runtime: string;
  /** META generator + generator_version, e.g. "psd2live 3.8.4". */
  readonly generator: string | null;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly clips: readonly ModelClip[];
  readonly expressions: readonly ModelNamed[];
  readonly hitAreas: readonly ModelNamed[];
  readonly parameters: readonly ModelParameter[];
  readonly parts: readonly ModelNamed[];
  /** Entries per group. */
  readonly poseGroups: readonly number[];
  /** The LipSync role names a parameter. */
  readonly lipSync: boolean;
  readonly textures: number;
}

/** A parameter held at a value within its range. */
export interface ModelParameterSetting {
  readonly id: string;
  readonly value: number;
}

export interface ModelOutfit {
  readonly id: string;
  readonly name: string;
  readonly poses: readonly { readonly group: number; readonly entry: number }[];
  readonly parameters: readonly ModelParameterSetting[];
  readonly hiddenParts: readonly string[];
}

export interface CharacterModel {
  readonly id: string;
  readonly name: string;
  readonly kind: CharacterModelKind;
  readonly size: number;
  readonly sha256: string;
  readonly importedAt: string;
  readonly updatedAt: string;
  readonly inventory: ModelInventory;
  /** null: the SDK's default (Head hit area for a call, the character's bounds on the desktop). */
  readonly framing: { readonly call: ModelBox | null; readonly companion: ModelBox | null };
  /** How far her gaze turns her head, body and eyes, 0..1 of the runtime's turn; 1 when unset. */
  readonly look: number;
  /** The owner's overrides only: mood tag → up to 2 expression ids; the SDK fills the rest. */
  readonly moods: Readonly<Record<string, readonly string[]>>;
  /** The owner's choices only: mood tag → up to 8 parameters it holds at a value. */
  readonly moodParameters: Readonly<Record<string, readonly ModelParameterSetting[]>>;
  /** The owner's overrides only: gesture → clip id. */
  readonly gestures: Readonly<Record<string, string>>;
  readonly outfits: readonly ModelOutfit[];
  readonly outfit: string | null;
}

export interface CharacterModels {
  readonly active: string | null;
  readonly models: readonly CharacterModel[];
}

/**
 * PATCH's fields, each checked against the model's inventory: a name of one line of 1 to 64
 * characters; `look` from 0 to 1; a mood or gesture key, and an outfit's id, a slug of up to 32
 * characters; up to 2 expressions per mood; up to 8 parameters per mood, each once and within its
 * range; up to 32 outfits, each naming its pose groups' entries, parameters within their ranges and
 * parts, each once; `outfit` one of the outfits, or null.
 */
export type CharacterModelPatch = Partial<
  Pick<
    CharacterModel,
    "name" | "framing" | "look" | "moods" | "moodParameters" | "gestures" | "outfits" | "outfit"
  >
>;

export interface CharacterModelUploadQuery {
  readonly filename?: string;
}

export interface CharacterModelFileQuery {
  readonly sha256: string;
}

export interface ActiveCharacterModel {
  readonly id: string;
  readonly name: string;
  readonly kind: CharacterModelKind;
  readonly sha256: string;
  readonly updatedAt: string;
}

export interface PersonaAppearance {
  /** What her appearance.model names, while it is one of her models; else null. */
  readonly model: ActiveCharacterModel | null;
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

export const VOICE_VISIBILITIES = ["public", "unlist", "private"] as const;

/** Who finds a Fish voice: everyone, whoever has its link, or its owner alone. */
export type VoiceVisibility = (typeof VOICE_VISIBILITIES)[number];

/** A Fish voice, with absolute https URLs. */
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
  readonly visibility: VoiceVisibility;
  /** ISO 8601; null where Fish gives none. */
  readonly createdAt: string | null;
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

/** GET accounts/:id/voices: a Fish account's own voices, newest first; `q` matches titles only. */
export interface AccountVoicesQuery {
  readonly q?: string;
  /** Unset lists every one. */
  readonly visibility?: VoiceVisibility;
  readonly page?: number;
}

export interface AccountVoicesResponse extends VoiceSearchResponse {
  /** `ok` with its voices; `no-key` while the account has no key; `refused` when Fish refused it. */
  readonly status: "ok" | "no-key" | "refused";
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
 * DELETE jobs/:id asks the job to stop, which it answers as SIGTERM, by cancelling its run once any
 * index rebuild it is in has finished; a repeat sends nothing more.
 */
export interface JobCancelQuery {
  /**
   * 1, on a job already stopping: kills it and what it started, at once, which can leave an index
   * without its table or its full-text index until the next ingest.
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
  "GET /api/local/accounts/:id/voices": Endpoint<
    undefined,
    AccountVoicesResponse,
    AccountVoicesQuery
  >;
  "GET /api/local/personas": Endpoint<undefined, PersonasResponse>;
  "POST /api/local/personas": Endpoint<CreatePersonaRequest, PersonaSummary>;
  "PUT /api/local/personas/active": Endpoint<ActivePersonaRequest, PersonasResponse>;
  "GET /api/local/personas/:id/prompt": Endpoint<undefined, PersonaText>;
  "PUT /api/local/personas/:id/prompt": Endpoint<TextUpdate, PersonaText>;
  "GET /api/local/personas/:id/glossary": Endpoint<undefined, GlossaryResponse>;
  "PUT /api/local/personas/:id/glossary": Endpoint<TextUpdate, GlossaryResponse>;
  "GET /api/local/personas/:id/identity": Endpoint<undefined, PersonaIdentityFields>;
  "PUT /api/local/personas/:id/identity": Endpoint<IdentityUpdate, PersonaIdentityFields>;
  "PUT /api/local/personas/:id/voice-styles": Endpoint<VoiceStylesUpdate, SettingsResponse>;
  "GET /api/local/personas/:id/references": Endpoint<undefined, ReferencesResponse>;
  "GET /api/local/personas/:id/references/:kind/:name": Endpoint<undefined, Raw<"image">>;
  "POST /api/local/personas/:id/references/:kind/:name": Endpoint<Raw<"image">, ReferenceImage>;
  "DELETE /api/local/personas/:id/references/:kind/:name": Endpoint<undefined, Ok>;
  "GET /api/local/personas/:id/avatar": Endpoint<undefined, Raw<"image">>;
  "PUT /api/local/personas/:id/avatar": Endpoint<Raw<"image">, ReferenceImage>;
  "DELETE /api/local/personas/:id/avatar": Endpoint<undefined, Ok>;
  /**
   * Her character models, which live only in her folder in the data home. Every
   * personas/:id/models/:model route answers 400 bad-request for a malformed model id, which is
   * never looked up, and 404 unknown-model for one she doesn't have.
   */
  "GET /api/local/personas/:id/models": Endpoint<undefined, CharacterModels>;
  /**
   * A .p2lrt, its bytes the body, kept under an id the server makes from `filename`; it never
   * becomes her active model. 400 bad-request when empty; 413 payload-too-large past
   * MAX_MODEL_BYTES; 415 unsupported-media-type for bytes that don't start as a .p2lrt does; 400
   * invalid-model, with the reason, when PSD2Live's runtime refuses it, its textures aren't PNGs
   * inside the file or its inventory passes 1 MiB; 409 call-active during a call.
   */
  "POST /api/local/personas/:id/models": Endpoint<
    Raw<"model">,
    CharacterModel,
    CharacterModelUploadQuery
  >;
  /**
   * A new file for the model, which keeps its id, name and settings, but for the moods, gestures
   * and outfit entries naming what the new file lacks. Its errors are POST's.
   */
  "PUT /api/local/personas/:id/models/:model/file": Endpoint<
    Raw<"model">,
    CharacterModel,
    CharacterModelUploadQuery
  >;
  /**
   * Each field sent replaces the model's. 400 bad-request for a field of the wrong shape, or one
   * naming what the model's file lacks.
   */
  "PATCH /api/local/personas/:id/models/:model": Endpoint<CharacterModelPatch, CharacterModel>;
  /** Also clears her appearance.model when it names the model. */
  "DELETE /api/local/personas/:id/models/:model": Endpoint<undefined, Ok>;
  /**
   * The model's .p2lrt while `sha256` is its file's, as immutable, which a browser caches for good.
   * 400 bad-request without `sha256`; 404 not-found for any other.
   */
  "GET /api/local/personas/:id/models/:model/file": Endpoint<
    undefined,
    Raw<"model">,
    CharacterModelFileQuery
  >;
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
  /** Newest activity first. */
  "GET /api/local/chats": Endpoint<undefined, readonly ChatSummary[]>;
  "POST /api/local/chats": Endpoint<ChatCreateRequest, ChatCreated>;
  "GET /api/local/chats/:id": Endpoint<undefined, ChatContents, ChatReadQuery>;
  "PATCH /api/local/chats/:id": Endpoint<ChatUpdateRequest, Ok>;
  /** 409 chat-in-call during a call. */
  "DELETE /api/local/chats/:id": Endpoint<undefined, Ok>;
  "POST /api/local/chats/:id/files": Endpoint<Raw<"image" | "text">, Attachment, ChatFileQuery>;
  "POST /api/local/chats/:id/messages": Endpoint<ChatMessageRequest, Raw<"ndjson">>;
  "POST /api/local/chats/:id/voice": Endpoint<Raw<"audio">, Raw<"ndjson">, ChatVoiceQuery>;
  /**
   * The running reply from its start; during a call, each event the chat stores, from its
   * call-started to its call-ended, where the stream ends. A 204 with no body while neither runs.
   */
  "GET /api/local/chats/:id/live": Endpoint<undefined, Raw<"ndjson">>;
  /** A 204 with no body, once the turn has stopped and what it said is stored. */
  "POST /api/local/chats/:id/stop": Endpoint<undefined, undefined>;
  "POST /api/local/chats/:id/participants": Endpoint<ChatParticipantsRequest, Ok>;
  /** Audio answers Range requests, so a player can seek. */
  "GET /api/local/chats/:id/files/:name": Endpoint<undefined, Raw<"image" | "audio">>;
  /** The app's tasks, which she starts in her chats with start_task; nothing else starts one. */
  "GET /api/local/tasks": Endpoint<undefined, TasksResponse, TasksQuery>;
  /**
   * 400 bad-request for a malformed id, which is never looked up. Every tasks/:id route answers 404
   * unknown-task for a laplace-task task's id too.
   */
  "GET /api/local/tasks/:id": Endpoint<undefined, TaskSnapshot>;
  /**
   * Each line a TaskEntry, as transcript.jsonl holds it: the entries from `after`, then each one
   * stored while the task runs, until it stops running. 416 range-not-satisfiable past the end.
   */
  "GET /api/local/tasks/:id/events": Endpoint<undefined, Raw<"ndjson">, TaskEventsQuery>;
  /**
   * 400 for a `model` createMind refuses. 409 nothing-pending, also for a `pending` the task no
   * longer asks; task-locked while another process, such as laplace-task, runs it; assistant-off;
   * assistant-not-ready, which Status' `assistant.problem` explains.
   */
  "POST /api/local/tasks/:id/approve": Endpoint<TaskApproveRequest, TaskSnapshot>;
  /**
   * 409 not-paused; pending, when it waits on an approval instead; task-locked; assistant-off;
   * assistant-not-ready.
   */
  "POST /api/local/tasks/:id/continue": Endpoint<TaskContinueRequest, TaskSnapshot>;
  /**
   * The card's Stop, which works while Assistant Mode is off too: a live task comes back cancelled,
   * an ended one as it is. No route deletes a task: its record says what was done on the computer.
   */
  "DELETE /api/local/tasks/:id": Endpoint<undefined, TaskSnapshot>;
  /** The commands Always in This Folder allowed on tasks' cards. */
  "GET /api/local/assistant/commands": Endpoint<undefined, AllowedCommandsResponse>;
  /**
   * Takes one back, answering with the rest: that command asks again. 400 bad-request for a
   * malformed id; 404 unknown-command.
   */
  "DELETE /api/local/assistant/commands/:id": Endpoint<undefined, AllowedCommandsResponse>;
  /** The MCP servers mcp.json gives tasks, as the file stands now. */
  "GET /api/local/mcp": Endpoint<undefined, McpServersResponse>;
  /**
   * Turns one on or off, or takes back one tool's Always, answering as GET does. 400 bad-request
   * for anything else; 404 unknown-mcp-server; 409 invalid-mcp-config while mcp.json doesn't
   * parse, and linked-mcp-config while it is a link, neither ever written over.
   */
  "PUT /api/local/mcp/servers/:name": Endpoint<McpServerChange, McpServersResponse>;
  /** The owner's skills and the built-in ones as their folders hold them now, each with its switch. */
  "GET /api/local/skills": Endpoint<undefined, SkillsResponse>;
  /**
   * Writes a new skill into the data home's skills folder, answering as GET does. 400 bad-request
   * for a name that breaks the naming rules, a blank description or one over 1,024 characters;
   * 409 skill-exists when the data home already has a skill folder by that name.
   */
  "POST /api/local/skills": Endpoint<SkillCreate, SkillsResponse>;
  /**
   * Switches the skills named `name` on or off, answering as GET does. 400 bad-request for
   * anything but `{enabled}`; 404 unknown-skill when no skill, the owner's or built in, has that
   * name.
   */
  "PUT /api/local/skills/:name": Endpoint<SkillChange, SkillsResponse>;
}

/**
 * POST chats: 1 to 6 personas, each once. One persona's greeting then runs, and GET live streams it;
 * a group chat doesn't greet, and is titled with their short names.
 */
export interface ChatCreateRequest {
  readonly participants: readonly ParticipantId[];
}

export interface ChatCreated {
  readonly id: string;
}

/** GET chats/:id. */
export interface ChatContents {
  readonly header: ChatHeader;
  readonly events: readonly ChatEvent[];
  /**
   * Tools her interrupted turns left running, by name, such as a selfie still rendering: what they
   * bring is stored after the turn, and each leaves the list once it is.
   */
  readonly lateTools: readonly string[];
  /**
   * Why the viewer can't send a voice message now, in English: the hearing role of the chat's first
   * persona, which hears them, has no key or can't be resolved, and POST voice answers 409
   * missing-key with this message. null when it can hear one.
   */
  readonly hearingRefusal: string | null;
  /**
   * While no persona in the chat can be called for want of a key, the accounts their calls lack
   * one for, as Settings names them; else empty.
   */
  readonly missingCallKeys: readonly string[];
  /** The call on in this chat, from its call-started until its call-ended is stored; else null. */
  readonly call: ChatCallInfo | null;
  /**
   * Whether the viewer can call every persona in the chat at once (`group` in the offer): a chat of
   * two or more, none of them on a realtime model.
   */
  readonly groupCall: boolean;
  /**
   * The app's chats.display as the read was made, which the chat shows her tasks by until a
   * `settings` event of its own sets a `display`.
   */
  readonly defaultDisplay: ChatDisplay;
  /**
   * The app's assistant.permissions as the read was made, which her tasks there act under until a
   * `settings` event of the chat's own sets `permissions`.
   */
  readonly defaultPermissions: PermissionLevel;
}

export interface ChatCallInfo {
  /** The `call` its call-started and call-ended carry. */
  readonly id: string;
  /** Whom the viewer called; in a group call, the host. */
  readonly persona: ParticipantId;
  /** Every persona in the chat is on the call. */
  readonly group?: true;
}

/**
 * The `requestData` of a local POST /api/offer that calls a persona inside a chat. The call runs as
 * `persona`, active or not, opens on her view of the chat, and stores each finished line in it as a
 * `call` message; GET chats/:id/live streams them. Without `chatId`, the call is the standalone
 * one to the active persona. Refused with 400 bad-request (no persona, or one not in the chat),
 * 404 unknown-chat, 400 invalid-persona-id or 404 unknown-persona, and 409 chat-in-call while
 * the chat is in another call.
 *
 * With `group`, every persona in the chat is on the call, `persona` hosting: her hearing role hears
 * the viewer, the director chooses who answers each line, and each decision is stored too. Refused
 * with 400 bad-request in a chat of one, and 409 realtime-in-group when a persona in the chat
 * talks through a realtime model.
 */
export interface ChatCallRequestData {
  readonly chatId: string;
  readonly persona: ParticipantId;
  readonly group?: boolean;
}

export interface ChatReadQuery {
  /** Only the events after this seq; every one when absent. */
  readonly afterSeq?: number;
}

/**
 * POST chats/:id/files: a file the viewer sends with a line, its bytes the body: a text file in UTF-8
 * of at most 1 MB, sent as any `text/` type, or else an image, a PNG, JPEG, WebP or GIF of at most
 * 50 MB and 64 megapixels, made ready for her mind as it is kept. It is kept in the chat's files/
 * under its content's hash, and answered 201 with its attachment, which POST messages names. 415 for
 * bytes that aren't one; 413 past the size; 400 when empty.
 */
export interface ChatFileQuery {
  /** A text file's name on the viewer's computer, which the line shows and her view names it by. */
  readonly filename?: string;
}

/**
 * POST chats/:id/messages: up to 4000 characters, and up to 8 files sent to POST files first,
 * one at least, answered with ChatStreamLines: the viewer's line, then for each line the director
 * answers, its `decision` and every chosen persona's turn. A reply still running is stopped first,
 * with the hops queued after it, and what it said is stored as interrupted. 409 chat-in-call during
 * a call, as for POST voice.
 */
export interface ChatMessageRequest {
  readonly text?: string;
  readonly attachments?: readonly {
    readonly name: string;
    /** A text file's name, as POST files answered it. */
    readonly filename?: string;
  }[];
}

/**
 * POST chats/:id/voice: a recorded voice message as the body, of type audio/webm, audio/ogg,
 * audio/mp4 or audio/mpeg, codecs and all, at most 10 MB, else 415 or 413. As POST messages, it
 * stops a reply still running; the clip is then heard through the hearing role of the chat's first
 * persona, stored with its transcript, which is empty when nothing was heard, and answered. The
 * stream is POST messages'. 409 missing-key while that role can't hear (ChatContents'
 * `hearingRefusal`) or a mind has no key; 502 upstream-failed, with nothing stored, when the
 * hearing provider fails.
 */
export interface ChatVoiceQuery {
  /** The clip's length by the recorder's clock, a whole number of ms up to 120000 (2 minutes). */
  readonly durationMs: number;
}

/**
 * PATCH chats/:id, one field at a time: a `title` of 1 to 80 characters on one line, the
 * `chainLimit` of persona-to-persona hops after each viewer line, 0 to 6, the `replyMode` that
 * overrides every persona's own, the `display` of her tasks there, focus, normal or verbose, or the
 * `permissions` her tasks there act under, ask, auto or full; each setting is kept as a `settings`
 * event.
 */
export type ChatUpdateRequest =
  | { readonly title: string }
  | { readonly chainLimit: number }
  | { readonly replyMode: ReplyMode }
  | { readonly display: ChatDisplay }
  | { readonly permissions: PermissionLevel };

/**
 * POST chats/:id/participants: personas to add, who aren't in the chat, and to remove, who are,
 * leaving 1 to 6. Kept as a `participants` event; a reply already running is left to finish.
 */
export interface ChatParticipantsRequest {
  readonly add?: readonly ParticipantId[];
  readonly remove?: readonly ParticipantId[];
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
  /** Web searches, as each provider billed them. */
  readonly searches: number;
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

/**
 * `interrupted`: the server stopped while it ran; it resumes at the next start while Assistant Mode
 * is on and ready, else on Continue. A task that `succeeded`, `failed` or was `cancelled` never
 * runs again.
 */
export type TaskStatus =
  | "awaiting-approval"
  | "running"
  | "paused"
  | "interrupted"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface TaskBrief {
  readonly goal: string;
  readonly deliverable: string;
  /** Absolute. */
  readonly folder: string;
  /** How the worker checks the deliverable before it reports. */
  readonly check: string;
}

/** An account, and the model a task runs on there. */
export interface TaskModel {
  readonly account: string;
  readonly model: string;
}

export interface TaskGrant {
  /** Absolute, or under `~`. */
  readonly path: string;
  readonly access: "read" | "read-write";
}

/**
 * `spend`: it reached the next multiple of its spend pause. `stall`: the same calls three turns
 * running. `approval`: it waits on the owner. `unpriced`: a request's spend can't be counted.
 */
export type TaskPauseReason = "spend" | "stall" | "approval" | "unpriced";

/** How a run ended, from the runtime, never from the worker's words. */
export type TaskOutcome =
  | { readonly status: "succeeded"; readonly report: string }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "cancelled" }
  | { readonly status: "paused"; readonly reason: TaskPauseReason; readonly detail: string };

/**
 * The risk Approve for Me's review named for an action it asks the owner about, or `failed` when
 * it named none.
 */
export type ReviewReason =
  | "delete"
  | "outside"
  | "secrets"
  | "send"
  | "publish"
  | "system"
  | "download"
  | "spend"
  | "unclear"
  | "failed";

/**
 * What a task waits on the owner for: to start, a path outside its grants, a site, a command, or
 * a call to an MCP server's tool.
 */
export type TaskPending = (
  | { readonly kind: "start" }
  | {
      readonly kind: "path";
      readonly path: string;
      readonly access: "read" | "write";
      /**
       * What an Allow grants, with the access asked for (a write's is read-write): the path when it
       * is a folder, else its parent. Absent when the path alone is granted, a file right in home.
       */
      readonly folder?: string;
    }
  | { readonly kind: "fetch"; readonly host: string }
  | {
      readonly kind: "command";
      /** The worker's call that asks, which an answer names with the command. */
      readonly call: string;
      /**
       * As it would run in the task's folder, whole: worker-written text, whose control and
       * invisible characters a page shows escaped.
       */
      readonly command: string;
      /** The seconds it may run once started, its time in the background included. */
      readonly timeout: number;
      /**
       * Always in This Folder allows it, but the task has read outside content (`external`), so it
       * asks anyway.
       */
      readonly granted?: true;
    }
  | {
      readonly kind: "mcp";
      /** The server, as mcp.json names it. */
      readonly server: string;
      /** The tool, as the server lists it. */
      readonly tool: string;
      /** The worker's call that asks, which an answer names with `key`. */
      readonly call: string;
      /** A hash of the call's tool and arguments, which Run Once and Deny hold. */
      readonly key: string;
      /**
       * Every argument the call sends, the shortest first. The whole call is the transcript's
       * `assistant` entry that holds `call`.
       */
      readonly args: readonly McpArgument[];
      /** What the server claims of the tool: shown as its claim, and never deciding anything. */
      readonly hint?: "read-only" | "destructive";
    }
) & {
  /** Approve for Me's review asked rather than let it through, and why. */
  readonly review?: ReviewReason;
};

/** One argument of an MCP call, as its card shows it. */
export interface McpArgument {
  /** Worker-written, as the value is. */
  readonly name: string;
  /**
   * A string as it is, anything else as JSON, cut at 300 characters, or shorter when the call
   * sends many.
   */
  readonly head: string;
  /** The whole value's length, in UTF-16 units as `head`'s. */
  readonly chars: number;
  readonly lines: number;
}

/** A task's MCP servers, as its card tells of them. */
export interface TaskMcp {
  /** The calls the owner refused it, by their key: it may not make them again. */
  readonly denied: readonly string[];
  /** The servers it works without, or mcp.json itself (no `server`), and why, in English. */
  readonly failed?: readonly { readonly server?: string; readonly error: string }[];
  /** How many of a server's tools the limits left out of it. */
  readonly left?: readonly { readonly server: string; readonly count: number }[];
}

/** The kinds of task with an account and model of their own, which she names at its start. */
export type TaskProfile = "quick" | "coding" | "research";

/** A task's command running in the background. */
export interface BackgroundCommand {
  /** Its number in the task, from 1. */
  readonly id: number;
  readonly command: string;
  /** ms since the epoch, as `endsAt`. */
  readonly startedAt: number;
  /** When its timeout kills it. */
  readonly endsAt: number;
}

export interface TaskPause {
  readonly reason: TaskPauseReason;
  readonly detail: string;
}

export type TaskTodoStatus = "pending" | "in_progress" | "done";

/** A step of the plan the worker keeps with its todo tool. */
export interface TaskTodoItem {
  readonly text: string;
  readonly status: TaskTodoStatus;
}

/** Lines for the task's run, kept until the run takes them. */
export interface TaskInboxLines {
  readonly steer: readonly string[];
  readonly followUp: readonly string[];
}

/** `ask`: the owner allows each site. `off`: the task gets no web_fetch. */
export type TaskWebMode = "ask" | "any" | "off";

export interface TaskWebAccess {
  readonly mode: TaskWebMode;
  /** Sites allowed while the mode is `ask`. */
  readonly hosts: readonly string[];
  /** Sites the owner refused. */
  readonly denied: readonly string[];
}

/** The latest tool call a task's run started. */
export interface TaskStep {
  /** The worker's tool, such as `write`. */
  readonly tool: string;
  /** Its path, url, pattern, glob or query, else its arguments' JSON: 120 characters at most. */
  readonly head: string;
}

/** Where a task started: the chat, the persona in it, and her start_task call's id. */
export interface TaskChat {
  readonly id: string;
  readonly persona: ParticipantId;
  /** The task's card sits at this call in the chat's log. */
  readonly call: string;
}

/** A task as its task.json holds it, which the task routes answer with. */
export interface TaskSnapshot {
  readonly v: 1;
  /** A UUIDv7, so ids sort by creation. */
  readonly id: string;
  /** ms since the epoch, as `endedAt`. */
  readonly createdAt: number;
  readonly status: TaskStatus;
  /** Set on every task the routes show: laplace-task's tasks have none, and answer 404. */
  readonly chat?: TaskChat;
  readonly brief: TaskBrief;
  readonly model: TaskModel;
  /** Folders besides its own. */
  readonly grants: readonly TaskGrant[];
  /** It pauses each time its spend crosses a multiple of this; 0 never. */
  readonly spendPauseUsd: number;
  readonly spentUsd: number;
  /** Absolute paths. */
  readonly files: { readonly read: readonly string[]; readonly written: readonly string[] };
  readonly endedAt?: number;
  readonly outcome?: TaskOutcome;
  readonly pending?: TaskPending;
  /** The latest pause, while `paused`. */
  readonly pause?: TaskPause;
  /** The latest list its todo tool wrote. */
  readonly todo?: readonly TaskTodoItem[];
  readonly step?: TaskStep;
  readonly inbox?: TaskInboxLines;
  /** `ask` with no sites when absent. */
  readonly web?: TaskWebAccess;
  /**
   * The kind of task she said it is, whose account and model it started on; absent when she
   * called it anything else, which runs on Assistant Mode's own.
   */
  readonly profile?: TaskProfile;
  /** The owner's skills she named for it, which it follows from its start; absent for none. */
  readonly skills?: readonly string[];
  /** The commands the owner refused it on its card: it may not run them again. */
  readonly bash?: { readonly denied: readonly string[] };
  /**
   * The paths the owner refused it on its card: no permission level grants a folder that holds one
   * or lies in one without asking again.
   */
  readonly paths?: { readonly denied: readonly string[] };
  /** Its commands running in the background, oldest first; the card's Stop ends them too. */
  readonly background?: readonly BackgroundCommand[];
  /**
   * It has read outside content: a page web_fetch got, a web search's results, or an MCP server's
   * answer. Commands allowed for good in its folder, and tools always allowed, ask again from then
   * on.
   */
  readonly external?: true;
  /** Absent while it has nothing to say. */
  readonly mcp?: TaskMcp;
  /** Cancelled by the owner's Deny at its start. */
  readonly denied?: true;
  /** Its `final` is stored in its chat. */
  readonly reported?: true;
}

/** A tool call in the worker's reply. */
export interface TaskToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /**
   * A call that never ran, its arguments' text as streamed: they aren't a JSON object, or the
   * output limit cut its reply off. Its `arguments` are then `{}`.
   */
  readonly unparsed?: string;
}

/** Absolute paths. */
export interface TaskFiles {
  readonly read?: readonly string[];
  readonly written?: readonly string[];
}

/** A line of a task's transcript.jsonl: `seq` counts from 1, `at` is ms since the epoch. */
export type TaskEntry = { readonly seq: number; readonly at: number } & (
  | { readonly type: "brief"; readonly brief: TaskBrief }
  | {
      readonly type: "assistant";
      readonly text: string;
      readonly calls: readonly TaskToolCall[];
      /** As its provider put it: a reply cut off or stopped is no report. */
      readonly finishReason?: string | null;
    }
  | { readonly type: "tool-start"; readonly callId: string; readonly name: string }
  | {
      readonly type: "tool-result";
      readonly callId: string;
      readonly name: string;
      /** What the worker saw, truncated. */
      readonly content: string;
      readonly isError: boolean;
      /** The tool's own, which the worker never sees, such as an edit's diff. */
      readonly details?: unknown;
      readonly files?: TaskFiles;
      /** The path the call was refused, so the owner can be asked for it. */
      readonly refused?: { readonly path: string; readonly access: "read" | "write" };
    }
  | { readonly type: "steer"; readonly text: string }
  | { readonly type: "follow-up"; readonly text: string }
  /** A runtime fact from the task's background work, such as a command ending. */
  | { readonly type: "notice"; readonly text: string }
  | {
      readonly type: "compaction";
      readonly summary: string;
      /** The first entry the worker's context keeps after the summary. */
      readonly firstKeptSeq: number;
      readonly files: { readonly read: readonly string[]; readonly written: readonly string[] };
      readonly tokensBefore: number;
    }
  | { readonly type: "pause"; readonly reason: TaskPauseReason; readonly detail: string }
  | { readonly type: "resume" }
  | { readonly type: "end"; readonly outcome: TaskOutcome }
);

export interface TasksQuery {
  /** A chat's id: only the tasks she started in it. */
  readonly chat?: string;
}

export interface TasksResponse {
  /** Newest first. */
  readonly tasks: readonly TaskSnapshot[];
}

export interface TaskEventsQuery {
  /** A byte offset into the transcript, at the start of a line. */
  readonly after?: number;
}

/** POST tasks/:id/approve: the owner's answer to its `pending`. */
export interface TaskApproveRequest {
  /**
   * `once`: for this task alone, and a command or an MCP call for its call alone. `always`: a
   * start's folder, or the `folder` a write's question names, joins `assistant.folders` (on any
   * other path question it is `once`); a site's answer turns the task's web mode to `any`; a
   * command runs, and is allowed in the task's folder for good (GET assistant/commands); an MCP
   * call runs, and its tool joins its server's `alwaysAllow` in mcp.json (409 invalid-mcp-config
   * while that file doesn't parse, linked-mcp-config while it is a link). `deny`: a start ends
   * `cancelled` and `denied`; a path, a site, a command or an MCP call with these arguments is
   * refused, and the run goes on.
   */
  readonly answer: "once" | "always" | "deny";
  /**
   * The question answered, as the snapshot's `pending` put it: one the task no longer asks is 409
   * nothing-pending, so a page showing an older question can't answer a newer one.
   */
  readonly pending?: TaskPending;
  /**
   * A start's only: the model to run on instead. One createMind would refuse, an unknown account
   * or one with no key, is a 400.
   */
  readonly model?: TaskModel;
  /** A start's only. */
  readonly web?: TaskWebMode;
}

/** POST tasks/:id/continue: for a task paused with no `pending`, or interrupted. */
export interface TaskContinueRequest {
  /** Replaces the task's own; continuing an `unpriced` pause sets it to 0. */
  readonly spendPauseUsd?: number;
}

/**
 * A command the owner allowed for good from a task's card: every task in `folder` runs exactly
 * this command there without asking, until one has read outside content.
 */
export interface AllowedCommand {
  /** A UUIDv7. */
  readonly id: string;
  /** Absolute, as the folder lies on disk: no subfolder is allowed with it. */
  readonly folder: string;
  /** Exactly as it runs: a command that differs by a character asks. */
  readonly command: string;
  /** ms since the epoch. */
  readonly addedAt: number;
  /** The task whose card allowed it. */
  readonly task: string;
}

/** GET assistant/commands, and what a DELETE leaves. */
export interface AllowedCommandsResponse {
  /** Newest first. */
  readonly commands: readonly AllowedCommand[];
}

/**
 * One server mcp.json declares, never with an `env` value or what a `${NAME}` resolves to: an
 * entry that doesn't check out has only its name, its switch and its problem.
 */
export interface McpServerView {
  readonly name: string;
  /** As mcp.json writes it, `~` and `${NAME}` unexpanded. */
  readonly command?: string;
  readonly args?: readonly string[];
  /** Neither `enabled: false` nor `disabled: true`. */
  readonly enabled: boolean;
  /** The owner's words for it. */
  readonly description?: string;
  /** The tools a task calls without asking. */
  readonly alwaysAllow: readonly string[];
  /** Each `${NAME}` it references, and whether the environment or mcpSecrets sets it. */
  readonly needs: readonly { readonly name: string; readonly set: boolean }[];
  /** Why the entry can't start, in English; null when it checks out. */
  readonly problem: string | null;
  /** The entry isn't an object, so a PUT can't change it: mcp.json needs fixing first. */
  readonly unchangeable?: true;
}

/** GET mcp, and what a PUT leaves. */
export interface McpServersResponse {
  /** mcp.json's path. */
  readonly path: string;
  /** In mcp.json's order, an entry that doesn't check out after those that do. */
  readonly servers: readonly McpServerView[];
  /** Why mcp.json as a whole starts no server: it doesn't parse, or isn't the mcpServers shape. */
  readonly errors: readonly string[];
}

/**
 * PUT mcp/servers/:name: its switch, or one tool's Always taken back, or both. Always is only ever
 * added from a task's card.
 */
export interface McpServerChange {
  /** On deletes `enabled` and `disabled`; off writes `enabled: false`. */
  readonly enabled?: boolean;
  /** A tool to take out of `alwaysAllow`: its calls ask again. */
  readonly revoke?: string;
}

/**
 * Where a skill tasks may use is: the data home's skills folder, the one the owner's agents share,
 * or the skills that ship with Eidolon.
 */
export type SkillOrigin = "eidolon" | "shared" | "builtin";

export interface SkillSourceView {
  readonly id: SkillOrigin;
  /** Absolute, `~` standing for the home folder. */
  readonly path: string;
}

/**
 * A skill in one of the owner's skill folders, or one that ships with Eidolon. A task folder's own
 * skills are never listed.
 */
export interface SkillView {
  readonly name: string;
  /** One line, as tasks read it. */
  readonly description: string;
  readonly source: SkillOrigin;
  /** As found in its source, `~` standing for the home folder. */
  readonly folder: string;
  /** Where its files are, when a link on the way there leads elsewhere. */
  readonly linksTo?: string;
  /**
   * The owner's switch, which goes by name: off, no task uses a skill by this name and she can't
   * name it.
   */
  readonly enabled: boolean;
  /** It opts out of model use: a task follows it only when she names it. */
  readonly onlyWhenNamed?: true;
  /** On, but tasks' list of skills is full without it, so a task loads it only when she names it. */
  readonly unlisted?: true;
  /** She can ask for it by name: start_task's `skills` takes it. */
  readonly nameable?: true;
  /** On, but past the 150 names she can give a task: she can't ask for it by name. */
  readonly unnameable?: true;
  /** The folder of the skill by this name that is used instead. */
  readonly shadowedBy?: string;
  /** What is off about it, in English, such as a name that breaks the naming rules. */
  readonly problems: readonly string[];
}

/** GET skills, and what a POST or PUT leaves. */
export interface SkillsResponse {
  /**
   * The data home's skills folder, then the folder the owner's agents share, then the built-in
   * skills' folder.
   */
  readonly sources: readonly SkillSourceView[];
  /** By name, a skill used before one it shadows. */
  readonly skills: readonly SkillView[];
  /** SKILL.md files and folders left out, and why, such as a SKILL.md with no description. */
  readonly skipped: readonly { readonly path: string; readonly message: string }[];
  /** Why skills.json can't be read, which then switches nothing off. */
  readonly errors: readonly string[];
}

/** PUT skills/:name. */
export interface SkillChange {
  readonly enabled: boolean;
}

/** POST skills: a skill of the owner's own, written to the data home's skills folder. */
export interface SkillCreate {
  /** Lowercase letters, digits and single hyphens, at most 64 characters: its folder's name too. */
  readonly name: string;
  /** What it does and when to use it: tasks choose a skill by it. At most 1,024 characters. */
  readonly description: string;
  /** SKILL.md's body, in Markdown. */
  readonly instructions: string;
}

/** The name of her tool that starts a task, as her `tool-call` events carry it. */
export type StartTaskToolName = "start_task";

/** Her tools that pass the owner's change to a task of hers, stop one, and read one's detail. */
export type SteerTaskToolName = "steer_task";
export type StopTaskToolName = "stop_task";
export type CheckTaskToolName = "check_task";

// Types, not interfaces: an interface can't be assigned to a record, which is what a tool returns
// and a tool-result event holds.

/** start_task's result as it returns, stored as her `tool-result` with `stage: "started"`. */
export type StartTaskStarted = {
  /** The task's id. */
  readonly task: string;
  readonly status: Extract<TaskStatus, "running" | "awaiting-approval">;
};

/** start_task's result once the task has ended, stored with `stage: "final"`. */
export type StartTaskFinal = {
  /** From the runtime, never from the worker's own words. */
  readonly status: Extract<TaskStatus, "succeeded" | "failed" | "cancelled">;
  /**
   * The worker's report, or why the task failed; empty when cancelled. Cut at 4,000 characters
   * with a note.
   */
  readonly report: string;
  /** Absolute paths: what its tool log shows it wrote, the first 50. */
  readonly files: readonly string[];
  /** How many more it wrote, when that is more than 50; the task's snapshot lists them all. */
  readonly moreFiles?: number;
  readonly spentUsd: number;
};

/** How each line she passes on with steer_task starts, in the task's inbox and its transcript. */
export const STEER_PREFIX = "The assistant updates the brief: ";

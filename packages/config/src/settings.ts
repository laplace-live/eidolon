// The settings layers. The install's: code defaults < settings.yaml < the environment. A persona's:
// code defaults < the local app's derived defaults < the environment < her persona.yaml. The
// environment's model and voice settings belong to the environment's provider, so they skip a
// persona who picks another, and its voice styles skip one with her own voice. Secrets come from
// credentials.json or the environment, never YAML. Every setting maps to one variable, and the env
// readers consult this layer, so a value parses and warns exactly as it would from the environment.
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ACCOUNTS_KEY, type AccountEntry, accountProvider, parseAccounts } from "./accounts.ts";
import { envVariable, setFileLayer } from "./env.ts";
import { DEFAULT_PERSONA, dataHome, personaDirs, personaIds, resolvePersonaPath } from "./home.ts";
import { logger } from "./logger.ts";
import { expandUser } from "./paths.ts";
import { isPlainObject } from "./py.ts";
import { type PersonaScope, personaScopes } from "./scope.ts";

export type SettingScope = "app" | "persona";
export type SettingKind = "string" | "int" | "float" | "flag" | "list" | "path" | "paths";

export interface SettingField {
  /** Dotted path in the scope's YAML file. */
  readonly path: string;
  readonly env: string;
  readonly scope: SettingScope;
  readonly kind: SettingKind;
  readonly title: string;
  /** A provider row's value when nothing sets it, unless it follows another. */
  readonly default?: string;
  /** A provider row that, unset, takes this provider row's value. */
  readonly follows?: string;
  /** The provider row whose provider this value is for: a model, a voice. */
  readonly provider?: string;
  /** A provider-named variable that also sets this, read while that provider fills the role. */
  readonly legacy?: { readonly env: string; readonly provider: string };
}

type FieldOptions = Pick<SettingField, "default" | "follows" | "provider" | "legacy">;

const field = (
  scope: SettingScope,
  path: string,
  env: string,
  kind: SettingKind,
  title: string,
  options: FieldOptions = {},
): SettingField => ({ path, env, scope, kind, title, ...options });

/** Every setting a YAML file may hold, in the order the web settings show them. */
export const SETTINGS: readonly SettingField[] = [
  field("app", "persona", "EIDOLON_PERSONA", "string", "Active persona"),
  field("app", "local.viewerName", "EIDOLON_LOCAL_VIEWER_NAME", "string", "Your name"),
  field("app", "access.workersBaseUrl", "WORKERS_BASE_URL", "string", "LAPLACE Workers URL"),
  field("app", "access.validateTtlSec", "EIDOLON_VALIDATE_TTL_SEC", "int", "Login cache seconds"),
  field(
    "app",
    "access.anonRateLimitPerHour",
    "EIDOLON_ANON_RATE_LIMIT_PER_HOUR",
    "int",
    "Anonymous calls per window",
  ),
  field(
    "app",
    "access.anonRateLimitWindowSec",
    "EIDOLON_ANON_RATE_LIMIT_WINDOW_SEC",
    "int",
    "Anonymous window seconds",
  ),
  field("app", "access.realIpHeader", "EIDOLON_REAL_IP_HEADER", "string", "Client IP header"),
  field(
    "app",
    "access.allowedOrigins",
    "PIPECAT_ALLOWED_ORIGINS",
    "list",
    "Allowed browser origins",
  ),
  field("app", "access.chatPersonas", "EIDOLON_CHAT_PERSONAS", "list", "Public chat personas"),
  field(
    "app",
    "access.chatAnonQuota",
    "EIDOLON_CHAT_ANON_QUOTA",
    "int",
    "Anonymous chat turns per hour",
  ),
  field(
    "app",
    "access.chatUserQuota",
    "EIDOLON_CHAT_USER_QUOTA",
    "int",
    "Logged-in chat turns per hour",
  ),
  field(
    "app",
    "network.cloudflareTurn.keyId",
    "CLOUDFLARE_TURN_KEY_ID",
    "string",
    "Cloudflare TURN key id",
  ),
  field(
    "app",
    "network.cloudflareTurn.ttlSec",
    "CLOUDFLARE_TURN_TTL_SEC",
    "int",
    "TURN credential lifetime",
  ),
  field("app", "network.stunUrl", "WEBRTC_STUN_URL", "string", "STUN URL"),
  field("app", "network.turnUrl", "WEBRTC_TURN_URL", "string", "TURN URL"),
  field("app", "network.turnUsername", "WEBRTC_TURN_USERNAME", "string", "TURN username"),
  field("app", "audio.opusBitrateBps", "EIDOLON_OPUS_BITRATE_BPS", "int", "Default Opus bitrate"),
  field(
    "app",
    "audio.opusBitrate.best",
    "EIDOLON_OPUS_BITRATE_BEST_BPS",
    "int",
    "Opus bitrate: best",
  ),
  field(
    "app",
    "audio.opusBitrate.medium",
    "EIDOLON_OPUS_BITRATE_MEDIUM_BPS",
    "int",
    "Opus bitrate: medium",
  ),
  field("app", "audio.opusBitrate.low", "EIDOLON_OPUS_BITRATE_LOW_BPS", "int", "Opus bitrate: low"),
  field(
    "app",
    "audio.opusBitrate.lowest",
    "EIDOLON_OPUS_BITRATE_LOWEST_BPS",
    "int",
    "Opus bitrate: lowest",
  ),
  field(
    "app",
    "mcp.anonRateLimitPerHour",
    "EIDOLON_MCP_ANON_RATE_LIMIT_PER_HOUR",
    "int",
    "MCP anonymous calls per window",
  ),
  field(
    "app",
    "mcp.authRateLimitPerHour",
    "EIDOLON_MCP_AUTH_RATE_LIMIT_PER_HOUR",
    "int",
    "MCP logged-in calls per window",
  ),
  field(
    "app",
    "mcp.rateLimitWindowSec",
    "EIDOLON_MCP_RATE_LIMIT_WINDOW_SEC",
    "int",
    "MCP window seconds",
  ),
  field("app", "mcp.allowedHosts", "EIDOLON_MCP_ALLOWED_HOSTS", "list", "MCP allowed hosts"),
  field("app", "memory.qdrant.host", "MEM0_QDRANT_HOST", "string", "Qdrant host"),
  field("app", "memory.qdrant.port", "MEM0_QDRANT_PORT", "int", "Qdrant port"),
  field("app", "memory.qdrant.collection", "MEM0_QDRANT_COLLECTION", "string", "Qdrant collection"),
  field("app", "memory.historyDb", "MEM0_HISTORY_DB_PATH", "path", "Mem0 history database"),
  field(
    "app",
    "providers.openrouter.apiBase",
    "OPENROUTER_API_BASE",
    "string",
    "OpenRouter API base",
  ),
  field(
    "app",
    "providers.openrouter.appName",
    "OPENROUTER_APP_NAME",
    "string",
    "OpenRouter app name",
  ),
  field("app", "providers.openrouter.appUrl", "OPENROUTER_APP_URL", "string", "OpenRouter app URL"),
  field("app", "providers.openai.baseUrl", "OPENAI_BASE_URL", "string", "OpenAI API base"),
  field("app", "embeddings.provider", "EMBED_PROVIDER", "string", "Embedding provider", {
    default: "openrouter",
  }),
  field("app", "embeddings.model", "EMBED_MODEL", "string", "Embedding model", {
    provider: "EMBED_PROVIDER",
  }),
  field("app", "embeddings.dim", "EMBED_DIM", "int", "Embedding dimension"),
  field("app", "embeddings.baseUrl", "EMBED_BASE_URL", "string", "Embedding API base"),
  field("app", "rerank.baseUrl", "RERANK_BASE_URL", "string", "Reranker API base"),
  field("app", "refine.baseUrl", "REFINE_BASE_URL", "string", "Refine API base"),
  field("app", "sources.ytDlp", "YT_DLP_PATH", "path", "yt-dlp binary"),
  field(
    "app",
    "sources.cookiesFromBrowser",
    "YT_DLP_COOKIES_FROM_BROWSER",
    "string",
    "Browser to read cookies from",
  ),
  field("app", "sources.cookiesFile", "YT_DLP_COOKIES", "path", "Cookies file"),
  field("app", "usage.db", "EIDOLON_USAGE_DB", "path", "Usage ledger"),

  field("persona", "prompt", "PERSONA_FILE", "path", "System prompt file"),
  field("persona", "identity.timezone", "PERSONA_TIMEZONE", "string", "Time zone"),
  field("persona", "voice.provider", "TTS_PROVIDER", "string", "Voice provider", {
    default: "fish",
  }),
  field("persona", "voice.model", "TTS_MODEL", "string", "Voice model", {
    provider: "TTS_PROVIDER",
    legacy: { env: "FISH_MODEL", provider: "fish" },
  }),
  field("persona", "voice.voiceId", "TTS_VOICE_ID", "string", "Voice", {
    provider: "TTS_PROVIDER",
    legacy: { env: "FISH_VOICE_ID", provider: "fish" },
  }),
  field("persona", "hearing.provider", "STT_PROVIDER", "string", "Speech recognition provider", {
    default: "soniox",
  }),
  field("persona", "hearing.model", "STT_MODEL", "string", "Speech recognition model", {
    provider: "STT_PROVIDER",
    legacy: { env: "SONIOX_MODEL", provider: "soniox" },
  }),
  field("persona", "hearing.language", "STT_LANGUAGE", "string", "Spoken language"),
  field("persona", "mind.provider", "LLM_PROVIDER", "string", "Chat provider", {
    default: "openrouter",
  }),
  field("persona", "mind.model", "LLM_MODEL", "string", "Chat model", {
    provider: "LLM_PROVIDER",
    legacy: { env: "OPENROUTER_MODEL", provider: "openrouter" },
  }),
  field("persona", "realtime.provider", "REALTIME_PROVIDER", "string", "Realtime provider"),
  field("persona", "realtime.model", "REALTIME_MODEL", "string", "Realtime model", {
    provider: "REALTIME_PROVIDER",
  }),
  field("persona", "realtime.voice", "REALTIME_VOICE", "string", "Realtime voice", {
    provider: "REALTIME_PROVIDER",
  }),
  field("persona", "memory.searchLimit", "MEM0_SEARCH_LIMIT", "int", "Memories per turn"),
  field(
    "persona",
    "memory.searchThreshold",
    "MEM0_SEARCH_THRESHOLD",
    "float",
    "Memory score threshold",
  ),
  field("persona", "memory.agentId", "MEM0_AGENT_ID", "string", "Mem0 agent id"),
  field("persona", "memory.runId", "MEM0_RUN_ID", "string", "Mem0 run id"),
  field("persona", "memory.provider", "MEM0_LLM_PROVIDER", "string", "Memory extraction provider", {
    follows: "LLM_PROVIDER",
  }),
  field("persona", "memory.model", "MEM0_LLM_MODEL", "string", "Memory extraction model", {
    provider: "MEM0_LLM_PROVIDER",
  }),
  field("persona", "knowledge.index", "LANCEDB_PATH", "path", "Knowledge index"),
  field(
    "persona",
    "knowledge.factsCandidates",
    "PERSONA_FACTS_CANDIDATES",
    "int",
    "Fact candidates",
  ),
  field(
    "persona",
    "knowledge.archiveCandidates",
    "STREAM_ARCHIVE_CANDIDATES",
    "int",
    "Stream candidates",
  ),
  field("persona", "knowledge.rerank.enabled", "RERANK_ENABLED", "flag", "Rerank results"),
  field("persona", "knowledge.rerank.provider", "RERANK_PROVIDER", "string", "Reranker provider", {
    default: "openrouter",
  }),
  field("persona", "knowledge.rerank.model", "RERANK_MODEL", "string", "Reranker model", {
    provider: "RERANK_PROVIDER",
  }),
  field("persona", "knowledge.gate.enabled", "RETRIEVAL_GATE_ENABLED", "flag", "Retrieval gate"),
  field(
    "persona",
    "knowledge.gate.provider",
    "RETRIEVAL_GATE_PROVIDER",
    "string",
    "Retrieval gate provider",
    { default: "openrouter" },
  ),
  field(
    "persona",
    "knowledge.gate.model",
    "RETRIEVAL_GATE_MODEL",
    "string",
    "Retrieval gate model",
    {
      provider: "RETRIEVAL_GATE_PROVIDER",
    },
  ),
  field("persona", "knowledge.facts.files", "FACTS_FILES", "list", "Fact files"),
  field("persona", "knowledge.facts.subject", "FACTS_SUBJECT", "string", "Fact subject pattern"),
  field(
    "persona",
    "knowledge.archive.skipTypes",
    "INGEST_SKIP_TYPES",
    "list",
    "Scene types left out of the index",
  ),
  field(
    "persona",
    "transcription.provider",
    "TRANSCRIBE_PROVIDER",
    "string",
    "Transcription provider",
    {
      default: "soniox",
    },
  ),
  field("persona", "transcription.model", "TRANSCRIBE_MODEL", "string", "Transcription model", {
    provider: "TRANSCRIBE_PROVIDER",
    legacy: { env: "SONIOX_ASYNC_MODEL", provider: "soniox" },
  }),
  field(
    "persona",
    "transcription.language",
    "TRANSCRIBE_LANGUAGE",
    "string",
    "Transcription language",
  ),
  field("persona", "refine.provider", "REFINE_PROVIDER", "string", "Refine provider", {
    default: "openrouter",
  }),
  field("persona", "refine.model", "REFINE_MODEL", "string", "Refine model", {
    provider: "REFINE_PROVIDER",
  }),
  field("persona", "refine.concurrency", "REFINE_CONCURRENCY", "int", "Refine concurrency"),
  field("persona", "selfie.provider", "SELFIE_PROVIDER", "string", "Selfie provider", {
    default: "openrouter",
  }),
  field("persona", "selfie.model", "SELFIE_MODEL", "string", "Selfie model", {
    provider: "SELFIE_PROVIDER",
  }),
  field("persona", "selfie.aspectRatio", "SELFIE_ASPECT_RATIO", "string", "Selfie aspect ratio"),
  field("persona", "selfie.quality", "SELFIE_QUALITY", "string", "Selfie quality"),
  field("persona", "selfie.ttlSeconds", "SELFIE_TTL_SECONDS", "int", "Selfie lifetime"),
  field("persona", "selfie.timeoutSeconds", "SELFIE_TIMEOUT_SECONDS", "int", "Selfie timeout"),
  field("persona", "selfie.references", "SELFIE_REFERENCE_IMAGES", "paths", "Selfie references"),
  field("persona", "chat.interests", "CHAT_INTERESTS", "string", "Chat interests"),
  field("persona", "chat.talkativeness", "CHAT_TALKATIVENESS", "float", "Chat talkativeness"),
  field("persona", "chat.replyMode", "CHAT_REPLY_MODE", "string", "Chat reply mode"),
];

/** `voice.styles.<name>`, a voice id or `{voiceId, hint}`, sets `TTS_VOICE_ID_<NAME>`. */
const VOICE_STYLES_PATH = "voice.styles";
const VOICE_STYLE_PREFIX = "TTS_VOICE_ID_";
const VOICE_STYLE_KEYS = new Set(["voiceId", "hint"]);
/** The environment's style variables: these, and Fish's names for them. */
const ENV_STYLE_PREFIXES = [VOICE_STYLE_PREFIX, "FISH_VOICE_ID_"];

/** One of her persona.yaml's voice styles. */
export interface VoiceStyleSetting {
  /** As change_voice_style names it: her key as its variable spells it, lowercased. */
  readonly name: string;
  readonly voiceId: string;
  /** What a viewer says to ask for it; "" leaves that to the built-in words, else the name. */
  readonly hint: string;
}

/** The keys credentials.json may hold: the variables that carry secrets. */
export const CREDENTIALS: readonly string[] = [
  "SONIOX_API_KEY",
  "OPENROUTER_API_KEY",
  "FISH_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "DASHSCOPE_API_KEY",
  "MOONSHOT_API_KEY",
  "ZHIPU_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
  "ELEVENLABS_API_KEY",
  "DEEPGRAM_API_KEY",
  "CARTESIA_API_KEY",
  "MINIMAX_API_KEY",
  "COHERE_API_KEY",
  "RERANK_API_KEY",
  "EMBED_API_KEY",
  "REFINE_API_KEY",
  "CLOUDFLARE_TURN_KEY_API_TOKEN",
  "WEBRTC_TURN_CREDENTIAL",
  "CF_WAF_BYPASS_TOKEN",
];

/** Who the persona is, as the built-in prompts name her. Written in the persona's language. */
export interface PersonaIdentity {
  readonly name: string;
  /** Her name for short, where the built-in prompts shorten it. */
  readonly shortName: string;
  /** What she calls a viewer. */
  readonly fans: string;
  /** One English sentence about her, for the retrieval gate. */
  readonly summary: string;
  /** The logged-in viewer line; `{fans}`, `{viewer}` and `{uid}` are filled in. "" omits it. */
  readonly viewerLine: string;
  /** The line for the local web app's viewer, who has no UID; `{fans}` and `{viewer}` are filled in. */
  readonly localViewerLine: string;
}

export interface PersonaSettings {
  readonly id: string;
  readonly identity: PersonaIdentity;
  /** Retrieval-gate question texts that replace the built-in ones, by question key. */
  readonly gateQuestions: Readonly<Record<string, string>>;
  /** Her voice styles' own hints, by style name. */
  readonly voiceStyleHints: Readonly<Record<string, string>>;
}

const IDENTITY_KEYS = [
  "name",
  "shortName",
  "fans",
  "summary",
  "viewerLine",
  "localViewerLine",
] as const;
// identity.timezone is a setting (PERSONA_TIMEZONE), read with the others.
const IDENTITY_FIELDS = new Set<string>([...IDENTITY_KEYS, "timezone"]);
/** The retrieval gate's questions, which knowledge.gate.questions may reword. */
export const GATE_QUESTION_KEYS = ["about_her", "her_past", "named_thing"] as const;
const GATE_QUESTIONS_PATH = "knowledge.gate.questions";
// Not settings themselves: identity is read by personaSettings, the gate questions likewise.
const PERSONA_STRUCTURE = new Set(["identity", "knowledge.gate.questions", VOICE_STYLES_PATH]);

type Tree = Record<string, unknown>;
type Warn = (message: string) => void;

const logWarning: Warn = (message) => logger.warning(message);

function readTree(path: string, label: string, warn: Warn): Tree {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = path.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text);
    if (parsed === null || parsed === undefined) return {};
    if (isPlainObject(parsed)) return parsed;
    warn(`Ignoring ${label}: expected a mapping at the top level`);
  } catch (error) {
    // JSON.parse's message quotes the text it stopped at, which in credentials.json is a key.
    if (path.endsWith(".json")) warn(`Ignoring ${label}: not valid JSON`);
    else warn(`Ignoring ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {};
}

function lookup(tree: Tree, dotted: string): unknown {
  let node: unknown = tree;
  for (const key of dotted.split(".")) {
    if (!isPlainObject(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/** Every dotted path to a leaf, so a misspelled key can be reported. */
function leafPaths(tree: Tree, prefix = ""): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (PERSONA_STRUCTURE.has(path)) continue;
    if (isPlainObject(value)) paths.push(...leafPaths(value, path));
    else paths.push(path);
  }
  return paths;
}

/** The setting's value as the environment variable would spell it, or null with a warning. */
function asEnvValue(
  value: unknown,
  setting: SettingField,
  label: string,
  resolvePath: (rel: string) => string,
  warn: Warn,
): string | null {
  const bad = () => {
    warn(`Ignoring ${label} ${setting.path}: expected ${setting.kind}`);
    return null;
  };
  switch (setting.kind) {
    case "string":
      return typeof value === "string" || typeof value === "number" ? String(value) : bad();
    case "int":
    case "float":
      return typeof value === "number" || typeof value === "string" ? String(value) : bad();
    case "flag":
      return typeof value === "boolean" || typeof value === "string" ? String(value) : bad();
    case "list":
      if (typeof value === "string") return value;
      return Array.isArray(value) && value.every((v) => typeof v === "string")
        ? value.join(",")
        : bad();
    case "path":
      if (typeof value !== "string") return bad();
      // Blank is unset, as for every other kind: resolved, it would name her folder itself.
      return value.trim() === "" ? null : resolvePath(value);
    case "paths": {
      const parts = typeof value === "string" ? value.split(",") : value;
      if (!Array.isArray(parts) || !parts.every((v) => typeof v === "string")) return bad();
      return parts
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => (/^https?:\/\//.test(part) ? part : resolvePath(part)))
        .join(",");
    }
  }
}

/** `EIDOLON_PERSONA`, then settings.yaml's `persona`, then milky-green, then the first one found. */
function choosePersona(app: Tree): string {
  const fromEnv = process.env.EIDOLON_PERSONA;
  if (fromEnv) return fromEnv;
  const fromFile = lookup(app, "persona");
  if (typeof fromFile === "string" && fromFile) return fromFile;
  const ids = personaIds();
  if (ids.includes(DEFAULT_PERSONA)) return DEFAULT_PERSONA;
  return ids[0] ?? DEFAULT_PERSONA;
}

/** What a persona that leaves an identity field out gets. */
export const IDENTITY_DEFAULTS: Omit<PersonaIdentity, "name" | "shortName"> = {
  fans: "观众",
  summary: "",
  viewerLine: "正在和你聊天的{fans}叫「{viewer}」（UID:{uid}）。",
  localViewerLine: "正在和你聊天的{fans}叫「{viewer}」。",
};

function readIdentity(
  persona: Tree,
  id: string,
  label: string,
  warn: Warn = logWarning,
): PersonaIdentity {
  const raw = lookup(persona, "identity");
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    warn(`Ignoring ${label} identity: expected a mapping`);
  }
  const tree = isPlainObject(raw) ? raw : {};
  for (const key of Object.keys(tree)) {
    if (!IDENTITY_FIELDS.has(key)) warn(`Unknown setting identity.${key} in ${label}`);
  }
  const value = (key: (typeof IDENTITY_KEYS)[number], fallback: string): string => {
    const v = tree[key];
    if (typeof v === "string") return v;
    if (v !== undefined) warn(`Ignoring ${label} identity.${key}: expected string`);
    return fallback;
  };
  const name = value("name", id);
  return {
    name,
    shortName: value("shortName", name),
    fans: value("fans", IDENTITY_DEFAULTS.fans),
    summary: value("summary", IDENTITY_DEFAULTS.summary),
    viewerLine: value("viewerLine", IDENTITY_DEFAULTS.viewerLine),
    localViewerLine: value("localViewerLine", IDENTITY_DEFAULTS.localViewerLine),
  };
}

/**
 * Persona `id`'s identity from its persona.yaml, the user's copy first, whether or not it is
 * active; nothing is logged. The caller validates the id, which becomes a folder name.
 */
export function readPersonaIdentity(id: string): PersonaIdentity {
  const path = resolvePersonaPath(id, "persona.yaml");
  const quiet: Warn = () => {};
  return readIdentity(readTree(path, path, quiet), id, path, quiet);
}

function readGateQuestions(persona: Tree, label: string): Record<string, string> {
  const raw = lookup(persona, GATE_QUESTIONS_PATH);
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) {
    logger.warning(`Ignoring ${label} ${GATE_QUESTIONS_PATH}: expected a mapping`);
    return {};
  }
  const questions: Record<string, string> = {};
  for (const [key, text] of Object.entries(raw)) {
    if (!(GATE_QUESTION_KEYS as readonly string[]).includes(key)) {
      logger.warning(`Unknown setting ${GATE_QUESTIONS_PATH}.${key} in ${label}`);
    } else if (typeof text === "string") {
      questions[key] = text;
    } else {
      logger.warning(`Ignoring ${label} ${GATE_QUESTIONS_PATH}.${key}: expected string`);
    }
  }
  return questions;
}

/** Her voice.styles by the variable each sets; one the file gets wrong is left out with a warning. */
function readVoiceStyles(persona: Tree, label: string, warn: Warn): Map<string, VoiceStyleSetting> {
  const styles = new Map<string, VoiceStyleSetting>();
  const raw = lookup(persona, VOICE_STYLES_PATH);
  if (raw === undefined || raw === null) return styles;
  if (!isPlainObject(raw)) {
    warn(`Ignoring ${label} ${VOICE_STYLES_PATH}: expected a mapping`);
    return styles;
  }
  for (const [key, value] of Object.entries(raw)) {
    const path = `${VOICE_STYLES_PATH}.${key}`;
    const entry = isPlainObject(value) ? value : { voiceId: value };
    for (const field of Object.keys(entry)) {
      if (!VOICE_STYLE_KEYS.has(field)) warn(`Unknown setting ${path}.${field} in ${label}`);
    }
    const { voiceId, hint } = entry;
    if (typeof voiceId !== "string" || voiceId === "") {
      warn(`Ignoring ${label} ${path}: expected a voice id, or voiceId and hint`);
      continue;
    }
    if (hint !== undefined && hint !== null && typeof hint !== "string") {
      warn(`Ignoring ${label} ${path}.hint: expected string`);
    }
    const env = `${VOICE_STYLE_PREFIX}${key.toUpperCase()}`;
    const name = env.slice(VOICE_STYLE_PREFIX.length).toLowerCase();
    styles.set(env, { name, voiceId, hint: typeof hint === "string" ? hint.trim() : "" });
  }
  return styles;
}

function warnIfShared(path: string, warn: Warn): void {
  try {
    if (statSync(path).mode & 0o077) {
      warn(`${path} is readable by other users; run \`chmod 600 ${path}\``);
    }
  } catch {
    // Absent: nothing to protect.
  }
}

export interface SettingsFiles {
  readonly home: string;
  readonly settings: string;
  readonly credentials: string;
  readonly persona: string;
}

/** Which file a value comes from; `default` when none sets it. */
export type SettingSource = "default" | "app" | "persona" | "credentials";

/** One variable as the settings files hold it. */
export interface LayeredSetting {
  readonly source: SettingSource;
  /** As the variable would spell it; null when unset, or when the file's value is the wrong kind. */
  readonly value: string | null;
  /** The file's own value (a relative path stays relative, a list stays a list); null when unset. */
  readonly raw: unknown;
}

export interface SettingsLayers {
  readonly persona: string;
  readonly files: SettingsFiles;
  /**
   * Every SETTINGS variable in its order, then the TTS_VOICE_ID_<STYLE> variables the persona's
   * voice.styles adds, then every credential: credentials.json's in its order, the rest unset.
   */
  readonly values: ReadonlyMap<string, LayeredSetting>;
  /**
   * The variables her persona.yaml decides, whatever the environment says: those it gives a value,
   * a model or voice whose provider she picks otherwise than the environment does, and with her
   * own voice every voice style in the environment.
   */
  readonly owned: ReadonlySet<string>;
  /** Her persona.yaml's voice styles, in its order. */
  readonly voiceStyles: readonly VoiceStyleSetting[];
  /** credentials.json's provider accounts, by id. */
  readonly accounts: ReadonlyMap<string, AccountEntry>;
  /** What loadSettings would log about these files, in its order. */
  readonly warnings: readonly string[];
}

const UNSET: LayeredSetting = Object.freeze({ source: "default", value: null, raw: null });

interface ReadLayers {
  readonly id: string;
  readonly persona: Tree;
  readonly values: Map<string, LayeredSetting>;
  readonly accounts: ReadonlyMap<string, AccountEntry>;
  readonly owned: ReadonlySet<string>;
  /** Why her persona.yaml decides each owned variable, as the log says it. */
  readonly why: ReadonlyMap<string, string>;
  readonly voiceStyles: readonly VoiceStyleSetting[];
  readonly files: SettingsFiles;
}

const BY_ENV: ReadonlyMap<string, SettingField> = new Map(SETTINGS.map((s) => [s.env, s]));

/**
 * The provider a provider row names: her persona.yaml's when `files` holds her values, else the
 * environment's, else the row it follows, else its default.
 */
function providerValue(
  env: string,
  files: ReadonlyMap<string, LayeredSetting> | null,
): string | undefined {
  const setting = BY_ENV.get(env);
  // Provider ids are case-blind, as the resolver reads them: `Fish` is `fish`.
  const hers = files?.get(env)?.value?.trim().toLowerCase();
  if (hers) return hers;
  const fromEnv = process.env[env]?.trim().toLowerCase();
  if (fromEnv) return fromEnv;
  if (setting?.follows !== undefined) return providerValue(setting.follows, files);
  return setting?.default;
}

/** The one reader behind loadSettings and readSettingsLayers; `chosen` null picks the active persona. */
function readLayers(chosen: string | null, warn: Warn): ReadLayers {
  const home = dataHome();
  const settingsPath = join(home, "settings.yaml");
  const credentialsPath = join(home, "credentials.json");
  const app = readTree(settingsPath, settingsPath, warn);
  // Before parsing: a file that fails to parse can still hold real keys.
  warnIfShared(credentialsPath, warn);
  const credentials = readTree(credentialsPath, credentialsPath, warn);
  const accounts = parseAccounts(credentials[ACCOUNTS_KEY], credentialsPath, warn);
  // An account stands for its provider, whose models and voices it shares.
  const providerOf = (value: string | undefined) =>
    value === undefined ? undefined : accountProvider(value, accounts);
  const id = chosen ?? choosePersona(app);
  const personaPath = resolvePersonaPath(id, "persona.yaml");
  const persona = readTree(personaPath, personaPath, warn);

  const values = new Map<string, LayeredSetting>();
  // "" decides nothing: an empty value reads as unset, as an empty variable does.
  const owned = new Set<string>();
  const known = new Set<string>();
  for (const setting of SETTINGS) {
    const tree = setting.scope === "app" ? app : persona;
    known.add(`${setting.scope}:${setting.path}`);
    const raw = lookup(tree, setting.path);
    if (raw === undefined || raw === null) {
      values.set(setting.env, UNSET);
      continue;
    }
    const label = setting.scope === "app" ? settingsPath : personaPath;
    const resolvePath =
      setting.scope === "app"
        ? (rel: string) => {
            const path = expandUser(rel);
            return isAbsolute(path) ? path : join(home, path);
          }
        : (rel: string) => resolvePersonaPath(id, rel);
    const value = asEnvValue(raw, setting, label, resolvePath, warn);
    values.set(setting.env, { source: setting.scope, value, raw });
    if (setting.scope === "persona" && value) owned.add(setting.env);
  }
  const styles = readVoiceStyles(persona, personaPath, warn);
  for (const [env, { voiceId }] of styles) {
    values.set(env, { source: "persona", value: voiceId, raw: voiceId });
    owned.add(env);
  }
  const why = new Map<string, string>();
  for (const name of owned) why.set(name, `sets ${BY_ENV.get(name)?.path ?? VOICE_STYLES_PATH}`);
  for (const setting of SETTINGS) {
    if (setting.scope !== "persona") continue;
    const own = owned.has(setting.env);
    // The environment's model or voice is for its own provider, which isn't the one she picks.
    const other =
      !own &&
      setting.provider !== undefined &&
      providerOf(providerValue(setting.provider, values)) !==
        providerOf(providerValue(setting.provider, null));
    if (other) {
      owned.add(setting.env);
      why.set(setting.env, `sets ${BY_ENV.get(setting.provider as string)?.path}`);
    }
    if ((own || other) && setting.legacy) {
      owned.add(setting.legacy.env);
      why.set(setting.legacy.env, why.get(setting.env) as string);
    }
  }
  // The environment's styles are another voice's moods: with her own voice they'd switch to it.
  if (owned.has("TTS_VOICE_ID")) {
    for (const name of Object.keys(process.env)) {
      if (ENV_STYLE_PREFIXES.some((prefix) => name.startsWith(prefix)) && !owned.has(name)) {
        owned.add(name);
        why.set(name, "has her own voice");
      }
    }
  }
  for (const [scope, tree, label] of [
    ["app", app, settingsPath],
    ["persona", persona, personaPath],
  ] as const) {
    for (const path of leafPaths(tree)) {
      if (!known.has(`${scope}:${path}`)) warn(`Unknown setting ${path} in ${label}`);
    }
  }

  for (const [name, secret] of Object.entries(credentials)) {
    if (name === ACCOUNTS_KEY) continue;
    if (!CREDENTIALS.includes(name)) {
      warn(`Ignoring ${name} in ${credentialsPath}: not a credential`);
    } else if (typeof secret === "string" && secret) {
      values.set(name, { source: "credentials", value: secret, raw: secret });
    } else if (secret !== "") {
      warn(`Ignoring ${name} in ${credentialsPath}: expected a non-empty string`);
      values.set(name, { source: "credentials", value: null, raw: secret });
    }
  }
  for (const name of CREDENTIALS) if (!values.has(name)) values.set(name, UNSET);

  return {
    id,
    persona,
    values,
    accounts,
    owned,
    why,
    voiceStyles: [...styles.values()],
    files: { home, settings: settingsPath, credentials: credentialsPath, persona: personaPath },
  };
}

/**
 * Persona `personaId`'s settings files, layer by layer, for a settings editor: nothing is
 * installed and nothing is logged. The caller validates the id, which becomes a folder name.
 */
export function readSettingsLayers(personaId: string): SettingsLayers {
  const warnings: string[] = [];
  const read = readLayers(personaId, (message) => warnings.push(message));
  return {
    persona: read.id,
    files: read.files,
    values: read.values,
    accounts: read.accounts,
    owned: read.owned,
    voiceStyles: read.voiceStyles,
    warnings,
  };
}

/**
 * `name` as the bot reads it with `layers`' persona active, the local app's derived defaults left
 * out: her own value, else the environment's, else the files'.
 */
export function layeredValue(layers: SettingsLayers, name: string): string | undefined {
  const fromEnv = layers.owned.has(name) ? undefined : envVariable(name);
  return fromEnv ?? layers.values.get(name)?.value ?? undefined;
}

export interface LoadedSettings {
  readonly persona: PersonaSettings;
  /** Variable name → value, as the files set them. */
  readonly values: ReadonlyMap<string, string>;
  /** credentials.json's provider accounts, by id. */
  readonly accounts: ReadonlyMap<string, AccountEntry>;
  /** As SettingsLayers' owned. */
  readonly owned: ReadonlySet<string>;
  /** Why her persona.yaml decides each owned variable. */
  readonly why: ReadonlyMap<string, string>;
  readonly files: SettingsFiles;
}

/**
 * Reads every layer, for persona `personaId` or else the active one, without installing it. The
 * caller validates the id, which becomes a folder name.
 */
export function loadSettings(personaId?: string): LoadedSettings {
  const read = readLayers(personaId ?? null, logWarning);
  const values = new Map<string, string>();
  for (const [env, layer] of read.values) if (layer.value !== null) values.set(env, layer.value);
  return {
    persona: {
      id: read.id,
      identity: readIdentity(read.persona, read.id, read.files.persona),
      gateQuestions: readGateQuestions(read.persona, read.files.persona),
      voiceStyleHints: Object.fromEntries(
        read.voiceStyles.filter((style) => style.hint !== "").map((s) => [s.name, s.hint]),
      ),
    },
    values,
    accounts: read.accounts,
    owned: read.owned,
    why: read.why,
    files: read.files,
  };
}

/** Values beneath every settings file, derived from the persona that was loaded. */
export type SettingDefaults = (persona: PersonaSettings) => Readonly<Record<string, string>>;

let installed: LoadedSettings | null = null;
let defaults: SettingDefaults | null = null;
/** The persona and variables installSettings last reported ignoring. */
let reported = "";
/** The personas withPersona has run as since the settings or their defaults last changed, by id. */
const scopes = new Map<string, PersonaScope>();
let generation = 0;

function dropScopes(): void {
  scopes.clear();
  generation++;
}

/**
 * A number that changes whenever the settings or their defaults do, so a cache of what a persona's
 * settings built can key on it.
 */
export function settingsGeneration(): number {
  return generation;
}

function fileLayer(loaded: LoadedSettings): ReadonlyMap<string, string> {
  if (defaults === null) return loaded.values;
  const layer = new Map(loaded.values);
  for (const [env, value] of Object.entries(defaults(loaded.persona))) {
    if (!layer.has(env)) layer.set(env, value);
  }
  return layer;
}

/** Loads every layer and makes it the one the env readers and persona lookups see. */
export function installSettings(): LoadedSettings {
  installed = loadSettings();
  setFileLayer(fileLayer(installed), installed.owned);
  dropScopes();
  const id = installed.persona.id;
  const ignored = [...installed.owned].filter((name) => envVariable(name) !== undefined);
  // The local app reinstalls on every save: say it once, until the persona or the list changes.
  const report = `${id}\0${ignored.join(",")}`;
  if (report !== reported) {
    reported = report;
    for (const name of ignored) {
      const why = installed.why.get(name) ?? "has her own voice";
      logger.info(`${name} from the environment is ignored: persona ${id} ${why}`);
    }
  }
  return installed;
}

/**
 * Sets the values every later installSettings() puts beneath the files, and applies them to what
 * is installed now. Only the local app sets any; null removes them.
 */
export function setSettingDefaults(derive: SettingDefaults | null): void {
  defaults = derive;
  if (installed !== null) setFileLayer(fileLayer(installed), installed.owned);
  dropScopes();
}

/**
 * Runs `fn`, and everything it starts, as persona `id`: inside, the env readers and the persona
 * lookups resolve her settings as installing her would, and nothing is installed. The caller
 * validates the id, which becomes a folder name.
 */
export function withPersona<T>(id: string, fn: () => T): T {
  let scope = scopes.get(id);
  if (scope === undefined) {
    // The installed persona's own settings, so her scope resolves exactly what is installed.
    const settings = installed?.persona.id === id ? installed : loadSettings(id);
    scope = { settings, values: fileLayer(settings), owned: settings.owned };
    scopes.set(id, scope);
  }
  return personaScopes.run(scope, fn);
}

/** withPersona's persona, else the installed one, else one read on demand. */
function current(): LoadedSettings {
  const scope = personaScopes.getStore();
  if (scope !== undefined) return scope.settings;
  installed ??= loadSettings();
  return installed;
}

/** The active persona: withPersona's, else the installed one. */
export function activePersona(): PersonaSettings {
  return current().persona;
}

/** credentials.json's provider accounts, by id, as the active persona's settings read them. */
export function accountEntries(): ReadonlyMap<string, AccountEntry> {
  return current().accounts;
}

/** The active persona's file or folder at `rel` (see resolvePersonaPath). */
export function personaPath(rel: string): string {
  return resolvePersonaPath(activePersona().id, rel);
}

/** The active persona's existing folders for `rel`, the user's first. */
export function personaFolders(rel: string): string[] {
  return personaDirs(activePersona().id, rel);
}

/** `{name}` placeholders in a persona text, filled from `values`; unknown ones stay as written. */
export function fillPersonaText(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.hasOwn(values, key) ? (values[key] as string) : whole,
  );
}

/** Forgets what was loaded; the next lookup reads the files again. For tests and reloads. */
export function resetSettings(): void {
  installed = null;
  reported = "";
  setFileLayer(new Map(), new Set());
  dropScopes();
}

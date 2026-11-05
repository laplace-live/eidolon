// The settings layers. Code defaults < settings.yaml (the install) < personas/<id>/persona.yaml
// (the persona) < the environment; secrets come from credentials.json or the environment, never
// YAML. Every setting maps to the variable that always configured it, and the env readers
// consult this layer, so a value parses and warns exactly as it would from the environment.
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setFileLayer } from "./env.ts";
import { DEFAULT_PERSONA, dataHome, personaDirs, personaIds, resolvePersonaPath } from "./home.ts";
import { logger } from "./logger.ts";
import { expandUser } from "./paths.ts";
import { isPlainObject } from "./py.ts";

export type SettingScope = "app" | "persona";
export type SettingKind = "string" | "int" | "float" | "flag" | "list" | "path" | "paths";

export interface SettingField {
  /** Dotted path in the scope's YAML file. */
  readonly path: string;
  readonly env: string;
  readonly scope: SettingScope;
  readonly kind: SettingKind;
  readonly title: string;
}

const field = (
  scope: SettingScope,
  path: string,
  env: string,
  kind: SettingKind,
  title: string,
): SettingField => ({ path, env, scope, kind, title });

/** Every setting a YAML file may hold, in the order the web settings show them. */
export const SETTINGS: readonly SettingField[] = [
  field("app", "persona", "EIDOLON_PERSONA", "string", "Active persona"),
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
  field(
    "app",
    "providers.openai.baseUrl",
    "OPENAI_BASE_URL",
    "string",
    "OpenAI-compatible base URL",
  ),
  field("app", "embeddings.model", "EMBED_MODEL", "string", "Embedding model"),
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

  field("persona", "prompt", "PERSONA_FILE", "path", "System prompt file"),
  field("persona", "identity.timezone", "PERSONA_TIMEZONE", "string", "Time zone"),
  field("persona", "voice.model", "FISH_MODEL", "string", "Fish Audio model"),
  field("persona", "voice.voiceId", "FISH_VOICE_ID", "string", "Voice"),
  field("persona", "hearing.model", "SONIOX_MODEL", "string", "Soniox model"),
  field("persona", "mind.model", "OPENROUTER_MODEL", "string", "Chat model"),
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
  field("persona", "memory.model", "MEM0_LLM_MODEL", "string", "Memory extraction model"),
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
  field("persona", "knowledge.rerank.model", "RERANK_MODEL", "string", "Reranker model"),
  field("persona", "knowledge.gate.enabled", "RETRIEVAL_GATE_ENABLED", "flag", "Retrieval gate"),
  field(
    "persona",
    "knowledge.gate.model",
    "RETRIEVAL_GATE_MODEL",
    "string",
    "Retrieval gate model",
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
  field("persona", "transcription.model", "SONIOX_ASYNC_MODEL", "string", "Transcription model"),
  field("persona", "refine.model", "REFINE_MODEL", "string", "Refine model"),
  field("persona", "refine.concurrency", "REFINE_CONCURRENCY", "int", "Refine concurrency"),
  field("persona", "selfie.model", "SELFIE_MODEL", "string", "Selfie model"),
  field("persona", "selfie.aspectRatio", "SELFIE_ASPECT_RATIO", "string", "Selfie aspect ratio"),
  field("persona", "selfie.quality", "SELFIE_QUALITY", "string", "Selfie quality"),
  field("persona", "selfie.ttlSeconds", "SELFIE_TTL_SECONDS", "int", "Selfie lifetime"),
  field("persona", "selfie.timeoutSeconds", "SELFIE_TIMEOUT_SECONDS", "int", "Selfie timeout"),
  field("persona", "selfie.references", "SELFIE_REFERENCE_IMAGES", "paths", "Selfie references"),
];

/** `voice.styles.<name>` sets `FISH_VOICE_ID_<NAME>`. */
const VOICE_STYLES_PATH = "voice.styles";
const VOICE_STYLE_PREFIX = "FISH_VOICE_ID_";

/** The keys credentials.json may hold: the variables that carry secrets. */
export const CREDENTIALS: readonly string[] = [
  "SONIOX_API_KEY",
  "OPENROUTER_API_KEY",
  "FISH_API_KEY",
  "RERANK_API_KEY",
  "EMBED_API_KEY",
  "REFINE_API_KEY",
  "OPENAI_API_KEY",
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
}

export interface PersonaSettings {
  readonly id: string;
  readonly identity: PersonaIdentity;
  /** Retrieval-gate question texts that replace the built-in ones, by question key. */
  readonly gateQuestions: Readonly<Record<string, string>>;
}

const IDENTITY_KEYS = ["name", "shortName", "fans", "summary", "viewerLine"] as const;
// identity.timezone is a setting (PERSONA_TIMEZONE), read with the others.
const IDENTITY_FIELDS = new Set<string>([...IDENTITY_KEYS, "timezone"]);
/** The retrieval gate's questions, which knowledge.gate.questions may reword. */
export const GATE_QUESTION_KEYS = ["about_her", "her_past", "named_thing"] as const;
const GATE_QUESTIONS_PATH = "knowledge.gate.questions";
// Not settings themselves: identity is read by personaSettings, the gate questions likewise.
const PERSONA_STRUCTURE = new Set(["identity", "knowledge.gate.questions", VOICE_STYLES_PATH]);

type Tree = Record<string, unknown>;

function readTree(path: string, label: string): Tree {
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
    logger.warning(`Ignoring ${label}: expected a mapping at the top level`);
  } catch (error) {
    logger.warning(`Ignoring ${label}: ${error instanceof Error ? error.message : String(error)}`);
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
): string | null {
  const bad = () => {
    logger.warning(`Ignoring ${label} ${setting.path}: expected ${setting.kind}`);
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
      return typeof value === "string" ? resolvePath(value) : bad();
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
};

function readIdentity(persona: Tree, id: string, label: string): PersonaIdentity {
  const raw = lookup(persona, "identity");
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    logger.warning(`Ignoring ${label} identity: expected a mapping`);
  }
  const tree = isPlainObject(raw) ? raw : {};
  for (const key of Object.keys(tree)) {
    if (!IDENTITY_FIELDS.has(key)) logger.warning(`Unknown setting identity.${key} in ${label}`);
  }
  const value = (key: (typeof IDENTITY_KEYS)[number], fallback: string): string => {
    const v = tree[key];
    if (typeof v === "string") return v;
    if (v !== undefined) logger.warning(`Ignoring ${label} identity.${key}: expected string`);
    return fallback;
  };
  const name = value("name", id);
  return {
    name,
    shortName: value("shortName", name),
    fans: value("fans", IDENTITY_DEFAULTS.fans),
    summary: value("summary", IDENTITY_DEFAULTS.summary),
    viewerLine: value("viewerLine", IDENTITY_DEFAULTS.viewerLine),
  };
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

function warnIfShared(path: string): void {
  try {
    if (statSync(path).mode & 0o077) {
      logger.warning(`${path} is readable by other users; run \`chmod 600 ${path}\``);
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

export interface LoadedSettings {
  readonly persona: PersonaSettings;
  /** Variable name → value, as the files set them. */
  readonly values: ReadonlyMap<string, string>;
  readonly files: SettingsFiles;
}

/** Reads every layer without installing it. */
export function loadSettings(): LoadedSettings {
  const home = dataHome();
  const settingsPath = join(home, "settings.yaml");
  const credentialsPath = join(home, "credentials.json");
  const app = readTree(settingsPath, settingsPath);
  const id = choosePersona(app);
  const personaPath = resolvePersonaPath(id, "persona.yaml");
  const persona = readTree(personaPath, personaPath);

  const values = new Map<string, string>();
  const known = new Set<string>();
  for (const setting of SETTINGS) {
    const tree = setting.scope === "app" ? app : persona;
    known.add(`${setting.scope}:${setting.path}`);
    const value = lookup(tree, setting.path);
    if (value === undefined || value === null) continue;
    const label = setting.scope === "app" ? settingsPath : personaPath;
    const resolvePath =
      setting.scope === "app"
        ? (rel: string) => {
            const path = expandUser(rel);
            return isAbsolute(path) ? path : join(home, path);
          }
        : (rel: string) => resolvePersonaPath(id, rel);
    const env = asEnvValue(value, setting, label, resolvePath);
    if (env !== null) values.set(setting.env, env);
  }
  const styles = lookup(persona, VOICE_STYLES_PATH);
  if (styles !== undefined && styles !== null && !isPlainObject(styles)) {
    logger.warning(`Ignoring ${personaPath} ${VOICE_STYLES_PATH}: expected a mapping`);
  }
  if (isPlainObject(styles)) {
    for (const [name, voiceId] of Object.entries(styles)) {
      if (typeof voiceId === "string" && voiceId) {
        values.set(`${VOICE_STYLE_PREFIX}${name.toUpperCase()}`, voiceId);
      } else {
        logger.warning(`Ignoring ${personaPath} ${VOICE_STYLES_PATH}.${name}: expected string`);
      }
    }
  }
  for (const [scope, tree, label] of [
    ["app", app, settingsPath],
    ["persona", persona, personaPath],
  ] as const) {
    for (const path of leafPaths(tree)) {
      if (!known.has(`${scope}:${path}`)) logger.warning(`Unknown setting ${path} in ${label}`);
    }
  }

  // Before parsing: a file that fails to parse can still hold real keys.
  warnIfShared(credentialsPath);
  const credentials = readTree(credentialsPath, credentialsPath);
  for (const [name, secret] of Object.entries(credentials)) {
    if (!CREDENTIALS.includes(name)) {
      logger.warning(`Ignoring ${name} in ${credentialsPath}: not a credential`);
    } else if (typeof secret === "string" && secret) {
      values.set(name, secret);
    } else if (secret !== "") {
      logger.warning(`Ignoring ${name} in ${credentialsPath}: expected a non-empty string`);
    }
  }

  return {
    persona: {
      id,
      identity: readIdentity(persona, id, personaPath),
      gateQuestions: readGateQuestions(persona, personaPath),
    },
    values,
    files: {
      home,
      settings: settingsPath,
      credentials: credentialsPath,
      persona: personaPath,
    },
  };
}

let installed: LoadedSettings | null = null;

/** Loads every layer and makes it the one the env readers and persona lookups see. */
export function installSettings(): LoadedSettings {
  installed = loadSettings();
  setFileLayer(installed.values);
  return installed;
}

/** The active persona: the installed one, or one read on demand where nothing installed it. */
export function activePersona(): PersonaSettings {
  installed ??= loadSettings();
  return installed.persona;
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
  setFileLayer(new Map());
}

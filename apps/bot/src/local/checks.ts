// The provider checks behind POST credentials/check. A verdict comes from the HTTP status; a body
// is read only for the fields a check names, and the provider's own wording is never shown. Every
// endpoint here is free: listings, key lookups and the Fish wallet, never a model call.
import {
  DEFAULT_EMBED_BASE_URL,
  DEFAULT_EMBED_MODEL,
  isPlainObject,
  pyParseInt,
  pyStrip,
} from "@eidolon/config";
import { refine, transcribe } from "@eidolon/ingest";
import { DEFAULT_RERANK_BASE_URL, DEFAULT_RERANK_MODEL } from "@eidolon/retrieval";
import type {
  CheckCode,
  CheckProvider,
  CheckResult,
  CheckWarning,
  CheckWarningCode,
} from "./api.ts";

export interface CheckDeps {
  readonly fetch: typeof fetch;
  /** A setting or key as the bot reads it now. */
  readonly read: (name: string) => string | undefined;
  /** The environment's value is the one read: over the files, or one a persona inherits. */
  readonly fromEnv: (name: string) => boolean;
  readonly now: () => number;
}

export const CHECK_TIMEOUT_MS = 10_000;
/** As packages/memory gives a Qdrant call. */
export const QDRANT_TIMEOUT_MS = 5_000;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const SONIOX_MODELS_URL = "https://api.soniox.com/v1/models";
const FISH_API = "https://api.fish.audio";
const FISH_BILLING = "https://fish.audio/app/developers/billing/";
const COHERE_CHECK_URL = "https://api.cohere.com/v1/check-api-key";

/** Fish's TTS models; a misspelled one falls back to s2.1-pro without a word. */
export const FISH_MODELS = ["drama-3", "s2.1-pro", "s2.1-pro-free", "s2-pro", "s1"] as const;
const FISH_FREE_MODEL = "s2.1-pro-free";
const FISH_DEPRECATED_MODEL = "s1";

/** The @qdrant/js-client-rest pin in packages/memory/package.json, which warns past one minor. */
export const QDRANT_CLIENT_VERSION = "1.19.0";
const QDRANT_TITLE = "qdrant - vector search engine";

const EXPIRY_WARNING_MS = 14 * 24 * 60 * 60 * 1000;

interface Answer {
  /** 0 when nothing answered in time. */
  readonly status: number;
  /** The JSON it sent; null for anything else. */
  readonly body: unknown;
}

/** One GET or POST that never follows a redirect; a key goes only in the Authorization header. */
export async function ask(
  deps: Pick<CheckDeps, "fetch">,
  url: string,
  options: { key?: string; method?: "GET" | "POST"; timeoutMs?: number } = {},
): Promise<Answer> {
  try {
    const response = await deps.fetch(url, {
      method: options.method ?? "GET",
      headers: options.key === undefined ? {} : { authorization: `Bearer ${options.key}` },
      // A key never follows a redirect, and no endpoint here sends one.
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? CHECK_TIMEOUT_MS),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: the status decides alone.
    }
    return { status: response.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

const field = (value: unknown, key: string): unknown =>
  isPlainObject(value) ? value[key] : undefined;

function codeOf(status: number): CheckCode {
  if (status === 0 || status >= 500) return "unreachable";
  if (status === 401) return "invalid-key";
  if (status === 402) return "no-credit";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  return "unexpected";
}

const MESSAGES: Readonly<Record<CheckCode, string>> = {
  ok: "The key works",
  missing: "There is nothing to check",
  "invalid-key": "The provider refused the key",
  "management-key": "This is a management key, which can't run models: create a regular key",
  "no-credit": "The account has no credit left",
  forbidden: "The key may not do this, or a budget is used up",
  "not-found": "The provider has no such endpoint or model",
  "rate-limited": "The provider is busy; try again shortly",
  unreachable: "The provider didn't answer",
  unexpected: "The provider gave an answer Eidolon can't read",
  "not-qdrant": "Something other than Qdrant answers there",
  "needs-api-key": "This Qdrant wants an API key, which Eidolon doesn't support",
  starting: "Qdrant is still starting; try again shortly",
};

interface Verdict {
  readonly ok: boolean;
  readonly code: CheckCode;
  readonly message?: string;
  readonly warnings?: readonly CheckWarning[];
  readonly credit?: number | null;
}

const fail = (code: CheckCode, message?: string): Verdict => ({
  ok: false,
  code,
  ...(message === undefined ? {} : { message }),
});

const warning = (code: CheckWarningCode, message: string): CheckWarning => ({ code, message });

function finish(verdict: Verdict, envOverride: boolean): CheckResult {
  return {
    ok: verdict.ok,
    code: verdict.code,
    message: verdict.message ?? MESSAGES[verdict.code],
    warnings: verdict.warnings ?? [],
    envOverride,
    credit: verdict.credit ?? null,
  };
}

function hostOf(base: string): string | null {
  try {
    return new URL(base).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const isOpenRouter = (base: string): boolean => hostOf(base) === "openrouter.ai";

const isCohere = (base: string): boolean =>
  ["api.cohere.com", "api.cohere.ai"].includes(hostOf(base) ?? "");

const trimSlash = (base: string): string => base.replace(/\/+$/, "");

function numberOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/** GET {base}/key: 401 invalid, a management key fails, and limits and expiry warn. */
async function checkOpenRouterKey(deps: CheckDeps, key: string, base: string): Promise<Verdict> {
  const answer = await ask(deps, `${trimSlash(base)}/key`, { key });
  if (answer.status !== 200) return fail(codeOf(answer.status));
  const data = field(answer.body, "data");
  if (!isPlainObject(data)) return fail("unexpected");
  if (data.is_management_key === true) return fail("management-key");
  const warnings: CheckWarning[] = [];
  if (data.is_free_tier === true) {
    warnings.push(warning("free-tier", "This account never bought credits; paid models refuse it"));
  }
  const remaining = numberOf(data.limit_remaining);
  if (remaining !== null && remaining <= 0) {
    warnings.push(warning("key-limit-reached", "The key's own spending limit is used up"));
  }
  const budget = numberOf(field(data.effective_budget, "remaining_usd"));
  if (budget !== null && budget <= 0) {
    warnings.push(warning("budget-exhausted", "A budget this key falls under is used up"));
  }
  const expires = typeof data.expires_at === "string" ? Date.parse(data.expires_at) : Number.NaN;
  if (!Number.isNaN(expires)) {
    if (expires <= deps.now()) {
      warnings.push(warning("key-expired", "The key has expired"));
    } else if (expires - deps.now() <= EXPIRY_WARNING_MS) {
      warnings.push(warning("key-expiring", `The key expires on ${data.expires_at}`));
    }
  }
  // The account's balance needs a management key, so this only says the key is accepted.
  return { ok: true, code: "ok", message: "Key accepted", warnings, credit: remaining };
}

/** The ids a listing answer names, aliases included; null when it lists nothing readable. */
function listedIds(body: unknown, key: "data" | "models"): Set<string> | null {
  const items = field(body, key);
  if (!Array.isArray(items)) return null;
  const ids = new Set<string>();
  for (const item of items) {
    for (const name of ["id", "aliased_model_id"]) {
      const id = field(item, name);
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  return ids;
}

/** A public OpenRouter listing that should name `model`; no warning when the listing fails. */
async function modelWarning(
  deps: CheckDeps,
  url: string,
  model: string,
  setting: string,
): Promise<CheckWarning[]> {
  const answer = await ask(deps, url);
  const ids = answer.status === 200 ? listedIds(answer.body, "data") : null;
  if (ids === null || ids.has(model)) return [];
  return [warning("unknown-model", `OpenRouter lists no model ${model} (${setting})`)];
}

/** Any other OpenAI-compatible base: GET {base}/models, where 404 or 405 can't tell. */
async function checkCompatibleBase(deps: CheckDeps, key: string, base: string): Promise<Verdict> {
  const answer = await ask(deps, `${trimSlash(base)}/models`, { key });
  if (answer.status >= 200 && answer.status < 300) return { ok: true, code: "ok" };
  if (answer.status === 401 || answer.status === 403) return fail("invalid-key");
  if (answer.status === 404 || answer.status === 405) {
    const note = "This provider has no model listing to check the key against";
    return { ok: true, code: "ok", warnings: [warning("cannot-verify", note)] };
  }
  return fail(codeOf(answer.status));
}

async function checkCohere(deps: CheckDeps, key: string): Promise<Verdict> {
  const answer = await ask(deps, COHERE_CHECK_URL, { key, method: "POST" });
  if (answer.status === 200) {
    return field(answer.body, "valid") === true ? { ok: true, code: "ok" } : fail("invalid-key");
  }
  // Cohere answers 498 for a key it doesn't know.
  return fail(answer.status === 498 ? "invalid-key" : codeOf(answer.status));
}

async function checkSoniox(deps: CheckDeps, key: string): Promise<Verdict> {
  const answer = await ask(deps, SONIOX_MODELS_URL, { key });
  if (answer.status === 401) {
    return fail(
      "invalid-key",
      "Soniox refused the key. It may be mistyped, or from an EU, JP or IN data-residency " +
        "project: Eidolon supports US projects only",
    );
  }
  if (answer.status === 403 && field(answer.body, "error_type") === "permission_denied") {
    const note =
      "The key works but may not list models. Calls need real-time speech-to-text; " +
      "transcription needs async speech-to-text and Files write";
    return { ok: true, code: "ok", warnings: [warning("cannot-list-models", note)] };
  }
  if (answer.status !== 200) return fail(codeOf(answer.status));
  const ids = listedIds(answer.body, "models");
  const warnings: CheckWarning[] = [];
  for (const [setting, name, fallback] of [
    // packages/runtime's default, which it doesn't export.
    ["hearing.model", "SONIOX_MODEL", "stt-rt-v5"],
    ["transcription.model", "SONIOX_ASYNC_MODEL", transcribe.DEFAULT_SONIOX_MODEL],
  ] as const) {
    const model = deps.read(name) ?? fallback;
    if (ids !== null && !ids.has(model)) {
      warnings.push(warning("unknown-model", `Soniox lists no model ${model} (${setting})`));
    }
  }
  return { ok: true, code: "ok", warnings };
}

/** What Fish says of a voice to this key: it can speak, it doesn't exist, it is someone else's. */
export type VoiceAnswer = "usable" | "unknown" | "private";

/** GET /model/{id} with the key; null when Fish gives no clear answer. */
export async function checkFishVoice(
  deps: Pick<CheckDeps, "fetch">,
  voiceId: string,
  key: string,
): Promise<VoiceAnswer | null> {
  const answer = await ask(deps, `${FISH_API}/model/${encodeURIComponent(voiceId)}`, { key });
  if (answer.status === 200) return "usable";
  if (answer.status === 404) return "unknown";
  if (answer.status === 403) return "private";
  return null;
}

/** A voice answer as GET status reports it. */
export function voiceOk(answer: VoiceAnswer | null): boolean | null {
  return answer === null ? null : answer === "usable";
}

interface FishVerdict extends Verdict {
  readonly voice?: { readonly id: string; readonly ok: boolean | null };
}

async function checkFish(deps: CheckDeps, key: string): Promise<FishVerdict> {
  const answer = await ask(deps, `${FISH_API}/wallet/self/api-credit`, { key });
  if (answer.status !== 200) return fail(codeOf(answer.status));
  const credit = numberOf(field(answer.body, "credit"));
  const model = deps.read("FISH_MODEL") ?? "drama-3";
  const warnings: CheckWarning[] = [];
  if (!(FISH_MODELS as readonly string[]).includes(model)) {
    warnings.push(warning("unknown-model", `Fish has no model ${model} (voice.model)`));
  } else if (model === FISH_DEPRECATED_MODEL) {
    warnings.push(warning("deprecated-model", "Fish retires s1 on 2026-12-31"));
  }
  if (credit !== null && credit <= 0 && model !== FISH_FREE_MODEL) {
    warnings.push(
      warning("no-credit", `The account has no API credit, and ${model} bills: ${FISH_BILLING}`),
    );
  }
  const voiceId = deps.read("FISH_VOICE_ID");
  if (voiceId === undefined) return { ok: true, code: "ok", warnings, credit };
  const voice = await checkFishVoice(deps, voiceId, key);
  const whose = deps.fromEnv("FISH_VOICE_ID")
    ? "The voice she inherits from FISH_VOICE_ID"
    : "The persona's voice";
  if (voice === "unknown") {
    warnings.push(warning("voice-unknown", `${whose} isn't one Fish has`));
  } else if (voice === "private") {
    warnings.push(warning("voice-private", `${whose} belongs to another Fish account`));
  }
  return { ok: true, code: "ok", warnings, credit, voice: { id: voiceId, ok: voiceOk(voice) } };
}

export const DEFAULT_QDRANT_PORT = 6333;

/** The Qdrant the bot's memory uses, read as packages/memory reads it; null when memory is off. */
export function configuredQdrant(
  read: CheckDeps["read"],
): { readonly host: string; readonly port: number } | null {
  const host = pyStrip(read("MEM0_QDRANT_HOST") ?? "");
  if (host === "") return null;
  const raw = read("MEM0_QDRANT_PORT");
  return { host, port: (raw === undefined ? null : pyParseInt(raw)) ?? DEFAULT_QDRANT_PORT };
}

/** `host`, `host:port`, `[v6]` or `[v6]:port`; null when it isn't one. */
export function parseQdrantAddress(
  value: string,
  defaultPort: number,
): { host: string; port: number } | null {
  const match = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(value.trim());
  if (match === null) return null;
  const port = match[2] === undefined ? defaultPort : Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return { host: (match[1] as string).replace(/^\[(.*)\]$/, "$1"), port };
}

function qdrantBase(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** Major and minor within one of the client's. */
function compatibleQdrant(version: string): boolean {
  const [major, minor] = version.split(".").map(Number);
  const [clientMajor, clientMinor] = QDRANT_CLIENT_VERSION.split(".").map(Number);
  return major === clientMajor && Math.abs((minor ?? Number.NaN) - (clientMinor as number)) <= 1;
}

/** GET / names the server and its version; GET /collections shows whether it wants a key. */
export async function checkQdrant(
  deps: Pick<CheckDeps, "fetch">,
  host: string,
  port: number,
): Promise<Verdict> {
  const base = qdrantBase(host, port);
  const root = await ask(deps, `${base}/`, { timeoutMs: QDRANT_TIMEOUT_MS });
  if (root.status === 0) return fail("unreachable", `Nothing answers at ${host}:${port}`);
  if (root.status === 503) return fail("starting");
  if (root.status !== 200 || field(root.body, "title") !== QDRANT_TITLE) return fail("not-qdrant");
  const warnings: CheckWarning[] = [];
  const version = field(root.body, "version");
  if (typeof version !== "string" || !compatibleQdrant(version)) {
    warnings.push(
      warning(
        "version-mismatch",
        `Qdrant ${String(version)} is more than one minor version from the client's ` +
          `${QDRANT_CLIENT_VERSION}`,
      ),
    );
  }
  const collections = await ask(deps, `${base}/collections`, { timeoutMs: QDRANT_TIMEOUT_MS });
  if (collections.status === 401 || collections.status === 403) return fail("needs-api-key");
  if (collections.status === 503) return fail("starting");
  if (collections.status !== 200) return fail(codeOf(collections.status));
  return { ok: true, code: "ok", message: `Qdrant ${String(version)} answers`, warnings };
}

/** The key a provider's check uses: its own, else OpenRouter's, which it falls back to. */
const KEYS: Readonly<Record<Exclude<CheckProvider, "qdrant">, readonly [string, string?]>> = {
  soniox: ["SONIOX_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  fish: ["FISH_API_KEY"],
  embeddings: ["EMBED_API_KEY", "OPENROUTER_API_KEY"],
  rerank: ["RERANK_API_KEY", "OPENROUTER_API_KEY"],
  refine: ["REFINE_API_KEY", "OPENROUTER_API_KEY"],
};

/** Each OpenAI-compatible provider's base setting, its default, and the model to look up. */
const BASES = {
  embeddings: {
    base: ["EMBED_BASE_URL", DEFAULT_EMBED_BASE_URL],
    model: ["EMBED_MODEL", DEFAULT_EMBED_MODEL, "embeddings.model"],
    listing: `${OPENROUTER_BASE}/embeddings/models`,
  },
  rerank: {
    base: ["RERANK_BASE_URL", DEFAULT_RERANK_BASE_URL],
    model: ["RERANK_MODEL", DEFAULT_RERANK_MODEL, "knowledge.rerank.model"],
    listing: `${OPENROUTER_BASE}/models?output_modalities=rerank`,
  },
  refine: {
    base: ["REFINE_BASE_URL", refine.DEFAULT_BASE_URL],
    model: ["REFINE_MODEL", refine.DEFAULT_MODEL, "refine.model"],
    listing: `${OPENROUTER_BASE}/models`,
  },
} as const;

/** The outcome of a check, and for Fish what it learned of the persona's voice. */
export interface CheckOutcome {
  readonly result: CheckResult;
  readonly voice?: { readonly id: string; readonly ok: boolean | null };
  readonly qdrant?: { readonly host: string; readonly port: number; readonly ok: boolean };
}

/**
 * Checks `provider` with `value` when given (a key typed but not saved, or a Qdrant address),
 * else with what the bot reads now.
 */
export async function checkProvider(
  provider: CheckProvider,
  value: string | undefined,
  deps: CheckDeps,
): Promise<CheckOutcome> {
  if (provider === "qdrant") {
    const envOverride = deps.fromEnv("MEM0_QDRANT_HOST") || deps.fromEnv("MEM0_QDRANT_PORT");
    const address =
      value === undefined
        ? configuredQdrant(deps.read)
        : parseQdrantAddress(value, DEFAULT_QDRANT_PORT);
    if (address === null) {
      const verdict =
        value === undefined
          ? fail("missing")
          : fail("unexpected", "That isn't a host, or host:port");
      return { result: finish(verdict, envOverride) };
    }
    const verdict = await checkQdrant(deps, address.host, address.port);
    return { result: finish(verdict, envOverride), qdrant: { ...address, ok: verdict.ok } };
  }
  const [own, fallback] = KEYS[provider];
  const envOverride = deps.fromEnv(own);
  const key = value ?? deps.read(own) ?? (fallback === undefined ? undefined : deps.read(fallback));
  if (key === undefined) return { result: finish(fail("missing"), envOverride) };
  switch (provider) {
    case "soniox":
      return { result: finish(await checkSoniox(deps, key), envOverride) };
    case "fish": {
      const verdict = await checkFish(deps, key);
      return {
        result: finish(verdict, envOverride),
        ...(verdict.voice === undefined ? {} : { voice: verdict.voice }),
      };
    }
    case "openrouter": {
      const base = deps.read("OPENROUTER_API_BASE") ?? OPENROUTER_BASE;
      const verdict = isOpenRouter(base)
        ? await checkOpenRouterKey(deps, key, base)
        : await checkCompatibleBase(deps, key, base);
      return { result: finish(verdict, envOverride) };
    }
    default: {
      const spec = BASES[provider];
      const base = deps.read(spec.base[0]) ?? spec.base[1];
      let verdict: Verdict;
      if (isOpenRouter(base)) {
        verdict = await checkOpenRouterKey(deps, key, base);
        if (verdict.ok) {
          const [setting, fallbackModel, path] = spec.model;
          const model = deps.read(setting) ?? fallbackModel;
          const extra = await modelWarning(deps, spec.listing, model, path);
          verdict = { ...verdict, warnings: [...(verdict.warnings ?? []), ...extra] };
        }
      } else if (provider === "rerank" && isCohere(base)) {
        verdict = await checkCohere(deps, key);
      } else {
        verdict = await checkCompatibleBase(deps, key, base);
      }
      return { result: finish(verdict, envOverride) };
    }
  }
}

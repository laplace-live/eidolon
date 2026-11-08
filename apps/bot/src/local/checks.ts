// The provider checks behind POST credentials/check. A verdict comes from the HTTP status; a body
// is read only for the fields a check names, and the provider's own wording is never shown. Every
// endpoint here is free: listings, key lookups and the Fish wallet, never a model call.
import { isPlainObject, pyParseInt, pyStrip } from "@eidolon/config";
import {
  type KeyCheck,
  LEGACY_VOICE_ENV,
  type Provider,
  providerById,
  type RoleId,
  roleById,
  type Selection,
  type Sources,
  select,
  takesKey,
  trySelect,
  VOICE_ENV,
  voiceOf,
} from "@eidolon/providers";
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
  /** What roles resolve from, accounts included; `read` alone where it is left out. */
  readonly sources?: Sources;
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
export const FISH_MODELS: readonly string[] =
  providerById("fish")?.offers.tts?.models.map((model) => model.id) ?? [];
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

/** One GET or POST that never follows a redirect; a key goes only in a header. */
export async function ask(
  deps: Pick<CheckDeps, "fetch">,
  url: string,
  options: {
    key?: string;
    headers?: Readonly<Record<string, string>>;
    method?: "GET" | "POST";
    timeoutMs?: number;
  } = {},
): Promise<Answer> {
  try {
    const response = await deps.fetch(url, {
      method: options.method ?? "GET",
      headers: {
        ...(options.key === undefined ? {} : { authorization: `Bearer ${options.key}` }),
        ...options.headers,
      },
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

async function checkCohere(deps: CheckDeps, key: string): Promise<Verdict> {
  const answer = await ask(deps, COHERE_CHECK_URL, { key, method: "POST" });
  if (answer.status === 200) {
    return field(answer.body, "valid") === true ? { ok: true, code: "ok" } : fail("invalid-key");
  }
  // Cohere answers 498 for a key it doesn't know.
  return fail(answer.status === 498 ? "invalid-key" : codeOf(answer.status));
}

/** The headers a provider's key check sends its key in. */
function keyHeaders(check: KeyCheck, key: string): Record<string, string> {
  const auth =
    check.auth === "bearer"
      ? { authorization: `Bearer ${key}` }
      : check.auth === "token"
        ? { authorization: `Token ${key}` }
        : { [check.auth]: key };
  return { ...auth, ...check.headers };
}

/**
 * A provider's own free check of a key at `base`, by default an OpenAI-compatible GET /models; 404
 * or 405 can't tell.
 */
async function checkListing(
  deps: CheckDeps,
  key: string | undefined,
  base: string,
  check: KeyCheck = { path: "/models", auth: "bearer" },
): Promise<Verdict> {
  const answer = await ask(deps, `${trimSlash(base)}${check.path}`, {
    headers: key === undefined ? {} : keyHeaders(check, key),
  });
  if (answer.status >= 200 && answer.status < 300) return { ok: true, code: "ok" };
  if (answer.status === 401 || answer.status === 403) return fail("invalid-key");
  if (answer.status === 404 || answer.status === 405) {
    const note = "This provider has no listing to check the key against";
    return { ok: true, code: "ok", warnings: [warning("cannot-verify", note)] };
  }
  return fail(codeOf(answer.status));
}

async function checkSoniox(
  deps: CheckDeps,
  key: string,
  base: string = SONIOX_MODELS_URL.replace(/\/models$/, ""),
): Promise<Verdict> {
  const answer = await ask(deps, `${trimSlash(base)}/models`, { key });
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
  for (const [role, setting] of [
    ["hearing", "hearing.model"],
    ["transcription", "transcription.model"],
  ] as const) {
    const model = selected(role, deps)?.model;
    if (model !== undefined && ids !== null && !ids.has(model)) {
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

async function checkFish(
  deps: CheckDeps,
  key: string,
  account: string = "fish",
): Promise<FishVerdict> {
  const answer = await ask(deps, `${FISH_API}/wallet/self/api-credit`, { key });
  if (answer.status !== 200) return fail(codeOf(answer.status));
  const credit = numberOf(field(answer.body, "credit"));
  // Fish's own voice settings matter only while this account speaks for her.
  const voiceRole = selected("voice", deps);
  if (voiceRole?.provider.id !== "fish" || voiceRole.account.id !== account) {
    return { ok: true, code: "ok", credit };
  }
  const model = voiceRole.model;
  const warnings: CheckWarning[] = [];
  if (!FISH_MODELS.includes(model)) {
    warnings.push(warning("unknown-model", `Fish has no model ${model} (voice.model)`));
  } else if (model === FISH_DEPRECATED_MODEL) {
    warnings.push(warning("deprecated-model", "Fish retires s1 on 2026-12-31"));
  }
  if (credit !== null && credit <= 0 && model !== FISH_FREE_MODEL) {
    warnings.push(
      warning("no-credit", `The account has no API credit, and ${model} bills: ${FISH_BILLING}`),
    );
  }
  const voiceId = voiceOf(voiceRole, deps.sources ?? deps.read);
  if (voiceId === undefined) return { ok: true, code: "ok", warnings, credit };
  const voice = await checkFishVoice(deps, voiceId, key);
  const inherited = [VOICE_ENV, LEGACY_VOICE_ENV].find((name) => deps.fromEnv(name));
  const whose =
    inherited === undefined ? "The persona's voice" : `The voice she inherits from ${inherited}`;
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

/** A role as the settings fill it now; undefined for one they leave off or name wrong. */
function selected(role: RoleId, deps: Pick<CheckDeps, "read" | "sources">): Selection | undefined {
  return trySelect(role, deps.sources ?? deps.read) ?? undefined;
}

/** The roles a check asks about by their own key and endpoint, and OpenRouter's listing of each. */
const ROLE_CHECKS = {
  embeddings: `${OPENROUTER_BASE}/embeddings/models`,
  rerank: `${OPENROUTER_BASE}/models?output_modalities=rerank`,
  refine: `${OPENROUTER_BASE}/models`,
} as const satisfies Partial<Record<RoleId, string>>;

type RoleCheck = keyof typeof ROLE_CHECKS;

const isRoleCheck = (provider: string): provider is RoleCheck =>
  Object.hasOwn(ROLE_CHECKS, provider);

/** A role's key, at the endpoint it calls: its provider's, or the one its own settings name. */
async function checkRole(
  role: RoleCheck,
  value: string | undefined,
  deps: CheckDeps,
): Promise<CheckOutcome> {
  let selection: Selection | null;
  try {
    selection = select(role, deps.sources ?? deps.read);
  } catch (error) {
    return { result: finish(fail("unexpected", (error as Error).message), false) };
  }
  if (selection === null) return { result: finish(fail("missing"), false) };
  const own = roleById(role).keyEnv;
  const envOverride = deps.fromEnv(own ?? selection.keyName ?? "");
  const key = value ?? selection.apiKey;
  if (key === undefined) return { result: finish(fail("missing"), envOverride) };
  const base = selection.baseUrl ?? "";
  let verdict: Verdict;
  if (isOpenRouter(base)) {
    verdict = await checkOpenRouterKey(deps, key, base);
    if (verdict.ok) {
      const path = `${roleById(role).path}.model`;
      const extra = await modelWarning(deps, ROLE_CHECKS[role], selection.model, path);
      verdict = { ...verdict, warnings: [...(verdict.warnings ?? []), ...extra] };
    }
  } else if (role === "rerank" && isCohere(base)) {
    verdict = await checkCohere(deps, key);
  } else if (selection.provider.check !== undefined) {
    verdict = await checkListing(deps, key, base, selection.provider.check);
  } else {
    verdict = await checkListing(deps, key, base);
  }
  return { result: finish(verdict, envOverride) };
}

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
  if (isRoleCheck(provider)) return checkRole(provider, value, deps);
  const entry = providerById(provider);
  const own = entry?.credential ?? null;
  if (entry === undefined || own === null) return { result: finish(fail("missing"), false) };
  const base =
    (entry.baseUrlEnv === null ? undefined : deps.read(entry.baseUrlEnv)) ??
    entry.baseUrl ??
    undefined;
  return checkAccount(
    { provider: entry, apiKey: value ?? deps.read(own), baseUrl: base, account: entry.id },
    deps,
    deps.fromEnv(own),
  );
}

/** The account a check asks about: its provider, and a key and API base typed or saved. */
export interface CheckTarget {
  readonly provider: Provider;
  readonly apiKey: string | undefined;
  readonly baseUrl: string | undefined;
  /** Its id, for what a check of the voice's own Fish account learns of the voice. */
  readonly account?: string;
}

/** An account's key, at its API base. A provider that takes no key is checked by its listing. */
export async function checkAccount(
  target: CheckTarget,
  deps: CheckDeps,
  envOverride: boolean,
): Promise<CheckOutcome> {
  const { provider, apiKey: key } = target;
  const base = target.baseUrl;
  if (key === undefined) {
    if (takesKey(provider) || base === undefined) {
      return { result: finish(fail("missing"), envOverride) };
    }
    return { result: finish(await checkListing(deps, undefined, base), envOverride) };
  }
  switch (provider.id) {
    case "soniox":
      return { result: finish(await checkSoniox(deps, key, base), envOverride) };
    case "fish": {
      const verdict = await checkFish(deps, key, target.account);
      return {
        result: finish(verdict, envOverride),
        ...(verdict.voice === undefined ? {} : { voice: verdict.voice }),
      };
    }
    case "openrouter": {
      const at = base ?? OPENROUTER_BASE;
      const verdict = isOpenRouter(at)
        ? await checkOpenRouterKey(deps, key, at)
        : await checkListing(deps, key, at);
      return { result: finish(verdict, envOverride) };
    }
    case "cohere":
      return { result: finish(await checkCohere(deps, key), envOverride) };
    default: {
      if (provider.check === undefined || base === undefined) {
        const note = `${provider.name} offers nothing to check the key against for free`;
        const verdict: Verdict = {
          ok: true,
          code: "ok",
          warnings: [warning("cannot-verify", note)],
        };
        return { result: finish(verdict, envOverride) };
      }
      return { result: finish(await checkListing(deps, key, base, provider.check), envOverride) };
    }
  }
}

// GET status, which the home page polls, so every part of it is local and cheap. Qdrant and the
// persona's voice are checked in the background and reported from the last answer; the tools on
// PATH are looked up at most once a minute.
import { existsSync, statfsSync, statSync } from "node:fs";
import { activePersona, dataHome, envOptional, envOverride, logger } from "@eidolon/config";
import { referenceCandidates } from "@eidolon/imagegen";
import { download, which } from "@eidolon/ingest";
import manifest from "../../package.json" with { type: "json" };
import { REQUIRED_KEYS, type Status, type VoiceStatus, type YtDlpStatus } from "./api.ts";
import { checkFishVoice, checkQdrant, configuredQdrant, voiceOk } from "./checks.ts";
import { indexStatus } from "./personas.ts";
import { restartTracker } from "./restart.ts";
import type { LocalApp } from "./router.ts";

export interface StatusDeps {
  readonly fetch: typeof fetch;
  readonly now: () => number;
}

export const defaultStatusDeps: StatusDeps = { fetch, now: Date.now };

/** How long a probe's answer stands before the next status asks again. */
export const PROBE_TTL_MS = 30_000;
/** A voice exists or doesn't for good; only a failed lookup is retried soon. */
export const VOICE_TTL_MS = 5 * 60_000;
const TOOLS_TTL_MS = 60_000;
const VERSION_TIMEOUT_MS = 10_000;

interface Answer {
  readonly ok: boolean | null;
  readonly at: number;
}

/** What one server remembers between polls. */
class StatusState {
  readonly qdrant = new Map<string, Answer>();
  readonly voices = new Map<string, Answer>();
  readonly probing = new Set<string>();
  readonly versions = new Map<string, string | null>();
  tools: { readonly at: number; readonly ytDlp: YtDlpStatus; readonly ffmpeg: boolean } | null =
    null;
  lastSessionError: Status["lastSessionError"] = null;
}

const states = new WeakMap<LocalApp, StatusState>();

function stateOf(app: LocalApp): StatusState {
  let state = states.get(app);
  if (state === undefined) {
    state = new StatusState();
    states.set(app, state);
  }
  return state;
}

/** A Qdrant check's answer, which GET status reports as memory.reachable. */
export function recordQdrant(
  app: LocalApp,
  address: { readonly host: string; readonly port: number },
  ok: boolean,
): void {
  stateOf(app).qdrant.set(`${address.host}:${address.port}`, { ok, at: Date.now() });
}

/**
 * What a voice answer is about: the voice, and the key that asked, since a voice another account
 * owns is private to every other key. The key itself, unhashed: the cache stays in this process,
 * and only an answer's `ok` leaves it.
 */
function voiceKey(voiceId: string, key: string): string {
  return `${voiceId}:${key}`;
}

/** Whether `key` is still the Fish key calls use: an answer for one replaced meanwhile is dropped. */
function isFishKey(key: string): boolean {
  return envOptional("FISH_API_KEY") === key;
}

/**
 * A Fish check's answer about a voice with `key`, which GET status reports as persona.voice.ok
 * while that key is the saved one.
 */
export function recordVoice(app: LocalApp, id: string, key: string, ok: boolean | null): void {
  if (isFishKey(key)) stateOf(app).voices.set(voiceKey(id, key), { ok, at: Date.now() });
}

// packages/runtime's runSessionSafely logs a session that failed after its offer was answered.
const SESSION_FAILED = "Bot session failed: ";
const SESSION_ERROR_MAX_CHARS = 500;

/** Keeps the last call failure the runtime logs, until the server stops. */
export function trackSessionErrors(app: LocalApp): void {
  const state = stateOf(app);
  const remove = logger.addSink((record) => {
    if (record.level !== "ERROR" || !record.message.startsWith(SESSION_FAILED)) return;
    state.lastSessionError = {
      message: record.message.slice(SESSION_FAILED.length).slice(0, SESSION_ERROR_MAX_CHARS),
      at: record.time.toISOString(),
    };
  });
  app.onStop(async () => remove());
}

/**
 * Runs `probe` unless one for `key` runs already or its last answer is fresher than `ttl`. The
 * answer is kept only if `current` still holds when it arrives.
 */
function refresh(
  state: StatusState,
  kind: "qdrant" | "voices",
  key: string,
  ttl: (answer: Answer) => number,
  deps: StatusDeps,
  probe: () => Promise<boolean | null>,
  current: () => boolean = () => true,
): void {
  const cache = state[kind];
  const last = cache.get(key);
  const id = `${kind}:${key}`;
  if (state.probing.has(id) || (last !== undefined && deps.now() - last.at < ttl(last))) return;
  state.probing.add(id);
  void probe()
    .then((ok) => {
      if (current()) cache.set(key, { ok, at: deps.now() });
    })
    .finally(() => state.probing.delete(id));
}

function voiceTtl(answer: Answer): number {
  return answer.ok === null ? PROBE_TTL_MS : VOICE_TTL_MS;
}

/** The first line `<path> --version` prints, or null. */
async function versionOf(path: string): Promise<string | null> {
  try {
    const child = Bun.spawn([path, "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => child.kill(), VERSION_TIMEOUT_MS);
    try {
      const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      const line = text.trim().split("\n")[0]?.trim() ?? "";
      return code === 0 && line !== "" ? line.slice(0, 64) : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** A yt-dlp other than the managed copy, with its version once `--version` has answered. */
function installedAt(state: StatusState, path: string): YtDlpStatus {
  let key = path;
  try {
    key = `${path}:${statSync(path).mtimeMs}`;
  } catch {
    // Compare by path alone.
  }
  if (!state.versions.has(key)) {
    state.versions.set(key, null);
    void versionOf(path).then((tag) => {
      state.versions.set(key, tag);
      // The lookup kept for a minute has no tag yet: the next poll looks again.
      state.tools = null;
    });
  }
  return { state: "installed", tag: state.versions.get(key) ?? "" };
}

/** What download would run, as packages/ingest's resolveYtDlp finds it, without installing it. */
function ytDlpStatus(state: StatusState): YtDlpStatus {
  const configured = envOptional("YT_DLP_PATH");
  if (configured !== undefined) {
    const path = which(configured);
    if (path === null) {
      return { state: "unavailable", reason: `yt-dlp not found at ${configured} (sources.ytDlp)` };
    }
    return installedAt(state, path);
  }
  // Only the file name changes with the C library, never whether a build exists.
  if (download.ytDlpAsset(process.platform, process.arch, false) === null) {
    const onPath = which("yt-dlp");
    if (onPath === null) {
      return {
        state: "unavailable",
        reason:
          `yt-dlp publishes no build for ${process.platform} ${process.arch}; ` +
          "install yt-dlp and set sources.ytDlp to it",
      };
    }
    return installedAt(state, onPath);
  }
  if (!existsSync(download.managedYtDlpPath())) return { state: "installs-on-first-download" };
  return { state: "installed", tag: download.managedYtDlpTag() ?? "" };
}

function tools(state: StatusState, deps: StatusDeps): NonNullable<StatusState["tools"]> {
  if (state.tools === null || deps.now() - state.tools.at >= TOOLS_TTL_MS) {
    state.tools = {
      at: deps.now(),
      ytDlp: ytDlpStatus(state),
      ffmpeg: which("ffmpeg") !== null,
    };
  }
  return state.tools;
}

function freeBytes(): number | null {
  try {
    const stats = statfsSync(dataHome());
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/**
 * Where the active persona's voice comes from, read from what is installed, so a status poll
 * re-reads no settings file: the environment's applies only where her persona.yaml sets none.
 */
function voiceSource(voiceId: string | null): VoiceStatus["source"] {
  if (envOverride("FISH_VOICE_ID") !== undefined) return "env";
  return voiceId === null ? "default" : "persona";
}

export function buildStatus(app: LocalApp, deps: StatusDeps = defaultStatusDeps): Status {
  const state = stateOf(app);
  const persona = activePersona();

  const voiceId = envOptional("FISH_VOICE_ID") ?? null;
  const fishKey = envOptional("FISH_API_KEY");
  let voice: string | null = null;
  if (voiceId !== null && fishKey !== undefined) {
    voice = voiceKey(voiceId, fishKey);
    // Fish limits concurrent requests per account, which a call's speech needs.
    if (app.activeCalls() === 0) {
      refresh(
        state,
        "voices",
        voice,
        voiceTtl,
        deps,
        async () => voiceOk(await checkFishVoice(deps, voiceId, fishKey)),
        () => isFishKey(fishKey),
      );
    }
  }

  const qdrant = configuredQdrant(envOptional);
  if (qdrant !== null) {
    refresh(
      state,
      "qdrant",
      `${qdrant.host}:${qdrant.port}`,
      () => PROBE_TTL_MS,
      deps,
      async () => (await checkQdrant(deps, qdrant.host, qdrant.port)).ok,
    );
  }

  const changes = restartTracker(app).changes();
  const { ytDlp, ffmpeg } = tools(state, deps);
  return {
    version: manifest.version,
    restartRequired: changes.calls.length > 0,
    mcpRestartRequired: changes.mcp.length > 0,
    keys: Object.fromEntries(
      REQUIRED_KEYS.map((name) => [name, envOptional(name) !== undefined]),
    ) as Status["keys"],
    persona: {
      id: persona.id,
      name: persona.identity.name,
      shortName: persona.identity.shortName,
      voice: {
        id: voiceId,
        source: voiceSource(voiceId),
        ok: voice === null ? null : (state.voices.get(voice)?.ok ?? null),
      },
    },
    index: indexStatus(persona.id),
    selfieReferences: referenceCandidates().length,
    memory: {
      configured: qdrant !== null,
      reachable:
        qdrant === null ? null : (state.qdrant.get(`${qdrant.host}:${qdrant.port}`)?.ok ?? null),
    },
    ytDlp,
    ffmpeg,
    freeBytes: freeBytes(),
    lastSessionError: state.lastSessionError,
    activeCalls: app.activeCalls(),
  };
}

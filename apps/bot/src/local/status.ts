// GET status, which the home page polls, so every part of it is local and cheap. The persona's
// voice is checked in the background and reported from the last answer; the tools on PATH are
// looked up at most once a minute.
import { existsSync, statfsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { grantRefusal } from "@eidolon/assistant";
import {
  activePersona,
  assistantSettings,
  dataHome,
  envOptional,
  envOverride,
  logger,
  spawnProcess,
  which,
} from "@eidolon/config";
import { referenceCandidates } from "@eidolon/imagegen";
import { download } from "@eidolon/ingest";
import { isMemoryConfigured } from "@eidolon/memory";
import {
  accountsFor,
  callRoles,
  hasKey,
  missingKey,
  ProviderConfigError,
  type RoleId,
  type Selection,
  select,
  selectRequired,
  selectTask,
  trySelect,
  voiceOf,
} from "@eidolon/providers";
import manifest from "../../package.json" with { type: "json" };
import type {
  AssistantStatus,
  CallRole,
  MemoryStatus,
  Status,
  TaskProfile,
  VoiceStatus,
  YtDlpStatus,
} from "./api.ts";
import { activeModel } from "./appearance.ts";
import { checkFishVoice, voiceOk } from "./checks.ts";
import { findAvatar, indexStatus } from "./personas.ts";
import { restartTracker } from "./restart.ts";
import type { LocalApp } from "./router.ts";
import type { TaskManager } from "./tasks/manager.ts";

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

/**
 * What a voice answer is about: the voice, and the key that asked, since a voice another account
 * owns is private to every other key. The key itself, unhashed: the cache stays in this process,
 * and only an answer's `ok` leaves it.
 */
function voiceKey(voiceId: string, key: string): string {
  return `${voiceId}:${key}`;
}

/** The key her Fish voice speaks with, wherever it is saved; undefined for another provider's. */
function fishVoiceKey(): string | undefined {
  const voice = trySelect("voice");
  return voice?.provider.id === "fish" ? voice.apiKey : undefined;
}

/** Whether `key` is still the Fish key calls use: an answer for one replaced meanwhile is dropped. */
function isFishKey(key: string): boolean {
  return fishVoiceKey() === key;
}

/**
 * A Fish check's answer about a voice with `key`, which GET status reports as persona.voice.ok
 * while that key is the saved one.
 */
export function recordVoice(app: LocalApp, id: string, key: string, ok: boolean | null): void {
  if (isFishKey(key)) stateOf(app).voices.set(voiceKey(id, key), { ok, at: Date.now() });
}

// packages/runtime's runNativeSafely logs a call that failed after its offer was answered.
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
 * Runs `probe` unless one for `key` runs already or its last answer is still fresh. The answer is
 * kept only if `current` still holds when it arrives.
 */
function refreshVoice(
  state: StatusState,
  key: string,
  deps: StatusDeps,
  probe: () => Promise<boolean | null>,
  current: () => boolean,
): void {
  const last = state.voices.get(key);
  if (state.probing.has(key) || (last !== undefined && deps.now() - last.at < voiceTtl(last))) {
    return;
  }
  state.probing.add(key);
  void probe()
    .then((ok) => {
      if (current()) state.voices.set(key, { ok, at: deps.now() });
    })
    .finally(() => state.probing.delete(key));
}

function voiceTtl(answer: Answer): number {
  return answer.ok === null ? PROBE_TTL_MS : VOICE_TTL_MS;
}

/** The first line `<path> --version` prints, or null. */
async function versionOf(path: string): Promise<string | null> {
  try {
    const child = spawnProcess([path, "--version"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: VERSION_TIMEOUT_MS,
    });
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const line = text.trim().split("\n")[0]?.trim() ?? "";
    return code === 0 && line !== "" ? line.slice(0, 64) : null;
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
  if (envOverride("TTS_VOICE_ID") !== undefined) return "env";
  if (envOptional("TTS_VOICE_ID") === undefined && envOverride("FISH_VOICE_ID") !== undefined) {
    return "env";
  }
  return voiceId === null ? "default" : "persona";
}

/** A role as the installed settings fill it, or what is wrong with them. */
function callRole(role: RoleId): { role: CallRole; selection: Selection | null } {
  try {
    const selection = select(role);
    return {
      role: {
        role,
        provider: selection?.provider.id ?? null,
        model: selection?.model ?? null,
        problem: null,
      },
      selection,
    };
  } catch (error) {
    if (!(error instanceof ProviderConfigError)) throw error;
    return { role: { role, provider: null, model: null, problem: error.message }, selection: null };
  }
}

/** Why one of `folders`, absolute, can't be granted, as every task's policy would refuse it. */
export function foldersProblem(folders: readonly string[]): string | null {
  const home = homedir();
  for (const folder of folders) {
    const refused = grantRefusal(folder, home);
    if (refused !== null) return refused.message;
  }
  return null;
}

/**
 * Why a task can't run, sending nothing: why createMind("assistant") would throw (no account or
 * model chosen, an account that can't run tasks, or no key), or an assistant folder no task may be
 * granted. null once a task can start.
 */
export function assistantProblem(): string | null {
  try {
    const selection = selectRequired("assistant");
    if (!hasKey(selection)) return missingKey(selection).message;
  } catch (error) {
    if (error instanceof ProviderConfigError) return error.message;
    throw error;
  }
  return foldersProblem(assistantSettings().folders);
}

/**
 * Whether tasks may search the web: the search role has an account and its key. `problem` says why
 * an account named can't; null when none is named, the owner's choice.
 */
export function searchStatus(): AssistantStatus["search"] {
  let problem: string | null = null;
  const selection = trySelect("search", undefined, (error) => {
    problem = error.message;
  });
  if (selection === null) return { on: false, problem };
  if (!hasKey(selection)) return { on: false, problem: missingKey(selection).message };
  return { on: true, problem: null };
}

/**
 * Why each kind of task runs on Assistant Mode's own account and model though its own are set; all
 * null unless `ready`, as Assistant Mode's own problem is the one to tell.
 */
export function kindsStatus(ready: boolean): AssistantStatus["kinds"] {
  const fallback = (kind: TaskProfile) => (ready ? selectTask(kind).fallback : null);
  return { quick: fallback("quick"), coding: fallback("coding"), research: fallback("research") };
}

/** The roles her calls run on; a realtime setting Eidolon can't use is the problem to report. */
export function statusRoles(): readonly RoleId[] {
  try {
    return callRoles();
  } catch (error) {
    if (error instanceof ProviderConfigError) return ["realtime"];
    throw error;
  }
}

/** Whether viewer memory is turned on and has the embedding and extraction keys it needs. */
export function memoryStatus(): MemoryStatus {
  if (!isMemoryConfigured()) {
    return { configured: false, ready: false, problem: null };
  }
  for (const role of ["embeddings", "memory"] as const) {
    try {
      const selection = selectRequired(role);
      if (!hasKey(selection)) {
        return { configured: true, ready: false, problem: missingKey(selection).message };
      }
    } catch (error) {
      if (error instanceof ProviderConfigError) {
        return { configured: true, ready: false, problem: error.message };
      }
      throw error;
    }
  }
  return { configured: true, ready: true, problem: null };
}

/** `tasks`: the server's task manager, which counts the running tasks; none runs without one. */
export function buildStatus(
  app: LocalApp,
  deps: StatusDeps = defaultStatusDeps,
  tasks?: Pick<TaskManager, "running">,
): Status {
  const state = stateOf(app);
  const persona = activePersona();

  const roles = statusRoles();
  const call = roles.map(callRole);
  const voiceRole = call.find((entry) => entry.role.role === "voice")?.selection ?? null;
  const voiceId = voiceRole === null ? null : (voiceOf(voiceRole) ?? null);
  const fishKey = voiceRole?.provider.id === "fish" ? voiceRole.apiKey : undefined;
  let voice: string | null = null;
  if (voiceId !== null && fishKey !== undefined) {
    voice = voiceKey(voiceId, fishKey);
    // Fish limits concurrent requests per account, which a call's speech needs.
    if (app.activeCalls() === 0) {
      refreshVoice(
        state,
        voice,
        deps,
        async () => voiceOk(await checkFishVoice(deps, voiceId, fishKey)),
        () => isFishKey(fishKey),
      );
    }
  }

  const changes = restartTracker(app).changes();
  const { ytDlp, ffmpeg } = tools(state, deps);
  const notReady = assistantProblem();
  return {
    version: manifest.version,
    restartRequired: changes.calls.length > 0,
    mcpRestartRequired: changes.mcp.length > 0,
    keys: accountsFor(roles).map(({ account, roles: served, set }) => ({
      account: account.id,
      name: account.name,
      provider: account.provider.id,
      roles: served,
      set,
    })),
    call: { realtime: roles.includes("realtime"), roles: call.map((entry) => entry.role) },
    persona: {
      id: persona.id,
      name: persona.identity.name,
      shortName: persona.identity.shortName,
      avatar: findAvatar(persona.id) !== null,
      appearance: { model: activeModel(persona.id, envOptional("APPEARANCE_MODEL")) },
      voice: {
        id: voiceId,
        source: voiceSource(voiceId),
        ok: voice === null ? null : (state.voices.get(voice)?.ok ?? null),
        provider: voiceRole?.provider.id ?? null,
        account: voiceRole?.account.id ?? null,
      },
    },
    index: indexStatus(persona.id),
    selfieReferences: referenceCandidates().length,
    memory: memoryStatus(),
    ytDlp,
    ffmpeg,
    freeBytes: freeBytes(),
    lastSessionError: state.lastSessionError,
    activeCalls: app.activeCalls(),
    assistant: {
      enabled: assistantSettings().enabled,
      ready: notReady === null,
      problem: notReady,
      running: tasks?.running() ?? 0,
      search: searchStatus(),
      kinds: kindsStatus(notReady === null),
    },
  };
}

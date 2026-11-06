// Which settings and keys the running server reads once, so that a change needs POST restart. Some
// are read at boot; others the first time memory or retrieval runs, which then keeps them:
// SharedEngine holds the first Mem0 engine it opens, and retrieval its first embedding client and
// reranker. Every other value applies from the next call once the settings are installed again.
import {
  activePersona,
  envOptional,
  installSettings,
  pyStrip,
  resetSettings,
} from "@eidolon/config";
import type { LocalApp } from "./router.ts";

/** What keeps a value it read once. */
export type BootReader = "server" | "mcp" | "memory" | "retrieval";

const READERS: readonly BootReader[] = ["server", "mcp", "memory", "retrieval"];

/** Every variable a reader keeps, with the readers that keep it. */
export const BOOT_READ: Readonly<Record<string, readonly BootReader[]>> = {
  // At boot: CORS, the anonymous offer quota, ICE and the Opus presets.
  PIPECAT_ALLOWED_ORIGINS: ["server"],
  EIDOLON_ANON_RATE_LIMIT_PER_HOUR: ["server"],
  EIDOLON_ANON_RATE_LIMIT_WINDOW_SEC: ["server"],
  CLOUDFLARE_TURN_KEY_ID: ["server"],
  CLOUDFLARE_TURN_TTL_SEC: ["server"],
  CLOUDFLARE_TURN_KEY_API_TOKEN: ["server"],
  WEBRTC_STUN_URL: ["server"],
  WEBRTC_TURN_URL: ["server"],
  WEBRTC_TURN_USERNAME: ["server"],
  WEBRTC_TURN_CREDENTIAL: ["server"],
  EIDOLON_OPUS_BITRATE_BPS: ["server"],
  EIDOLON_OPUS_BITRATE_BEST_BPS: ["server"],
  EIDOLON_OPUS_BITRATE_MEDIUM_BPS: ["server"],
  EIDOLON_OPUS_BITRATE_LOW_BPS: ["server"],
  EIDOLON_OPUS_BITRATE_LOWEST_BPS: ["server"],
  // At boot, the MCP server opens the persona's index and builds its quotas. Logins are validated
  // only for MCP's logged-in tier here, whose resolver keeps its TTL and WAF token.
  EIDOLON_PERSONA: ["mcp"],
  LANCEDB_PATH: ["mcp"],
  PERSONA_FACTS_CANDIDATES: ["mcp"],
  STREAM_ARCHIVE_CANDIDATES: ["mcp"],
  EIDOLON_MCP_ANON_RATE_LIMIT_PER_HOUR: ["mcp"],
  EIDOLON_MCP_AUTH_RATE_LIMIT_PER_HOUR: ["mcp"],
  EIDOLON_MCP_RATE_LIMIT_WINDOW_SEC: ["mcp"],
  EIDOLON_MCP_ALLOWED_HOSTS: ["mcp"],
  EIDOLON_VALIDATE_TTL_SEC: ["mcp"],
  CF_WAF_BYPASS_TOKEN: ["mcp"],
  // The Mem0 engine's whole configuration (packages/memory buildMemoryConfig).
  MEM0_QDRANT_HOST: ["memory"],
  MEM0_QDRANT_PORT: ["memory"],
  MEM0_QDRANT_COLLECTION: ["memory"],
  MEM0_HISTORY_DB_PATH: ["memory"],
  MEM0_LLM_MODEL: ["memory"],
  OPENROUTER_MODEL: ["memory"],
  OPENROUTER_API_BASE: ["memory"],
  OPENAI_BASE_URL: ["memory"],
  OPENAI_API_KEY: ["memory"],
  EMBED_MODEL: ["memory"],
  EMBED_DIM: ["memory"],
  EMBED_BASE_URL: ["memory", "retrieval"],
  EMBED_API_KEY: ["memory", "retrieval"],
  OPENROUTER_API_KEY: ["memory", "retrieval"],
  // Retrieval's embedding client and reranker.
  OPENROUTER_APP_NAME: ["retrieval"],
  OPENROUTER_APP_URL: ["retrieval"],
  RERANK_ENABLED: ["retrieval"],
  RERANK_MODEL: ["retrieval"],
  RERANK_BASE_URL: ["retrieval"],
  RERANK_API_KEY: ["retrieval"],
};

/** Every other setting and key: read per call, per request or by the offline tools. */
export const LIVE_READ: readonly string[] = [
  "EIDOLON_LOCAL_VIEWER_NAME",
  "WORKERS_BASE_URL",
  "EIDOLON_REAL_IP_HEADER",
  "REFINE_BASE_URL",
  "YT_DLP_PATH",
  "YT_DLP_COOKIES_FROM_BROWSER",
  "YT_DLP_COOKIES",
  "PERSONA_FILE",
  "PERSONA_TIMEZONE",
  "FISH_MODEL",
  "FISH_VOICE_ID",
  "SONIOX_MODEL",
  "MEM0_SEARCH_LIMIT",
  "MEM0_SEARCH_THRESHOLD",
  "MEM0_AGENT_ID",
  "MEM0_RUN_ID",
  "RETRIEVAL_GATE_ENABLED",
  "RETRIEVAL_GATE_MODEL",
  "FACTS_FILES",
  "FACTS_SUBJECT",
  "INGEST_SKIP_TYPES",
  "SONIOX_ASYNC_MODEL",
  "TRANSCRIBE_LANGUAGE",
  "REFINE_MODEL",
  "REFINE_CONCURRENCY",
  "SELFIE_MODEL",
  "SELFIE_ASPECT_RATIO",
  "SELFIE_QUALITY",
  "SELFIE_TTL_SECONDS",
  "SELFIE_TIMEOUT_SECONDS",
  "SELFIE_REFERENCE_IMAGES",
  "SONIOX_API_KEY",
  "FISH_API_KEY",
  "REFINE_API_KEY",
];

type Read = (name: string) => string | undefined;

/** What a reader acts on: for EIDOLON_PERSONA, the persona the files choose, even by default. */
function effective(name: string): string | undefined {
  return name === "EIDOLON_PERSONA" ? activePersona().id : envOptional(name);
}

/**
 * When a reader may first keep what it reads. Memory needs a Qdrant host (isMemoryConfigured) and
 * retrieval a key, so the wizard can save both before the first call without asking for a restart.
 */
const ARMED: Readonly<Record<BootReader, (read: Read) => boolean>> = {
  server: () => true,
  mcp: () => true,
  memory: (read) => pyStrip(read("MEM0_QDRANT_HOST") ?? "") !== "",
  retrieval: (read) =>
    ["OPENROUTER_API_KEY", "EMBED_API_KEY", "RERANK_API_KEY"].some((name) => !!read(name)),
};

export interface RestartChanges {
  /** Variables calls still read their old values of. */
  readonly calls: readonly string[];
  /** Variables only the MCP server still reads the old values of. */
  readonly mcp: readonly string[];
}

/**
 * Each kept variable's value from when its first reader could have kept it, and which have differed
 * since. A reader may have taken up a changed value before it was set back, so a change stays
 * flagged until the restart.
 */
export class RestartTracker {
  readonly #read: Read;
  readonly #armed = new Set<BootReader>();
  readonly #baseline = new Map<string, string | undefined>();
  readonly #changed = new Set<string>();

  constructor(read: Read = effective) {
    this.#read = read;
    this.noteInstalled();
  }

  /** After each installSettings(): a reader whose first use is now possible starts its watch. */
  noteInstalled(): void {
    this.#noteChanges();
    for (const reader of READERS) {
      if (this.#armed.has(reader) || !ARMED[reader](this.#read)) continue;
      this.#armed.add(reader);
      for (const [name, readers] of Object.entries(BOOT_READ)) {
        if (readers.includes(reader) && !this.#baseline.has(name)) {
          this.#baseline.set(name, this.#read(name));
        }
      }
    }
  }

  #noteChanges(): void {
    for (const [name, before] of this.#baseline) {
      if (this.#read(name) !== before) this.#changed.add(name);
    }
  }

  changes(): RestartChanges {
    this.#noteChanges();
    const calls: string[] = [];
    const mcp: string[] = [];
    for (const name of this.#changed) {
      const mcpOnly = (BOOT_READ[name] ?? []).every((reader) => reader === "mcp");
      (mcpOnly ? mcp : calls).push(name);
    }
    return { calls, mcp };
  }
}

const trackers = new WeakMap<LocalApp, RestartTracker>();

/** The server's tracker; the first call, while the routes are built at boot, takes the baseline. */
export function restartTracker(app: LocalApp): RestartTracker {
  let tracker = trackers.get(app);
  if (tracker === undefined) {
    tracker = new RestartTracker();
    trackers.set(app, tracker);
  }
  return tracker;
}

/** Reads every settings file again after a write, so the next call sees it. */
export function reinstallSettings(app: LocalApp): void {
  resetSettings();
  installSettings();
  restartTracker(app).noteInstalled();
}

// Home's readiness list: what calls and builds need, read from GET status, each with its fix.
import type {
  CheckProvider,
  IndexTable,
  MemoryStatus,
  RequiredKey,
  Status,
  VoiceStatus,
} from "@/lib/api";
import { formatCount, formatDateTime } from "@/lib/format";
import type { Lang, Vars } from "@/lib/i18n";
import { studioPath } from "@/lib/paths";

export type Tone = "ok" | "info" | "warn" | "error";

export type Fix =
  | { readonly kind: "link"; readonly to: string; readonly label: string }
  | { readonly kind: "pick-voice" }
  | { readonly kind: "check"; readonly provider: Extract<CheckProvider, "fish" | "qdrant"> }
  | { readonly kind: "restart" };

export interface Item {
  readonly id: string;
  readonly tone: Tone;
  /** A locale key, filled with `vars`. */
  readonly text: string;
  readonly vars?: Vars;
  /** The server's English detail, shown as is. */
  readonly detail?: string;
  readonly fix?: Fix;
}

export interface Formats {
  readonly bytes: (bytes: number) => string;
  readonly date: (iso: string) => string;
  readonly count: (count: number) => string;
}

export function formatsFor(lang: Lang): Formats {
  const size = new Intl.NumberFormat(lang, {
    style: "unit",
    unit: "gigabyte",
    maximumFractionDigits: 1,
  });
  return {
    bytes: (bytes) => size.format(bytes / 1e9),
    date: (iso) => formatDateTime(iso, lang),
    count: (n) => formatCount(n, lang),
  };
}

/** Below this, home warns: a few videos' audio fills it. */
export const LOW_DISK_BYTES = 10e9;

const PROVIDERS: Readonly<Record<RequiredKey, string>> = {
  SONIOX_API_KEY: "Soniox",
  OPENROUTER_API_KEY: "OpenRouter",
  FISH_API_KEY: "Fish Audio",
};

function voiceItem(voice: VoiceStatus): Item {
  // FISH_VOICE_ID in the environment wins over persona.yaml: a voice picked here would do nothing.
  const fromEnv = voice.source === "env";
  const pick: Fix | undefined = fromEnv ? undefined : { kind: "pick-voice" };
  if (voice.id === null)
    return { id: "voice", tone: "error", text: "home.ready.voice.none", fix: pick };
  const vars = { id: voice.id };
  if (voice.ok === false) {
    const text = fromEnv ? "home.ready.voice.badEnv" : "home.ready.voice.bad";
    return { id: "voice", tone: "error", text, vars, fix: pick };
  }
  if (voice.ok === null) {
    const fix: Fix = { kind: "check", provider: "fish" };
    return { id: "voice", tone: "info", text: "home.ready.voice.unchecked", vars, fix };
  }
  const text = fromEnv ? "home.ready.voice.env" : "home.ready.voice.ok";
  return { id: "voice", tone: "ok", text, vars };
}

function memoryItem(memory: MemoryStatus): Item {
  if (!memory.configured) {
    const fix: Fix = { kind: "link", to: "/setup?step=memory", label: "home.fix.memory" };
    return { id: "memory", tone: "info", text: "home.ready.memory.off", fix };
  }
  const check: Fix = { kind: "check", provider: "qdrant" };
  if (memory.reachable === false) {
    return { id: "memory", tone: "warn", text: "home.ready.memory.down", fix: check };
  }
  if (memory.reachable === null) {
    return { id: "memory", tone: "info", text: "home.ready.memory.unchecked", fix: check };
  }
  return { id: "memory", tone: "ok", text: "home.ready.memory.on" };
}

/** One index table; a table the Python tools built has no meta, so no row count. */
function indexItem(
  id: "facts" | "streams",
  table: IndexTable | undefined,
  tab: string,
  format: Formats,
): Item {
  const link = (label: string): Fix => ({ kind: "link", to: tab, label });
  if (!table?.built) {
    return { id, tone: "info", text: `home.ready.${id}.none`, fix: link(`home.fix.${id}`) };
  }
  if (table.stale) {
    return { id, tone: "warn", text: `home.ready.${id}.stale`, fix: link("home.fix.reingest") };
  }
  if (table.rows === null) return { id, tone: "ok", text: `home.ready.${id}.built` };
  const date = table.builtAt === null ? "—" : format.date(table.builtAt);
  const vars = { rows: format.count(table.rows), date };
  return { id, tone: "ok", text: `home.ready.${id}.ok`, vars };
}

function ytDlpItem(ytDlp: Status["ytDlp"]): Item {
  switch (ytDlp.state) {
    case "installed":
      return {
        id: "ytdlp",
        tone: "ok",
        text: "home.ready.ytdlp.installed",
        vars: { tag: ytDlp.tag },
      };
    case "installs-on-first-download":
      return { id: "ytdlp", tone: "info", text: "home.ready.ytdlp.onFirstDownload" };
    case "unavailable":
      return {
        id: "ytdlp",
        tone: "warn",
        text: "home.ready.ytdlp.unavailable",
        detail: ytDlp.reason,
      };
  }
}

/** Every item, in a fixed order so the list doesn't jump between polls. */
export function readiness(status: Status, format: Formats): Item[] {
  const items: Item[] = [];
  const studio = (tab: string) => studioPath(status.persona.id, tab);
  if (status.restartRequired) {
    items.push({
      id: "restart",
      tone: "warn",
      text: "home.ready.restart",
      fix: { kind: "restart" },
    });
  } else if (status.mcpRestartRequired) {
    const fix: Fix = { kind: "restart" };
    items.push({ id: "restart", tone: "info", text: "home.ready.mcpRestart", fix });
  }
  if (status.activeCalls > 0) {
    const vars = { count: status.activeCalls };
    items.push({ id: "call", tone: "info", text: "home.ready.inCall", vars });
  }
  const missing = (Object.keys(status.keys) as RequiredKey[]).filter((key) => !status.keys[key]);
  if (missing.length > 0) {
    const names = missing.map((key) => PROVIDERS[key] ?? key).join(", ");
    const fix: Fix = { kind: "link", to: "/setup", label: "home.fix.setup" };
    items.push({
      id: "keys",
      tone: "error",
      text: "home.ready.keys.missing",
      vars: { names },
      fix,
    });
  } else {
    items.push({ id: "keys", tone: "ok", text: "home.ready.keys.ok" });
  }
  items.push(voiceItem(status.persona.voice));
  items.push(memoryItem(status.memory));
  const table = (name: IndexTable["table"]) => status.index.tables.find((t) => t.table === name);
  items.push(indexItem("facts", table("persona_facts"), studio("knowledge"), format));
  const streams = indexItem("streams", table("stream_chunks"), studio("videos"), format);
  if (streams.tone === "ok" && status.index.catalogBuiltAt === null) {
    const fix: Fix = { kind: "link", to: studio("videos"), label: "home.fix.catalog" };
    items.push({ ...streams, tone: "info", text: "home.ready.streams.noCatalog", fix });
  } else {
    items.push(streams);
  }
  if (status.selfieReferences === 0) {
    const fix: Fix = { kind: "link", to: studio("references"), label: "home.fix.references" };
    items.push({ id: "selfies", tone: "info", text: "home.ready.selfies.none", fix });
  } else {
    const vars = { count: format.count(status.selfieReferences) };
    items.push({ id: "selfies", tone: "ok", text: "home.ready.selfies.ok", vars });
  }
  items.push(ytDlpItem(status.ytDlp));
  items.push(
    status.ffmpeg
      ? { id: "ffmpeg", tone: "ok", text: "home.ready.ffmpeg.ok" }
      : { id: "ffmpeg", tone: "info", text: "home.ready.ffmpeg.missing" },
  );
  if (status.freeBytes !== null) {
    const low = status.freeBytes < LOW_DISK_BYTES;
    const vars = { free: format.bytes(status.freeBytes) };
    items.push({
      id: "disk",
      tone: low ? "warn" : "ok",
      text: low ? "home.ready.disk.low" : "home.ready.disk.ok",
      vars,
    });
  }
  if (status.lastSessionError) {
    items.push({
      id: "lastError",
      tone: "warn",
      text: "home.ready.lastError",
      vars: { when: format.date(status.lastSessionError.at) },
      detail: status.lastSessionError.message,
    });
  }
  return items;
}

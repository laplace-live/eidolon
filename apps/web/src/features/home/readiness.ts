// Home's readiness list: what calls and builds need, read from GET status, each with its fix.
import { RECOMMENDED_ROLES } from "@/features/setup/first-run";
import type { IndexTable, MemoryStatus, Status } from "@/lib/api";
import { formatCount, formatDateTime } from "@/lib/format";
import { studioPath } from "@/lib/paths";
import { providerName } from "@/lib/providers";
import type { Lang } from "@/locales/i18n";
import type { CheckId, FixCode, ReadyCode } from "./readiness-labels";

/** The values a sentence fills its `{name}` placeholders with. */
export type Values = Readonly<Record<string, string | number>>;

export type Tone = "ok" | "info" | "warn" | "error";

/** The action at the right of an item: its fix, or for a working voice, a change of it. */
export type Fix =
  | { readonly kind: "link"; readonly to: string; readonly label: FixCode }
  | { readonly kind: "pick-voice"; readonly label: FixCode }
  /** A check of her voice's account. */
  | { readonly kind: "check"; readonly account: string }
  | { readonly kind: "restart" };

export interface Item {
  /** Also picks its title. */
  readonly id: CheckId;
  readonly tone: Tone;
  /** Picks its sentence, filled with `vars`. */
  readonly text: ReadyCode;
  readonly vars?: Values;
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

function voiceItem(persona: Status["persona"], voiceKeyMissing: boolean): Item {
  const { voice } = persona;
  if (voice.provider === null) {
    return {
      id: "voice",
      tone: "info",
      text: "home.ready.voice.off",
      fix: { kind: "link", to: studioPath(persona.id, "voice"), label: "home.fix.voice" },
    };
  }
  // Only Fish's voices are looked up; another provider's voice is its own to know.
  if (voice.provider !== "fish") {
    const vars = { provider: providerName(voice.provider), id: voice.id ?? "" };
    const fix: Fix = { kind: "link", to: studioPath(persona.id, "voice"), label: "home.fix.voice" };
    if (voice.id !== null) {
      return { id: "voice", tone: "ok", text: "home.ready.voice.provider", vars, fix };
    }
    if (voice.provider === "openai-compatible" || voice.provider === "fish-speech") {
      return { id: "voice", tone: "ok", text: "home.ready.voice.providerDefault", vars, fix };
    }
    return {
      id: "voice",
      tone: voiceKeyMissing ? "info" : "error",
      text: voiceKeyMissing ? "home.ready.voice.noneTextOnly" : "home.ready.voice.providerNone",
      vars,
      fix,
    };
  }
  const inherited = voice.source === "env";
  // An inherited voice is changed in her studio, which says where it comes from; her own, in place.
  const pick = (label: FixCode): Fix =>
    inherited
      ? { kind: "link", to: studioPath(persona.id, "voice"), label }
      : { kind: "pick-voice", label };
  if (voice.id === null) {
    return {
      id: "voice",
      tone: voiceKeyMissing ? "info" : "error",
      text: voiceKeyMissing ? "home.ready.voice.noneTextOnly" : "home.ready.voice.none",
      fix: pick("home.fix.pickVoice"),
    };
  }
  const vars = { id: voice.id };
  if (voice.ok === false) {
    const text = inherited ? "home.ready.voice.badEnv" : "home.ready.voice.bad";
    return { id: "voice", tone: "error", text, vars, fix: pick("home.fix.pickVoice") };
  }
  if (voice.ok === null) {
    const text = inherited ? "home.ready.voice.uncheckedEnv" : "home.ready.voice.unchecked";
    const fix: Fix = { kind: "check", account: voice.account ?? "fish" };
    return { id: "voice", tone: "info", text, vars, fix };
  }
  const text = inherited ? "home.ready.voice.env" : "home.ready.voice.ok";
  return { id: "voice", tone: "ok", text, vars, fix: pick("home.fix.changeVoice") };
}

function memoryItem(memory: MemoryStatus): Item {
  if (!memory.configured) {
    const fix: Fix = { kind: "link", to: "/setup?step=memory", label: "home.fix.memory" };
    return { id: "memory", tone: "info", text: "home.ready.memory.off", fix };
  }
  if (!memory.ready) {
    const fix: Fix = { kind: "link", to: "/settings?tab=providers", label: "home.fix.setup" };
    return {
      id: "memory",
      tone: "warn",
      text: "home.ready.memory.notReady",
      detail: memory.problem ?? undefined,
      fix,
    };
  }
  return { id: "memory", tone: "ok", text: "home.ready.memory.on" };
}

/** One index table; a table built without its meta record has no row count. */
function indexItem(
  id: "facts" | "streams",
  table: IndexTable | undefined,
  tab: string,
  format: Formats,
): Item {
  const link = (label: FixCode): Fix => ({ kind: "link", to: tab, label });
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
  const problems = status.call.roles.filter((role) => role.problem !== null);
  if (problems.length > 0) {
    const fix: Fix = { kind: "link", to: studio("models"), label: "home.fix.models" };
    for (const role of problems) {
      items.push({
        id: `models-${role.role}` as CheckId,
        tone: "error",
        text: "home.ready.models.problem",
        detail: role.problem ?? undefined,
        fix,
      });
    }
  }
  const missing = status.keys.filter((key) => !key.set);
  const requiredMissing = missing.filter((key) =>
    key.roles.some((role) => !RECOMMENDED_ROLES.has(role)),
  );
  if (missing.length > 0) {
    const names = missing.map((key) => key.name).join(", ");
    const fix: Fix = { kind: "link", to: "/setup", label: "home.fix.setup" };
    items.push({
      id: "keys",
      tone: requiredMissing.length > 0 ? "error" : "info",
      text: requiredMissing.length > 0 ? "home.ready.keys.missing" : "home.ready.keys.callOnly",
      vars: { names },
      fix,
    });
  } else if (status.keys.length === 0) {
    items.push({ id: "keys", tone: "ok", text: "home.ready.keys.none" });
  } else {
    const names = status.keys.map((key) => key.name).join(", ");
    items.push({ id: "keys", tone: "ok", text: "home.ready.keys.ok", vars: { names } });
  }
  if (!status.call.realtime) {
    const hearing = status.call.roles.find((role) => role.role === "hearing");
    if (hearing && hearing.provider === null && hearing.problem === null) {
      items.push({
        id: "models-hearing",
        tone: "info",
        text: "home.ready.hearing.off",
        fix: { kind: "link", to: studio("models"), label: "home.fix.models" },
      });
    }
    const voiceRole = status.call.roles.find((role) => role.role === "voice");
    if (status.persona.voice.provider !== null || (voiceRole?.problem ?? null) === null) {
      const voiceKeyMissing = missing.some((key) => key.roles.includes("voice"));
      items.push(voiceItem(status.persona, voiceKeyMissing));
    }
  }
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

/** The list in a word: calls can't start, something wants a look, or all is well. */
export type Verdict = "blocked" | "attention" | "ready";

export function verdict(items: readonly Pick<Item, "tone">[]): Verdict {
  if (items.some((item) => item.tone === "error")) return "blocked";
  return items.some((item) => item.tone === "warn") ? "attention" : "ready";
}

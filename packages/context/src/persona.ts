// The per-session system instruction: a prefix of session facts (clock, viewer, recent stream
// dates, tool hints) on top of persona.md, which carries the persona itself.
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
  envStr,
  errorText,
  logger,
  PROJECT_ROOT,
  personaTimeZone,
  pyRepr,
  pyStr,
  pyStrip,
  sortedPy,
  zonedClock,
} from "@eidolon/config";
import { diffDays, isValidIsoDate, resolveDbPath, scanStreamDates } from "@eidolon/retrieval";

export const FALLBACK_PERSONA =
  "You are a helpful assistant in a voice conversation. Your responses will " +
  "be spoken aloud, so avoid emojis, bullet points, or other formatting that " +
  "can't be spoken. Always reply in the same language the user just spoke; " +
  "if they switch languages, switch with them. Respond briefly.";

export const WEEKDAY_ZH = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;

// Five dates covers the usual "你最近播了几场?" / "你这周播了吗?" questions
// without bloating the prompt; raise to 7-10 for a full weekly calendar.
export const RECENT_STREAM_DATES_N = 5;

// Coarse, since re-ingest is infrequent — but short enough that a new
// stream shows up without a restart.
export const STREAM_DATES_TTL_SEC = 600;

/** The viewer fields the persona prefix reads; access's UserContext satisfies it. */
export interface Viewer {
  readonly isLoggedIn: boolean;
  readonly uname: string | null;
  readonly mid: number | null;
}

/**
 * A day delta as a natural Chinese phrase, so the LLM can answer "上次什么时候播的?" without
 * doing date arithmetic itself; LLMs are surprisingly bad at counting days.
 */
export function humanizeDaysAgo(days: number): string {
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days === 2) return "前天";
  if (days < 7) return `${days}天前`;
  if (days < 30) return `${Math.floor(days / 7)}周前`;
  if (days < 365) return `${Math.floor(days / 30)}个月前`;
  return `${Math.floor(days / 365)}年前`;
}

export interface PersonaPrefixInput {
  readonly viewer: Viewer;
  readonly timeZone: string;
  readonly now?: Date;
  /** Newest first; entries that aren't ISO dates are skipped. */
  readonly recentStreamDates: readonly string[];
  /** Pre-rendered tool hint lines; "" when the tool isn't offered. */
  readonly voiceHint?: string;
  readonly selfieHint?: string;
}

/**
 * The preamble prepended to persona.md. The 不要主动念 lines are load-bearing: without them the
 * model occasionally narrates the current time or reads the UID aloud, which sounds robotic and
 * breaks the persona's 短简、不像 AI 助手 rule. The wording matches persona.md's 奶绿 / 奶糖花
 * vocabulary.
 */
export function buildPersonaPrefix(input: PersonaPrefixInput): string {
  const clock = zonedClock(input.timeZone, input.now);
  const time = `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
  const lines = [
    `现在是 ${clock.year}年${clock.month}月${clock.day}日 ${WEEKDAY_ZH[clock.weekday]} ${time}。` +
      "如果用户问到时间或日期，根据这里的事实回答；" +
      "不要主动念时间，除非话题相关。",
  ];
  const viewer = input.viewer;
  if (viewer.isLoggedIn && viewer.uname) {
    lines.push(
      `今天来花店的奶糖花叫「${viewer.uname}」（B站UID:${pyStr(viewer.mid)}）。` +
        "聊天里可以自然地叫她/他的名字，但不要每句都重复，也不要主动念UID。",
    );
  }

  const dates: string[] = [];
  for (const iso of input.recentStreamDates) {
    if (!isValidIsoDate(iso)) continue;
    const [year, month, day] = iso.split("-").map(Number) as [number, number, number];
    const ago = humanizeDaysAgo(diffDays(iso, clock.isoDate));
    // "5月9日", not "2026年5月9日": how a fan says it when both sides know the year.
    dates.push(
      year === clock.year
        ? `${month}月${day}日（${ago}）`
        : `${year}年${month}月${day}日（${ago}）`,
    );
  }
  if (dates.length > 0) {
    lines.push(
      `你最近几次直播：${dates.join("、")}。` +
        "如果用户问最近 / 上次 / 上一次 / 好久没播 / 这周播了吗 之类的，" +
        "根据这里的日期自然回答；不要凭空编日期。",
    );
  }

  if (input.voiceHint) lines.push(input.voiceHint);
  if (input.selfieHint) lines.push(input.selfieHint);
  return `${lines.join("\n")}\n\n`;
}

/** persona.md, read fresh each session so edits apply without a restart. */
export async function loadPersona(options: { root?: string; file?: string } = {}): Promise<string> {
  const root = options.root ?? PROJECT_ROOT;
  const file = options.file ?? envStr("PERSONA_FILE", "persona.md");
  const path = isAbsolute(file) ? file : join(root, file);
  const found = await stat(path).then(
    () => true,
    () => false,
  );
  if (found) {
    const text = pyStrip(await readFile(path, "utf8"));
    if (text) {
      const shown = relative(root, path);
      const inside = shown !== "" && !shown.startsWith("..") && !isAbsolute(shown);
      logger.info(`Loaded persona from ${inside ? shown : path}`);
      return text;
    }
  }
  logger.warning(`Persona file ${path} not found; using fallback prompt`);
  return FALLBACK_PERSONA;
}

interface DatesEntry {
  dates: string[] | null;
  at: number;
  refreshing: Promise<void> | null;
}

const datesByDb = new Map<string, DatesEntry>();

/**
 * Up to `n` most recent stream dates, newest first, cached process-wide per database.
 *
 * Injected into the system prompt because recency questions like "你最后一次直播什么时候?" ask
 * about table metadata, not about any fact inside a chunk — retrieval cannot answer them at all.
 * A failed refresh keeps the previous list and retries on the next call: a stale date list beats
 * the LLM guessing.
 */
export async function getRecentStreamDates(
  options: {
    n?: number;
    dbPath?: string;
    /** Epoch milliseconds, as Date.now. */
    now?: () => number;
    scan?: (dbPath: string) => Promise<string[] | null>;
  } = {},
): Promise<string[]> {
  const n = options.n ?? RECENT_STREAM_DATES_N;
  const dbPath = options.dbPath ?? resolveDbPath();
  const now = options.now ?? Date.now;
  const scan = options.scan ?? scanStreamDates;
  let entry = datesByDb.get(dbPath);
  if (entry === undefined) {
    entry = { dates: null, at: 0, refreshing: null };
    datesByDb.set(dbPath, entry);
  }
  // One scan at a time; whoever waited reads what it cached.
  while (entry.refreshing !== null) await entry.refreshing;
  const started = now();
  if (entry.dates !== null && started - entry.at < STREAM_DATES_TTL_SEC * 1000) {
    return entry.dates.slice(0, n);
  }
  let done = (): void => {};
  entry.refreshing = new Promise<void>((resolve) => {
    done = resolve;
  });
  try {
    const raw = await scan(dbPath);
    const dates = raw === null ? [] : sortedPy(new Set(raw.filter(Boolean))).reverse();
    entry.dates = dates;
    entry.at = started;
    return dates.slice(0, n);
  } catch (error) {
    logger.warning(
      `Could not refresh recent stream dates: ${errorText(error)}; ` +
        `returning cached=${pyRepr(entry.dates !== null)}`,
    );
    return entry.dates?.length ? entry.dates.slice(0, n) : [];
  } finally {
    entry.refreshing = null;
    done();
  }
}

/** The per-session system instruction: persona prefix + persona.md. */
export async function buildSystemInstruction(input: {
  viewer: Viewer;
  /** Pre-rendered tool hint lines; "" when the tool isn't offered. */
  voiceHint: string;
  selfieHint: string;
  /** Defaults to config's personaTimeZone(). */
  timeZone?: string;
  now?: Date;
  /** Defaults to retrieval's resolveDbPath(); used for the recent stream dates. */
  dbPath?: string;
}): Promise<string> {
  // Read before the scan, so the prompt's clock is the session's start.
  const now = input.now ?? new Date();
  const recentStreamDates = await getRecentStreamDates({ dbPath: input.dbPath });
  const prefix = buildPersonaPrefix({
    viewer: input.viewer,
    timeZone: input.timeZone ?? personaTimeZone(),
    now,
    recentStreamDates,
    voiceHint: input.voiceHint,
    selfieHint: input.selfieHint,
  });
  return prefix + (await loadPersona());
}

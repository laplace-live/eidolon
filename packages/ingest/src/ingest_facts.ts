// laplace-ingest-facts' library: the persona_facts rows, one per line of the persona's fact files,
// and the run that embeds them and rebuilds the table.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  activePersona,
  cpLen,
  cpSlice,
  envOptional,
  errorText,
  logger,
  pyLstrip,
  pyPath,
  pyPathName,
  pyRepr,
  pyStrip,
  sortedPy,
  splitlines,
} from "@eidolon/config";
import {
  type EmbeddingClient,
  EmbeddingUsage,
  type EmbedReport,
  embeddingTotalsMessage,
  embedInBatches,
  PERSONA_FACTS_TABLE,
  PyPattern,
  personaFactsSchema,
  pyInt,
  tokenizeZh,
  writeTable,
} from "@eidolon/retrieval";
import { ingestFailure, lazyDefaultClient, openEmbedCache, writeIndexMeta } from "./index_build.ts";
import { criticalSection } from "./limit.ts";
import {
  costFields,
  type EventCode,
  noProgress,
  type Provider,
  type RunOptions,
  type SUMMARY_COUNTS,
} from "./progress.ts";

/** knowledge.facts.files when unset. */
export const DEFAULT_FACT_PATTERNS: readonly string[] = ["*.txt"];

/** Facts per embedding request: they average ~30 characters, so more fit than stream chunks. */
export const FACTS_BATCH_SIZE = 96;

/**
 * knowledge.facts.files (FACTS_FILES): name patterns of the files in the facts folder. Null for
 * unset: an `undefined` argument would take the default, the active persona's value.
 */
export function factPatterns(raw: string | null = envOptional("FACTS_FILES") ?? null): string[] {
  const patterns = (raw ?? "")
    .split(",")
    .map((pattern) => pyStrip(pattern))
    .filter((pattern) => pattern !== "");
  return patterns.length > 0 ? patterns : [...DEFAULT_FACT_PATTERNS];
}

/** Python's `re.escape`. */
function reEscape(text: string): string {
  return text.replace(/[()[\]{}?*+\-|^$\\.&~# \t\n\r\v\f]/g, "\\$&");
}

/**
 * knowledge.facts.subject (FACTS_SUBJECT): a regex, in Python's syntax, for the name most facts
 * open with. The active persona's name, matched literally, when unset.
 */
export function factSubject(): string {
  return envOptional("FACTS_SUBJECT") ?? reEscape(activePersona().identity.name);
}

const STAR = "[^/]*";
const ONE = "[^/]";
// With the u flag, JS accepts an escape only before these.
const SYNTAX_CHARS = new Set("^$\\.*+?()[]{}|/");

function literalChar(c: string): string {
  return SYNTAX_CHARS.has(c) ? `\\${c}` : c;
}

/** A character-class body as fnmatch writes it for Python's `re`, rewritten for JS's u flag. */
function jsClassBody(body: string): string {
  const chars = [...body];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string;
    if (c === "\\") {
      const next = chars[++i] as string;
      out += next === "&" || next === "~" ? next : `\\${next}`;
    } else {
      out += c === "]" || c === "[" ? `\\${c}` : c;
    }
  }
  return out;
}

const firstCp = (s: string): number => s.codePointAt(0) as number;
const lastCp = (s: string): number => [...s].at(-1)?.codePointAt(0) as number;
const dropLast = (s: string): string => [...s].slice(0, -1).join("");
const dropFirst = (s: string): string => [...s].slice(1).join("");

// What fnmatch escapes in a bracket expression: backslashes, the set operations (&&, ~~, ||), and
// within a range's chunks, hyphens.
function escapeClassChars(text: string): string {
  return text.replace(/[\\&~|-]/g, "\\$&");
}

/**
 * fnmatch's bracket expression `pat[i:j]` (between `[` and `]`), escaped, as Python's `re` reads
 * it.
 */
function pythonClass(pat: readonly string[], start: number, j: number): string {
  let i = start;
  const stuff = pat.slice(i, j).join("");
  if (!stuff.includes("-")) return escapeClassChars(stuff);
  const chunks: string[] = [];
  let k = pat[i] === "!" ? i + 2 : i + 1;
  for (;;) {
    k = pat.indexOf("-", k);
    if (k < 0 || k >= j) break;
    chunks.push(pat.slice(i, k).join(""));
    i = k + 1;
    k += 3;
  }
  const chunk = pat.slice(i, j).join("");
  if (chunk) chunks.push(chunk);
  else chunks[chunks.length - 1] += "-";
  // A range whose ends are out of order is dropped, as fnmatch does.
  for (let n = chunks.length - 1; n > 0; n--) {
    const before = chunks[n - 1] as string;
    const after = chunks[n] as string;
    if (lastCp(before) > firstCp(after)) {
      chunks[n - 1] = dropLast(before) + dropFirst(after);
      chunks.splice(n, 1);
    }
  }
  return chunks.map(escapeClassChars).join("-");
}

/** `fnmatch._translate` of one pattern, for JS. */
function translatePattern(pattern: string): string {
  const pat = [...pattern];
  const n = pat.length;
  let out = "";
  let afterStar = false;
  let i = 0;
  while (i < n) {
    const c = pat[i++] as string;
    if (c === "*") {
      if (!afterStar) out += STAR;
      afterStar = true;
      continue;
    }
    afterStar = false;
    if (c === "?") {
      out += ONE;
    } else if (c === "[") {
      let j = i;
      if (j < n && pat[j] === "!") j++;
      if (j < n && pat[j] === "]") j++;
      while (j < n && pat[j] !== "]") j++;
      if (j >= n) {
        out += "\\[";
        continue;
      }
      let stuff = pythonClass(pat, i, j);
      i = j + 1;
      if (!stuff) {
        out += "(?!)";
      } else if (stuff === "!") {
        out += "[\\s\\S]";
      } else {
        if (stuff[0] === "!") stuff = `^${stuff.slice(1)}`;
        else if (stuff[0] === "^" || stuff[0] === "[") stuff = `\\${stuff}`;
        out += `[${jsClassBody(stuff)}]`;
      }
    } else {
      out += literalChar(c);
    }
  }
  return out;
}

/**
 * What pathlib's glob makes of `pattern` as one path component: `*`, `?` and `[...]` as fnmatch
 * reads them, a leading dot matched like any character, and case always significant.
 */
export function namePattern(pattern: string): RegExp {
  return new RegExp(`^(?:${translatePattern(pattern)})$`, "u");
}

/**
 * The fact files in `dir`: for each pattern in order, the folder's entries whose name matches it,
 * by code point, with a file a pattern before already took left out. A missing folder holds none.
 */
export function resolveFactFiles(
  dir: string,
  patterns: readonly string[] = factPatterns(),
): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const regex = namePattern(pattern);
    for (const name of sortedPy(names.filter((name) => regex.test(name)))) {
      const path = join(dir, name);
      if (seen.has(path)) continue;
      seen.add(path);
      files.push(path);
    }
  }
  return files;
}

// 贴吧 floor markers are the curator's scrape-resume notes: the number must never reach the text,
// the embedding or the tokens, where it is high-cardinality noise.
const FLOOR = new PyPattern(String.raw`^\s*第(\d+)楼\s*[:：]\s*`);
const BV = new PyPattern(String.raw`^\s*BV[0-9A-Za-z]+\s*[/、,，]\s*`);
// The trailing 日 keeps "2022年圣诞节" out; the lookahead keeps an ISO time from eating a following
// number.
const DATE = new PyPattern(
  String.raw`^\s*(?:(\d{4})年(\d{1,2})月(\d{1,2})日|(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?(?=\D|$))\s*[/、,，]?\s*`,
);

const matchEnd = (match: RegExpExecArray): number => match.index + match[0].length;

/**
 * A fact line's ISO date ("" when undated), its 贴吧 floor (0 when none) and its text, with the
 * floor marker, a leading BV id and the date taken off, in that order.
 */
export function parseFactLine(raw: string): [date: string, floor: number, text: string] {
  let line = pyStrip(raw);
  if (!line) return ["", 0, ""];
  let floor = 0;
  const marker = FLOOR.match(line);
  if (marker) {
    floor = pyInt(marker[1] as string);
    line = pyLstrip(line.slice(matchEnd(marker)));
  }
  line = BV.sub("", line, { count: 1 });
  const date = DATE.match(line);
  if (!date) return ["", floor, line];
  const [year, month, day] = (date[1] !== undefined ? date.slice(1, 4) : date.slice(4, 7)).map(
    (digits) => pyInt(digits as string),
  ) as [number, number, number];
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return [iso, floor, pyLstrip(line.slice(matchEnd(date)))];
}

// Longer alternates come first ("声称是" before "声称"), and negations and auxiliaries (不, 没, 是,
// 在, 有, 会) stay out, so "…不喜欢XX" keeps its negation.
const VERBS =
  "声称是|声称|声明|强调|认为|觉得|说过|说|解释|讨论|吐槽|抱怨|提到|表示|回应|喜欢|讨厌|希望|担心|模仿|询问|评价|介绍|分享|多次";

/**
 * The prefix `stripFactPrefix` removes: `subject`, an optional reporting verb, and punctuation.
 * About 95% of 奶绿's facts open "明前奶绿声称…", and that shared prefix pulled every vector into
 * one cluster; leaving it out of the embedding lifted vector-only MRR from 0.833 to 0.925.
 */
export function factPrefixPattern(subject: string): PyPattern {
  try {
    return new PyPattern(`^(?:${subject})(?:${VERBS})?[，。、,.;；:：\\s]*`);
  } catch (error) {
    throw new Error(
      `knowledge.facts.subject (FACTS_SUBJECT) ${pyRepr(subject)} is not a valid regex: ${errorText(error)}`,
    );
  }
}

/** The fact without `prefix`; a fact that is all prefix stays whole. */
export function stripFactPrefix(text: string, prefix: PyPattern): string {
  return prefix.sub("", text, { count: 1 }) || text;
}

/** A persona_facts row, with the text its vector embeds, which the table doesn't store. */
export interface FactRow {
  readonly id: string;
  readonly source: string;
  readonly date: string;
  readonly floor: number;
  readonly text: string;
  readonly tokens: string;
  readonly embed_input: string;
}

/** A fact file as it was read. */
export interface FactSource {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly mtime: string;
  readonly kept: number;
  readonly duplicates: number;
}

export interface LoadedFacts {
  readonly rows: FactRow[];
  /** The files read, in order; a missing one is left out. */
  readonly sources: FactSource[];
}

export interface LoadFactsOptions extends RunOptions {
  readonly minChars?: number;
  /** False keeps the subject prefix in `embed_input`, for an A/B index. */
  readonly stripPrefix?: boolean;
  /** The subject regex; the persona's knowledge.facts.subject when omitted. */
  readonly subject?: string;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `read_text(encoding="utf-8")`: strict, and a byte-order mark stays in the text. */
function readUtf8(path: string): string {
  const bytes = readFileSync(path);
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new Error(`${pyPath(path)} is not valid UTF-8`);
  }
}

/**
 * One row per line of `files`, in order. A line repeated anywhere keeps its first occurrence,
 * which keeps the earliest date of a fact that changed; a line shorter than `minChars` once
 * cleaned is dropped.
 */
export function loadFacts(files: readonly string[], options: LoadFactsOptions = {}): LoadedFacts {
  const { minChars = 4, stripPrefix = true, signal } = options;
  const emit = options.onProgress ?? noProgress;
  const prefix = stripPrefix ? factPrefixPattern(options.subject ?? factSubject()) : null;
  const rows: FactRow[] = [];
  const sources: FactSource[] = [];
  const seen = new Set<string>();
  let lines = 0;
  let short = 0;
  for (const [i, path] of files.entries()) {
    signal?.throwIfAborted();
    const name = pyPathName(path);
    const position = { index: i + 1, total: files.length };
    if (!existsSync(path)) {
      logger.warning(`Fact file not found, skipping: ${pyPath(path)}`);
      emit({
        type: "item",
        stage: "ingest-facts",
        item: name,
        status: "skipped",
        message: "not found",
        ...position,
      });
      continue;
    }
    // Before the read: a file edited meanwhile then looks changed since this ingest, never the
    // reverse.
    const stat = statSync(path);
    const text = readUtf8(path);
    let kept = 0;
    let duplicates = 0;
    for (const raw of splitlines(text)) {
      lines++;
      const [date, floor, cleaned] = parseFactLine(raw);
      if (!cleaned || cpLen(cleaned) < minChars) {
        if (cleaned) short++;
        continue;
      }
      if (seen.has(cleaned)) {
        duplicates++;
        continue;
      }
      seen.add(cleaned);
      const body = prefix ? stripFactPrefix(cleaned, prefix) : cleaned;
      rows.push({
        id: createHash("sha1").update(cleaned, "utf8").digest("hex").slice(0, 16),
        source: name,
        date,
        floor,
        text: cleaned,
        // The display text, so BM25 still finds the persona's name the embedding leaves out.
        tokens: tokenizeZh(cleaned),
        // The date leads, so a query naming it matches semantically; the column does filtering.
        embed_input: date ? `${date}：${body}` : body,
      });
      kept++;
    }
    logger.info(`Loaded ${name}: ${kept} facts kept, ${duplicates} duplicates skipped`);
    sources.push({
      path,
      name,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      kept,
      duplicates,
    });
    emit({
      type: "item",
      stage: "ingest-facts",
      item: name,
      status: "done",
      message: `${kept} facts kept, ${duplicates} duplicates skipped`,
      ...position,
    });
  }
  if (short > 0) logger.info(`Filtered out ${short} lines shorter than ${minChars} chars`);
  logger.info(
    `Total: ${rows.length} unique facts from ${lines} raw lines across ${files.length} file(s)`,
  );
  return { rows, sources };
}

/** What `index/<table>.meta.json` records of the build that wrote the table. */
export interface FactsIndexMeta {
  readonly embedModel: string;
  readonly embedDim: number;
  readonly rows: number;
  readonly builtAt: string;
  /** Each file read, in order, as it was when read. */
  readonly sources: readonly {
    readonly name: string;
    readonly size: number;
    readonly mtime: string;
  }[];
  /** knowledge.facts.files, or null when the files were named explicitly. */
  readonly patterns: readonly string[] | null;
}

export interface IngestFactsOptions extends RunOptions {
  /** Where the fact files are found (`--data-dir`). */
  readonly factsDir: string;
  /** The persona's knowledge.facts.files when omitted. */
  readonly patterns?: readonly string[];
  /** Files to read instead of the folder's matches, in order; repeats are read again. */
  readonly files?: readonly string[] | null;
  readonly dbPath: string;
  readonly table?: string;
  readonly minChars?: number;
  readonly stripPrefix?: boolean;
  readonly subject?: string;
  /** Parse and report only: no cache, no embedding, no write. */
  readonly dryRun?: boolean;
  /** The embedding cache file; null embeds every fact afresh. */
  readonly cachePath?: string | null;
  /** Empties the cache first, every persona's and model's vectors included. */
  readonly clearCache?: boolean;
  /** EMBED_MODEL and EMBED_DIM when omitted. */
  readonly model?: string;
  readonly dim?: number;
  /** The env-configured client, built at the first cache miss, when omitted. */
  readonly client?: Pick<EmbeddingClient, "embedWithUsage">;
  readonly now?: () => Date;
}

export interface IngestFactsReport {
  readonly ok: boolean;
  readonly cancelled: boolean;
  readonly sources: readonly FactSource[];
  readonly rows: number;
  readonly cacheHits: number;
  readonly embedded: number;
  readonly usage: EmbeddingUsage;
  /** Whether the table was replaced. */
  readonly written: boolean;
  readonly error: string | null;
  readonly code: EventCode | null;
}

function sampleLines(rows: readonly FactRow[]): string[] {
  return rows
    .slice(0, 5)
    .flatMap((row) => [
      `  - ${row.id} [${row.date || "undated"}, ${row.floor ? `第${row.floor}楼` : "no-floor"}, ${row.source}]`,
      `      text:        ${cpSlice(row.text, 0, 80)}`,
      `      embed_input: ${cpSlice(row.embed_input, 0, 80)}`,
      `      tokens:      ${cpSlice(row.tokens, 0, 80)}`,
    ]);
}

/** What the summary counts. */
export type FactsCounts = Record<(typeof SUMMARY_COUNTS)["ingest-facts"][number], number>;

/**
 * laplace-ingest-facts after argument parsing: reads the fact files, embeds what the cache lacks
 * and replaces the table, then records the build in `<table>.meta.json` beside it. The old table
 * stays until every vector is in hand. Never throws: a failure, or `signal` aborting before the
 * old table is dropped, ends in a report with `ok` false and a summary event.
 */
export async function ingestFactFiles(options: IngestFactsOptions): Promise<IngestFactsReport> {
  const emit = options.onProgress ?? noProgress;
  const { signal, dbPath } = options;
  const table = options.table ?? PERSONA_FACTS_TABLE;
  const started = performance.now();
  let sources: readonly FactSource[] = [];
  let rows: readonly FactRow[] = [];
  let report: EmbedReport | null = null;
  let written = false;

  const finish = (
    status: "done" | "skipped" | "failed" | "cancelled",
    detail: { message?: string; code?: EventCode; provider?: Provider } = {},
  ): IngestFactsReport => {
    const ok = status === "done" || status === "skipped";
    emit({ type: "stage", stage: "ingest-facts", status, ...detail });
    const error = status === "failed" ? (detail.message ?? "failed") : null;
    const counts: FactsCounts = {
      files: sources.length,
      rows: rows.length,
      cacheHits: report?.cacheHits ?? 0,
      embedded: report?.embedded ?? 0,
    };
    emit({
      type: "summary",
      stage: "ingest-facts",
      ok,
      ...(status === "cancelled" ? { cancelled: true } : {}),
      counts,
      durationSec: (performance.now() - started) / 1000,
      // Nothing before the embedding finished, then what it reported.
      ...(report === null ? {} : costFields(report.usage, report.embedded > 0)),
      ...(error === null ? {} : { failures: [{ item: table, error }] }),
    });
    return {
      ok,
      cancelled: status === "cancelled",
      sources,
      rows: counts.rows,
      cacheHits: counts.cacheHits,
      embedded: counts.embedded,
      usage: report?.usage ?? new EmbeddingUsage(),
      written,
      error,
      code: detail.code ?? null,
    };
  };

  try {
    signal?.throwIfAborted();
    const patterns = options.patterns ?? factPatterns();
    const explicit = options.files && options.files.length > 0 ? options.files : null;
    const files = explicit ?? resolveFactFiles(options.factsDir, patterns);
    if (files.length === 0) {
      const message =
        `No fact files found. Looked under ${pyPath(options.factsDir)} for ` +
        `${pyRepr([...patterns])}. Pass --files to specify explicitly.`;
      logger.warning(message);
      return finish("skipped", { message });
    }
    emit({ type: "stage", stage: "ingest-facts", status: "start", total: files.length });
    logger.info(`Ingesting from: ${pyRepr(files.map(pyPathName))}`);
    const loaded = loadFacts(files, {
      minChars: options.minChars,
      stripPrefix: options.stripPrefix,
      subject: options.subject,
      onProgress: emit,
      signal,
    });
    sources = loaded.sources;
    rows = loaded.rows;
    if (rows.length === 0) {
      const message = "No facts to ingest. Files were empty or filtered out.";
      logger.warning(message);
      return finish("skipped", { message });
    }
    if (options.dryRun) {
      logger.info(`Dry run: ${rows.length} facts would be embedded and written.`);
      // text beside embed_input is the quickest way to spot a prefix-strip regression.
      for (const line of sampleLines(rows)) logger.info(line);
      return finish("done");
    }

    mkdirSync(dbPath, { recursive: true });
    const cachePath = options.cachePath ?? null;
    const cache =
      cachePath === null ? null : openEmbedCache(cachePath, options.clearCache === true);
    try {
      report = await embedInBatches(
        rows.map((row) => row.embed_input),
        {
          batchSize: FACTS_BATCH_SIZE,
          noun: "facts",
          cache,
          client: options.client ?? lazyDefaultClient,
          model: options.model,
          dim: options.dim,
          onProgress: ({ done, total }) =>
            emit({ type: "progress", stage: "ingest-facts", done, total, unit: "rows" }),
          signal,
        },
      );
    } finally {
      cache?.close();
    }
    const built = report;
    // From the drop to the index and its build record, which a forced exit would leave half done.
    await criticalSection(async () => {
      await writeTable(dbPath, table, rows, personaFactsSchema(built.dim), built.vectors, {
        signal,
      });
      written = true;
      logger.info(embeddingTotalsMessage(rows.length, "facts", built.usage));
      const meta: FactsIndexMeta = {
        embedModel: built.model,
        embedDim: built.dim,
        rows: rows.length,
        builtAt: (options.now ?? (() => new Date()))().toISOString(),
        sources: sources.map(({ name, size, mtime }) => ({ name, size, mtime })),
        patterns: explicit ? null : [...patterns],
      };
      writeIndexMeta(dbPath, table, meta);
    });
    return finish("done");
  } catch (error) {
    if (signal?.aborted && !written) return finish("cancelled", { code: "cancelled" });
    return finish("failed", ingestFailure(error, "Fact ingest"));
  }
}

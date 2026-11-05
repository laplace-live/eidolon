// A persona's glossary.toml becomes Soniox's StructuredContext: the vocabulary that biases the
// model toward her names and slang. One per project, never per stream: one stream spans chat,
// games and karaoke, so a stream-level topic would mislead.
import { existsSync, readFileSync } from "node:fs";
import {
  cpLen,
  errorText,
  isPlainObject,
  logger,
  pyJsonDumps,
  pyRepr,
  pyTruthy,
  sortedPy,
} from "@eidolon/config";
import { TranscribeError } from "./errors.ts";

/** The glossary as written, in TOML order: what is persisted, so old transcripts stay explainable. */
export type SonioxContext = Readonly<Record<string, unknown>>;

const ALLOWED_KEYS = ["general", "terms", "text", "translation_terms"];
// Soniox caps context at ~8000 tokens; ~10k chars is a deliberately conservative stand-in, since
// CJK runs ~1 token/char against English's ~4 chars/token and this content mixes both.
export const CONTEXT_MAX_CHARS = 10_000;

const TRAP_HINT =
  "Each [[general]] entry must contain ONLY `key` and `value`. " +
  'Hint: top-level scalars like `text = "..."` and `terms = [...]` MUST appear ABOVE all ' +
  "[[general]] / [[translation_terms]] blocks in the TOML — otherwise TOML silently nests them " +
  "into the last array entry.";

function extraKeys(item: Readonly<Record<string, unknown>>, allowed: readonly string[]): string[] {
  return sortedPy(Object.keys(item).filter((key) => !allowed.includes(key)));
}

/** What StructuredContext accepts; Python's SDK rejects anything else before the upload. */
function checkShape(path: string, ctx: SonioxContext): void {
  const fail = (what: string): Error =>
    new TranscribeError(`${path}: ${what}, as Soniox's StructuredContext requires.`);
  for (const [key, fields] of [
    ["general", ["key", "value"]],
    ["translation_terms", ["source", "target"]],
  ] as const) {
    const items = ctx[key];
    if (items === undefined) continue;
    if (!Array.isArray(items)) throw fail(`\`${key}\` must be an array of [[${key}]] tables`);
    items.forEach((item: unknown, i) => {
      for (const name of fields) {
        if (!isPlainObject(item) || typeof item[name] !== "string") {
          throw fail(`${key}[${i}].${name} must be a string`);
        }
      }
    });
  }
  if (ctx.text !== undefined && typeof ctx.text !== "string") throw fail("`text` must be a string");
  const terms = ctx.terms;
  if (terms !== undefined && (!Array.isArray(terms) || terms.some((t) => typeof t !== "string"))) {
    throw fail("`terms` must be an array of strings");
  }
}

/**
 * `_load_soniox_context_dict`: the glossary at `path` as Soniox's StructuredContext, in TOML order,
 * or null when context is off, the file is missing, or nothing in it has a value. Throws a
 * TranscribeError for a glossary Soniox would reject, before anything is uploaded.
 */
export function loadContext(path: string | null, skip = false): SonioxContext | null {
  if (skip || path === null) return null;
  if (!existsSync(path)) {
    logger.info(
      `No Soniox context file at ${path} — running without glossary. ` +
        "Create one to bias the model toward your vocabulary.",
    );
    return null;
  }
  let raw: Record<string, unknown>;
  try {
    raw = { ...(Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>) };
  } catch (error) {
    throw new TranscribeError(`${path}: invalid TOML: ${errorText(error)}`);
  }

  const unknown = Object.keys(raw).filter((key) => !ALLOWED_KEYS.includes(key));
  if (unknown.length > 0) {
    logger.warning(
      `Ignoring unknown keys in ${path}: ${pyRepr(sortedPy(unknown))}. ` +
        `Allowed: ${pyRepr(ALLOWED_KEYS)}.`,
    );
    for (const key of unknown) delete raw[key];
  }

  // TOML silently nests a top-level `text = …` or `terms = […]` written after a [[general]] block
  // into its last entry; catch it loudly, or the run goes out with phantom context.
  for (const [key, allowed, hint] of [
    ["general", ["key", "value"], TRAP_HINT],
    [
      "translation_terms",
      ["source", "target"],
      "Each entry must contain ONLY `source` and `target`. (Same TOML-ordering pitfall as above.)",
    ],
  ] as const) {
    const items = raw[key];
    if (!Array.isArray(items)) continue;
    items.forEach((item, i) => {
      if (!isPlainObject(item)) return;
      const extras = extraKeys(item, allowed);
      if (extras.length > 0) {
        throw new TranscribeError(
          `${path}: ${key}[${i}] has unexpected keys ${pyRepr(extras)}. ${hint}`,
        );
      }
    });
  }

  const ctx = Object.fromEntries(Object.entries(raw).filter(([, value]) => pyTruthy(value)));
  if (Object.keys(ctx).length === 0) return null;
  checkShape(path, ctx);

  const chars = cpLen(pyJsonDumps(ctx, { ensureAscii: false }));
  if (chars > CONTEXT_MAX_CHARS) {
    throw new TranscribeError(
      `Soniox context from ${path} is ${chars} chars (~${Math.floor(chars / 4)} tokens), which ` +
        `exceeds the ~8000-token / ~${CONTEXT_MAX_CHARS}-char limit. Trim or split the file.`,
    );
  }
  if (chars > CONTEXT_MAX_CHARS * 0.8) {
    logger.warning(
      `Soniox context is ${chars} chars — within 20% of the ~${CONTEXT_MAX_CHARS}-char limit. ` +
        "Consider trimming.",
    );
  }
  return ctx;
}

/** `_summarize_soniox_context`: `6 general, 191 chars text, 122 terms`. */
export function summarizeContext(ctx: SonioxContext): string {
  const parts: string[] = [];
  const count = (value: unknown): number =>
    typeof value === "string" ? cpLen(value) : Array.isArray(value) ? value.length : 0;
  if ("general" in ctx) parts.push(`${count(ctx.general)} general`);
  if ("text" in ctx) parts.push(`${count(ctx.text)} chars text`);
  if ("terms" in ctx) parts.push(`${count(ctx.terms)} terms`);
  if ("translation_terms" in ctx) parts.push(`${count(ctx.translation_terms)} translation_terms`);
  return parts.length > 0 ? parts.join(", ") : "(empty)";
}

function pairsOf(items: unknown, a: string, b: string): Record<string, unknown>[] {
  return (items as Record<string, unknown>[]).map((item) => ({ [a]: item[a], [b]: item[b] }));
}

/** The context as the SDK sends it: StructuredContext's field order, each item's too. */
export function apiContext(ctx: SonioxContext): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (ctx.general !== undefined) body.general = pairsOf(ctx.general, "key", "value");
  if (ctx.text !== undefined) body.text = ctx.text;
  if (ctx.terms !== undefined) body.terms = ctx.terms;
  if (ctx.translation_terms !== undefined) {
    body.translation_terms = pairsOf(ctx.translation_terms, "source", "target");
  }
  return body;
}

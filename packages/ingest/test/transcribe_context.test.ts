// fixtures/transcribe/render.golden.json holds what tools/transcribe.py's glossary loader made of
// each fixtures/transcribe/glossary/*.toml, and the create bodies the soniox SDK built.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  consoleSink,
  cpLen,
  type LogRecord,
  logger,
  PROJECT_ROOT,
  pyJsonDumps,
} from "@eidolon/config";
import { transcribe } from "../src/index.ts";

const { apiContext, loadContext, summarizeContext, TranscribeError } = transcribe;

const GLOSSARIES = join(import.meta.dir, "fixtures/transcribe/glossary");

interface ContextCase {
  name: string;
  error_type?: string;
  error?: string | null;
  context?: Record<string, unknown> | null;
  serialized?: string | null;
  summary?: string | null;
  sdk_accepts?: boolean;
}

const golden = (await Bun.file(
  join(import.meta.dir, "fixtures/transcribe/render.golden.json"),
).json()) as {
  contexts: ContextCase[];
  create_bodies: Record<string, string>;
  real_glossary: { chars: number; sha256: string; summary: string; create_body_sha256: string };
};

let logs: [string, string][] = [];
beforeEach(() => {
  logs = [];
  logger.setSink((record: LogRecord) => {
    logs.push([record.level, record.message]);
  });
});
afterEach(() => {
  logger.setSink(consoleSink);
});

function createBody(ctx: transcribe.SonioxContext | null, language: string | null): string {
  const body: Record<string, unknown> = { model: "stt-async-v5", file_id: "file-1" };
  if (language) body.language_hints = [language];
  if (ctx) body.context = apiContext(ctx);
  body.client_reference_id = "laplace-eidolon:BV1aaaaaaaaa.m4a";
  return pyJsonDumps(body, { ensureAscii: false });
}

test("each glossary loads to Python's context, or fails before the upload as Python does", () => {
  for (const c of golden.contexts) {
    const path = join(GLOSSARIES, `${c.name}.toml`);
    if (c.error_type !== undefined || c.sdk_accepts === false) {
      // A TOMLDecodeError, an AttributeError or the SDK's ValidationError was a traceback.
      const thrown = (() => {
        try {
          loadContext(path);
        } catch (error) {
          return error;
        }
        return null;
      })();
      expect([c.name, thrown]).toEqual([c.name, expect.any(TranscribeError)]);
      if (c.error) expect((thrown as Error).message).toBe(c.error.replace("<PATH>", path));
      continue;
    }
    const ctx = loadContext(path);
    expect([c.name, ctx === null ? null : pyJsonDumps(ctx, { ensureAscii: false })]).toEqual([
      c.name,
      c.serialized ?? null,
    ]);
    expect([c.name, ctx === null ? null : summarizeContext(ctx)]).toEqual([
      c.name,
      c.summary ?? null,
    ]);
  }
});

test("unknown keys are dropped with Python's warning; a context near the limit warns", () => {
  loadContext(join(GLOSSARIES, "unknown.toml"));
  expect(logs).toEqual([
    [
      "WARNING",
      `Ignoring unknown keys in ${join(GLOSSARIES, "unknown.toml")}: ['alpha', 'zeta']. ` +
        "Allowed: ['general', 'terms', 'text', 'translation_terms'].",
    ],
  ]);
  logs = [];
  loadContext(join(GLOSSARIES, "near_limit.toml"));
  expect(logs).toEqual([
    [
      "WARNING",
      "Soniox context is 8512 chars — within 20% of the ~10000-char limit. Consider trimming.",
    ],
  ]);
});

test("context off, or no glossary file, means none", () => {
  expect(loadContext(null)).toBeNull();
  expect(loadContext(join(GLOSSARIES, "full.toml"), true)).toBeNull();
  const missing = join(GLOSSARIES, "missing.toml");
  expect(loadContext(missing)).toBeNull();
  expect(logs).toEqual([
    [
      "INFO",
      `No Soniox context file at ${missing} — running without glossary. Create one to bias the ` +
        "model toward your vocabulary.",
    ],
  ]);
});

test("the create body sends the context in StructuredContext's order, as the SDK built it", () => {
  const full = loadContext(join(GLOSSARIES, "full.toml"));
  expect(createBody(full, "zh")).toBe(golden.create_bodies.context_zh as string);
  expect(createBody(null, null)).toBe(golden.create_bodies.no_context_no_language as string);
});

test("milky-green's glossary serializes as Python's: same size, same bytes, same body", () => {
  const ctx = loadContext(join(PROJECT_ROOT, "personas/milky-green/glossary.toml"));
  expect(ctx).not.toBeNull();
  const serialized = pyJsonDumps(ctx, { ensureAscii: false });
  const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  expect({
    chars: cpLen(serialized),
    sha256: sha256(serialized),
    summary: summarizeContext(ctx as transcribe.SonioxContext),
    create_body_sha256: sha256(createBody(ctx, "zh")),
  }).toEqual(golden.real_glossary);
});

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cliEntry,
  consoleSink,
  dataHome,
  envFlag,
  envFloat,
  envInt,
  envOptional,
  envRaw,
  envStr,
  extractCostUsd,
  findDotenv,
  jiebaDir,
  type LogRecord,
  loadDotenv,
  logger,
  logToStderr,
  openrouterHeaders,
  PROJECT_ROOT,
  parseDotenv,
  personaIds,
  personaTemplateDir,
  personaTimeZone,
  pyIsoformatUtc,
  resamplerDir,
  resolveProjectPath,
  serverEntry,
  sourceFolder,
  sourcesDir,
  templatesDir,
  voiceModelsDir,
  webDist,
  zonedClock,
} from "../src/index.ts";

const touched = new Set<string>();
function setEnv(name: string, value: string | undefined): void {
  touched.add(name);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
afterEach(() => {
  for (const name of touched) delete process.env[name];
  touched.clear();
});

describe("env readers", () => {
  test("empty counts as unset", () => {
    setEnv("EIDOLON_TEST_X", "");
    expect(envOptional("EIDOLON_TEST_X")).toBeUndefined();
    expect(envStr("EIDOLON_TEST_X", "fallback")).toBe("fallback");
    expect(envInt("EIDOLON_TEST_X", 60)).toBe(60);
    expect(envFloat("EIDOLON_TEST_X", 0.5)).toBe(0.5);
  });

  test("ints follow Python int()", () => {
    setEnv("EIDOLON_TEST_X", " 42 ");
    expect(envInt("EIDOLON_TEST_X", 0)).toBe(42);
    setEnv("EIDOLON_TEST_X", "+1_000");
    expect(envInt("EIDOLON_TEST_X", 0)).toBe(1000);
    setEnv("EIDOLON_TEST_X", "1.5");
    expect(envInt("EIDOLON_TEST_X", 7)).toBe(7);
    setEnv("EIDOLON_TEST_X", "abc");
    expect(envInt("EIDOLON_TEST_X", 7)).toBe(7);
    setEnv("EIDOLON_TEST_X", "\uff11\uff10");
    expect(envInt("EIDOLON_TEST_X", 5)).toBe(10);
  });

  test("an unparseable number warns with the value's Python repr", () => {
    const records: LogRecord[] = [];
    const remove = logger.addSink((record) => records.push(record));
    try {
      setEnv("EIDOLON_TEST_X", "90.5");
      expect(envInt("EIDOLON_TEST_X", 120)).toBe(120);
      expect(records.at(-1)?.message).toBe(
        "EIDOLON_TEST_X='90.5' is not a valid int; using default 120",
      );
    } finally {
      remove();
    }
  });

  test("floats follow Python float()", () => {
    setEnv("EIDOLON_TEST_X", "1e3");
    expect(envFloat("EIDOLON_TEST_X", 0)).toBe(1000);
    setEnv("EIDOLON_TEST_X", ".25");
    expect(envFloat("EIDOLON_TEST_X", 0)).toBe(0.25);
    setEnv("EIDOLON_TEST_X", "-inf");
    expect(envFloat("EIDOLON_TEST_X", 0)).toBe(-Infinity);
    setEnv("EIDOLON_TEST_X", "1.2.3");
    expect(envFloat("EIDOLON_TEST_X", 9)).toBe(9);
  });
});

describe("dotenv", () => {
  test("parses python-dotenv syntax", () => {
    const text = [
      "# comment",
      "export A=1",
      "B = two words # trailing comment",
      "C='single $X \\' quote'",
      'D="line\\nbreak"',
      'E="multi',
      'line"',
      "F=",
      "G=#not-a-comment",
      "NOEQUALS",
    ].join("\n");
    expect(parseDotenv(text).map((e) => [e.key, e.value])).toEqual([
      ["A", "1"],
      ["B", "two words"],
      ["C", "single $X ' quote"],
      ["D", "line\nbreak"],
      ["E", "multi\nline"],
      ["F", ""],
      ["G", "#not-a-comment"],
    ]);
  });

  test("matches python-dotenv on quotes, escapes and trailing text", () => {
    // Expected values printed by python-dotenv 1.2.3's dotenv_values(interpolate=True).
    const dir = mkdtempSync(join(tmpdir(), "dotenv-"));
    const path = join(dir, ".env");
    const keys = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"].map(
      (k) => `EIDOLON_DT_${k}`,
    );
    for (const key of keys) setEnv(key, undefined);
    setEnv("EIDOLON_DT_BASE", "base");
    writeFileSync(
      path,
      [
        "EIDOLON_DT_A=ck-123",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: dotenv interpolation syntax under test
        "EIDOLON_DT_B='${EIDOLON_DT_A}'",
        'EIDOLON_DT_C="tok\\x41b\\u0041\\0"',
        'EIDOLON_DT_D="laplace" agent',
        'EIDOLON_DT_E="ok"  # comment',
        'EIDOLON_DT_F="ok"# tight comment',
        "'EIDOLON_DT_G'=quoted key",
        'EIDOLON_DT_H="a\\tb\\nc\\\\d\\"e\\\'f"',
        "EIDOLON_DT_I='x\\'y\\\\z'",
        'EIDOLON_DT_J="multi',
        'line"',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: dotenv interpolation syntax under test
        "EIDOLON_DT_K=${EIDOLON_DT_BASE}-${MISSING_DT:-dflt}",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: dotenv interpolation syntax under test
        'EIDOLON_DT_L="${EIDOLON_DT_A}"',
      ].join("\n"),
    );
    loadDotenv(path, { override: true });
    expect(Object.fromEntries(keys.map((key) => [key.slice(11), process.env[key]]))).toEqual({
      A: "ck-123",
      B: "ck-123",
      C: "tok\\x41b\\u0041\\0",
      D: undefined,
      E: "ok",
      F: "ok",
      G: "quoted key",
      H: "a\tb\nc\\d\"e'f",
      I: "x'y\\z",
      J: "multi\nline",
      K: "base-dflt",
      L: "ck-123",
    });
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: names the dotenv syntax under test
  test("override wins over the inherited environment and interpolates ${VAR}", () => {
    const dir = mkdtempSync(join(tmpdir(), "eidolon-dotenv-"));
    const path = join(dir, ".env");
    writeFileSync(
      path,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: dotenv interpolation syntax under test
      "EIDOLON_TEST_A=file\nEIDOLON_TEST_B=${EIDOLON_TEST_A}-x\nEIDOLON_TEST_C=${MISSING:-dflt}\n",
    );
    setEnv("EIDOLON_TEST_A", "inherited");
    setEnv("EIDOLON_TEST_B", undefined);
    setEnv("EIDOLON_TEST_C", undefined);
    loadDotenv(path, { override: true });
    expect(process.env.EIDOLON_TEST_A).toBe("file");
    expect(process.env.EIDOLON_TEST_B).toBe("file-x");
    expect(process.env.EIDOLON_TEST_C).toBe("dflt");
  });

  test("without override the inherited environment wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "eidolon-dotenv-"));
    const path = join(dir, ".env");
    writeFileSync(path, "EIDOLON_TEST_A=file\n");
    setEnv("EIDOLON_TEST_A", "inherited");
    loadDotenv(path, { override: false });
    expect(process.env.EIDOLON_TEST_A).toBe("inherited");
  });

  test("findDotenv walks upward", () => {
    const root = mkdtempSync(join(tmpdir(), "eidolon-find-"));
    writeFileSync(join(root, ".env"), "X=1\n");
    const nested = join(root, "a", "b");
    Bun.spawnSync(["mkdir", "-p", nested]);
    expect(findDotenv(nested)).toBe(join(root, ".env"));
  });

  test("a linked worktree without a .env reads its main checkout's, wherever it lives", () => {
    const root = mkdtempSync(join(tmpdir(), "eidolon-find-"));
    const main = join(root, "Git", "repo");
    const linked = join(main, ".git", "worktrees", "wt");
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, "commondir"), "../..\n");
    writeFileSync(join(main, ".env"), "X=main\n");
    const worktree = join(root, "workspaces", "repo", "wt");
    const nested = join(worktree, "apps", "bot", "src");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${linked}\n`);
    expect(findDotenv(nested)).toBe(join(main, ".env"));

    writeFileSync(join(worktree, ".env"), "X=own\n");
    expect(findDotenv(nested)).toBe(join(worktree, ".env"));
  });

  test("a .git file without a main checkout behind it keeps walking up", () => {
    const root = mkdtempSync(join(tmpdir(), "eidolon-find-"));
    writeFileSync(join(root, ".env"), "X=above\n");
    const submodule = join(root, "repo", "lib");
    mkdirSync(join(root, "repo", ".git", "modules", "lib"), { recursive: true });
    mkdirSync(submodule, { recursive: true });
    writeFileSync(join(submodule, ".git"), "gitdir: ../.git/modules/lib\n");
    expect(findDotenv(submodule)).toBe(join(root, ".env"));
  });
});

describe("flags, raw values and paths", () => {
  test("envRaw keeps blank, envFlag honors its default", () => {
    setEnv("EIDOLON_TEST_X", "");
    expect(envRaw("EIDOLON_TEST_X")).toBe("");
    expect(envFlag("EIDOLON_TEST_X", true)).toBe(true);
    setEnv("EIDOLON_TEST_X", " OFF ");
    expect(envFlag("EIDOLON_TEST_X", true)).toBe(false);
    setEnv("EIDOLON_TEST_X", "garbage");
    expect(envFlag("EIDOLON_TEST_X", true)).toBe(true);
    expect(envFlag("EIDOLON_TEST_X", false)).toBe(false);
    setEnv("EIDOLON_TEST_X", "Yes");
    expect(envFlag("EIDOLON_TEST_X", false)).toBe(true);
  });

  test("project paths join like pathlib", () => {
    expect(existsSync(join(PROJECT_ROOT, "personas", "milky-green", "prompt.md"))).toBe(true);
    expect(resolveProjectPath("data/lancedb")).toBe(join(PROJECT_ROOT, "data/lancedb"));
    expect(resolveProjectPath("/abs/x")).toBe("/abs/x");
  });

  test("shipped files are this checkout's, or the npm package's that EIDOLON_APP_ROOT names", () => {
    const shipped = () => ({
      templates: templatesDir(),
      web: webDist(),
      server: serverEntry(),
      cli: cliEntry(),
      jieba: jiebaDir(),
      resampler: resamplerDir(),
      models: voiceModelsDir(),
    });
    expect(shipped()).toEqual({
      templates: join(PROJECT_ROOT, "personas"),
      web: join(PROJECT_ROOT, "apps/web/dist"),
      server: join(PROJECT_ROOT, "apps/bot/src/local/server.ts"),
      cli: join(PROJECT_ROOT, "apps/cli/src/main.ts"),
      jieba: join(PROJECT_ROOT, "packages/retrieval/data/jieba"),
      resampler: join(PROJECT_ROOT, "packages/voice/src/dsp/resampler/wasm"),
      models: join(PROJECT_ROOT, "packages/voice/models"),
    });
    for (const file of [
      join(templatesDir(), "milky-green", "prompt.md"),
      serverEntry(),
      cliEntry(),
      join(jiebaDir(), "dict.txt"),
      join(resamplerDir(), "resampler.wasm"),
      join(voiceModelsDir(), "silero_vad.onnx"),
      join(voiceModelsDir(), "smart-turn-v3.2-cpu.onnx"),
    ]) {
      expect([file, existsSync(file)]).toEqual([file, true]);
    }
    setEnv("EIDOLON_APP_ROOT", "");
    expect(shipped().templates).toBe(join(PROJECT_ROOT, "personas"));

    setEnv("EIDOLON_APP_ROOT", "/opt/eidolon");
    expect(shipped()).toEqual({
      templates: "/opt/eidolon/personas",
      web: "/opt/eidolon/web",
      server: "/opt/eidolon/dist/server.js",
      cli: "/opt/eidolon/dist/cli.js",
      jieba: "/opt/eidolon/data/jieba",
      resampler: "/opt/eidolon/data/resampler",
      models: "/opt/eidolon/data/models",
    });
    expect(personaTemplateDir("milky-green")).toBe("/opt/eidolon/personas/milky-green");
    // What a user configures never resolves into the package, which an update replaces.
    expect(resolveProjectPath("data/lancedb")).toBe(join(PROJECT_ROOT, "data/lancedb"));
  });

  test("a packaged install lists the package's templates", () => {
    const root = mkdtempSync(join(tmpdir(), "eidolon-app-root-"));
    try {
      mkdirSync(join(root, "personas", "packaged"), { recursive: true });
      setEnv("EIDOLON_APP_ROOT", root);
      expect(personaIds()).toEqual(["packaged"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a persona's sources live in the data home, beside the personas", () => {
    expect(sourcesDir("milky-green")).toBe(join(dataHome(), "sources", "milky-green"));
    expect(sourceFolder("milky-green", "streams")).toBe(
      join(dataHome(), "sources", "milky-green", "streams"),
    );
  });
});

describe("persona clock", () => {
  test("zonedClock reads the wall clock in the zone", () => {
    const at = new Date("2026-03-01T16:30:05Z");
    expect(zonedClock("Asia/Shanghai", at)).toEqual({
      year: 2026,
      month: 3,
      day: 2,
      hour: 0,
      minute: 30,
      second: 5,
      weekday: 0,
      isoDate: "2026-03-02",
    });
  });

  test("an invalid zone warns once and falls back to UTC", () => {
    const lines: string[] = [];
    const remove = logger.addSink((r) => lines.push(r.message));
    try {
      // A zone no other test sets: the warn-once memory is per process, and bun runs every file in one.
      setEnv("PERSONA_TIMEZONE", "Not/AConfigTestZone");
      expect(personaTimeZone()).toBe("UTC");
      expect(personaTimeZone()).toBe("UTC");
      setEnv("PERSONA_TIMEZONE", "");
      expect(personaTimeZone()).toBe("Asia/Shanghai");
    } finally {
      remove();
    }
    expect(lines.filter((l) => l.startsWith("PERSONA_TIMEZONE invalid"))).toHaveLength(1);
  });
});

describe("logger", () => {
  test("sinks receive records at or above the level", () => {
    const seen: string[] = [];
    const remove = logger.addSink((r) => seen.push(`${r.level}:${r.message}`));
    try {
      logger.setLevel("INFO");
      logger.debug("hidden");
      logger.warning("shown");
    } finally {
      logger.setLevel("DEBUG");
      remove();
    }
    expect(seen).toEqual(["WARNING:shown"]);
  });

  test("logToStderr sends every level to stderr", () => {
    const err: string[] = [];
    const out: string[] = [];
    const error = spyOn(console, "error").mockImplementation((line: unknown) => {
      err.push(String(line));
    });
    const log = spyOn(console, "log").mockImplementation((line: unknown) => {
      out.push(String(line));
    });
    try {
      logToStderr();
      logger.info("progress");
      logger.warning("careful");
    } finally {
      logger.setSink(consoleSink);
      error.mockRestore();
      log.mockRestore();
    }
    expect(out).toEqual([]);
    expect(err.map((line) => line.slice(line.indexOf(" | ") + 3))).toEqual([
      "INFO     | progress",
      "WARNING  | careful",
    ]);
  });
});

test("isoformat takes a bigint for instants past 2^53 microseconds", () => {
  expect(pyIsoformatUtc(253402300799999999n)).toBe("9999-12-31T23:59:59.999999+00:00");
  expect(pyIsoformatUtc(0)).toBe("1970-01-01T00:00:00+00:00");
});

describe("openrouter", () => {
  test("headers fall back when the app name is empty", () => {
    setEnv("OPENROUTER_APP_NAME", "");
    setEnv("OPENROUTER_APP_URL", undefined);
    expect(openrouterHeaders()).toEqual({
      "HTTP-Referer": "https://laplace.live/ai",
      "X-Title": "LAPLACE Live!",
      "X-OpenRouter-Title": "LAPLACE Live!",
      "X-OpenRouter-Categories": "roleplay",
    });
  });

  test("cost prefers billed cost, then upstream inference cost", () => {
    expect(extractCostUsd({ cost: 0.002 })).toBe(0.002);
    expect(extractCostUsd({ cost: 0, cost_details: { upstream_inference_cost: 0.01 } })).toBe(0.01);
    expect(extractCostUsd({ cost: 0 })).toBe(0);
    expect(extractCostUsd({ cost: "" })).toBeNull();
    expect(extractCostUsd(null)).toBeNull();
    expect(extractCostUsd({})).toBeNull();
  });
});

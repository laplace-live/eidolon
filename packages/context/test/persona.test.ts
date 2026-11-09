import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LogRecord, PROJECT_ROOT } from "@eidolon/config";
import {
  buildGreetingKickoff,
  buildPersonaPrefix,
  buildSystemInstruction,
  FALLBACK_PERSONA,
  GREETING_KICKOFF,
  getRecentStreamDates,
  humanizeDaysAgo,
  INTERRUPTED_EMPTY_TURN_PROMPT,
  loadPersona,
  STREAM_DATES_TTL_SEC,
  type Viewer,
  WEEKDAY_ZH,
} from "../src/index.ts";
import { captureLogs, deferred, resetEnv, setEnv } from "./helpers.ts";

const TEMPLATE_PROMPT = readFileSync(
  join(PROJECT_ROOT, "personas", "milky-green", "prompt.md"),
  "utf8",
).trim();

interface PrefixCase {
  name: string;
  now: string;
  timeZone: string;
  viewer: Viewer;
  recent: string[];
  voiceHint: string;
  selfieHint: string;
  output: string;
}

// buildPersonaPrefix at a fixed clock (the zone's wall time in `now`), fixed stream dates and
// placeholder tool hints; humanizeDaysAgo per day count; and the fallback persona.
const goldens = JSON.parse(
  readFileSync(new URL("./fixtures/goldens.json", import.meta.url), "utf8"),
) as { personaPrefix: PrefixCase[]; humanize: Record<string, string>; fallbackPersona: string };
const prompts = JSON.parse(
  readFileSync(new URL("./fixtures/prompts.json", import.meta.url), "utf8"),
) as { kickoff: string; kickoffPieces: string[]; interrupted: string };

let logs: { records: LogRecord[]; restore: () => void };
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
  resetEnv();
});

/** The instant whose wall clock in `timeZone` reads `local` (no DST in these zones). */
function instant(local: string, timeZone: string): Date {
  const offsetHours = timeZone === "Asia/Shanghai" ? 8 : 0;
  return new Date(Date.parse(`${local}Z`) - offsetHours * 3_600_000);
}

const ANONYMOUS: Viewer = { isLoggedIn: false, uname: null, mid: null };

describe("buildPersonaPrefix", () => {
  for (const c of goldens.personaPrefix) {
    test(`matches bot.py: ${c.name}`, () => {
      expect(
        buildPersonaPrefix({
          viewer: c.viewer,
          timeZone: c.timeZone,
          now: instant(c.now, c.timeZone),
          recentStreamDates: c.recent,
          voiceHint: c.voiceHint,
          selfieHint: c.selfieHint,
        }),
      ).toBe(c.output);
    });
  }

  test("the context spec's golden prefix, with real tool hints", () => {
    const voiceHint =
      "如果奶糖花明确要求换声音（『温柔一点』『换个声音』『换回原来的』之类），调用 change_voice_style 工具，参数 style 可选：default、gentle、lively。不要主动切换；平时保持默认声线。";
    const selfieHint =
      "奶糖花要看照片 / 要自拍 / 说想看看你（『发张自拍』『让我看看你』『来张照片』之类），一定要调用 take_selfie 工具，这是唯一能把照片发出去的方式。你可以一边调侃一边拍（『就知道你想看』『只此一张啊』），但不能用『想得美』『不给看』之类的话搪塞过去，也不能说自己拍不了或者走不开。拍照要十几秒，调用后先说一句让对方等一下，照片会自动出现在对方屏幕上。她没提照片时不要主动拍，也不要念出图片链接或文件名。\n如果你记得或者刚才聊到今天正和朋友在外面（一起逛街、吃饭、出门玩），拍照时把她们填进 with_friends 参数，可选：七海Nana7mi，拍出来就是在外面的合照。不确定、或者你人在家，就不要填。";
    expect(
      buildPersonaPrefix({
        viewer: { isLoggedIn: true, uname: "小明", mid: 123 },
        timeZone: "Asia/Shanghai",
        now: new Date("2026-09-08T23:05:00Z"),
        recentStreamDates: ["2026-09-09", "2026-09-08", "2026-09-01", "2026-08-01", "2025-09-08"],
        voiceHint,
        selfieHint,
      }),
    ).toBe(
      "现在是 2026年9月9日 周三 07:05。如果用户问到时间或日期，根据这里的事实回答；不要主动念时间，除非话题相关。\n今天来花店的奶糖花叫「小明」（B站UID:123）。聊天里可以自然地叫她/他的名字，但不要每句都重复，也不要主动念UID。\n你最近几次直播：9月9日（今天）、9月8日（昨天）、9月1日（1周前）、8月1日（1个月前）、2025年9月8日（1年前）。如果用户问最近 / 上次 / 上一次 / 好久没播 / 这周播了吗 之类的，根据这里的日期自然回答；不要凭空编日期。\n" +
        `${voiceHint}\n${selfieHint}\n\n`,
    );
  });

  test("anonymous with nothing else is the clock line alone", () => {
    expect(
      buildPersonaPrefix({
        viewer: ANONYMOUS,
        timeZone: "Asia/Shanghai",
        now: new Date("2026-09-08T23:05:00Z"),
        recentStreamDates: [],
      }),
    ).toBe(
      "现在是 2026年9月9日 周三 07:05。如果用户问到时间或日期，根据这里的事实回答；不要主动念时间，除非话题相关。\n\n",
    );
  });

  test("pads the hour and minute, and names every weekday Monday first", () => {
    const lines = [0, 1, 2, 3, 4, 5, 6].map((offset) =>
      buildPersonaPrefix({
        viewer: ANONYMOUS,
        timeZone: "UTC",
        // 2026-09-07 is a Monday.
        now: new Date(Date.UTC(2026, 8, 7 + offset, 0, 5)),
        recentStreamDates: [],
      }),
    );
    expect(lines.map((line) => line.slice(0, line.indexOf("。")))).toEqual(
      WEEKDAY_ZH.map((weekday, i) => `现在是 2026年9月${7 + i}日 ${weekday} 00:05`),
    );
  });

  test("a whitespace-only uname is shown, an empty one is not", () => {
    const blank = buildPersonaPrefix({
      viewer: { isLoggedIn: true, uname: " ", mid: 7 },
      timeZone: "UTC",
      now: new Date("2026-01-04T00:05:00Z"),
      recentStreamDates: [],
    });
    expect(blank).toContain("今天来花店的奶糖花叫「 」（B站UID:7）。");
    const empty = buildPersonaPrefix({
      viewer: { isLoggedIn: true, uname: "", mid: 7 },
      timeZone: "UTC",
      now: new Date("2026-01-04T00:05:00Z"),
      recentStreamDates: [],
    });
    expect(empty).not.toContain("奶糖花叫");
  });
});

describe("humanizeDaysAgo", () => {
  test("matches bot.py across every boundary", () => {
    for (const [days, phrase] of Object.entries(goldens.humanize)) {
      expect(humanizeDaysAgo(Number(days))).toBe(phrase);
    }
    expect(humanizeDaysAgo(7)).toBe("1周前");
    expect(humanizeDaysAgo(29)).toBe("4周前");
    expect(humanizeDaysAgo(30)).toBe("1个月前");
    expect(humanizeDaysAgo(364)).toBe("12个月前");
    expect(humanizeDaysAgo(365)).toBe("1年前");
    expect(humanizeDaysAgo(730)).toBe("2年前");
    expect(humanizeDaysAgo(-1)).toBe("今天");
  });
});

describe("loadPersona", () => {
  const dir = mkdtempSync(join(tmpdir(), "eidolon-persona-"));

  function warningsOf(): string[] {
    return logs.records.filter((r) => r.level === "WARNING").map((r) => r.message);
  }

  test("FALLBACK_PERSONA is bot.py's", () => {
    expect(FALLBACK_PERSONA).toBe(goldens.fallbackPersona);
  });

  test("a missing file falls back with a warning", async () => {
    expect(await loadPersona({ root: dir, file: "missing.md" })).toBe(FALLBACK_PERSONA);
    expect(warningsOf()).toEqual([
      `Persona file ${join(dir, "missing.md")} not found; using fallback prompt`,
    ]);
  });

  test("a whitespace-only file falls back too", async () => {
    writeFileSync(join(dir, "blank.md"), " \n\t\n");
    expect(await loadPersona({ root: dir, file: "blank.md" })).toBe(FALLBACK_PERSONA);
    expect(warningsOf()).toHaveLength(1);
  });

  test("returns the stripped text and logs the path under the root", async () => {
    writeFileSync(join(dir, "prompt.md"), "\n  # 奶绿\n\n设定  \n");
    expect(await loadPersona({ root: dir, file: "prompt.md" })).toBe("# 奶绿\n\n设定");
    expect(logs.records.at(-1)?.message).toBe("Loaded persona from prompt.md");
  });

  test("PERSONA_FILE picks the file; blank means the persona's prompt.md", async () => {
    writeFileSync(join(dir, "fork.md"), "fork persona");
    setEnv("PERSONA_FILE", "fork.md");
    expect(await loadPersona({ root: dir })).toBe("fork persona");
    setEnv("PERSONA_FILE", "");
    expect(await loadPersona({ root: dir })).toBe(TEMPLATE_PROMPT);
  });

  test("an absolute path outside the root loads and logs in full", async () => {
    const outside = mkdtempSync(join(tmpdir(), "eidolon-elsewhere-"));
    const path = join(outside, "persona.md");
    writeFileSync(path, "elsewhere");
    setEnv("PERSONA_FILE", path);
    expect(await loadPersona({ root: dir })).toBe("elsewhere");
    expect(logs.records.at(-1)?.message).toBe(`Loaded persona from ${path}`);
  });

  test("a directory is not a persona file", async () => {
    mkdirSync(join(dir, "folder"), { recursive: true });
    await expect(loadPersona({ root: dir, file: "folder" })).rejects.toThrow();
  });

  test("defaults to the active persona's prompt.md, the template when the data home has none", async () => {
    setEnv("PERSONA_FILE", undefined);
    expect(await loadPersona()).toBe(TEMPLATE_PROMPT);
  });
});

describe("getRecentStreamDates", () => {
  let n = 0;
  const db = (): string => `/virtual/db-${n++}`;

  test("dedupes, sorts newest first and slices", async () => {
    const dates = await getRecentStreamDates({
      dbPath: db(),
      scan: async () => ["2026-09-01", "2026-09-08", "2026-09-01", "2025-12-31", "2026-09-06"],
      n: 3,
    });
    expect(dates).toEqual(["2026-09-08", "2026-09-06", "2026-09-01"]);
  });

  test("holds the value until the TTL passes", async () => {
    const dbPath = db();
    let clock = 1_000_000;
    let scans = 0;
    const read = () =>
      getRecentStreamDates({
        dbPath,
        now: () => clock,
        scan: async () => {
          scans++;
          return [`2026-09-0${scans}`];
        },
      });
    expect(await read()).toEqual(["2026-09-01"]);
    clock += STREAM_DATES_TTL_SEC * 1000 - 1;
    expect(await read()).toEqual(["2026-09-01"]);
    clock += 1;
    expect(await read()).toEqual(["2026-09-02"]);
    expect(scans).toBe(2);
  });

  test("a missing table caches no dates for the TTL", async () => {
    const dbPath = db();
    let clock = 0;
    let scans = 0;
    const read = () =>
      getRecentStreamDates({
        dbPath,
        now: () => clock,
        scan: async () => {
          scans++;
          return null;
        },
      });
    expect(await read()).toEqual([]);
    clock += 599_000;
    expect(await read()).toEqual([]);
    expect(scans).toBe(1);
  });

  test("a failed refresh returns the stale list and retries next time", async () => {
    const dbPath = db();
    let clock = 0;
    let fail = false;
    let scans = 0;
    const read = () =>
      getRecentStreamDates({
        dbPath,
        now: () => clock,
        scan: async () => {
          scans++;
          if (fail) throw new Error("lance gone");
          return ["2026-09-08"];
        },
      });
    expect(await read()).toEqual(["2026-09-08"]);
    fail = true;
    clock += 600_000;
    expect(await read()).toEqual(["2026-09-08"]);
    expect(logs.records.at(-1)).toMatchObject({
      level: "WARNING",
      message: "Could not refresh recent stream dates: lance gone; returning cached=True",
    });
    expect(await read()).toEqual(["2026-09-08"]);
    expect(scans).toBe(3);
  });

  test("a failure with nothing cached returns no dates", async () => {
    const dates = await getRecentStreamDates({
      dbPath: db(),
      scan: async () => {
        throw new Error("no lancedb");
      },
    });
    expect(dates).toEqual([]);
    expect(logs.records.at(-1)?.message).toBe(
      "Could not refresh recent stream dates: no lancedb; returning cached=False",
    );
  });

  test("concurrent callers share one scan", async () => {
    const dbPath = db();
    const gate = deferred<string[]>();
    let scans = 0;
    const read = () =>
      getRecentStreamDates({
        dbPath,
        scan: () => {
          scans++;
          return gate.promise;
        },
      });
    const both = Promise.all([read(), read()]);
    gate.resolve(["2026-09-08"]);
    expect(await both).toEqual([["2026-09-08"], ["2026-09-08"]]);
    expect(scans).toBe(1);
  });
});

describe("buildSystemInstruction", () => {
  test("is the prefix followed by persona.md", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eidolon-instruction-"));
    writeFileSync(join(dir, "persona.md"), "  人设正文  \n");
    setEnv("PERSONA_FILE", join(dir, "persona.md"));
    const instruction = await buildSystemInstruction({
      viewer: { isLoggedIn: true, uname: "小明", mid: 123 },
      voiceHint: "VOICE",
      selfieHint: "",
      timeZone: "Asia/Shanghai",
      now: new Date("2026-09-08T23:05:00Z"),
      dbPath: join(dir, "no-lancedb"),
    });
    expect(instruction).toBe(
      "现在是 2026年9月9日 周三 07:05。如果用户问到时间或日期，根据这里的事实回答；不要主动念时间，除非话题相关。\n" +
        "今天来花店的奶糖花叫「小明」（B站UID:123）。聊天里可以自然地叫她/他的名字，但不要每句都重复，也不要主动念UID。\n" +
        "VOICE\n\n人设正文",
    );
  });

  test("defaults the zone to PERSONA_TIMEZONE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eidolon-instruction-"));
    writeFileSync(join(dir, "persona.md"), "p");
    setEnv("PERSONA_FILE", join(dir, "persona.md"));
    setEnv("PERSONA_TIMEZONE", "UTC");
    const instruction = await buildSystemInstruction({
      viewer: { isLoggedIn: false, uname: null, mid: null },
      voiceHint: "",
      selfieHint: "",
      now: new Date("2026-09-08T23:05:00Z"),
      dbPath: join(dir, "no-lancedb"),
    });
    expect(instruction.startsWith("现在是 2026年9月8日 周二 23:05。")).toBe(true);
  });
});

describe("greeting and empty-turn prompts", () => {
  test("are bot.py's literals", () => {
    expect(GREETING_KICKOFF).toBe(prompts.kickoff);
    expect(INTERRUPTED_EMPTY_TURN_PROMPT).toBe(prompts.interrupted);
  });

  test("the kickoff mentions up to three non-empty memories", () => {
    const [tail, head, join] = prompts.kickoffPieces as [string, string, string];
    expect(buildGreetingKickoff(null)).toBe(GREETING_KICKOFF);
    expect(buildGreetingKickoff([])).toBe(GREETING_KICKOFF);
    expect(buildGreetingKickoff([{ memory: "" }, {}, { memory: null }])).toBe(GREETING_KICKOFF);
    expect(
      buildGreetingKickoff([
        { memory: "喜欢猫" },
        { memory: "" },
        { memory: "在上海" },
        { memory: "养了仓鼠" },
        { memory: "第四件" },
      ]),
    ).toBe(`${head}${["喜欢猫", "在上海", "养了仓鼠"].join(join)}${tail}`);
    expect(buildGreetingKickoff([{ memory: "只有一件" }])).toBe(
      "用一两句话简短自然地打个招呼。你之前跟ta聊过这些事：只有一件。如果合适的话自然地提一两件，不要全念出来。",
    );
  });
});

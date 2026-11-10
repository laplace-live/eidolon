import "../../config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataHome, type LogRecord, resetSettings } from "@eidolon/config";
import { setUsageSink, type UsageRecord } from "@eidolon/providers";
import { VOICE_THRESHOLD, VOICE_THRESHOLD_AFTER_VOICE, voiceThreshold } from "../src/director.ts";
import {
  ADDRESSED_THRESHOLD,
  DEFAULT_GATE_MODEL,
  Director,
  type DirectorInput,
  type DirectorLine,
  type DirectorParticipant,
  directorFromEnv,
  directorParticipant,
  directorQuestions,
  directorState,
  GATE_URL,
  HOP_STEP,
  INTEREST_THRESHOLD,
  INVITES_THRESHOLD,
  JUST_SPOKE_PENALTY,
  MAX_REPLIES_TO_USER,
} from "../src/index.ts";
import { captureLogs, resetEnv, setEnv } from "./helpers.ts";

let logs: { records: LogRecord[]; restore: () => void };
let usage: UsageRecord[];
beforeEach(() => {
  logs = captureLogs();
  usage = [];
  setUsageSink((record) => usage.push(record));
});
afterEach(() => {
  logs.restore();
  setUsageSink(null);
  resetEnv();
  resetSettings();
  rmSync(dataHome(), { recursive: true, force: true });
});

const messages = (level: string) =>
  logs.records.filter((r) => r.level === level).map((r) => r.message);

function persona(
  id: string,
  name: string,
  talkativeness = 0.5,
  shortName = name,
): DirectorParticipant {
  return { id, name, shortName, summary: `${name}, a streamer`, interests: [], talkativeness };
}

const MILKY = persona("milky", "明前奶绿", 0.5, "奶绿");
const RUBY = persona("ruby", "露比");
const KEN = persona("ken", "Ken", 0.9);
const ROOM = [MILKY, RUBY, KEN];

const viewer = (text: string): DirectorLine => ({ speaker: { kind: "user" }, text });
const from = (id: string, text: string): DirectorLine => ({
  speaker: { kind: "persona", id },
  text,
});

type FakeFetch = (url: string, init: RequestInit) => Promise<Response>;
type Body = { model: string; state: Record<string, any>; questions: Record<string, any> };

/** Answers every question asked: its noul from `nouls`, else 0. */
function answering(nouls: Record<string, unknown> = {}, bodies: Body[] = []): FakeFetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init.body)) as Body;
    bodies.push(body);
    return Response.json({
      model: "typesafe/jev-1.14",
      answers: Object.fromEntries(
        Object.keys(body.questions).map((key) => [key, { type: "noul", noul: nouls[key] ?? 0 }]),
      ),
      usage: { input_tokens: 120, output_tokens: 7, cost: 0.00002 },
    });
  };
}

function directorWith(fetch: FakeFetch, options: { timeoutSec?: number } = {}): Director {
  return new Director({
    apiKey: "test",
    fetch: fetch as unknown as typeof globalThis.fetch,
    ...options,
  });
}

function input(lines: DirectorLine[], fields: Partial<DirectorInput> = {}): DirectorInput {
  return { participants: ROOM, lines, hop: 0, ...fields };
}

async function who(
  nouls: Record<string, unknown>,
  lines: DirectorLine[],
  fields: Partial<DirectorInput> = {},
): Promise<string[]> {
  const decision = await directorWith(answering(nouls)).decide(input(lines, fields));
  return decision.replies.map((reply) => reply.persona);
}

describe("what Jev reads", () => {
  test("the participants, the last 8 lines before the latest, the latest and recent turns", () => {
    const lines = [
      viewer("one"),
      from("milky", "two"),
      viewer("three"),
      from("ruby", "four"),
      { ...from("milky", "five"), modality: "voice" as const },
      viewer("six"),
      from("gone", "seven"),
      from("ken", "eight"),
      viewer("nine"),
      from("ruby", "ten"),
      viewer("eleven"),
    ];
    const state = directorState(input(lines));
    expect(state.participants).toEqual([
      { id: "milky", name: "明前奶绿", summary: "明前奶绿, a streamer", interests: [] },
      { id: "ruby", name: "露比", summary: "露比, a streamer", interests: [] },
      { id: "ken", name: "Ken", summary: "Ken, a streamer", interests: [] },
    ]);
    expect(state.earlier_lines).toEqual([
      { speaker: "viewer", text: "three", modality: "text" },
      { speaker: "露比", text: "four", modality: "text" },
      { speaker: "明前奶绿", text: "five", modality: "voice" },
      { speaker: "viewer", text: "six", modality: "text" },
      { speaker: "gone", text: "seven", modality: "text" },
      { speaker: "Ken", text: "eight", modality: "text" },
      { speaker: "viewer", text: "nine", modality: "text" },
      { speaker: "露比", text: "ten", modality: "text" },
    ]);
    expect(state.latest).toEqual({ speaker: "viewer", text: "eleven", modality: "text" });
    // The last 10 lines: two through eleven.
    expect(state.recent_turns).toEqual({ 明前奶绿: 2, 露比: 2, Ken: 1 });
    expect(Object.keys(state)).toEqual(["participants", "earlier_lines", "latest", "recent_turns"]);
  });

  test("a short chat has fewer earlier lines, and interests go as a list", () => {
    const keen = { ...MILKY, interests: ["猫", "恐怖片"] };
    const state = directorState({ participants: [keen, RUBY], lines: [viewer("hi")], hop: 0 });
    expect(state.earlier_lines).toEqual([]);
    expect(state.participants[0]?.interests).toEqual(["猫", "恐怖片"]);
    expect(state.recent_turns).toEqual({ 明前奶绿: 0, 露比: 0 });
  });

  test("each candidate's two questions, then invites_reply, as the roadmap words them", () => {
    expect(directorQuestions([RUBY, KEN])).toEqual({
      addressed_ruby: {
        type: "noul",
        instructions:
          "Is the latest message addressed to 露比, by name or by answering what she said?",
      },
      interested_ruby: {
        type: "noul",
        instructions:
          "Is the latest message about something 露比 cares about (her interests above), or " +
          "something she has a stake in?",
      },
      addressed_ken: {
        type: "noul",
        instructions:
          "Is the latest message addressed to Ken, by name or by answering what she said?",
      },
      interested_ken: {
        type: "noul",
        instructions:
          "Is the latest message about something Ken cares about (her interests above), or " +
          "something she has a stake in?",
      },
      invites_reply: {
        type: "noul",
        instructions:
          "Does the latest message invite a reply (a question, an opinion, a tease) rather than " +
          "close the exchange?",
      },
    });
    expect(Object.keys(directorQuestions([RUBY, KEN]))).toEqual([
      "addressed_ruby",
      "interested_ruby",
      "addressed_ken",
      "interested_ken",
      "invites_reply",
    ]);
  });
});

describe("the request", () => {
  test("posts the gate's model, the state and every candidate's questions, as the gate does", async () => {
    setEnv("OPENROUTER_APP_NAME", undefined);
    setEnv("OPENROUTER_APP_URL", undefined);
    const requests: { url: string; init: RequestInit }[] = [];
    const bodies: Body[] = [];
    const director = directorWith(async (url, init) => {
      requests.push({ url, init });
      return answering({}, bodies)(url, init);
    });
    const lines = [viewer("大家好"), from("milky", "露比你呢？")];
    const decision = await director.decide(input(lines, { hop: 1 }));
    expect(requests[0]?.url).toBe(GATE_URL);
    expect(requests[0]?.init.method).toBe("POST");
    expect(requests[0]?.init.redirect).toBe("manual");
    expect(requests[0]?.init.headers).toEqual({
      "HTTP-Referer": "https://laplace.live/ai",
      "X-Title": "LAPLACE Live!",
      "X-OpenRouter-Title": "LAPLACE Live!",
      "X-OpenRouter-Categories": "roleplay",
      Authorization: "Bearer test",
      "Content-Type": "application/json",
    });
    expect(Object.keys(bodies[0] as Body)).toEqual(["model", "state", "questions"]);
    expect(bodies[0]?.model).toBe(DEFAULT_GATE_MODEL);
    expect(bodies[0]?.state).toEqual(directorState(input(lines)));
    // She wrote the latest line, so she isn't asked about.
    expect(bodies[0]?.questions).toEqual(directorQuestions([RUBY, KEN]));
    expect(decision.scores).toEqual({
      addressed_ruby: 0,
      interested_ruby: 0,
      addressed_ken: 0,
      interested_ken: 0,
      invites_reply: 0,
    });
    expect(usage).toEqual([
      expect.objectContaining({
        role: "gate",
        provider: "openrouter",
        model: "typesafe/jev-1.14",
        units: { inputTokens: 120, outputTokens: 7 },
        costUsd: 0.00002,
      }),
    ]);
  });

  test("a one-persona chat asks nothing: she answers the viewer, and not herself", async () => {
    let calls = 0;
    const director = directorWith(async () => {
      calls++;
      return Response.json({});
    });
    const alone = { participants: [MILKY], hop: 0 };
    expect(await director.decide({ ...alone, lines: [viewer("你好")] })).toEqual({
      replies: [{ persona: "milky", mode: "text" }],
      source: "single",
      scores: {},
    });
    expect(
      await director.decide({ ...alone, lines: [viewer("你好"), from("milky", "嗨")] }),
    ).toEqual({ replies: [], source: "single", scores: {} });
    expect(calls).toBe(0);
    expect(logs.records).toEqual([]);
  });

  test("the decision is logged with who answers and why", async () => {
    await directorWith(answering({ addressed_ruby: 0.9, addressed_ken: 0.8 })).decide(
      input([viewer("露比和Ken在吗")]),
    );
    expect(messages("INFO")).toHaveLength(1);
    expect(messages("INFO")[0]).toMatch(/^Director: 露比, Ken \(model, hop 0, \d+ ms\)$/);
    await directorWith(answering({ invites_reply: 0.1 })).decide(
      input([viewer("hi"), from("ruby", "晚安")], { hop: 1 }),
    );
    expect(messages("INFO")[1]).toMatch(/^Director: no one \(model, hop 1, \d+ ms\)$/);
  });
});

describe("after the viewer's line", () => {
  const line = [viewer("你们好")];

  test("a mention answers first, in mention order, then the addressed, two at most", async () => {
    const decision = await directorWith(answering({ addressed_ken: 0.9 })).decide(
      input([viewer("@露比 @奶绿 你们呢")], { mentions: ["ruby", "milky"] }),
    );
    expect(decision.replies).toEqual([
      { persona: "ruby", mode: "text" },
      { persona: "milky", mode: "text" },
    ]);
    expect(decision.source).toBe("mention");
    expect(MAX_REPLIES_TO_USER).toBe(2);
    expect(await who({ addressed_ken: 0.9 }, line, { mentions: ["ruby"] })).toEqual([
      "ruby",
      "ken",
    ]);
  });

  test("a mention of someone not in the chat counts for nothing", async () => {
    const decision = await directorWith(answering({ addressed_ken: 0.9 })).decide(
      input(line, { mentions: ["nobody"] }),
    );
    expect(decision.replies.map((r) => r.persona)).toEqual(["ken"]);
    expect(decision.source).toBe("model");
  });

  test("the addressed answer, most addressed first; the bar is inclusive", async () => {
    expect(
      await who({ addressed_ken: 0.8, addressed_ruby: 0.95, interested_milky: 1 }, line),
    ).toEqual(["ruby", "ken"]);
    expect(await who({ addressed_milky: ADDRESSED_THRESHOLD }, line)).toEqual(["milky"]);
    expect(
      await who({ addressed_milky: ADDRESSED_THRESHOLD - 0.01, interested_ruby: 1 }, line),
    ).toEqual(["ruby"]);
  });

  test("otherwise the keenest by interest × talkativeness, inclusive, two at most", async () => {
    const eager = [persona("a", "A", 1), persona("b", "B", 1), persona("c", "C", 1)];
    const keen = (nouls: Record<string, number>) => who(nouls, line, { participants: eager });
    expect(await keen({ interested_a: 0.6, interested_b: 0.9, interested_c: 0.7 })).toEqual([
      "b",
      "c",
    ]);
    expect(await keen({ interested_a: INTEREST_THRESHOLD })).toEqual(["a"]);
    // Below the bar, the keenest answers anyway.
    expect(await keen({ interested_b: INTEREST_THRESHOLD - 0.01 })).toEqual(["b"]);
    // Ken's interest weighs 0.9, Milky's 0.5.
    expect(await who({ interested_ken: 0.5, interested_milky: 0.8 }, line)).toEqual([
      "ken",
      "milky",
    ]);
    expect(await who({ interested_ruby: 0.5, interested_milky: 0.8 }, line)).toEqual(["milky"]);
  });

  test("whoever spoke the persona line before is marked down", async () => {
    const eager = [persona("a", "A", 1), persona("b", "B", 1)];
    const lines = [viewer("hi"), from("a", "嗨"), viewer("你们觉得呢")];
    const level = INTEREST_THRESHOLD + JUST_SPOKE_PENALTY / 2;
    expect(
      await who({ interested_a: level, interested_b: level }, lines, { participants: eager }),
    ).toEqual(["b"]);
    expect(
      await who({ interested_a: 0.9, interested_b: 0.9 }, lines, { participants: eager }),
    ).toEqual(["b", "a"]);
  });

  test("with no one keen, the keenest answers anyway, the more talkative of a tie", async () => {
    const shy = persona("cook", "Cook", 0.3);
    const room = [{ ...MILKY, talkativeness: 0.9 }, shy];
    const below = (INTEREST_THRESHOLD - 0.01) / shy.talkativeness;
    expect(
      await who({ interested_milky: 0.08, interested_cook: below }, line, { participants: room }),
    ).toEqual(["cook"]);
    expect(await who({}, line)).toEqual(["ken"]);
    const pair = [MILKY, RUBY];
    expect(await who({ interested_ruby: 0.2 }, line, { participants: pair })).toEqual(["ruby"]);
    expect(await who({}, line, { participants: pair })).toEqual(["milky"]);
    // At 0 she never volunteers, but someone always answers the viewer.
    const quiet = [persona("a", "A", 0), persona("b", "B", 0.1)];
    expect(await who({ interested_a: 1 }, line, { participants: quiet })).toEqual(["b"]);
  });

  test("the forced answer passes over a persona at 0 unless everyone is", async () => {
    const room = [persona("chatty", "Chatty", 0.5), persona("mute", "Mute", 0)];
    // Marked down, Chatty's 0.1 × 0.5 − 0.1 ranks under Mute's 0.
    const lines = [viewer("hi"), from("chatty", "嗨"), viewer("嗯嗯")];
    expect(
      await who({ interested_chatty: 0.1, interested_mute: 1 }, lines, { participants: room }),
    ).toEqual(["chatty"]);
    const silent = [persona("a", "A", 0), persona("b", "B", 0)];
    expect(await who({ interested_b: 1 }, line, { participants: silent })).toHaveLength(1);
  });
});

describe("after a persona's line", () => {
  const lines = [viewer("你们好"), from("milky", "露比你呢？")];

  test("only a line that invites a reply gets one, addressed or not", async () => {
    const bar = INVITES_THRESHOLD + HOP_STEP;
    expect(await who({ invites_reply: bar - 0.01, addressed_ruby: 1 }, lines, { hop: 1 })).toEqual(
      [],
    );
    expect(await who({ invites_reply: bar, addressed_ruby: 1 }, lines, { hop: 1 })).toEqual([
      "ruby",
    ]);
  });

  test("one reply at most, and none forced", async () => {
    const asked = { invites_reply: 1, addressed_ruby: 0.9, addressed_ken: 0.95 };
    expect(await who(asked, lines, { hop: 1 })).toEqual(["ken"]);
    expect(
      await who({ invites_reply: 1, interested_ken: 1, interested_ruby: 1 }, lines, { hop: 1 }),
    ).toEqual(["ken"]);
    expect(await who({ invites_reply: 1 }, lines, { hop: 1 })).toEqual([]);
  });

  test("a mention still needs the invitation, then answers first", async () => {
    const mentions = { hop: 1, mentions: ["ruby"] };
    expect(await who({ addressed_ken: 1 }, lines, mentions)).toEqual([]);
    const decision = await directorWith(answering({ invites_reply: 1, addressed_ken: 1 })).decide(
      input(lines, mentions),
    );
    expect(decision.replies).toEqual([{ persona: "ruby", mode: "text" }]);
    expect(decision.source).toBe("mention");
  });

  test("every bar rises by HOP_STEP a hop", async () => {
    const at = (hop: number, nouls: Record<string, number>) => who(nouls, lines, { hop });
    const addressed = ADDRESSED_THRESHOLD + HOP_STEP + 0.05;
    expect(await at(1, { invites_reply: 1, addressed_ruby: addressed })).toEqual(["ruby"]);
    expect(await at(2, { invites_reply: 1, addressed_ruby: addressed })).toEqual([]);
    const keen = (INTEREST_THRESHOLD + HOP_STEP + 0.05) / KEN.talkativeness;
    expect(await at(1, { invites_reply: 1, interested_ken: keen })).toEqual(["ken"]);
    expect(await at(2, { invites_reply: 1, interested_ken: keen })).toEqual([]);
    const invites = INVITES_THRESHOLD + HOP_STEP + 0.05;
    expect(await at(1, { invites_reply: invites, addressed_ruby: 1 })).toEqual(["ruby"]);
    expect(await at(2, { invites_reply: invites, addressed_ruby: 1 })).toEqual([]);
  });

  test("the persona who spoke before the latest is marked down in a chain", async () => {
    const chain = [viewer("hi"), from("ruby", "猫呢？"), from("milky", "猫最可爱了，对吧？")];
    const eager = [
      { ...MILKY, talkativeness: 1 },
      { ...RUBY, talkativeness: 1 },
      persona("a", "A", 1),
    ];
    const level = INTEREST_THRESHOLD + HOP_STEP * 2 + JUST_SPOKE_PENALTY / 2;
    expect(
      await who({ invites_reply: 1, interested_ruby: level, interested_a: level }, chain, {
        hop: 2,
        participants: eager,
      }),
    ).toEqual(["a"]);
  });
});

describe("falling back to rules", () => {
  const failures: [string, FakeFetch][] = [
    ["a 5xx", async () => new Response("busy", { status: 503 })],
    ["a redirect", async () => new Response(null, { status: 302, headers: { location: "/x" } })],
    ["invalid JSON", async () => new Response("not json")],
    ["missing answers", async () => Response.json({ model: "x" })],
    ["a missing answer", async () => Response.json({ answers: { invites_reply: { noul: 1 } } })],
    ["a non-numeric noul", answering({ addressed_ruby: "abc" })],
    [
      "a transport error",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
  ];
  for (const [name, fetch] of failures) {
    test(`on ${name}`, async () => {
      const decision = await directorWith(fetch).decide(input([viewer("Ken在吗")]));
      expect(decision).toEqual({
        replies: [{ persona: "ken", mode: "text" }],
        source: "fallback",
        scores: {},
      });
      expect(messages("WARNING")).toHaveLength(1);
      expect(messages("WARNING")[0]).toStartWith("Director fell back to rules: ");
      expect(messages("INFO")).toEqual(["Director: Ken (fallback, hop 0)"]);
    });
  }

  test("on a timeout", async () => {
    const hang: FakeFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const decision = await directorWith(hang, { timeoutSec: 0.05 }).decide(input([viewer("hi")]));
    expect(decision.source).toBe("fallback");
    expect(messages("WARNING")).toEqual([
      "Director fell back to rules: TimeoutError('The operation timed out.')",
    ]);
  });

  test("a 5xx logs like the gate's", async () => {
    await directorWith(async () => new Response(null, { status: 503 })).decide(
      input([viewer("hi")]),
    );
    expect(messages("WARNING")).toEqual([
      `Director fell back to rules: HTTPStatusError("Server error '503' for url '${GATE_URL}'")`,
    ]);
  });

  const rules = (lines: DirectorLine[], fields: Partial<DirectorInput> = {}) =>
    new Director(null).decide(input(lines, fields));

  test("without a model it asks nothing and warns of nothing", async () => {
    expect(await rules([viewer("hi")])).toEqual({
      replies: [{ persona: "ken", mode: "text" }],
      source: "fallback",
      scores: {},
    });
    expect(messages("WARNING")).toEqual([]);
  });

  test("mentions first, two at most", async () => {
    const decision = await rules([viewer("@露比 @Ken @奶绿")], {
      mentions: ["ruby", "ken", "milky"],
    });
    expect(decision.replies.map((r) => r.persona)).toEqual(["ruby", "ken"]);
  });

  test("then whoever the line names, by name or short name, case-blind, in order", async () => {
    const named = await rules([viewer("ken和奶绿你们呢，明前奶绿？")]);
    expect(named.replies.map((r) => r.persona)).toEqual(["ken", "milky"]);
    const late = await rules([viewer("问一下奶绿，然后露比")], { participants: [RUBY, MILKY] });
    expect(late.replies.map((r) => r.persona)).toEqual(["milky", "ruby"]);
  });

  test("a Latin name is named only as a whole word", async () => {
    const lines = [viewer("hi"), from("milky", "Kenny说的token好贵")];
    expect((await rules(lines, { hop: 1 })).replies).toEqual([]);
    const named = [viewer("hi"), from("milky", "问问Ken吧")];
    expect((await rules(named, { hop: 1 })).replies.map((r) => r.persona)).toEqual(["ken"]);
  });

  test("then, after the viewer's line only, the most talkative", async () => {
    expect((await rules([viewer("大家好")])).replies.map((r) => r.persona)).toEqual(["ken"]);
    const lines = [viewer("大家好"), from("ken", "晚上好")];
    expect((await rules(lines, { hop: 1 })).replies).toEqual([]);
  });

  test("after a persona's line, one at most, and never the speaker", async () => {
    const lines = [viewer("hi"), from("milky", "露比和Ken，还有奶绿我自己")];
    expect((await rules(lines, { hop: 1 })).replies.map((r) => r.persona)).toEqual(["ruby"]);
  });

  test("an empty name never matches", async () => {
    const blank = { ...persona("blank", ""), shortName: "" };
    const decision = await rules([viewer("Ken?")], { participants: [blank, KEN] });
    expect(decision.replies.map((r) => r.persona)).toEqual(["ken"]);
    const quiet = await rules([viewer("hi")], {
      participants: [{ ...blank, talkativeness: 1 }, persona("x", "X", 0)],
    });
    expect(quiet.replies.map((r) => r.persona)).toEqual(["blank"]);
  });
});

describe("aborting", () => {
  test("the caller's abort rejects with its reason and falls back to nothing", async () => {
    const controller = new AbortController();
    const director = directorWith(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const pending = director.decide(input([viewer("hi")]), controller.signal);
    const reason = new Error("the viewer stepped in");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(logs.records).toEqual([]);
  });

  test("an aborted signal sends nothing", async () => {
    let calls = 0;
    const director = directorWith(async () => {
      calls++;
      return Response.json({});
    });
    const reason = new Error("gone");
    await expect(director.decide(input([viewer("hi")]), AbortSignal.abort(reason))).rejects.toBe(
      reason,
    );
    expect(calls).toBe(0);
  });
});

describe("from the settings", () => {
  function write(rel: string, text: string): void {
    const path = join(dataHome(), rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }

  test("a participant is her identity and her chat settings", () => {
    write(
      "personas/alice/persona.yaml",
      "identity:\n  name: 爱丽丝\n  shortName: 丽丝\n  summary: Alice, a streamer\n" +
        "chat:\n  interests: 游戏、猫\n  talkativeness: 0.8\n",
    );
    write("personas/bob/persona.yaml", "identity:\n  name: Bob\n");
    expect(directorParticipant("alice")).toEqual({
      id: "alice",
      name: "爱丽丝",
      shortName: "丽丝",
      summary: "Alice, a streamer",
      interests: ["游戏", "猫"],
      talkativeness: 0.8,
    });
    expect(directorParticipant("bob")).toEqual({
      id: "bob",
      name: "Bob",
      shortName: "Bob",
      summary: "",
      interests: [],
      talkativeness: 0.5,
    });
  });

  test("the gate role's account and model, whether or not the gate retrieves", async () => {
    const seen: { path: string; auth: string | null; body: Body }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as Body;
        seen.push({
          path: new URL(request.url).pathname,
          auth: request.headers.get("authorization"),
          body,
        });
        return answering()(request.url, { body: JSON.stringify(body) });
      },
    });
    try {
      setEnv("OPENROUTER_API_KEY", "or-key");
      setEnv("OPENROUTER_API_BASE", `http://127.0.0.1:${server.port}/api/v1`);
      setEnv("RETRIEVAL_GATE_MODEL", "typesafe/jev-1.14");
      setEnv("RETRIEVAL_GATE_ENABLED", "false");
      const decision = await directorFromEnv().decide(input([viewer("hi")]));
      expect(decision.source).toBe("model");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.path).toBe("/api/alpha/decisions");
      expect(seen[0]?.auth).toBe("Bearer or-key");
      expect(seen[0]?.body.model).toBe("typesafe/jev-1.14");
    } finally {
      server.stop(true);
    }
  });

  test("without the gate role's key, it follows the rules and says so", async () => {
    setEnv("OPENROUTER_API_KEY", "");
    const decision = await directorFromEnv().decide(input([viewer("hi")]));
    expect(decision.source).toBe("fallback");
    expect(messages("INFO")[0]).toBe(
      "Director has no decision model: group chats follow rules, and auto replies are text",
    );
    expect(messages("WARNING")).toEqual([]);
  });
});

describe("voice replies", () => {
  const auto = (p: DirectorParticipant): DirectorParticipant => ({ ...p, replyMode: "auto" });
  const voiced = (p: DirectorParticipant): DirectorParticipant => ({ ...p, replyMode: "voice" });
  const VOICE_QUESTION = {
    type: "noul" as const,
    instructions:
      "Would a voice message suit a reply to the latest message better than text, because the " +
      "moment is emotional, playful or intimate, or calls for a sound (a laugh, a sigh, a song)?",
  };

  test("voice_moment is asked once, last, only when some candidate is auto", async () => {
    expect(Object.keys(directorQuestions([auto(RUBY), auto(KEN)]))).toEqual([
      "addressed_ruby",
      "interested_ruby",
      "addressed_ken",
      "interested_ken",
      "invites_reply",
      "voice_moment",
    ]);
    expect(directorQuestions([RUBY, auto(KEN)]).voice_moment).toEqual(VOICE_QUESTION);
    expect(directorQuestions([voiced(RUBY), KEN]).voice_moment).toBeUndefined();
    // The latest line's speaker is no candidate, so her auto asks nothing.
    const bodies: Body[] = [];
    await directorWith(answering({}, bodies)).decide(
      input([viewer("hi"), from("milky", "露比？")], {
        participants: [auto(MILKY), RUBY, KEN],
        hop: 1,
      }),
    );
    expect(bodies[0]?.questions.voice_moment).toBeUndefined();
  });

  test("each reply takes her mode: voice always, auto when voice_moment clears its bar", async () => {
    const room = [auto(MILKY), voiced(RUBY), KEN];
    const modes = async (voice_moment: number) => {
      const decision = await directorWith(
        answering({ addressed_milky: 0.9, addressed_ruby: 0.8, addressed_ken: 0.7, voice_moment }),
      ).decide(input([viewer("大家好")], { participants: room }));
      return decision.replies.map(({ persona, mode }) => `${persona} ${mode}`);
    };
    expect(await modes(VOICE_THRESHOLD)).toEqual(["milky voice", "ruby voice"]);
    expect(await modes(VOICE_THRESHOLD - 0.01)).toEqual(["milky text", "ruby voice"]);
    const ken = await directorWith(answering({ addressed_ken: 1, voice_moment: 1 })).decide(
      input([viewer("Ken?")], { participants: room }),
    );
    expect(ken.replies).toEqual([{ persona: "ken", mode: "text" }]);
    expect(ken.scores.voice_moment).toBe(1);
  });

  test("the bar drops while the viewer's last line was a voice message, hops included", async () => {
    const said = { ...viewer("今天好累"), modality: "voice" as const };
    const room = [auto(MILKY), auto(RUBY)];
    const mode = async (lines: DirectorLine[], hop: number, voice_moment: number) => {
      const decision = await directorWith(
        answering({ addressed_milky: 1, addressed_ruby: 1, invites_reply: 1, voice_moment }),
      ).decide(input(lines, { participants: room, hop }));
      return decision.replies[0]?.mode;
    };
    expect(VOICE_THRESHOLD_AFTER_VOICE).toBeLessThan(VOICE_THRESHOLD);
    expect(voiceThreshold({ lines: [said] })).toBe(VOICE_THRESHOLD_AFTER_VOICE);
    expect(voiceThreshold({ lines: [viewer("今天好累")] })).toBe(VOICE_THRESHOLD);
    expect(await mode([said], 0, VOICE_THRESHOLD_AFTER_VOICE)).toBe("voice");
    expect(await mode([viewer("今天好累")], 0, VOICE_THRESHOLD_AFTER_VOICE)).toBe("text");
    const hop = [said, { ...from("milky", "抱抱～"), modality: "voice" as const }];
    expect(await mode(hop, 1, VOICE_THRESHOLD_AFTER_VOICE)).toBe("voice");
    // A persona's voice message doesn't lower it.
    const typed = [viewer("今天好累"), { ...from("milky", "抱抱～"), modality: "voice" as const }];
    expect(await mode(typed, 1, VOICE_THRESHOLD_AFTER_VOICE)).toBe("text");
  });

  test("falling back to rules, auto is text and voice is voice", async () => {
    const decision = await new Director(null).decide(
      input([viewer("奶绿和露比")], { participants: [auto(MILKY), voiced(RUBY), KEN] }),
    );
    expect(decision.replies).toEqual([
      { persona: "milky", mode: "text" },
      { persona: "ruby", mode: "voice" },
    ]);
    expect(messages("INFO")).toEqual(["Director: 明前奶绿, 露比 in voice (fallback, hop 0)"]);
  });

  test("a chat of one in auto asks voice_moment alone, about the same state", async () => {
    const bodies: Body[] = [];
    const alone = { participants: [auto(MILKY)], hop: 0 };
    const lines = [viewer("早"), from("milky", "早呀"), viewer("想你了")];
    const decision = await directorWith(answering({ voice_moment: 0.8 }, bodies)).decide({
      ...alone,
      lines,
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.questions).toEqual({ voice_moment: VOICE_QUESTION });
    expect(bodies[0]?.state).toEqual(directorState({ ...alone, lines }));
    expect(decision).toEqual({
      replies: [{ persona: "milky", mode: "voice" }],
      source: "single",
      scores: { voice_moment: 0.8 },
    });
    expect(messages("INFO")).toHaveLength(1);
    expect(messages("INFO")[0]).toMatch(/^Director: 明前奶绿 in voice \(single, hop 0, \d+ ms\)$/);
    expect(usage).toHaveLength(1);
  });

  test("a chat of one asks nothing without auto or a model, and answers in text when Jev fails", async () => {
    let calls = 0;
    const counting = directorWith(async (url, init) => {
      calls++;
      return answering({ voice_moment: 1 })(url, init);
    });
    const line = [viewer("你好")];
    expect(await counting.decide({ participants: [voiced(MILKY)], lines: line, hop: 0 })).toEqual({
      replies: [{ persona: "milky", mode: "voice" }],
      source: "single",
      scores: {},
    });
    expect(calls).toBe(0);
    expect(
      await new Director(null).decide({ participants: [auto(MILKY)], lines: line, hop: 0 }),
    ).toEqual({ replies: [{ persona: "milky", mode: "text" }], source: "single", scores: {} });
    expect(logs.records).toEqual([]);

    const failing = directorWith(async () => new Response(null, { status: 503 }));
    expect(await failing.decide({ participants: [auto(MILKY)], lines: line, hop: 0 })).toEqual({
      replies: [{ persona: "milky", mode: "text" }],
      source: "single",
      scores: {},
    });
    expect(messages("WARNING")).toEqual([
      "Director couldn't weigh a voice reply, so she answers in text: " +
        `HTTPStatusError("Server error '503' for url '${GATE_URL}'")`,
    ]);
  });

  test("a chat of one's abort rejects with its reason", async () => {
    const controller = new AbortController();
    const director = directorWith(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const pending = director.decide(
      { participants: [auto(MILKY)], lines: [viewer("hi")], hop: 0 },
      controller.signal,
    );
    const reason = new Error("the viewer stepped in");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});

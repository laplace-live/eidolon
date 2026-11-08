import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GATE_QUESTION_KEYS, type LogRecord } from "@eidolon/config";
import type { SearchRow } from "@eidolon/retrieval";
import {
  DEFAULT_GATE_MODEL,
  GATE_FRAME_KEY,
  GATE_QUESTIONS,
  GATE_URL,
  GateDecision,
  type GateVerdict,
  gateQuestions,
  gateState,
  PersonaFacts,
  RetrievalGate,
  retrievalGateFromEnv,
  StreamArchive,
  TIMELINE_QUESTIONS,
  unlessSkipped,
} from "../src/index.ts";
import {
  captureLogs,
  deferred,
  FakeContext,
  FakeRetriever,
  MemoryCatalog,
  resetEnv,
  setEnv,
  ticks,
  turnOf,
} from "./helpers.ts";

const HIT: SearchRow[] = [{ text: "喜欢奶茶", date: "2026-09-01", stream_date: "2026-09-01" }];
const RETRIEVE: GateVerdict = { retrieve: true, timeline: false };
const SKIP: GateVerdict = { retrieve: false, timeline: false };

let logs: { records: LogRecord[]; restore: () => void };
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
  resetEnv();
});

function warnings(): string[] {
  return logs.records.filter((r) => r.level === "WARNING").map((r) => r.message);
}

/** Python's SlowSearch: blocks until released, and notices its cancellation. */
class SlowSearch {
  started = false;
  cancelled = false;
  readonly release = deferred<void>();
  readonly run = (signal: AbortSignal): Promise<SearchRow[]> => {
    this.started = true;
    return new Promise((resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          this.cancelled = true;
          reject(signal.reason);
        },
        { once: true },
      );
      this.release.promise.then(() => resolve(HIT));
    });
  };
}

type FakeFetch = (url: string, init: RequestInit) => Promise<Response>;

function gateWith(fetch: FakeFetch, options: { timeoutSec?: number } = {}): RetrievalGate {
  return new RetrievalGate({
    apiKey: "test",
    fetch: fetch as unknown as typeof globalThis.fetch,
    ...options,
  });
}

function answering(
  score: (body: Record<string, any>, name: string) => unknown,
  bodies: unknown[] = [],
) {
  return async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    return Response.json({
      answers: Object.fromEntries(
        Object.keys(body.questions).map((name) => [
          name,
          { type: "noul", noul: score(body, name) },
        ]),
      ),
    });
  };
}

function settledOf(promise: Promise<unknown>): () => boolean {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

describe("unlessSkipped (tests/test_retrieval_gate.py)", () => {
  test("test_skip_before_the_search_finishes_cancels_it", async () => {
    const search = new SlowSearch();
    const verdict = deferred<GateVerdict | undefined>();
    const pending = unlessSkipped(GateDecision.of(verdict.promise), search.run);
    await ticks();
    expect(search.started).toBe(true);
    verdict.resolve(SKIP);
    expect(await pending).toEqual([]);
    await ticks();
    expect(search.cancelled).toBe(true);
  });

  test("test_search_that_beats_the_gate_is_kept", async () => {
    const never = GateDecision.of(new Promise<GateVerdict>(() => {}));
    expect(await unlessSkipped(never, async () => HIT)).toEqual(HIT);
  });

  test("test_settled_skip_never_starts_the_search", async () => {
    const search = new SlowSearch();
    expect(await unlessSkipped(GateDecision.settled(SKIP), search.run)).toEqual([]);
    expect(search.started).toBe(false);
  });

  for (const verdict of [RETRIEVE, undefined]) {
    test(`test_retrieve_or_a_swallowed_failure_waits_for_the_search[${verdict?.retrieve}]`, async () => {
      const search = new SlowSearch();
      const decided = deferred<GateVerdict | undefined>();
      const pending = unlessSkipped(GateDecision.of(decided.promise), search.run);
      const done = settledOf(pending);
      await ticks();
      decided.resolve(verdict);
      await ticks();
      expect(done()).toBe(false);
      search.release.resolve();
      expect(await pending).toEqual(HIT);
    });
  }
});

test("the gate asks exactly the questions a persona may reword", () => {
  expect(Object.keys(GATE_QUESTIONS)).toEqual([...GATE_QUESTION_KEYS]);
});

describe("gateState and the gate (tests/test_retrieval_gate.py)", () => {
  test("test_state_is_the_latest_user_line_and_the_exchange_before_it", () => {
    const state = gateState([
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好呀" },
      { role: "system", content: "你过去在直播里说过 / 设定过的相关事实" },
      { role: "user", content: "你家有宠物吗？" },
      { role: "assistant", content: "有只猫叫坚果。" },
      { role: "assistant", content: "", tool_calls: [{ id: "x" }] },
      { role: "user", content: " 它几岁了？ " },
    ]);
    expect(state).not.toBeNull();
    expect(state?.viewer_latest_message).toBe("它几岁了？");
    expect(state?.earlier_turns).toEqual([
      { speaker: "viewer", text: "你家有宠物吗？" },
      { speaker: "streamer", text: "有只猫叫坚果。" },
    ]);
    expect(gateState([{ role: "system", content: "x" }])).toBeNull();
  });

  test("test_gate_asks_once_per_user_turn", async () => {
    const bodies: Record<string, any>[] = [];
    const gate = gateWith(
      answering((body) => (body.state.viewer_latest_message.includes("坚果") ? 0.9 : 0.05), bodies),
    );
    const context = new FakeContext([{ role: "user", content: "哈哈哈哈" }]);
    const frames: Record<string, unknown>[] = [{}, {}];
    gate.attach(context.getMessages(), frames[0] as Record<string, unknown>);
    gate.attach(context.getMessages(), frames[1] as Record<string, unknown>);
    context.add({ role: "assistant", content: "嘿嘿" });
    context.add({ role: "user", content: "坚果几岁了？" });
    frames.push({});
    gate.attach(context.getMessages(), frames[2] as Record<string, unknown>);
    const decisions = frames.map((frame) => frame[GATE_FRAME_KEY] as GateDecision);
    expect(decisions[0]).toBe(decisions[1] as GateDecision);
    const verdicts = await Promise.all(decisions.map((d) => d.value()));
    expect(verdicts.map((v) => v?.retrieve)).toEqual([false, false, true]);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.model).toBe(DEFAULT_GATE_MODEL);
  });

  test("test_gate_fails_open_when_the_decision_route_errors", async () => {
    const gate = gateWith(async () => new Response(null, { status: 503 }));
    const metadata: Record<string, unknown> = {};
    gate.attach([{ role: "user", content: "哈哈哈哈" }], metadata);
    expect(await (metadata[GATE_FRAME_KEY] as GateDecision).value()).toEqual(RETRIEVE);
  });

  test("test_both_tiers_search_only_turns_the_gate_lets_through", async () => {
    const factsRetriever = new FakeRetriever(HIT);
    const archiveRetriever = new FakeRetriever(HIT);
    const facts = new PersonaFacts({ retriever: factsRetriever });
    const archive = new StreamArchive({
      retriever: archiveRetriever,
      catalog: new MemoryCatalog([]),
      timeZone: "UTC",
    });
    for (const [text, verdict] of [
      ["我今天加班好累啊。", false],
      ["你最喜欢吃什么呀？", true],
    ] as const) {
      const context = new FakeContext([{ role: "user", content: text }]);
      const metadata = {
        [GATE_FRAME_KEY]: GateDecision.settled({ retrieve: verdict, timeline: false }),
      };
      await archive.onContext(turnOf(context, metadata));
      await facts.onContext(turnOf(context, metadata));
    }
    expect(factsRetriever.calls.map((call) => call.query)).toEqual(["你最喜欢吃什么呀？"]);
    expect(archiveRetriever.calls.map((call) => call.query)).toEqual(["你最喜欢吃什么呀？"]);
  });
});

describe("gateState", () => {
  test("ignores assistant turns after the latest user line", () => {
    const state = gateState([
      { role: "user", content: "q" },
      { role: "assistant", content: "r" },
    ]);
    expect(state).toEqual({
      streamer: state?.streamer as string,
      earlier_turns: [],
      viewer_latest_message: "q",
    });
  });

  test("keeps two consecutive user lines as earlier turns", () => {
    const state = gateState([
      { role: "user", content: "a" },
      { role: "user", content: "b" },
      { role: "user", content: "c" },
    ]);
    expect(state?.earlier_turns).toEqual([
      { speaker: "viewer", text: "a" },
      { speaker: "viewer", text: "b" },
    ]);
    expect(state?.viewer_latest_message).toBe("c");
  });

  test("list content is not a turn, and objects without a role are skipped", () => {
    expect(gateState([{ role: "user", content: [{ type: "text", text: "hi" }] }])).toBeNull();
    const state = gateState([
      { llm: "openai", message: { role: "user", content: "x" } },
      { role: "user", content: "hello" },
    ]);
    expect(state?.earlier_turns).toEqual([]);
  });
});

describe("RetrievalGate.decide", () => {
  const state = gateState([
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好呀" },
    { role: "user", content: "你家有宠物吗？" },
  ]);

  test("posts the model, state and questions to the decisions route with attribution", async () => {
    setEnv("OPENROUTER_APP_NAME", undefined);
    setEnv("OPENROUTER_APP_URL", undefined);
    const requests: { url: string; init: RequestInit }[] = [];
    const gate = gateWith(async (url, init) => {
      requests.push({ url, init });
      return answering(() => 0.9)(url, init);
    });
    expect((await gate.decide(state)).retrieve).toBe(true);
    const [request] = requests;
    expect(request?.url).toBe(GATE_URL);
    expect(request?.init.method).toBe("POST");
    expect(request?.init.headers).toEqual({
      "HTTP-Referer": "https://laplace.live/ai",
      "X-Title": "LAPLACE Live!",
      "X-OpenRouter-Title": "LAPLACE Live!",
      "X-OpenRouter-Categories": "roleplay",
      Authorization: "Bearer test",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(request?.init.body));
    expect(Object.keys(body)).toEqual(["model", "state", "questions"]);
    expect(body.state).toEqual(state);
    expect(Object.keys(body.questions)).toEqual([
      "about_her",
      "her_past",
      "named_thing",
      "last_time",
      "first_time",
      "how_often",
    ]);
    expect(body.questions).toEqual({ ...gateQuestions(), ...TIMELINE_QUESTIONS });
    expect(body.questions.about_her.instructions).toBe(
      "Is the viewer's latest message asking about the streamer herself — her preferences, " +
        "opinions, habits, abilities, body, family, pets, friends, relationships, backstory, " +
        "or her flower shop?",
    );
  });

  test("a null state asks nothing and retrieves", async () => {
    let calls = 0;
    const gate = gateWith(async () => {
      calls++;
      return new Response("{}");
    });
    expect(await gate.decide(null)).toEqual(RETRIEVE);
    expect(calls).toBe(0);
  });

  test("the threshold is inclusive", async () => {
    expect((await gateWith(answering(() => 0.3)).decide(state)).retrieve).toBe(true);
    expect((await gateWith(answering(() => 0.2999)).decide(state)).retrieve).toBe(false);
    const info = logs.records.find((r) => r.level === "INFO")?.message;
    expect(info).toMatch(
      /^Retrieval gate: retrieve query='你家有宠物吗？' \(score=0\.30, timeline=0\.30, \d+ ms\)$/,
    );
  });

  test("the score is the highest noul of the three", async () => {
    const nouls: Record<string, number> = { about_her: 0.1, her_past: 0.5, named_thing: 0.2 };
    const gate = gateWith(answering((_body, name) => nouls[name] ?? 0.9));
    expect((await gate.decide(state)).retrieve).toBe(true);
    expect(logs.records.at(-1)?.message).toContain("(score=0.50, ");
  });

  test("the timeline questions decide the timeline alone, at 0.7 inclusive", async () => {
    const scoring = (gateScore: number, timelineScore: number) =>
      answering((_body, name) =>
        Object.hasOwn(TIMELINE_QUESTIONS, name) ? timelineScore : gateScore,
      );
    expect(await gateWith(scoring(0.9, 0.7)).decide(state)).toEqual({
      retrieve: true,
      timeline: true,
    });
    expect(logs.records.at(-1)?.message).toMatch(
      /^Retrieval gate: retrieve \+ timeline query='你家有宠物吗？' \(score=0\.90, timeline=0\.70, /,
    );
    expect(await gateWith(scoring(0.9, 0.6999)).decide(state)).toEqual(RETRIEVE);
    expect(await gateWith(scoring(0.1, 0.9)).decide(state)).toEqual({
      retrieve: false,
      timeline: true,
    });
  });

  test("numeric strings and booleans count as Python float() reads them", async () => {
    expect((await gateWith(answering(() => " 0.9 ")).decide(state)).retrieve).toBe(true);
    expect((await gateWith(answering(() => true)).decide(state)).retrieve).toBe(true);
    expect((await gateWith(answering(() => "1_0e-2")).decide(state)).retrieve).toBe(false);
    // NaN never compares >= 0.3, so Python skipped; parity keeps it.
    expect((await gateWith(answering(() => "nan")).decide(state)).retrieve).toBe(false);
    expect(warnings()).toEqual([]);
  });

  const failures: [string, FakeFetch][] = [
    ["a 5xx", async () => new Response("busy", { status: 503 })],
    ["a redirect", async () => new Response(null, { status: 302, headers: { location: "/x" } })],
    ["invalid JSON", async () => new Response("not json")],
    ["a non-object body", async () => Response.json([1, 2])],
    ["missing answers", async () => Response.json({ model: "x" })],
    [
      "a missing answer",
      async () => Response.json({ answers: { about_her: { noul: 0.9 }, her_past: { noul: 0.9 } } }),
    ],
    ["a null noul", answering(() => null)],
    ["a non-numeric noul", answering(() => "abc")],
    ["an object noul", answering(() => ({ value: 0.9 }))],
    [
      "a transport error",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
  ];
  for (const [name, fetch] of failures) {
    test(`fails open on ${name}`, async () => {
      expect((await gateWith(fetch).decide(state)).retrieve).toBe(true);
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toStartWith("Retrieval gate failed open: ");
    });
  }

  test("fails open when the decision times out", async () => {
    const gate = gateWith(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
      { timeoutSec: 0.05 },
    );
    expect((await gate.decide(state)).retrieve).toBe(true);
    expect(warnings()[0]).toBe(
      "Retrieval gate failed open: TimeoutError('The operation timed out.')",
    );
  });

  test("a 5xx logs like httpx's raise_for_status", async () => {
    await gateWith(async () => new Response(null, { status: 503 })).decide(state);
    expect(warnings()[0]).toBe(
      `Retrieval gate failed open: HTTPStatusError("Server error '503' for url '${GATE_URL}'")`,
    );
  });

  test("a missing answer logs a KeyError", async () => {
    await gateWith(async () => Response.json({ answers: {} })).decide(state);
    expect(warnings()[0]).toBe("Retrieval gate failed open: KeyError('about_her')");
  });

  test("a missing timeline answer costs only the timeline, never the skip", async () => {
    const onlyTheGates = async () =>
      Response.json({
        answers: Object.fromEntries(
          Object.keys(GATE_QUESTIONS).map((name) => [name, { noul: 0.1 }]),
        ),
      });
    expect(await gateWith(onlyTheGates).decide(state)).toEqual(SKIP);
    expect(warnings()).toEqual([
      "Retrieval gate's timeline answer unreadable: KeyError('last_time')",
    ]);
  });
});

describe("RetrievalGate.forTurn", () => {
  test("a repeated user text on a new turn asks again", async () => {
    const bodies: unknown[] = [];
    const gate = gateWith(answering(() => 0.9, bodies));
    const context = new FakeContext([{ role: "user", content: "坚果几岁了？" }]);
    const first = gate.forTurn(context.getMessages());
    expect(gate.forTurn(context.getMessages())).toBe(first);
    context.add({ role: "developer", content: "memories" });
    context.add({ role: "tool", content: "result" });
    expect(gate.forTurn(context.getMessages())).toBe(first);
    context.add({ role: "assistant", content: "三岁。" });
    context.add({ role: "user", content: "坚果几岁了？" });
    expect(gate.forTurn(context.getMessages())).not.toBe(first);
    await ticks(20);
    expect(bodies).toHaveLength(2);
  });

  test("a context without a user line retrieves without asking", async () => {
    let calls = 0;
    const gate = gateWith(async () => {
      calls++;
      return Response.json({});
    });
    expect(await gate.forTurn([{ role: "system", content: "x" }]).value()).toEqual(RETRIEVE);
    expect(calls).toBe(0);
  });
});

describe("retrievalGateFromEnv", () => {
  test("RETRIEVAL_GATE_ENABLED switches it off", () => {
    setEnv("OPENROUTER_API_KEY", "key");
    for (const value of [" Off ", "0", "no", "FALSE"]) {
      setEnv("RETRIEVAL_GATE_ENABLED", value);
      expect(retrievalGateFromEnv()).toBeNull();
    }
    expect(logs.records.at(-1)?.message).toBe(
      "RETRIEVAL_GATE_ENABLED is off — every turn searches both LanceDB tiers",
    );
    for (const value of ["", "true", "maybe"]) {
      setEnv("RETRIEVAL_GATE_ENABLED", value);
      expect(retrievalGateFromEnv()).not.toBeNull();
    }
  });

  test("an empty key disables it silently; an empty model is the default", () => {
    setEnv("RETRIEVAL_GATE_ENABLED", undefined);
    setEnv("OPENROUTER_API_KEY", "");
    expect(retrievalGateFromEnv()).toBeNull();
    expect(logs.records).toEqual([]);
    setEnv("OPENROUTER_API_KEY", "key");
    setEnv("RETRIEVAL_GATE_MODEL", "");
    expect(retrievalGateFromEnv()?.model).toBe(DEFAULT_GATE_MODEL);
    expect(logs.records.at(-1)?.message).toBe(
      "Retrieval gate enabled: model='~typesafe/jev-latest'",
    );
    setEnv("RETRIEVAL_GATE_MODEL", "typesafe/jev-1.13");
    expect(retrievalGateFromEnv()?.model).toBe("typesafe/jev-1.13");
  });
});

describe("unlessSkipped", () => {
  test("an outer abort while waiting rejects and aborts the search", async () => {
    const search = new SlowSearch();
    const outer = new AbortController();
    const pending = unlessSkipped(GateDecision.of(new Promise(() => {})), search.run, outer.signal);
    await ticks();
    const reason = new Error("interrupted");
    outer.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await ticks();
    expect(search.cancelled).toBe(true);
  });

  test("an already aborted signal never starts the search", async () => {
    const search = new SlowSearch();
    const outer = new AbortController();
    outer.abort(new Error("gone"));
    await expect(unlessSkipped(null, search.run, outer.signal)).rejects.toThrow("gone");
    expect(search.started).toBe(false);
  });

  test("a search that fails first propagates even when a skip follows", async () => {
    const verdict = deferred<GateVerdict | undefined>();
    const failure = new Error("lancedb down");
    const pending = unlessSkipped(GateDecision.of(verdict.promise), async () => {
      throw failure;
    });
    await ticks();
    verdict.resolve(SKIP);
    await expect(pending).rejects.toBe(failure);
  });

  test("a skip that settles after the search finished keeps the result", async () => {
    const verdict = deferred<GateVerdict | undefined>();
    const decision = GateDecision.of(verdict.promise);
    const result = await unlessSkipped(decision, async () => HIT);
    verdict.resolve(SKIP);
    await decision.whenSettled;
    expect(result).toEqual(HIT);
    expect(decision.saidSkip).toBe(true);
  });

  test("no decision just searches", async () => {
    expect(await unlessSkipped(null, async () => HIT)).toEqual(HIT);
    expect(await unlessSkipped(undefined, async () => HIT)).toEqual(HIT);
  });

  test("an early skip leaves no unhandled rejection behind", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const search = new SlowSearch();
      const verdict = deferred<GateVerdict | undefined>();
      const pending = unlessSkipped(GateDecision.of(verdict.promise), search.run);
      await ticks();
      verdict.resolve(SKIP);
      expect(await pending).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(search.cancelled).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("GateDecision", () => {
  test("a rejected verdict settles as retrieve", async () => {
    const decision = GateDecision.of(Promise.reject(new Error("task failed")));
    expect(decision.done).toBe(false);
    expect(await decision.value()).toBeUndefined();
    expect(decision.done).toBe(true);
    expect(decision.saidSkip).toBe(false);
  });

  test("only an explicit false skips", async () => {
    for (const verdict of [undefined, RETRIEVE]) {
      const decision = GateDecision.of(Promise.resolve(verdict));
      await decision.whenSettled;
      expect(decision.saidSkip).toBe(false);
    }
    const skip = GateDecision.of(Promise.resolve(SKIP));
    expect(skip.saidSkip).toBe(false);
    await skip.whenSettled;
    expect(skip.saidSkip).toBe(true);
    expect(GateDecision.settled(SKIP).saidSkip).toBe(true);
    expect(GateDecision.settled(undefined).done).toBe(true);
  });

  test("asks for a timeline only once settled with one", async () => {
    const verdict = deferred<GateVerdict | undefined>();
    const decision = GateDecision.of(verdict.promise);
    expect(decision.asksTimeline).toBe(false);
    verdict.resolve({ retrieve: true, timeline: true });
    await decision.whenSettled;
    expect(decision.asksTimeline).toBe(true);
    expect(GateDecision.settled(RETRIEVE).asksTimeline).toBe(false);
    expect(GateDecision.settled(undefined).asksTimeline).toBe(false);
    const failed = GateDecision.of(Promise.reject(new Error("task failed")));
    await failed.whenSettled;
    expect(failed.asksTimeline).toBe(false);
  });
});

import type { Direction } from "@laplace.live/eidolon-sdk/avatar";
import { describe, expect, test } from "vitest";
import { type CallPhase, IDLE, type PhaseEvent, reducePhase } from "@/features/call/phase";
import { type CallTarget, type CastMember, chatTarget, soloTarget } from "@/features/call/target";
import type { Status } from "@/lib/api";
import { FeedLink, feedState, MOUTH_SEND_MS, MOUTH_SLACK_MS, mouthLevel } from "./feed-link";
import type { PortLike } from "./page-port";
import type { ChatFact, CompanionCall, ToApp } from "./protocol";

/** One end of a port: what this side posted, and the other side's messages and close by hand. */
function fakePort() {
  const posted: unknown[] = [];
  const closers: (() => void)[] = [];
  let closed = false;
  const port: PortLike = {
    onmessage: null,
    postMessage: (message) => posted.push(message),
    close: () => {
      closed = true;
    },
    addEventListener: (type, listener) => {
      if (type === "close") closers.push(listener);
    },
  };
  return {
    port,
    posted,
    get closed() {
      return closed;
    },
    deliver: (data: unknown) => port.onmessage?.({ data } as MessageEvent),
    /** The other end went. */
    end: () => {
      for (const listener of closers) listener();
    },
  };
}

function feedLink() {
  let now = 0;
  const received: ToApp[] = [];
  const link = new FeedLink(
    (message) => received.push(message),
    () => now,
  );
  return { link, received, at: (ms: number) => (now = ms) };
}

const CALL: CompanionCall = { up: true, live: true, hers: true, micOn: true, callable: false };

/** A direction made anew at each call, as directionOf makes one. */
function direction(fields: Partial<Direction> = {}): Direction {
  return {
    persona: null,
    mood: ["happy"],
    pulse: null,
    speaking: true,
    listening: false,
    thinking: false,
    looking: "idle",
    gesture: { name: "nod", seq: 1 },
    ...fields,
  };
}

const FACT: ChatFact = {
  type: "said",
  persona: "milky-green",
  chat: "0199a3f2-7c1e-7d40-9b6a-3f5e8c2d1a07",
  seq: 3,
  text: "[开心地] 在呀！",
};

describe("FeedLink", () => {
  test("sends nothing before a port, then the last persona and call told", () => {
    const { link } = feedLink();
    link.persona("milky-green", "tml:abc:1");
    link.call({ ...CALL, live: false });
    link.call(CALL);
    link.direction(direction());
    link.mouth(0.5);
    link.chat(FACT);
    expect(link.linked).toBe(false);
    const one = fakePort();
    link.connect(one.port);
    expect(link.linked).toBe(true);
    expect(one.posted).toEqual([
      { type: "persona", id: "milky-green", stamp: "tml:abc:1" },
      { type: "call", call: CALL },
    ]);
  });

  test("sends a persona or a call only when it changed", () => {
    const { link } = feedLink();
    const one = fakePort();
    link.connect(one.port);
    link.persona("milky-green", "");
    link.persona("milky-green", "");
    link.persona("milky-green", "tml:abc:1");
    link.call(CALL);
    link.call({ ...CALL });
    link.call({ ...CALL, micOn: false });
    expect(one.posted).toEqual([
      { type: "persona", id: "milky-green", stamp: "" },
      { type: "persona", id: "milky-green", stamp: "tml:abc:1" },
      { type: "call", call: CALL },
      { type: "call", call: { ...CALL, micOn: false } },
    ]);
  });

  test("sends a call again when any one of its fields changes", () => {
    for (const field of ["up", "live", "hers", "micOn", "callable"] as const) {
      const { link } = feedLink();
      const one = fakePort();
      link.connect(one.port);
      link.call(CALL);
      link.call({ ...CALL, [field]: !CALL[field] });
      expect([field, one.posted.length]).toEqual([field, 2]);
    }
  });

  test("sends a direction again when any one field it compares changes", () => {
    const changes: readonly Partial<Direction>[] = [
      { persona: "milky-green" },
      { mood: ["sad"] },
      { mood: [] },
      { pulse: "shy" },
      { speaking: false },
      { listening: true },
      { thinking: true },
      { looking: "viewer" },
      { gesture: { name: "shake", seq: 1 } },
      { gesture: { name: "nod", seq: 2 } },
      { gesture: null },
    ];
    for (const change of changes) {
      const { link } = feedLink();
      const one = fakePort();
      link.connect(one.port);
      link.direction(direction());
      link.direction(direction(change));
      link.direction(direction(change));
      expect([change, one.posted.length]).toEqual([change, 2]);
    }
  });

  test("sends a direction that differs, field by field, from the last one sent to this port", () => {
    const { link } = feedLink();
    const one = fakePort();
    link.connect(one.port);
    link.direction(direction());
    link.direction(direction());
    link.direction(direction({ gesture: { name: "nod", seq: 2 } }));
    link.direction(direction({ gesture: { name: "nod", seq: 2 } }));
    link.direction(direction({ gesture: { name: "nod", seq: 2 }, mood: ["happy", "shy"] }));
    expect(one.posted.map((message) => (message as { direction: Direction }).direction)).toEqual([
      direction(),
      direction({ gesture: { name: "nod", seq: 2 } }),
      direction({ gesture: { name: "nod", seq: 2 }, mood: ["happy", "shy"] }),
    ]);
    // A new port gets the direction as it stands, unchanged or not.
    const two = fakePort();
    link.connect(two.port);
    link.direction(direction({ gesture: { name: "nod", seq: 2 }, mood: ["happy", "shy"] }));
    expect(two.posted).toEqual([
      {
        type: "direction",
        direction: direction({ gesture: { name: "nod", seq: 2 }, mood: ["happy", "shy"] }),
      },
    ]);
  });

  test("sends the widest mouth level at most every MOUTH_SEND_MS", () => {
    const { link, at } = feedLink();
    const one = fakePort();
    link.connect(one.port);
    const levels = () => one.posted.map((message) => (message as { level: number }).level);
    at(0);
    link.mouth(0.2);
    at(20);
    link.mouth(0.7);
    expect(levels()).toEqual([0.2]);
    at(MOUTH_SEND_MS);
    link.mouth(0.1);
    expect(levels()).toEqual([0.2, 0.7]);
    at(40);
    link.mouth(0.3);
    at(50);
    link.mouth(0.1);
    expect(levels()).toEqual([0.2, 0.7]);
    at(2 * MOUTH_SEND_MS);
    link.mouth(0);
    expect(levels()).toEqual([0.2, 0.7, 0.3]);
  });

  test("lets a timer's run come up to MOUTH_SLACK_MS early, never pulling the next one earlier", () => {
    const { link, at } = feedLink();
    const one = fakePort();
    link.connect(one.port);
    at(0);
    link.mouth(0.1);
    at(MOUTH_SEND_MS - MOUTH_SLACK_MS);
    link.mouth(0.2);
    // Due at twice MOUTH_SEND_MS, not a period after the early one.
    at(2 * MOUTH_SEND_MS - MOUTH_SLACK_MS - 1);
    link.mouth(0.3);
    at(2 * MOUTH_SEND_MS - MOUTH_SLACK_MS);
    link.mouth(0.4);
    expect(one.posted).toEqual([
      { type: "mouth", level: 0.1 },
      { type: "mouth", level: 0.2 },
      { type: "mouth", level: 0.4 },
    ]);
  });

  test("keeps about 30 a second on a timer whose runs come 28 and 38 ms apart, and no more on a faster one", () => {
    /** When a timer whose runs come `gaps` apart, in turn, sent her mouth in one second. */
    const sent = (gaps: readonly number[]): number[] => {
      const { link, at } = feedLink();
      const one = fakePort();
      link.connect(one.port);
      const times: number[] = [];
      for (let now = 0, run = 0; now < 1000; now += gaps[run++ % gaps.length]) {
        at(now);
        const before = one.posted.length;
        link.mouth(0.5);
        if (one.posted.length > before) times.push(now);
      }
      return times;
    };
    expect(sent([28, 38]).length).toBeGreaterThanOrEqual(29);
    const fast = sent([5]);
    expect(fast.length).toBeLessThanOrEqual(31);
    const closest = Math.min(...fast.slice(1).map((time, index) => time - fast[index]));
    expect(closest).toBeGreaterThanOrEqual(MOUTH_SEND_MS - MOUTH_SLACK_MS);
  });

  test("sends the chat facts of the persona told alone, as told", () => {
    const { link } = feedLink();
    const one = fakePort();
    link.connect(one.port);
    link.chat(FACT);
    link.persona("milky-green", "");
    link.chat(FACT);
    link.chat({ ...FACT, persona: "hazel" });
    expect(one.posted).toEqual([{ type: "persona", id: "milky-green", stamp: "" }, FACT]);
  });

  test("hands on only her appearance changing from the companion's page", () => {
    const { link, received } = feedLink();
    const one = fakePort();
    link.connect(one.port);
    one.deliver({ type: "appearance", persona: "milky-green" });
    one.deliver({ type: "call" });
    one.deliver({ type: "mic", on: false });
    one.deliver({ type: "dance" });
    one.deliver("appearance");
    expect(received).toEqual([{ type: "appearance", persona: "milky-green" }]);
  });

  test("unlinks at the other end's close or a disconnect, and sends nothing until the next port", () => {
    const { link } = feedLink();
    const one = fakePort();
    link.connect(one.port);
    one.end();
    expect(link.linked).toBe(false);
    link.call(CALL);
    link.direction(direction());
    link.mouth(0.5);
    link.chat(FACT);
    expect(one.posted).toEqual([]);
    const two = fakePort();
    link.connect(two.port);
    expect(two.posted).toEqual([{ type: "call", call: CALL }]);
    link.disconnect();
    expect(two.closed).toBe(true);
    expect(link.linked).toBe(false);
    link.chat(FACT);
    expect(two.posted).toHaveLength(1);
  });

  test("a second port closes the first, whose messages and close then do nothing", () => {
    const { link, received } = feedLink();
    const one = fakePort();
    const two = fakePort();
    link.connect(one.port);
    link.connect(two.port);
    expect(one.closed).toBe(true);
    one.deliver({ type: "appearance", persona: "milky-green" });
    one.end();
    expect(received).toEqual([]);
    expect(link.linked).toBe(true);
    link.persona("milky-green", "");
    link.chat(FACT);
    expect(two.posted.at(-1)).toEqual(FACT);
    expect(one.posted).toEqual([]);
  });
});

const MILKY: CastMember = {
  id: "milky-green",
  name: "明前奶绿",
  shortName: "奶绿",
  avatar: false,
  appearance: { model: null },
};
const HAZEL: CastMember = { ...MILKY, id: "hazel", name: "Hazel", shortName: "Hazel" };

const READY = {
  keys: [{ account: "fish", name: "Fish Audio", provider: "fish", roles: ["voice"], set: true }],
  call: { realtime: false, roles: [] },
  persona: { id: "milky-green", voice: { id: "a-voice" } },
} as unknown as Pick<Status, "keys" | "call" | "persona">;

function run(...events: PhaseEvent[]): CallPhase {
  return events.reduce(reducePhase, IDLE);
}

const STARTING = run({ type: "start", at: 1 });
const LIVE = run({ type: "start", at: 1 }, { type: "dial" }, { type: "ready" });
const ENDING = reducePhase(LIVE, { type: "hang-up" });

describe("feedState", () => {
  const idle = { target: null, phase: IDLE, up: false, micOn: true };

  test("with no status, nothing is hers and nothing callable", () => {
    expect(feedState(undefined, idle)).toEqual({
      persona: null,
      call: { up: false, live: false, hers: false, micOn: true, callable: false },
      key: undefined,
      feeding: false,
    });
    const up = { target: soloTarget(MILKY), phase: LIVE, up: true, micOn: true };
    expect([feedState(undefined, up).call.hers, feedState(undefined, up).feeding]).toEqual([
      false,
      false,
    ]);
  });

  test("a ready status with no call up calls", () => {
    expect(feedState(READY, idle)).toEqual({
      persona: "milky-green",
      call: { up: false, live: false, hers: false, micOn: true, callable: true },
      key: undefined,
      feeding: false,
    });
  });

  test("feeds her only while a call of hers is up, starting or live", () => {
    const feeding = (target: CallTarget | null, phase: CallPhase, up: boolean) =>
      feedState(READY, { target, phase, up, micOn: true }).feeding;
    expect(feeding(soloTarget(MILKY), STARTING, true)).toBe(true);
    expect(feeding(soloTarget(MILKY), LIVE, true)).toBe(true);
    expect(feeding(chatTarget("c1", HAZEL, [HAZEL, MILKY]), LIVE, true)).toBe(true);
    expect(feeding(chatTarget("c1", HAZEL, null), LIVE, true)).toBe(false);
    expect(feeding(soloTarget(MILKY), IDLE, false)).toBe(false);
    expect(feeding(null, IDLE, false)).toBe(false);
  });

  test("/call's call with her is hers, her direction its own", () => {
    const state = feedState(READY, {
      target: soloTarget(MILKY),
      phase: LIVE,
      up: true,
      micOn: false,
    });
    expect(state.call).toEqual({ up: true, live: true, hers: true, micOn: false, callable: false });
    expect(state.key).toBeUndefined();
  });

  test("a group chat's call with her is hers, under her own id", () => {
    const target = chatTarget("c1", HAZEL, [HAZEL, MILKY]);
    const state = feedState(READY, { target, phase: LIVE, up: true, micOn: true });
    expect([state.call.hers, state.key]).toEqual([true, "milky-green"]);
  });

  test("a chat's call with another persona isn't hers", () => {
    const target = chatTarget("c1", HAZEL, null);
    const state = feedState(READY, { target, phase: LIVE, up: true, micOn: true });
    expect([state.call.hers, state.call.callable, state.key]).toEqual([false, false, undefined]);
  });

  test("is live only in the live phase", () => {
    const target = soloTarget(MILKY);
    for (const [phase, up, live] of [
      [STARTING, true, false],
      [LIVE, true, true],
      [ENDING, true, false],
      [IDLE, false, false],
    ] as const) {
      expect(feedState(READY, { target, phase, up, micOn: true }).call.live).toBe(live);
    }
  });

  test("calls nothing while a blocker stands", () => {
    const noKey = { ...READY, keys: [{ ...READY.keys[0], set: false }] } as typeof READY;
    expect(feedState(noKey, idle).call.callable).toBe(false);
  });
});

describe("mouthLevel", () => {
  test("is the meter's alone on a call of one, and on a group call only while she speaks", () => {
    expect(mouthLevel(0.6, undefined, () => false)).toBe(0.6);
    expect(mouthLevel(0.6, "milky-green", () => false)).toBe(0);
    expect(mouthLevel(0.6, "milky-green", (key) => key === "milky-green")).toBe(0.6);
  });
});

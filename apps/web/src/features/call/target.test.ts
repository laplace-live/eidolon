import { describe, expect, test } from "vitest";
import type { ActiveCharacterModel } from "@/lib/api";
import { type CallPhase, IDLE, type PhaseEvent, reducePhase } from "./phase";
import {
  barShown,
  type CallTarget,
  type CastMember,
  callPath,
  chatCallView,
  chatTarget,
  hungUp,
  isUp,
  offerData,
  opensVideo,
  outlived,
  soloCallView,
  soloTarget,
} from "./target";

function run(...events: PhaseEvent[]): CallPhase {
  return events.reduce(reducePhase, IDLE);
}

const START: PhaseEvent = { type: "start", at: 1 };
const DIAL: PhaseEvent = { type: "dial" };
const READY: PhaseEvent = { type: "ready" };
const STARTING = run(START);
const CONNECTING = run(START, DIAL);
const LIVE = run(START, DIAL, READY);
const ENDING = run(START, DIAL, READY, { type: "hang-up" });
const HUNG_UP = run(
  START,
  DIAL,
  READY,
  { type: "hang-up" },
  {
    type: "disconnected",
    at: 9,
    end: { kind: "hung-up" },
  },
);
const DROPPED = run(START, DIAL, READY, {
  type: "disconnected",
  at: 9,
  end: { kind: "dropped", byBot: false },
});
const PHASES = { IDLE, STARTING, CONNECTING, LIVE, ENDING, HUNG_UP, DROPPED };

const MODEL: ActiveCharacterModel = {
  id: "tml",
  name: "TML",
  kind: "psd2live",
  sha256: "0".repeat(64),
  updatedAt: "2026-11-23T00:00:00.000Z",
};

function member(id: string, model: ActiveCharacterModel | null = null): CastMember {
  return { id, name: `${id} name`, shortName: id, avatar: false, appearance: { model } };
}

const MILKY = member("milky-green");
const HAZEL = member("hazel");
const ROSE = member("rose");

describe("a call's target", () => {
  test("lives on /call, or on its chat's page", () => {
    expect(callPath(soloTarget(MILKY))).toBe("/call");
    expect(callPath(chatTarget("c1", MILKY, null))).toBe("/chats/c1");
  });

  test("offers no chat on /call; the host, and group only on a group call, in a chat", () => {
    expect(offerData(soloTarget(MILKY))).toBeUndefined();
    expect(offerData(chatTarget("c1", HAZEL, null))).toEqual({ chatId: "c1", persona: "hazel" });
    expect(offerData(chatTarget("c1", HAZEL, [MILKY, HAZEL]))).toEqual({
      chatId: "c1",
      persona: "hazel",
      group: true,
    });
  });

  test("puts the host first, once, before everyone else", () => {
    expect(chatTarget("c1", HAZEL, null)).toEqual({
      kind: "chat",
      chatId: "c1",
      group: false,
      cast: [HAZEL],
    });
    const group = chatTarget("c1", HAZEL, [MILKY, HAZEL, ROSE]);
    expect(group.kind === "chat" && group.group).toBe(true);
    expect(group.cast.map((each) => each.id)).toEqual(["hazel", "milky-green", "rose"]);
  });

  test("opens as video when anyone on it had a model as it was placed", () => {
    expect(opensVideo(chatTarget("c1", MILKY, [MILKY, HAZEL, ROSE]))).toBe(false);
    expect(opensVideo(soloTarget(member("milky-green", MODEL)))).toBe(true);
    expect(opensVideo(chatTarget("c1", MILKY, [MILKY, member("hazel", MODEL), ROSE]))).toBe(true);
  });
});

describe("a call's phase", () => {
  test("is up from starting through ending, and hung up only when the viewer ended it", () => {
    const up = Object.entries(PHASES).filter(([, phase]) => isUp(phase));
    expect(up.map(([name]) => name)).toEqual(["STARTING", "CONNECTING", "LIVE", "ENDING"]);
    const hung = Object.entries(PHASES).filter(([, phase]) => hungUp(phase));
    expect(hung.map(([name]) => name)).toEqual(["HUNG_UP"]);
  });
});

describe("barShown", () => {
  const chat = chatTarget("c1", MILKY, null);

  test("shows a call no view shows, up or ended on its own, until it is closed", () => {
    expect(barShown({ target: null, phase: LIVE, shown: false })).toBe(false);
    expect(barShown({ target: chat, phase: IDLE, shown: false })).toBe(false);
    expect(barShown({ target: chat, phase: LIVE, shown: true })).toBe(false);
    // On another page, or on its own page while that throws.
    expect(barShown({ target: chat, phase: LIVE, shown: false })).toBe(true);
    expect(barShown({ target: chat, phase: CONNECTING, shown: false })).toBe(true);
    expect(barShown({ target: chat, phase: HUNG_UP, shown: false })).toBe(false);
    expect(barShown({ target: chat, phase: HUNG_UP, shown: true })).toBe(false);
    expect(barShown({ target: chat, phase: DROPPED, shown: false })).toBe(true);
    expect(barShown({ target: chat, phase: DROPPED, shown: true })).toBe(false);
  });
});

describe("outlived", () => {
  const solo = soloTarget(MILKY);

  test("forgets a /call call once it is over and its persona is no longer active", () => {
    expect(outlived({ target: solo, phase: DROPPED }, "milky-green")).toBe(false);
    expect(outlived({ target: solo, phase: HUNG_UP }, "hazel")).toBe(true);
    expect(outlived({ target: solo, phase: LIVE }, "hazel")).toBe(false);
    expect(outlived({ target: chatTarget("c1", MILKY, null), phase: DROPPED }, "hazel")).toBe(
      false,
    );
    expect(outlived({ target: null, phase: DROPPED }, "hazel")).toBe(false);
    expect(outlived({ target: solo, phase: DROPPED }, null)).toBe(false);
  });
});

describe("chatCallView", () => {
  const mine = chatTarget("c1", MILKY, null);
  const view = (
    target: CallTarget | null,
    phase: CallPhase,
    o: { layout?: "screen" | "dock"; video?: boolean } = {},
  ) => chatCallView({ target, phase, layout: o.layout ?? "screen", video: o.video ?? true }, "c1");

  test("shows nothing without a call", () => {
    expect(view(null, IDLE)).toEqual({
      mine: false,
      calling: false,
      elsewhere: false,
      video: false,
      docked: false,
    });
  });

  test("shows this chat's live call on its screen, or in the dock", () => {
    expect(view(mine, LIVE)).toEqual({
      mine: true,
      calling: true,
      elsewhere: false,
      video: true,
      docked: false,
    });
    expect(view(mine, LIVE, { layout: "dock" })).toEqual({
      mine: true,
      calling: true,
      elsewhere: false,
      video: false,
      docked: true,
    });
    expect(view(mine, LIVE, { video: false })).toMatchObject({ video: false, docked: true });
  });

  test("says a call is up elsewhere: another chat's, or /call's", () => {
    expect(view(chatTarget("c2", MILKY, null), LIVE)).toEqual({
      mine: false,
      calling: false,
      elsewhere: true,
      video: false,
      docked: false,
    });
    expect(view(soloTarget(MILKY), LIVE)).toMatchObject({ mine: false, elsewhere: true });
  });

  test("leaves nothing of a hung-up call, and docks one that ended on its own", () => {
    expect(view(mine, HUNG_UP)).toEqual({
      mine: true,
      calling: false,
      elsewhere: false,
      video: false,
      docked: false,
    });
    expect(view(mine, DROPPED)).toEqual({
      mine: true,
      calling: false,
      elsewhere: false,
      video: false,
      docked: true,
    });
  });
});

describe("soloCallView", () => {
  const solo = soloTarget(MILKY);

  test("shows /call's own call, as video while up with a model", () => {
    expect(soloCallView({ target: solo, phase: LIVE, video: true }, "milky-green")).toEqual({
      own: true,
      elsewhere: false,
      video: true,
    });
    expect(soloCallView({ target: solo, phase: LIVE, video: false }, "milky-green")).toEqual({
      own: true,
      elsewhere: false,
      video: false,
    });
    expect(soloCallView({ target: solo, phase: DROPPED, video: true }, "milky-green")).toEqual({
      own: true,
      elsewhere: false,
      video: false,
    });
  });

  test("calls a chat's call elsewhere, and isn't one with a persona no longer active", () => {
    const chat = chatTarget("c1", MILKY, null);
    expect(soloCallView({ target: chat, phase: LIVE, video: true }, "milky-green")).toEqual({
      own: false,
      elsewhere: true,
      video: false,
    });
    expect(soloCallView({ target: solo, phase: HUNG_UP, video: false }, "hazel")).toEqual({
      own: false,
      elsewhere: false,
      video: false,
    });
  });
});

import { describe, expect, test } from "bun:test";
import type { ChatEvent, ParticipantId } from "@eidolon/chat";
import { nextUp, reasonOf, scoreTable } from "./group";

function said(seq: number, persona: ParticipantId | null, text = "…"): ChatEvent {
  return {
    type: "message",
    seq,
    at: seq,
    id: `m${seq}`,
    speaker: persona === null ? { kind: "user" } : { kind: "persona", id: persona },
    text,
  };
}

function chose(seq: number, after: number, personas: readonly ParticipantId[]): ChatEvent {
  return {
    type: "decision",
    seq,
    at: seq,
    after,
    replies: personas.map((persona) => ({ persona, mode: "text" })),
    source: "model",
    scores: {},
  };
}

describe("nextUp", () => {
  test("is the first one chosen who hasn't answered yet", () => {
    const events = [said(1, null), chose(2, 1, ["ken", "mio"])];
    expect(nextUp(events)).toBe("ken");
    expect(nextUp([...events, said(3, "ken")])).toBe("mio");
    expect(nextUp([...events, said(3, "ken"), said(4, "mio")])).toBeNull();
  });

  test("counts a failed turn as answered", () => {
    const failed: ChatEvent = {
      type: "turn-failed",
      seq: 3,
      at: 3,
      persona: "ken",
      turn: "t",
      error: "x",
    };
    expect(nextUp([said(1, null), chose(2, 1, ["ken", "mio"]), failed])).toBe("mio");
  });

  test("looks past a hop that chose no one to who the viewer's line still waits for", () => {
    const events = [said(1, null), chose(2, 1, ["ken", "mio"]), said(3, "ken"), chose(4, 3, [])];
    expect(nextUp(events)).toBe("mio");
  });

  test("is no one while the viewer's newer line waits for its decision", () => {
    expect(nextUp([said(1, null), chose(2, 1, ["ken"]), said(3, null)])).toBeNull();
    expect(nextUp([])).toBeNull();
  });
});

describe("scoreTable", () => {
  test("puts each persona's scores on a row in the order asked, and invites_reply apart", () => {
    expect(
      scoreTable({
        addressed_ken: 0.9,
        interested_ken: 0.2,
        addressed_milky_green: 0.1,
        interested_milky_green: 0.75,
        invites_reply: 0.6,
      }),
    ).toEqual({
      rows: [
        { persona: "ken", addressed: 0.9, interested: 0.2 },
        { persona: "milky_green", addressed: 0.1, interested: 0.75 },
      ],
      invites: 0.6,
    });
  });

  test("is empty without scores, as a fallback decision has", () => {
    expect(scoreTable({})).toEqual({ rows: [], invites: null });
    expect(scoreTable({ interested_mio: 0.4 }).rows).toEqual([
      { persona: "mio", addressed: null, interested: 0.4 },
    ]);
  });
});

describe("reasonOf", () => {
  test("names who wrote the line it answered, when the log holds it", () => {
    const decision = chose(3, 2, ["mio"]) as Extract<ChatEvent, { type: "decision" }>;
    const speakers = new Map([[2, { kind: "persona", id: "ken" } as const]]);
    expect(reasonOf(decision, speakers)).toEqual({
      source: "model",
      scores: {},
      to: { kind: "persona", id: "ken" },
    });
    expect(reasonOf({ ...decision, scores: undefined }, new Map()).to).toBeNull();
    expect(reasonOf({ ...decision, scores: undefined }, new Map()).scores).toEqual({});
  });
});

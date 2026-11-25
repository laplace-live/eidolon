// Her direction from scripted call events, as each voice reports what was heard: Fish announces a
// segment and then completes it with no progress between, word-timed voices report progress as
// words play, and a realtime model's segments arrive after she stopped speaking.
import { describe, expect, test } from "vitest";
import {
  type Direction,
  type DirectionEvent,
  type DirectionState,
  direct,
  directionOf,
  directionState,
} from "../src/avatar/direct.ts";

function run(events: readonly DirectionEvent[], state = directionState()): DirectionState {
  return events.reduce(direct, state);
}

const userTurn = (at: number): DirectionEvent[] => [
  { type: "user-started-speaking", at },
  { type: "user-words", at: at + 300 },
  { type: "user-stopped-speaking", at: at + 900 },
];

const announced = (segment: number, text: string, at: number): DirectionEvent => ({
  type: "bot-output",
  at,
  segment,
  text,
  status: "new",
});

const heard = (segment: number, text: string, spoken: number, at: number): DirectionEvent => ({
  type: "bot-output",
  at,
  segment,
  text,
  status: "in-progress",
  spoken,
});

const completed = (segment: number, text: string, at: number): DirectionEvent => ({
  type: "bot-output",
  at,
  segment,
  text,
  status: "completed",
});

const tick = (at: number): DirectionEvent => ({ type: "tick", at });

function face(direction: Direction) {
  return { mood: direction.mood, pulse: direction.pulse, gesture: direction.gesture?.name ?? null };
}

describe("a Fish voice, which reports no progress", () => {
  const LINE = "[懒洋洋的，带点笑意] 嗯，我刚睡醒 [chuckling] 嘿嘿，你来啦";

  test("her reply's opening direction sets her mood, and its cue lands by her pace", () => {
    let state = run([
      ...userTurn(0),
      { type: "bot-llm-started", at: 1000 },
      { type: "bot-started-speaking", at: 1800 },
      announced(7, LINE, 1800),
    ]);
    expect(directionOf(state)).toMatchObject({
      mood: ["lazy", "happy"],
      pulse: null,
      speaking: true,
      thinking: false,
      looking: "idle",
      gesture: { name: "nod", seq: 1 },
    });
    // Five letters before the cue at 4.5 a second: heard about 1.1 s after the segment starts.
    state = direct(state, tick(2800));
    expect(directionOf(state).gesture).toEqual({ name: "nod", seq: 1 });
    state = direct(state, tick(2950));
    expect(face(directionOf(state))).toEqual({
      mood: ["lazy", "happy"],
      pulse: "happy",
      gesture: "nod",
    });
    expect(directionOf(state).gesture?.seq).toBe(2);
    state = direct(state, tick(4400));
    expect(directionOf(state).pulse).toBe("happy");
    state = direct(state, tick(4460));
    expect(directionOf(state).pulse).toBeNull();

    state = run(
      [
        completed(7, LINE, 5000),
        announced(8, "我给你泡杯茶吧。", 5000),
        completed(8, "我给你泡杯茶吧。", 6500),
        { type: "bot-stopped-speaking", at: 6600 },
      ],
      state,
    );
    expect(directionOf(state)).toMatchObject({
      mood: ["lazy", "happy"],
      speaking: false,
      gesture: { seq: 2 },
    });
  });

  test("a cue before her first word lands as the segment starts", () => {
    const state = run([announced(1, "[chuckling] 嘿嘿，被你发现啦", 0)]);
    expect(face(directionOf(state))).toEqual({ mood: [], pulse: "happy", gesture: "nod" });
  });

  test("a cue her pace hasn't reached lands when the segment completes, never later", () => {
    const line = "[嘴硬，装作嫌弃] 不是，你这话说的……[chuckling] 嘿嘿，好吧好吧，你说得对。";
    let state = run([announced(3, line, 0), tick(900)]);
    expect(face(directionOf(state))).toEqual({ mood: ["pout"], pulse: null, gesture: null });
    state = direct(state, completed(3, line, 1000));
    expect(face(directionOf(state))).toEqual({ mood: ["pout"], pulse: "happy", gesture: "nod" });
    state = direct(state, tick(5000));
    expect(directionOf(state).gesture?.seq).toBe(1);
  });
});

describe("a voice with word timings", () => {
  // The cue sits at offset 7; once 吧 is heard 6 characters are, and the next letter jumps past it.
  const LINE = "那我们开始吧 [laughing] 哈哈哈";

  test("lands a cue as the words around it are heard, not by the pace", () => {
    let state = run([announced(4, LINE, 0), heard(4, LINE, 3, 200), tick(2000)]);
    expect(directionOf(state).gesture).toBeNull();
    state = direct(state, heard(4, LINE, 6, 2100));
    expect(directionOf(state).gesture).toBeNull();
    state = direct(state, heard(4, LINE, 19, 2300));
    expect(face(directionOf(state))).toEqual({ mood: [], pulse: "happy", gesture: "nod" });
    state = direct(state, completed(4, LINE, 3000));
    expect(directionOf(state).gesture?.seq).toBe(1);
  });
});

describe("a realtime model, whose segments arrive after she spoke them", () => {
  test("speaking follows her audio alone, and the late segment still sets her mood", () => {
    const line = "[温柔地安慰] 没事的，慢慢来。";
    const state = run([
      ...userTurn(0),
      { type: "bot-started-speaking", at: 1000 },
      { type: "bot-stopped-speaking", at: 3000 },
      announced(1, line, 3100),
      completed(1, line, 3100),
    ]);
    expect(directionOf(state)).toMatchObject({ mood: ["gentle"], speaking: false });
  });

  test("a reply with no cues leaves her neutral", () => {
    const state = run([
      announced(1, "[嘴硬，装作嫌弃] 不是吧。", 0),
      ...userTurn(1000),
      { type: "bot-started-speaking", at: 2500 },
      { type: "bot-stopped-speaking", at: 4000 },
      announced(2, "好呀，那就这么定了。", 4100),
      completed(2, "好呀，那就这么定了。", 4100),
    ]);
    expect(directionOf(state).mood).toEqual([]);
  });
});

describe("a reply's mood", () => {
  test("holds through its later segments, whatever they open with", () => {
    const state = run([
      announced(1, "[有点失落，慢慢地说] 他跑路那天，", 0),
      announced(2, "[开心地] 我也是这种感觉，嗯。", 1500),
    ]);
    expect(directionOf(state).mood).toEqual(["sad"]);
  });

  test("ends at the viewer's next turn: a reply without a direction is neutral", () => {
    const state = run([
      announced(1, "[嘴硬，装作嫌弃] 不是，你这话说的……", 0),
      completed(1, "[嘴硬，装作嫌弃] 不是，你这话说的……", 1000),
      { type: "user-words", at: 2000 },
      announced(2, "好吧，听你的。", 3000),
    ]);
    expect(directionOf(state).mood).toEqual([]);
  });

  test("holds until the next reply even with nothing said", () => {
    const state = run([announced(1, "[懒洋洋的，带点笑意] 嗯。", 0), ...userTurn(2000)]);
    expect(directionOf(state).mood).toEqual(["lazy", "happy"]);
  });

  test("survives the viewer's backchannel while she speaks", () => {
    const state = run([
      { type: "bot-started-speaking", at: 0 },
      announced(1, "[懒洋洋的] 我跟你说哦，", 0),
      { type: "user-words", at: 800 },
      announced(2, "那天可好玩了。", 1200),
    ]);
    expect(directionOf(state).mood).toEqual(["lazy"]);
  });

  test("an interruption ends it, dropping the cues she never got to", () => {
    const line = "[嘴硬，装作嫌弃] 不是，你听我说完 [sighing] 唉…";
    let state = run([
      { type: "bot-started-speaking", at: 0 },
      announced(1, line, 0),
      { type: "bot-interrupted", at: 500 },
      tick(5000),
    ]);
    expect(directionOf(state)).toMatchObject({ mood: ["pout"], pulse: null, speaking: false });
    state = direct(state, announced(2, "嗯？你说。", 6000));
    expect(directionOf(state).mood).toEqual([]);
  });
});

describe("listening and thinking", () => {
  test("she watches the viewer speak, nods when their words are in, and thinks until she speaks", () => {
    let state = direct(directionState(), { type: "user-started-speaking", at: 0 });
    expect(directionOf(state)).toMatchObject({ listening: true, looking: "viewer", gesture: null });
    state = run(
      [
        { type: "user-words", at: 400 },
        { type: "user-stopped-speaking", at: 900 },
      ],
      state,
    );
    expect(directionOf(state)).toMatchObject({
      listening: false,
      thinking: true,
      looking: "away",
      gesture: { name: "nod", seq: 1 },
    });
    state = direct(state, { type: "bot-started-speaking", at: 2000 });
    expect(directionOf(state)).toMatchObject({ thinking: false, speaking: true, looking: "idle" });
  });

  test("words that arrive after the viewer stopped still earn the nod", () => {
    let state = run([
      { type: "user-started-speaking", at: 0 },
      { type: "user-stopped-speaking", at: 900 },
    ]);
    expect(directionOf(state)).toMatchObject({ gesture: null, thinking: false });
    state = direct(state, { type: "user-words", at: 1100 });
    expect(directionOf(state)).toMatchObject({ gesture: { name: "nod" }, thinking: true });
    state = direct(state, { type: "user-words", at: 1200 });
    expect(directionOf(state).gesture?.seq).toBe(1);
  });

  test("a stop with no words, then her answer, earns no nod", () => {
    const state = run([
      { type: "user-started-speaking", at: 0 },
      { type: "user-stopped-speaking", at: 900 },
      { type: "bot-started-speaking", at: 1500 },
      { type: "user-words", at: 1600 },
    ]);
    expect(directionOf(state).gesture).toBeNull();
  });

  test("a tool call has her thinking until she speaks again", () => {
    let state = run([
      { type: "bot-started-speaking", at: 0 },
      { type: "bot-stopped-speaking", at: 1000 },
      { type: "function-call", at: 1100 },
    ]);
    expect(directionOf(state)).toMatchObject({ thinking: true, looking: "away" });
    state = direct(state, { type: "bot-started-speaking", at: 3000 });
    expect(directionOf(state)).toMatchObject({ thinking: false, looking: "idle" });
  });

  test("she doesn't look away while she speaks, even as her mind works", () => {
    const state = run([
      { type: "bot-started-speaking", at: 0 },
      { type: "bot-llm-started", at: 100 },
    ]);
    expect(directionOf(state)).toMatchObject({ speaking: true, thinking: false, looking: "idle" });
  });
});

describe("a group call", () => {
  test("bot events go to the persona speaking, while everyone listens to the viewer", () => {
    let state = run([
      { type: "speaker", at: 0, persona: "milky-green" },
      { type: "bot-started-speaking", at: 0 },
      announced(1, "[懒洋洋的，带点笑意] 嗨～", 0),
      { type: "bot-stopped-speaking", at: 1000 },
      { type: "speaker", at: 1100, persona: "hazel" },
      { type: "bot-started-speaking", at: 1100 },
      announced(2, "[嘴硬，装作嫌弃] 你又来了。[sighing] 唉…", 1100),
    ]);
    expect(directionOf(state, "milky-green")).toMatchObject({
      persona: "milky-green",
      mood: ["lazy", "happy"],
      speaking: false,
    });
    expect(directionOf(state, "hazel")).toMatchObject({ mood: ["pout"], speaking: true });
    expect(directionOf(state).persona).toBe("hazel");

    // hazel's segment completes after the floor passed back: its cue stays hers.
    state = run(
      [
        { type: "speaker", at: 2000, persona: "milky-green" },
        completed(2, "[嘴硬，装作嫌弃] 你又来了。[sighing] 唉…", 2000),
      ],
      state,
    );
    expect(directionOf(state, "hazel").pulse).toBe("wry");
    expect(directionOf(state, "milky-green").pulse).toBeNull();

    state = run(
      [
        { type: "bot-started-speaking", at: 2100 },
        announced(3, "[温柔地安慰] 别理她。", 2100),
        { type: "bot-stopped-speaking", at: 3000 },
        { type: "user-started-speaking", at: 3500 },
      ],
      state,
    );
    expect(directionOf(state, "milky-green")).toMatchObject({ mood: ["gentle"], listening: true });
    expect(directionOf(state, "hazel")).toMatchObject({ mood: ["pout"], listening: true });
    expect(directionOf(state, "someone-new")).toMatchObject({
      persona: "someone-new",
      mood: [],
      listening: true,
      looking: "viewer",
    });
  });

  test("the viewer's nod is everyone's", () => {
    const state = run([{ type: "speaker", at: 0, persona: "hazel" }, ...userTurn(100)]);
    expect(directionOf(state, "hazel").gesture).toEqual({ name: "nod", seq: 1 });
    expect(directionOf(state, "milky-green").gesture).toEqual({ name: "nod", seq: 1 });
  });
});

describe("the rest", () => {
  test("word, token, backchannel and expression outputs are skipped", () => {
    const state = run([
      ...["word", "token", "backchannel", "expression_sound"].map(
        (output, i): DirectionEvent => ({
          type: "bot-output",
          at: i,
          segment: i,
          text: "[嘴硬] [chuckling] 嗯",
          status: "new",
          output,
        }),
      ),
    ]);
    expect(face(directionOf(state))).toEqual({ mood: [], pulse: null, gesture: null });
    expect(state.personas).toEqual([]);
  });

  test("progress for a segment it never saw announced changes nothing", () => {
    const before = run([announced(1, "嗯 [chuckling] 嘿", 0)]);
    const after = run([heard(9, "嗯 [chuckling] 嘿", 99, 10), completed(9, "嗯", 20)], before);
    expect(after).toEqual(before);
  });

  test("a chat reply, said by no voice, moves her too", () => {
    let state = direct(directionState(), {
      type: "reply",
      at: 0,
      text: "[懒洋洋的，带点笑意] 嗯… [chuckling] 嘿嘿",
    });
    expect(face(directionOf(state))).toEqual({
      mood: ["lazy", "happy"],
      pulse: null,
      gesture: null,
    });
    state = direct(state, tick(300));
    expect(face(directionOf(state))).toEqual({
      mood: ["lazy", "happy"],
      pulse: "happy",
      gesture: "nod",
    });
    state = direct(state, { type: "reply", at: 5000, text: "好。" });
    expect(directionOf(state).mood).toEqual([]);
  });

  test("reset starts over without reusing a gesture's number", () => {
    let state = run([...userTurn(0), announced(1, "[chuckling] 嘿嘿", 1000)]);
    expect(directionOf(state).gesture?.seq).toBe(2);
    state = direct(state, { type: "reset", at: 2000 });
    expect(directionOf(state)).toEqual(directionOf({ ...directionState(), seq: 0 }));
    state = run(userTurn(3000), state);
    expect(directionOf(state).gesture?.seq).toBe(3);
  });

  test("its state and directions are plain data", () => {
    const state = run([
      { type: "speaker", at: 0, persona: "hazel" },
      ...userTurn(0),
      announced(1, "[懒洋洋的，带点笑意] 嗯，我刚睡醒 [chuckling] 嘿嘿", 1000),
    ]);
    expect(structuredClone(state)).toEqual(state);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    const direction = directionOf(state);
    expect(JSON.parse(JSON.stringify(direction))).toEqual(direction);
    expect(direct(state, tick(1001))).not.toBe(state);
  });
});

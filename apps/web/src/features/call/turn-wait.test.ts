import { expect, test } from "bun:test";
import { TurnWait } from "./turn-wait";

function wait() {
  const calls: string[] = [];
  const turn = new TurnWait({
    arm: () => calls.push("arm"),
    clear: () => calls.push("clear"),
    llmStarted: () => calls.push("llm"),
  });
  return { turn, calls };
}

test("a turn with words in a final transcript starts the wait as it ends", () => {
  const { turn, calls } = wait();
  turn.started();
  turn.heard({ text: "你好", final: false });
  turn.heard({ text: "你好呀", final: true });
  turn.stopped();
  expect(calls).toEqual(["clear", "arm"]);
});

test("a turn without words never starts it, since no answer would end it", () => {
  const { turn, calls } = wait();
  turn.started();
  turn.stopped();
  turn.started();
  turn.heard({ text: "嗯", final: false });
  turn.heard({ text: "  ", final: true });
  turn.stopped();
  expect(calls).toEqual(["clear", "clear"]);
});

test("a new turn forgets the last one's words", () => {
  const { turn, calls } = wait();
  turn.started();
  turn.heard({ text: "你好", final: true });
  turn.stopped();
  turn.started();
  turn.stopped();
  expect(calls).toEqual(["clear", "arm", "clear"]);
});

test("on a realtime call the transcript after the turn's end starts the wait, once", () => {
  const { turn, calls } = wait();
  turn.started();
  turn.stopped();
  turn.heard({ text: "你好", final: true });
  turn.heard({ text: "你好", final: true });
  expect(calls).toEqual(["clear", "arm"]);
});

test("a transcript after she started answering starts no wait", () => {
  const { turn, calls } = wait();
  turn.started();
  turn.stopped();
  turn.settled();
  turn.heard({ text: "你好", final: true });
  expect(calls).toEqual(["clear", "clear"]);
});

test("a late wait keeps an LLM start that came before the transcript, so it never reads stuck", () => {
  const { turn, calls } = wait();
  turn.started();
  turn.stopped();
  turn.llmStarted();
  turn.heard({ text: "你好", final: true });
  expect(calls).toEqual(["clear", "llm", "arm", "llm"]);
});

test("a new turn forgets the last one's LLM start", () => {
  const { turn, calls } = wait();
  turn.started();
  turn.llmStarted();
  turn.started();
  turn.stopped();
  turn.heard({ text: "你好", final: true });
  expect(calls).toEqual(["clear", "llm", "clear", "arm"]);
});

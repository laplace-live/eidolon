import { expect, test } from "bun:test";
import { TurnWait } from "./turn-wait";

function wait() {
  const calls: string[] = [];
  const turn = new TurnWait({
    arm: () => calls.push("arm"),
    clear: () => calls.push("clear"),
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

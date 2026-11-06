import { expect, test } from "bun:test";
import { changeVoiceDialog } from "./voice";

test("a save in flight holds the dialog open and keeps its state", () => {
  const done: string[] = [];
  const setOpen = (open: boolean) => done.push(open ? "open" : "close");
  const reset = () => done.push("reset");
  changeVoiceDialog(false, true, setOpen, reset);
  expect(done).toEqual([]);
  changeVoiceDialog(false, false, setOpen, reset);
  expect(done).toEqual(["close", "reset"]);
  done.length = 0;
  changeVoiceDialog(true, false, setOpen, reset);
  expect(done).toEqual(["open"]);
});

import { describe, expect, test } from "bun:test";
import { joinSegments, separator } from "../src/index.ts";

describe("separator", () => {
  test("spaces only between two non-CJK words", () => {
    expect(separator("Hi there.", "How")).toBe(" ");
    expect(separator("你好。", "我是")).toBe("");
    expect(separator("OK,", "你好")).toBe("");
    expect(separator("好的", "OK")).toBe("");
    expect(separator("Hi ", "there")).toBe("");
    expect(separator("Hi", " there")).toBe("");
    expect(separator("", "x")).toBe("");
    expect(separator("x", "")).toBe("");
  });

  test("kana, hangul and full-width punctuation count as CJK", () => {
    expect(separator("ありがとう", "OK")).toBe("");
    expect(separator("OK", "감사")).toBe("");
    expect(separator("真的？", "Yes")).toBe("");
    expect(separator("「Hi」", "there")).toBe("");
  });
});

describe("joinSegments", () => {
  test("runs CJK together, where pipedog's space read 我想问 你", () => {
    expect(joinSegments(["我想问", "你今天播什么"])).toBe("我想问你今天播什么");
  });

  test("puts a space between Latin words, and none beside one already there", () => {
    expect(joinSegments(["Hi there.", "How are you?"])).toBe("Hi there. How are you?");
    expect(joinSegments(["Hi there. ", "How are you?"])).toBe("Hi there. How are you?");
    expect(joinSegments(["我在玩", "Minecraft", "呢"])).toBe("我在玩Minecraft呢");
  });

  test("keeps her cues as she wrote them", () => {
    expect(joinSegments(["你好。", "[温暖] 今天怎么样？"])).toBe("你好。[温暖] 今天怎么样？");
    expect(joinSegments(["Hello.", "[warm] How was it?"])).toBe("Hello. [warm] How was it?");
  });

  test("skips empty pieces and trims the ends", () => {
    expect(joinSegments([])).toBe("");
    expect(joinSegments(["", " 好的 ", "", "嗯"])).toBe("好的 嗯");
    expect(joinSegments([" ", ""])).toBe("");
  });
});

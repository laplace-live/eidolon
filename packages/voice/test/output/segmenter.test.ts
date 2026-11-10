// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/core/test/test_simple_text_aggregator.test.ts@ce8f8bc

import { beforeEach, describe, expect, test } from "bun:test";
import { hasWords, Segmenter } from "../../src/output/segmenter.ts";

/** Every sentence `deltas` complete, then the flush, marked. */
function cut(...deltas: string[]): string[] {
  const segmenter = new Segmenter();
  const sentences = deltas.flatMap((delta) => segmenter.push(delta));
  const rest = segmenter.flush();
  return rest === null ? sentences : [...sentences, `flush: ${rest}`];
}

describe("TestSimpleTextAggregator", () => {
  let segmenter: Segmenter;

  beforeEach(() => {
    segmenter = new Segmenter();
  });

  test("test_reset_aggregations", () => {
    // No complete sentences yet
    expect(segmenter.push("Hello ")).toEqual([]);
    expect(segmenter.held).toBe("Hello");
    segmenter.reset();
    expect(segmenter.held).toBe("");
  });

  test("test_simple_sentence", () => {
    // No complete sentences yet (waiting for lookahead after "!")
    expect(segmenter.push("Hello Pipecat!")).toEqual([]);
    // Flush to get the pending sentence
    expect(segmenter.flush()).toBe("Hello Pipecat!");
    expect(segmenter.held).toBe("");
  });

  test("test_multiple_sentences", () => {
    // First sentence should be complete (lookahead from "H" confirmed it)
    expect(segmenter.push("Hello Pipecat! How are you?")).toEqual(["Hello Pipecat!"]);
    expect(segmenter.flush()).toBe("How are you?");
  });

  test("test_lookahead_decimal_number", () => {
    // Test that $29.95 is not split at $29.
    expect(segmenter.push("Ask me for only $29.95/month.")).toEqual([]);
    expect(segmenter.flush()).toBe("Ask me for only $29.95/month.");
  });

  test("test_lookahead_abbreviation", () => {
    // Test that Mr. Smith is not split at Mr.
    expect(segmenter.push("Hello Mr. Smith.")).toEqual([]);
    expect(segmenter.flush()).toBe("Hello Mr. Smith.");
  });

  test("test_lookahead_actual_sentence_end", () => {
    // First sentence should be complete (lookahead from "N" confirmed it)
    expect(segmenter.push("Hello world. Next sentence")).toEqual(["Hello world."]);
  });

  test("test_flush_pending_sentence", () => {
    expect(segmenter.push("Hello world.")).toEqual([]);
    expect(segmenter.flush()).toBe("Hello world.");
    // Flush again should return None
    expect(segmenter.flush()).toBeNull();
  });

  test("test_flush_with_no_pending", () => {
    expect(segmenter.push("Hello")).toEqual([]);
    // flush() returns any remaining text, not just pending lookahead
    expect(segmenter.flush()).toBe("Hello");
    expect(segmenter.held).toBe("");
  });

  test("test_flush_after_lookahead_confirmed", () => {
    expect(segmenter.push("Hello. W")).toEqual(["Hello."]);
    // flush() returns any remaining text (the "W" in this case)
    expect(segmenter.flush()).toBe("W");
  });

  test("test_japanese_multiple_sentences", () => {
    // First sentence detected when 元 arrives as lookahead after 。
    expect(segmenter.push("こんにちは。元気ですか？")).toEqual(["こんにちは。"]);
    expect(segmenter.flush()).toBe("元気ですか？");
  });

  test("test_japanese_sentence_with_lookahead", () => {
    expect(segmenter.push("こんにちは。元")).toEqual(["こんにちは。"]);
    expect(segmenter.flush()).toBe("元");
  });

  test("test_chinese_streaming_tokens", () => {
    const tokens = ["你好", "世界", "。", "下一", "句话", "。"];
    // First sentence detected when 下 arrives after 。
    expect(tokens.flatMap((token) => segmenter.push(token))).toEqual(["你好世界。"]);
    expect(segmenter.flush()).toBe("下一句话。");
  });

  test("test_japanese_single_sentence_flush", () => {
    expect(segmenter.push("こんにちは。")).toEqual([]);
    expect(segmenter.flush()).toBe("こんにちは。");
  });
});

describe("where it parts from pipedog (D7)", () => {
  test("a closing quote stays with its sentence, which goes at the next character", () => {
    const segmenter = new Segmenter();
    expect(segmenter.push("他说：“我不去。”")).toEqual([]);
    expect(segmenter.push("然")).toEqual(["他说：“我不去。”"]);
    expect(cut("「好啊。」她笑了。（小声。）好。")).toEqual([
      "「好啊。」",
      "她笑了。",
      "（小声。）",
      "flush: 好。",
    ]);
    expect(cut("“好。”")).toEqual(["flush: “好。”"]);
  });

  test("so does repeated end punctuation, in a quote or out of one", () => {
    expect(cut("他说：“不去！！”然后走了。")).toEqual(["他说：“不去！！”", "flush: 然后走了。"]);
    expect(cut("嗯？！……好吧。")).toEqual(["嗯？！……", "flush: 好吧。"]);
  });

  test("nothing ends inside an open [", () => {
    expect(cut("[语气平静。带着", "笑意] 好。下一句。")).toEqual([
      "[语气平静。带着笑意] 好。",
      "flush: 下一句。",
    ]);
  });

  test("a sentence with no words merges into the next", () => {
    expect(cut("……。好的。下一句。")).toEqual(["……。好的。", "flush: 下一句。"]);
    expect(cut("<whisper>嗯。</whisper>。好的。")).toEqual([
      "<whisper>嗯。",
      "flush: </whisper>。好的。",
    ]);
  });

  test("text with no words at a round's end waits for the next round", () => {
    const segmenter = new Segmenter();
    expect(segmenter.push("[开心地] ")).toEqual([]);
    expect(segmenter.flush()).toBeNull();
    expect(segmenter.held).toBe("[开心地]");
    expect(segmenter.push("拍好啦！")).toEqual([]);
    expect(segmenter.flush()).toBe("[开心地] 拍好啦！");
    expect(segmenter.held).toBe("");
  });

  test("and at the reply's end is only held", () => {
    const segmenter = new Segmenter();
    expect(segmenter.push("<whisper>悄悄告诉你。</whisper> ")).toEqual(["<whisper>悄悄告诉你。"]);
    expect(segmenter.flush()).toBeNull();
    expect(segmenter.held).toBe("</whisper>");
    segmenter.reset();
    expect(segmenter.held).toBe("");
  });
});

describe("where a sentence ends", () => {
  test("Chinese ends at its own punctuation, never at a comma, ～ or …", () => {
    expect(cut("早啊……周一这一大早的，怎么跑来看我啦，嗯？")).toEqual([
      "flush: 早啊……周一这一大早的，怎么跑来看我啦，嗯？",
    ]);
    expect(cut("好呀～那我们走吧。嗯；好的。")).toEqual([
      "好呀～那我们走吧。",
      "嗯；",
      "flush: 好的。",
    ]);
    expect(cut("嗯，好，那就这样吧，")).toEqual(["flush: 嗯，好，那就这样吧，"]);
  });

  test("Latin ends before a space, unless an abbreviation, an initial or an ellipsis goes on", () => {
    expect(cut("Hello world. this is it. Wait... what? Albert I. Douglas came. ")).toEqual([
      "Hello world.",
      "this is it.",
      "Wait... what?",
      "flush: Albert I. Douglas came.",
    ]);
    expect(cut("I live in the U.S.A. now. e.g. this. Yes")).toEqual([
      "I live in the U.S.A. now.",
      "e.g. this.",
      "flush: Yes",
    ]);
  });

  test("Latin ! and ? also end straight before another script; a period never does", () => {
    expect(cut("Hi!你好。OK.好的。我在1.5小时后到。")).toEqual([
      "Hi!",
      "你好。",
      "OK.好的。",
      "flush: 我在1.5小时后到。",
    ]);
  });

  test("a sentence keeps its line breaks, as pipedog's does", () => {
    expect(cut("好的。\n\n下一句。")).toEqual(["好的。", "flush: \n\n下一句。"]);
  });
});

test("hasWords looks past cues", () => {
  expect(["嗯", "[叹气] 唉", "OK"].map(hasWords)).toEqual([true, true, true]);
  expect(["[叹气]", "</whisper>", "……。", " ", "<emphasis></emphasis>"].map(hasWords)).toEqual([
    false,
    false,
    false,
    false,
    false,
  ]);
});

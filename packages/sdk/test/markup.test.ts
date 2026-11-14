import { describe, expect, test } from "bun:test";
import { type MarkupToken, parseMarkup, trimTrailingPartialCue } from "../src/index.ts";

/** The tokens without offsets, which only the spoken split reads. */
function shapes(source: string) {
  return parseMarkup(source).map(({ start: _, ...token }) => token);
}

/** What a reader sees: words as written, a cue as its emoji, a direction in brackets. */
function shown(tokens: readonly MarkupToken[]): string {
  return tokens
    .map((token) =>
      token.kind === "text" ? token.text : token.kind === "cue" ? token.emoji : `{${token.text}}`,
    )
    .join("");
}

describe("parseMarkup", () => {
  test("plain text is one token", () => {
    expect(shapes("你好呀，今天过得怎么样？")).toEqual([
      { kind: "text", text: "你好呀，今天过得怎么样？", tags: [] },
    ]);
    expect(parseMarkup("")).toEqual([]);
  });

  test("a free-form direction becomes a direction chip, as written", () => {
    expect(shapes("[温暖，带着怀念] 小时候上美术课")).toEqual([
      { kind: "direction", text: "温暖，带着怀念" },
      { kind: "text", text: " 小时候上美术课", tags: [] },
    ]);
    expect(shapes("[ 压低声音 ]嗯")[0]).toEqual({ kind: "direction", text: "压低声音" });
  });

  test("a cue from Fish's vocabulary becomes its emoji, whatever its case", () => {
    expect(shapes("我一般都能得A [chuckling] 嘿嘿")).toEqual([
      { kind: "text", text: "我一般都能得A ", tags: [] },
      { kind: "cue", name: "chuckling", emoji: "😄" },
      { kind: "text", text: " 嘿嘿", tags: [] },
    ]);
    expect(shapes("[Laughing]哈哈哈")[0]).toEqual({ kind: "cue", name: "laughing", emoji: "😆" });
    expect(shapes("[in a hurry tone]")[0]).toEqual({
      kind: "cue",
      name: "in a hurry tone",
      emoji: "⏱️",
    });
  });

  test("a pause or a blank cue shows as nothing and takes its trailing space along", () => {
    expect(shown(parseMarkup("等一下 [break] 好了"))).toBe("等一下 好了");
    expect(shown(parseMarkup("等一下[long-break]\u3000好了"))).toBe("等一下好了");
    expect(shown(parseMarkup("[ ] 好了"))).toBe("好了");
    expect(shown(parseMarkup("等等 [break]\n下一句"))).toBe("等等 \n下一句");
  });

  test("names that only an object's prototype knows stay directions", () => {
    expect(shapes("[constructor]")).toEqual([{ kind: "direction", text: "constructor" }]);
    expect(shapes("[toString]")).toEqual([{ kind: "direction", text: "toString" }]);
  });

  test("paired tags restyle the words between them and are never shown", () => {
    expect(shapes("我没事，<whisper>你先走吧</whisper>。")).toEqual([
      { kind: "text", text: "我没事，", tags: [] },
      { kind: "text", text: "你先走吧", tags: ["whisper"] },
      { kind: "text", text: "。", tags: [] },
    ]);
    expect(shapes("<Emphasis>重</EMPHASIS>")).toEqual([
      { kind: "text", text: "重", tags: ["emphasis"] },
    ]);
  });

  test("nested tags list the outermost first, and a stray closer is dropped", () => {
    expect(shapes("<emphasis><slow>慢</slow>快</emphasis>")).toEqual([
      { kind: "text", text: "慢", tags: ["emphasis", "slow"] },
      { kind: "text", text: "快", tags: ["emphasis"] },
    ]);
    expect(shapes("</whisper>我一会儿就来。")).toEqual([
      { kind: "text", text: "我一会儿就来。", tags: [] },
    ]);
  });

  test("an unclosed tag runs to the end", () => {
    expect(shapes("好，<soft>别哭了。我在呢。")).toEqual([
      { kind: "text", text: "好，", tags: [] },
      { kind: "text", text: "别哭了。我在呢。", tags: ["soft"] },
    ]);
  });

  test("unknown tags vanish, and anything that isn't a bare tag stays text", () => {
    expect(shown(parseMarkup("<b>粗</b><script>alert(1)</script>"))).toBe("粗alert(1)");
    const attribute = "<img src=x onerror=alert(1)>";
    expect(shapes(attribute)).toEqual([{ kind: "text", text: attribute, tags: [] }]);
    expect(shapes("a < b > c")).toEqual([{ kind: "text", text: "a < b > c", tags: [] }]);
  });

  test("brackets never span a line, and empty ones stay text", () => {
    expect(shapes("[a\nb] []")).toEqual([{ kind: "text", text: "[a\nb] []", tags: [] }]);
    expect(shown(parseMarkup("[[温柔]]"))).toBe("[{温柔}]");
  });

  test("every token knows where it starts", () => {
    const source = "[温暖] 你<emphasis>好</emphasis> [chuckling]";
    expect(parseMarkup(source).map((token) => token.start)).toEqual([0, 4, 16, 28, 29]);
    for (const token of parseMarkup(source)) {
      if (token.kind === "text") {
        expect(source.slice(token.start, token.start + token.text.length)).toBe(token.text);
      }
    }
  });
});

describe("trimTrailingPartialCue", () => {
  test("drops a cue or tag cut off at the end, and nothing else", () => {
    expect(trimTrailingPartialCue("真的</emp")).toBe("真的");
    expect(trimTrailingPartialCue("<emphasis>真")).toBe("<emphasis>真");
    expect(trimTrailingPartialCue("你好[温柔")).toBe("你好");
    expect(trimTrailingPartialCue("你好[温柔地]")).toBe("你好[温柔地]");
    expect(trimTrailingPartialCue("a <")).toBe("a ");
    expect(trimTrailingPartialCue("3 < 5")).toBe("3 < 5");
  });
});

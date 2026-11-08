// Expected jieba cuts were printed by Python jieba 0.42.1.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JiebaTokenizer,
  tokenizeZh,
  tokenizeZhQuery,
  warmTokenizer,
  ZH_QUERY_STOPWORDS,
} from "../src/index.ts";
import { chunkFtsText, FTS_COLUMNS, factFtsText } from "./fts_text.ts";
import { realTable } from "./helpers.ts";

// [input, " ".join(cut_for_search), tokenizeZh, tokenizeZhQuery]
const CASES: [string, string, string, string][] = [
  ["", "", "", ""],
  [" ", " ", "", ""],
  ["　你好　", "　 你好 　", "你好", "你好"],
  ["嗯嗯", "嗯 嗯", "嗯 嗯", "嗯 嗯"],
  ["嗯吗", "嗯 吗", "嗯 吗", "嗯 吗"],
  ["OK吗？", "OK 吗 ？", "OK 吗 ？", "OK ？"],
  ["你最喜欢的歌是哪首", "你 最 喜欢 的 歌 是 哪首", "你 最 喜欢 的 歌 是 哪首", "最 喜欢 歌 哪首"],
  ["坚果 体重", "坚果   体重", "坚果 体重", "坚果 体重"],
  ["a\x1fb", "a \x1f b", "a b", "a b"],
  ["﻿你好", "﻿ 你好", "﻿ 你好", "﻿ 你好"],
  ["K-pop是什么", "K - pop 是 什么", "K - pop 是 什么", "K - pop"],
  ["D.Va好玩吗", "D . Va 好玩 吗", "D . Va 好玩 吗", "D . Va 好玩"],
  ["坚果5.5kg吗", "坚果 5.5 kg 吗", "坚果 5.5 kg 吗", "坚果 5.5 kg"],
  ["S.H.E的歌", "S . H . E 的 歌", "S . H . E 的 歌", "S . H . E 歌"],
  ["你听过T-ara吗", "你 听 过 T - ara 吗", "你 听 过 T - ara 吗", "听 T - ara"],
  ["163.com", "163 . com", "163 . com", "163 . com"],
  ["哈哈哈哈哈", "哈哈 哈哈 哈哈哈 哈哈", "哈哈 哈哈 哈哈哈 哈哈", "哈哈 哈哈 哈哈哈 哈哈"],
  ["啊啊啊啊啊啊", "啊啊啊 啊啊啊", "啊啊啊 啊啊啊", "啊啊啊 啊啊啊"],
  ["Ｋ－ｐｏｐ", "Ｋ － ｐ ｏ ｐ", "Ｋ － ｐ ｏ ｐ", "Ｋ － ｐ ｏ ｐ"],
  ["２６年", "２ ６ 年", "２ ６ 年", "２ ６"],
  ["😀你好", "😀 你好", "😀 你好", "😀 你好"],
  ["㵘㵘", "㵘 㵘", "㵘 㵘", "㵘 㵘"],
  ["卑卑卑卑卑卑卑", "卑卑卑 卑卑卑卑", "卑卑卑 卑卑卑卑", "卑卑卑 卑卑卑卑"],
  ["指桑桑桑桑桑", "指桑桑 桑桑桑", "指桑桑 桑桑桑", "指桑桑 桑桑桑"],
  ["Kenniman-MEI", "Kenniman - MEI", "Kenniman - MEI", "Kenniman - MEI"],
  ["10.49.00", "10.49 . 00", "10.49 . 00", "10.49 . 00"],
  ["05-15", "05 - 15", "05 - 15", "05 - 15"],
  ["AT&T", "AT&T", "AT&T", "AT&T"],
  ["C++", "C++", "C++", "C++"],
  ["c#", "c#", "c#", "c#"],
  ["100%", "100%", "100%", "100%"],
  ["3.14", "3.14", "3.14", "3.14"],
  ["U盘", "U盘", "U盘", "U盘"],
  ["B超", "B超", "B超", "B超"],
  ["iPhone15", "iPhone15", "iPhone15", "iPhone15"],
  ["x\r\ny", "x \r\n y", "x y", "x y"],
  ["\r\r\n", "\r \r\n", "", ""],
  ["a\tb\nc", "a \t b \n c", "a b c", "a b c"],
  [
    "他来到了网易杭研大厦",
    "他 来到 了 网易 杭研 大厦",
    "他 来到 了 网易 杭研 大厦",
    "来到 网易 杭研 大厦",
  ],
  [
    "小明硕士毕业于中国科学院计算所，后在日本京都大学深造",
    "小明 硕士 毕业 于 中国 科学 学院 科学院 中国科学院 计算 计算所 ， 后 在 日本 京都 大学 日本京都大学 深造",
    "小明 硕士 毕业 于 中国 科学 学院 科学院 中国科学院 计算 计算所 ， 后 在 日本 京都 大学 日本京都大学 深造",
    "小明 硕士 毕业 于 中国 科学 学院 科学院 中国科学院 计算 计算所 ， 后 日本 京都 大学 日本京都大学 深造",
  ],
  ["我们中出了一个叛徒", "我们 中出 了 一个 叛徒", "我们 中出 了 一个 叛徒", "中出 一个 叛徒"],
  ["abc_def", "abc _ def", "abc _ def", "abc _ def"],
  [
    "Bilibili的BV1RL411p72W",
    "Bilibili 的 BV1RL411p72W",
    "Bilibili 的 BV1RL411p72W",
    "Bilibili BV1RL411p72W",
  ],
  ["5月9号", "5 月 9 号", "5 月 9 号", "5 9"],
  [
    "今天天气不错😀😀",
    "今天 天天 天气 今天天气 不错 😀 😀",
    "今天 天天 天气 今天天气 不错 😀 😀",
    "今天 天天 天气 今天天气 不错 😀 😀",
  ],
  ["我爱北京天安门", "我 爱 北京 天安 天安门", "我 爱 北京 天安 天安门", "爱 北京 天安 天安门"],
  [
    "\u{20000}\u{20001}中文",
    "\u{20000} \u{20001} 中文",
    "\u{20000} \u{20001} 中文",
    "\u{20000} \u{20001} 中文",
  ],
  ["ａｂｃ１２３", "ａ ｂ ｃ １ ２ ３", "ａ ｂ ｃ １ ２ ３", "ａ ｂ ｃ １ ２ ３"],
];

// The retrieval eval's queries, through tokenizeZhQuery.
const EVAL_QUERIES: [string, string][] = [
  ["你梦想是什么", "梦想"],
  ["坚果体重多少斤", "坚果 体重 斤"],
  ["你为什么戴眼镜", "眼镜 戴眼镜"],
  ["你智商多少", "智商"],
  ["你最喜欢的数字", "最 喜欢 数字"],
  ["你体重多少kg", "体重 kg"],
  ["奶糖花是什么", "奶糖 花是"],
  ["你2026年5月9号说了什么", "2026 5 9 说"],
  ["梦境之花多久一次", "梦境 之花 多久 一次"],
  ["坚果什么时候来你家的", "坚果 时候 来 你家"],
  ["永雏塔菲是谁", "永雏塔菲"],
  ["你怕什么", "怕"],
  ["你拔过智齿吗", "拔 智齿"],
  ["你玩塞尔达打火神殿了吗", "玩 塞尔 塞尔达 打火 神殿"],
  ["你家坚果剃毛之后什么样", "你家 坚果 剃毛 之后 什么样"],
  ["店长坚果是什么品种", "店长 坚果 品种"],
  ["26年3月24直播内容", "26 3 24 直播 内容"],
];

describe("jieba port", () => {
  test("warmTokenizer is idempotent and builds the prefix dict", () => {
    warmTokenizer();
    warmTokenizer();
    expect(JiebaTokenizer.default().initialized).toBe(true);
  });

  test.each(CASES)("%p", (input, raw, zh, query) => {
    const searched = input ? JiebaTokenizer.default().cutForSearch(input).join(" ") : "";
    expect(searched).toBe(raw);
    expect(tokenizeZh(input)).toBe(zh);
    expect(tokenizeZhQuery(input)).toBe(query);
  });

  test("cut keeps HMM words, decimals and CRLF as Python does", () => {
    const jieba = JiebaTokenizer.default();
    expect(jieba.cut("他来到了网易杭研大厦")).toEqual(["他", "来到", "了", "网易", "杭研", "大厦"]);
    expect(jieba.cut("坚果5.5kg吗")).toEqual(["坚果", "5.5", "kg", "吗"]);
    expect(jieba.cut("x\r\ny")).toEqual(["x", "\r\n", "y"]);
    expect(jieba.cut("卑卑卑卑卑卑卑")).toEqual(["卑卑卑", "卑卑卑卑"]);
  });

  test.each(EVAL_QUERIES)("eval query %p", (input, expected) => {
    expect(tokenizeZhQuery(input)).toBe(expected);
  });

  test("80 stopwords, the two whitespace entries included", () => {
    expect(ZH_QUERY_STOPWORDS.size).toBe(80);
    expect(ZH_QUERY_STOPWORDS.has(" ") && ZH_QUERY_STOPWORDS.has("\t")).toBe(true);
    expect(tokenizeZhQuery("你梦想是什么？")).toBe("梦想 ？");
  });
});

const facts = await realTable("persona_facts");
const chunks = await realTable("stream_chunks");

// `bun packages/retrieval/test/jieba-parity.ts` checks every row; this samples it.
describe("parity with the stored tokens column", () => {
  test.skipIf(facts === null)("every persona_facts row", async () => {
    const rows = await facts
      ?.query()
      .select([...FTS_COLUMNS.persona_facts])
      .toArray();
    const mismatched = (rows ?? []).filter((r) => tokenizeZh(factFtsText(r)) !== r.tokens);
    expect(rows?.length).toBeGreaterThan(3000);
    expect(mismatched.map((r) => r.id)).toEqual([]);
  });

  test.skipIf(chunks === null)("stream_chunks rows whose id ends in 7", async () => {
    const rows = await chunks
      ?.query()
      .where("id LIKE '%7'")
      .select([...FTS_COLUMNS.stream_chunks])
      .toArray();
    const mismatched = (rows ?? []).filter((r) => tokenizeZh(chunkFtsText(r)) !== r.tokens);
    expect(rows?.length).toBeGreaterThan(1000);
    expect(mismatched.map((r) => r.id)).toEqual([]);
  });
});

test("a packaged install reads jieba's data from the package EIDOLON_APP_ROOT names", () => {
  const root = mkdtempSync(join(tmpdir(), "eidolon-app-root-"));
  const jieba = join(root, "data", "jieba");
  try {
    process.env.EIDOLON_APP_ROOT = root;
    expect(() => new JiebaTokenizer().initialize()).toThrow(join(jieba, "dict.txt"));
    // One word gets past the dictionary to the HMM tables, without building the real dictionary.
    mkdirSync(jieba, { recursive: true });
    writeFileSync(join(jieba, "dict.txt"), "哪首 3 r\n");
    expect(() => new JiebaTokenizer().initialize()).toThrow(join(jieba, "hmm.json"));
  } finally {
    delete process.env.EIDOLON_APP_ROOT;
    rmSync(root, { recursive: true, force: true });
  }
});

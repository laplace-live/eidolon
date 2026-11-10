// The native segmenter against pipedog's SimpleTextAggregator, which every production TTS service
// splits a reply with, fed the same deltas and flushed at the same mind-round ends. Its sentences
// must be pipedog's, but for the differences D7 allows.
import { describe, expect, test } from "bun:test";
import { SimpleTextAggregator } from "@pipedog/core/utils/text/simple_text_aggregator";
import { hasWords, Segmenter } from "../../../voice/src/output/segmenter.ts";

/** A reply's deltas, one array per mind round. */
type Rounds = readonly (readonly string[])[];

/**
 * Every reply in the eight timelines e2e-call.ts recorded against production deploys, from PR 17
 * to 0.6.0: the `bot-llm-text` deltas between each `bot-llm-started` and `bot-llm-stopped`.
 */
const REPLIES: readonly (readonly string[])[] = [
  ["[懒洋洋的，带点笑意", "] 哎，来啦？今天怎么这个点跑过来了，嗯。"],
  ["[平静，带着点怀念] 叫坚果呀，大家以前不都喊", "他店长嘛。不过他后来跑路了，嗯。"],
  ["[懒洋洋的，带点笑意] 哎，来啦？今天花店这边也没什么", "事，过来坐会儿吧，嗯。"],
  ["[温柔，带着点怀念] 叫", "坚果呀，大家平时都喊他店长，是一只黑色的布偶猫，嗯。"],
  ["[懒洋洋的，带点笑意] 哎，你来啦？这个", "点居然能看到你，[chuckling] 嘿嘿，早啊。"],
  [
    "[平静，带着点怀念] 叫",
    "坚果呀，大家平时都叫他店长，[chuckling] 嘿嘿，以前是只很高冷的黑色布偶",
    "猫，嗯。",
  ],
  [
    "[带着笑意，懒洋洋地] 哎，今天怎么有空过来了？",
    "[chuckling] 嘿嘿，我还以为你把我给忘了呢，嗯。",
  ],
  [
    "[语气平静，带着",
    "一点轻描淡写的怀念] 叫坚果呀，大家以前不都喊他店长嘛。",
    "不过他后来跑路了，嗯。",
  ],
  ["[懒洋洋的", "，带点笑意] 哎，奶糖花，今天来得挺早嘛，[chuckling] 嘿嘿，", "进来坐会儿吧，嗯。"],
  [
    "[眼神柔和了一点，慢慢",
    "地说] 怎么可能不记得啊，叫<emphasis>坚果</emphasis>，大家平时都叫他店长，嗯",
    "。",
  ],
  ["[带着笑意，轻声打招呼] 哎，来啦", "？今天花店这边还挺安静的，嗯。"],
  ["[平静温和，带着一点怀念] 叫坚果呀，大家以前", "都喊他店长，嗯。虽然那家伙已经跑路了。"],
  ["[懒洋洋的，带点笑意] 哎，早啊，怎么这么早就", "过来看我了，嗯？"],
  [
    "[懒洋",
    "洋的，伸了个懒腰] 哎，花店里什么时候不忙了，每天都有做不完的梦",
    "要打理，不过今天二楼倒是挺安静的，嗯。",
  ],
  ["[散漫地，带着笑意] 早", "啊……周一这一大早的，怎么跑来看我啦，嗯？"],
  [
    "[平静地，带着一丝怀念] 叫<emphasis>坚果</emphasis>呀，大家都喊",
    "他店长，是一只黑色的布偶猫，嗯。",
  ],
];

/** Quotes, `…`, `～`, cues cut across deltas, comma-only replies, and their neighbours. */
const INVENTORY: Readonly<Record<string, Rounds>> = {
  "a closed quote": [["他说：“我不去。”然后就走了。"]],
  "two quotes in a row": [["她问：“你来吗？”我说：“来！”好。"]],
  "corner brackets": [["「好啊。」她笑了。『真的吗？』嗯。"]],
  "a quote that ends the reply": [["“好。”"]],
  "a quote still open": [["他说：“我不去。然后就走了。"]],
  "a closing bracket with no opener": [["好的。」然后。好的！）然后。"]],
  "repeated end punctuation in a quote": [["他说：“不去！！”然后走了。"]],
  "mixed end punctuation in a quote": [["他说：“不去？！”然后走了。"]],
  "repeated end punctuation": [["真的吗？？我不信！！好吧。好。。。行吧。"]],
  "mixed end punctuation": [["真的吗？！我不信。嗯？！……好吧。"]],
  "an ellipsis inside a sentence": [["早啊……周一这一大早的，怎么跑来看我啦，嗯？"]],
  "an ellipsis before a space": [["嗯…… 好吧。等等…你说什么？"]],
  "an ellipsis with no words": [["……。好的。"]],
  "an ellipsis in a quote": [["他说：“好……”然后走了。"]],
  "wave dashes": [["好呀～那我们走吧。嘿嘿～"]],
  "a wave dash before a full stop": [["好呀～。那走吧。"]],
  "a direction cut across deltas": [
    ["[懒洋", "洋的，带点笑意", "] 哎，来啦？今天", "怎么这个点跑过来了，嗯。"],
  ],
  "a direction with a full stop in it": [["[语气平静。带着", "笑意] 好。下一句。"]],
  "laughs between sentences": [["[chuckling] 嘿嘿。[sigh] 好吧。好的。[笑]然后呢。"]],
  "a paired tag cut across deltas": [["<whis", "per>悄悄告诉你。</whis", "per>其实我早就知道了。"]],
  "a closing tag that ends the reply": [["<whisper>悄悄告诉你。</whisper>"]],
  "a direction that ends the reply": [["嗯。[叹气] "]],
  "a direction before a tool call": [["[开心地] "], ["拍好啦！你看看。"]],
  "a sentence open at a tool call": [["好，我拍一张", "给你"], ["拍好啦！"]],
  "full-width parentheses": [["（小声）我知道了。（笑）好吧。（小声。）好。"]],
  "a comma-only reply": [["嗯，好，那就这样吧，"]],
  "a reply with no end punctuation": [["好的，没问题，我知道了"]],
  "a single word": [["嗯"]],
  "a full-width semicolon": [["嗯；好的。"]],
  "a line break": [["好的。\n\n下一句。"]],
  "a decimal": [["我在1.5小时后到。好的。"]],
  "English in Chinese": [["我喜欢 Python. 它很好。你好！Hello! 再见。Hi!你好。他是Dr. Wang。"]],
  English: [
    [
      "Hello Pipecat! How are you? Hello Mr. Smith. It costs $29.95/month. ",
      'Wait... What? Hmm… okay. He said "Hi." Then left. e.g. this one. Hello world. Next',
    ],
  ],
  "English going on in lowercase": [
    [
      "Hello world. this is it. Stop! wait. Wait... what? Wait.. 3 dogs. Done. 3 dogs. ",
      "Hello!! oh no. Albert I. Douglas came. I live in the U.S.A. now. No. 3 is good. Yes",
    ],
  ],
};

/** Closing quotes and brackets, and end punctuation: a sentence keeps the ones that follow it. */
const KEPT = new Set([..."”’」』）)】\"'", ...".!?;…。？！；．｡"]);

/** pipedog's sentences for `rounds`, with the flush at each round's end. */
async function pipedog(rounds: Rounds, language: string): Promise<string[]> {
  const aggregator = new SimpleTextAggregator({ language });
  const sentences: string[] = [];
  for (const deltas of rounds) {
    for (const delta of deltas) {
      for await (const sentence of aggregator.aggregate(delta)) sentences.push(sentence.text);
    }
    const rest = await aggregator.flush();
    if (rest) sentences.push(rest.text);
  }
  return sentences;
}

function native(rounds: Rounds): { sentences: string[]; held: string } {
  const segmenter = new Segmenter();
  const sentences: string[] = [];
  for (const deltas of rounds) {
    for (const delta of deltas) sentences.push(...segmenter.push(delta));
    const rest = segmenter.flush();
    if (rest !== null) sentences.push(rest);
  }
  return { sentences, held: segmenter.held };
}

/** Strips ASCII spaces only, as both splitters do. */
function stripSpaces(text: string): string {
  return text.replace(/^ +| +$/g, "");
}

/**
 * pipedog's sentences with D7 applied to their cuts: a cut moves past the closers and end
 * punctuation that follow it, a cut inside an open `[` goes, and so does one that would leave a
 * sentence with no words, which then merges into the next. Text with no words left at the end is
 * held, not said.
 */
function withD7(full: string, sentences: readonly string[]): { sentences: string[]; held: string } {
  const cuts: number[] = [];
  let at = 0;
  for (const sentence of sentences) {
    const start = full.indexOf(sentence, at);
    expect(full.slice(at, start).trim()).toBe("");
    at = start + sentence.length;
    cuts.push(at);
  }
  const kept: number[] = [0];
  for (let cut of cuts.slice(0, -1)) {
    while (cut < full.length && KEPT.has(full[cut] as string)) cut++;
    const before = full.slice(0, cut);
    const open = (before.match(/\[/g)?.length ?? 0) > (before.match(/\]/g)?.length ?? 0);
    const from = kept[kept.length - 1] as number;
    if (cut <= from || open || !hasWords(full.slice(from, cut))) continue;
    kept.push(cut);
  }
  const pieces = kept.map((from, i) => full.slice(from, kept[i + 1] ?? full.length));
  const last = pieces[pieces.length - 1] as string;
  if (hasWords(last)) return { sentences: pieces.map(stripSpaces), held: "" };
  return { sentences: pieces.slice(0, -1).map(stripSpaces), held: last.trim() };
}

const CASES: readonly [string, Rounds][] = [
  ...REPLIES.map((deltas, i): [string, Rounds] => [`recorded reply ${i + 1}`, [deltas]]),
  ...Object.entries(INVENTORY),
];

describe("the segmenter", () => {
  for (const [name, rounds] of CASES) {
    test(`cuts ${name} as pipedog does, but for D7`, async () => {
      const full = rounds.flat().join("");
      const ours = native(rounds);
      // Fish, ElevenLabs, MiniMax and OpenAI split as English; Cartesia and Soniox as `zh`.
      for (const language of ["en", "zh"]) {
        expect([language, ours]).toEqual([language, withD7(full, await pipedog(rounds, language))]);
      }
    });
  }

  test("cuts every recorded reply exactly as pipedog does", async () => {
    for (const deltas of REPLIES) {
      expect(native([deltas])).toEqual({ sentences: await pipedog([deltas], "en"), held: "" });
    }
  });

  test("differs from pipedog where D7 says, so the comparison above isn't vacuous", async () => {
    for (const name of [
      "a closed quote",
      "repeated end punctuation in a quote",
      "mixed end punctuation",
      "an ellipsis with no words",
      "a direction with a full stop in it",
      "a closing tag that ends the reply",
      "a direction before a tool call",
      "full-width parentheses",
    ]) {
      const rounds = INVENTORY[name] as Rounds;
      expect([name, native(rounds).sentences]).not.toEqual([name, await pipedog(rounds, "en")]);
    }
  });
});

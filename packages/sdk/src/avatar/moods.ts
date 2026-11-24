// Her mood, read from the cues she writes for her voice: the [direction] a reply opens with, and Fish
// Audio's sound and emotion cues inside it. A model shows a mood through its own expressions.
import type { Gesture } from "./model.ts";

/** The moods her directions and cues tag. */
export const MOOD_TAGS = [
  "happy",
  "gentle",
  "lazy",
  "pout",
  "wry",
  "shy",
  "sad",
  "angry",
  "surprised",
  "thinking",
  "gloom",
] as const;

export type MoodTag = (typeof MOOD_TAGS)[number];

interface MoodFamily {
  readonly tag: MoodTag;
  /** Matched anywhere in a direction but right after a negation. */
  readonly zh: readonly string[];
  /** Matched as whole words, whatever their case, so "unhappy" is never happy. */
  readonly en: readonly string[];
}

// In precedence order: a direction keeps the first two families it matches. Its first draft tagged
// 85 of 88 of her logged directions, most of them with two families.
const FAMILIES: readonly MoodFamily[] = [
  {
    tag: "surprised",
    zh: ["惊", "意外", "没想到", "诧异", "愣住"],
    en: ["surprised", "shocked", "startled", "amazed"],
  },
  {
    tag: "thinking",
    zh: ["疑惑", "困惑", "摸不着头脑", "回忆", "想了想", "思考", "琢磨", "犹豫", "纳闷"],
    en: ["thinking", "puzzled", "pondering", "curious"],
  },
  {
    tag: "wry",
    zh: ["哭笑不得", "无奈", "无语", "叹气", "没好气", "好笑又", "又好笑"],
    en: ["wry", "exasperated", "resigned"],
  },
  {
    tag: "shy",
    zh: ["害羞", "不好意思", "心虚", "脸红", "羞", "扭捏", "找补", "歉意"],
    en: ["shy", "embarrassed", "sheepish", "bashful"],
  },
  {
    tag: "sad",
    zh: ["难过", "失落", "伤心", "委屈", "低落", "闷闷", "哽咽", "哭"],
    en: ["sad", "hurt", "sorrowful", "crying"],
  },
  {
    tag: "angry",
    zh: ["生气", "恼火", "愤", "气呼呼", "不爽", "烦躁"],
    en: ["angry", "annoyed", "furious", "irritated"],
  },
  { tag: "gloom", zh: ["阴沉", "阴阳", "冷笑", "阴森"], en: ["ominous", "sinister", "sarcastic"] },
  {
    tag: "pout",
    zh: ["嘴硬", "嫌弃", "傲娇", "轻哼", "哼", "吐槽", "反驳", "理直气壮", "嘟囔"],
    en: ["pouting", "defiant", "tsundere"],
  },
  {
    tag: "lazy",
    zh: ["懒洋洋", "慵懒", "散漫", "漫不经心", "拖长音", "困", "哈欠"],
    en: ["lazy", "sleepy", "drowsy", "languid"],
  },
  {
    tag: "happy",
    zh: ["笑", "开心", "高兴", "欢快", "兴奋", "得意", "调侃", "起哄", "打趣", "轻快", "雀跃"],
    en: ["happy", "cheerful", "playful", "teasing", "excited", "delighted"],
  },
  {
    tag: "gentle",
    zh: ["温柔", "轻柔", "软软", "哄", "安慰", "轻声"],
    en: ["gentle", "soft", "tender", "warm", "soothing"],
  },
];

/** Words a keyword never matches inside: 哭笑不得 is wry, never sad, and 困惑 puzzled, never sleepy. */
const REFUSED_INSIDE: ReadonlyMap<string, readonly string[]> = new Map([
  ["哭", ["哭笑不得"]],
  ["困", ["困惑", "困扰", "困难"]],
]);

/** A negation, softened or not: 不, 不是, 没有, 别, 不太, 不是特别…; the 别 of 特别 negates nothing. */
const NEGATION = "(?:不是?|没有?|(?<!特)别)(?:太|大|很|怎么|那么|这么|特别|再)?";

/** A keyword right after a negation, erased whole, so 不害羞 takes its 羞 along. */
const NEGATED = new RegExp(`${NEGATION}(?:${FAMILIES.flatMap(({ zh }) => zh).join("|")})`, "g");

const MAX_TAGS = 2;

function matchesZh(direction: string, keyword: string): boolean {
  let text = direction;
  for (const word of REFUSED_INSIDE.get(keyword) ?? []) text = text.replaceAll(word, "\n");
  return text.includes(keyword);
}

function matchesEn(direction: string, words: readonly string[]): boolean {
  return words.length > 0 && new RegExp(`\\b(?:${words.join("|")})\\b`, "i").test(direction);
}

/** The moods a direction such as 懒洋洋的，带点笑意 tags, in precedence order, at most two. */
export function moodTags(direction: string): MoodTag[] {
  const affirmed = direction.replace(NEGATED, "\n");
  const tags: MoodTag[] = [];
  for (const family of FAMILIES) {
    if (
      family.zh.some((keyword) => matchesZh(affirmed, keyword)) ||
      matchesEn(direction, family.en)
    ) {
      tags.push(family.tag);
      if (tags.length === MAX_TAGS) break;
    }
  }
  return tags;
}

/**
 * The expressions a mood shows by default, by the ids PSD2Live gives a generated rig's standard
 * expressions. Two moods show the two lists' union, in tag order, at most two: 懒洋洋的，带点笑意's
 * lazy and happy show sleepy and smile.
 */
export const DEFAULT_MOOD_EXPRESSIONS: Readonly<Record<MoodTag, readonly string[]>> = {
  happy: ["smile"],
  gentle: ["smile"],
  lazy: ["sleepy"],
  pout: ["angry"],
  wry: ["sad", "smile"],
  shy: ["shy"],
  sad: ["sad"],
  angry: ["angry"],
  surprised: ["surprised"],
  gloom: ["gloom"],
  thinking: [],
};

/** What a cue does to her face while it is heard: a mood for a few seconds, a gesture, or both. */
export interface SoundCueEffect {
  readonly mood?: MoodTag;
  readonly seconds: number;
  readonly gesture?: Gesture;
}

/** Every cue in the SDK's CUE_EMOJI, decided; null for one that shows nothing on her face. */
export const CUE_EFFECTS: ReadonlyMap<string, SoundCueEffect | null> = new Map<
  string,
  SoundCueEffect | null
>([
  ["chuckling", { mood: "happy", seconds: 1.5, gesture: "nod" }],
  ["laughing", { mood: "happy", seconds: 1.5, gesture: "nod" }],
  ["sighing", { mood: "wry", seconds: 2 }],
  ["gasping", { mood: "surprised", seconds: 1.5 }],
  ["panting", null],
  ["yawning", { mood: "lazy", seconds: 2 }],
  ["groaning", { mood: "wry", seconds: 1.5 }],
  ["snoring", { mood: "lazy", seconds: 3 }],
  ["sobbing", { mood: "sad", seconds: 3 }],
  ["crying loudly", { mood: "sad", seconds: 3 }],
  ["happy", { mood: "happy", seconds: 2 }],
  ["excited", { mood: "happy", seconds: 2 }],
  ["delighted", { mood: "happy", seconds: 2 }],
  ["satisfied", { mood: "happy", seconds: 2 }],
  ["relaxed", { mood: "gentle", seconds: 2 }],
  ["grateful", { mood: "gentle", seconds: 2, gesture: "nod" }],
  ["proud", { mood: "happy", seconds: 2 }],
  ["moved", { mood: "gentle", seconds: 2 }],
  ["calm", { mood: "gentle", seconds: 2 }],
  ["curious", { mood: "thinking", seconds: 2 }],
  ["empathetic", { mood: "gentle", seconds: 2 }],
  ["sympathetic", { mood: "gentle", seconds: 2 }],
  ["compassionate", { mood: "gentle", seconds: 2 }],
  ["surprised", { mood: "surprised", seconds: 2 }],
  ["embarrassed", { mood: "shy", seconds: 2 }],
  ["nostalgic", { mood: "gentle", seconds: 2 }],
  ["lonely", { mood: "sad", seconds: 2 }],
  ["regretful", { mood: "sad", seconds: 2 }],
  ["disappointed", { mood: "sad", seconds: 2 }],
  ["uncertain", { mood: "thinking", seconds: 2 }],
  ["confused", { mood: "thinking", seconds: 2 }],
  ["doubtful", { mood: "thinking", seconds: 2 }],
  ["worried", { mood: "sad", seconds: 2 }],
  ["hopeful", { mood: "happy", seconds: 2 }],
  ["optimistic", { mood: "happy", seconds: 2 }],
  ["sarcastic", { mood: "gloom", seconds: 2 }],
  ["confident", { mood: "happy", seconds: 2 }],
  ["determined", null],
  ["indifferent", null],
  ["sad", { mood: "sad", seconds: 2 }],
  ["angry", { mood: "angry", seconds: 2 }],
  ["frustrated", { mood: "angry", seconds: 2 }],
  ["unhappy", { mood: "sad", seconds: 2 }],
  ["in a hurry tone", null],
  ["shouting", null],
  ["screaming", { mood: "surprised", seconds: 1.5 }],
  ["whispering", null],
  ["soft tone", { mood: "gentle", seconds: 2 }],
]);

/** What hearing a cue such as `chuckling` does to her face; null for a cue that does nothing. */
export function soundCueEffect(name: string): SoundCueEffect | null {
  return CUE_EFFECTS.get(name.trim().toLowerCase()) ?? null;
}

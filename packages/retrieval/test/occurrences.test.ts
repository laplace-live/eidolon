import { describe, expect, test } from "bun:test";
import { type Broadcast, type BroadcastScene, OccurrenceIndex } from "../src/index.ts";

function scene(heading: string, topics: string[], summary = ""): BroadcastScene {
  return {
    id: heading,
    streamId: "",
    heading,
    summary,
    topics,
    chunkType: "commentary",
    refined: true,
    timestamp: "",
  };
}

function broadcast(day: string, scenes: BroadcastScene[]): Broadcast {
  return {
    id: `${day}-BV1abc`,
    streamDate: day,
    streamIds: [`${day}-BV1abc_p1`],
    overview: "",
    sourceChunkIds: [],
    scenes,
    sourcePaths: [],
    unrefinedCount: 0,
    overviewCompressed: false,
  };
}

/** Newest first, as StreamCatalog keeps them. */
const ARCHIVE = [
  broadcast("2026-09-17", [
    scene("开场闲聊", ["开场"]),
    scene("鬼武者实况：Boss战", ["鬼武者", "Boss战"]),
    scene("读SC", ["读SC"], "顺便吐槽了鬼武者的定价"),
  ]),
  broadcast("2026-09-10", [
    scene("开始游玩《鬼武者》", ["鬼武者", "新手教程"]),
    scene("坚果打翻水碗", ["坚果", "宝箱"]),
  ]),
  broadcast("2026-08-30", [
    scene("健身环第一关", ["健身环"]),
    scene("健身环打卡", ["健身环", "APEX"]),
    scene("坚果生病了", ["坚果", "生病"]),
  ]),
  broadcast("2026-08-01", [
    scene("坚果生病去医院", ["坚果", "生病"]),
    scene("和朋友玩apex", ["apex"]),
  ]),
];

async function timelineOf(query: string, broadcasts: readonly Broadcast[] = ARCHIVE) {
  const timeline = await (await OccurrenceIndex.build(broadcasts)).timeline(query);
  return (
    timeline && {
      terms: timeline.terms,
      occurrences: timeline.occurrences.map((o) => [
        o.broadcast.streamDate,
        o.scenes.map((s) => s.heading),
      ]),
    }
  );
}

describe("OccurrenceIndex.timeline", () => {
  test("lists every broadcast naming the topic, newest first, with its matching scenes", async () => {
    expect(await timelineOf("你上次播鬼武者是什么时候？")).toEqual({
      terms: ["鬼武者"],
      occurrences: [
        ["2026-09-17", ["鬼武者实况：Boss战", "读SC"]],
        ["2026-09-10", ["开始游玩《鬼武者》"]],
      ],
    });
  });

  test("a topic only one scene carries names nothing", async () => {
    expect(await timelineOf("你上次开宝箱是什么时候")).toBeNull();
    expect(await timelineOf("你今天吃了什么")).toBeNull();
    expect(await timelineOf("")).toBeNull();
    expect(await timelineOf("你上次播鬼武者是什么时候", [])).toBeNull();
  });

  test("scenes must name every topic the question names", async () => {
    expect(await timelineOf("坚果上次生病是哪天")).toEqual({
      terms: ["坚果", "生病"],
      occurrences: [
        ["2026-08-30", ["坚果生病了"]],
        ["2026-08-01", ["坚果生病去医院"]],
      ],
    });
  });

  test("when no scene names them all, the topic the fewest scenes name stands alone", async () => {
    expect(await timelineOf("你上次边玩健身环边聊坚果是什么时候")).toEqual({
      terms: ["健身环"],
      occurrences: [["2026-08-30", ["健身环第一关", "健身环打卡"]]],
    });
  });

  test("a topic inside a longer one the question names gives way to it", async () => {
    const archive = [
      broadcast("2026-09-02", [
        scene("黑神话悟空二周目", ["黑神话悟空"]),
        scene("黑神话DLC", ["黑神话"]),
      ]),
      broadcast("2026-08-02", [
        scene("黑神话悟空通关", ["黑神话悟空"]),
        scene("聊黑神话", ["黑神话"]),
      ]),
    ];
    expect((await timelineOf("你最后一次玩黑神话悟空是哪天", archive))?.terms).toEqual([
      "黑神话悟空",
    ]);
    expect((await timelineOf("你上回打黑神话是几号", archive))?.occurrences).toEqual([
      ["2026-09-02", ["黑神话悟空二周目", "黑神话DLC"]],
      ["2026-08-02", ["黑神话悟空通关", "聊黑神话"]],
    ]);
  });

  test("matching ignores case", async () => {
    expect(await timelineOf("你上次玩Apex是什么时候")).toEqual({
      terms: ["apex"],
      occurrences: [
        ["2026-08-30", ["健身环打卡"]],
        ["2026-08-01", ["和朋友玩apex"]],
      ],
    });
  });

  test("a Latin topic matches whole words only", async () => {
    const archive = [
      broadcast("2026-09-02", [scene("开黑打OW", ["OW"]), scene("slow down", ["节奏"])]),
      broadcast("2026-08-02", [scene("OW新英雄", ["ow"])]),
    ];
    expect(await timelineOf("how long since you played fall guys", archive)).toBeNull();
    expect(await timelineOf("你上次玩OW是什么时候", archive)).toEqual({
      terms: ["ow"],
      occurrences: [
        ["2026-09-02", ["开黑打OW"]],
        ["2026-08-02", ["OW新英雄"]],
      ],
    });
  });
});

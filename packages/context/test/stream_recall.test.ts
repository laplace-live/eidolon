import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LogRecord } from "@eidolon/config";
import type { LlmTool, ToolEffects, ToolResult } from "@eidolon/core";
import type { Broadcast } from "@eidolon/retrieval";
import {
  OVERVIEW_FRAME_KEY,
  PersonaFacts,
  RECALL_TOOL_NAME,
  StreamArchive,
  StreamRecall,
} from "../src/index.ts";
import {
  broadcast,
  captureLogs,
  deferred,
  FakeContext,
  FakeRetriever,
  MemoryCatalog,
  scope,
  TODAY,
  turnOf,
} from "./helpers.ts";

const NO_EFFECTS: ToolEffects = {
  switchVoice: async () => {
    throw new Error("recall_streams switches no voice");
  },
  sendServerMessage: async () => {
    throw new Error("recall_streams sends no message");
  },
};

// The session's registered tools in runtime's order; runtime advertises all but the hidden ones.
const ALL_TOOLS = ["change_voice_style", RECALL_TOOL_NAME];

let logs: { records: LogRecord[]; restore: () => void };
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => logs.restore());

function recallOf(broadcasts: Broadcast[]): { recall: StreamRecall; retriever: FakeRetriever } {
  const retriever = new FakeRetriever();
  const recall = new StreamRecall({
    retriever,
    catalog: new MemoryCatalog(broadcasts),
    timeZone: "UTC",
    today: () => TODAY,
  });
  return { recall, retriever };
}

function archiveOf(broadcasts: Broadcast[]): { archive: StreamArchive; retriever: FakeRetriever } {
  const retriever = new FakeRetriever();
  const archive = new StreamArchive({
    retriever,
    catalog: new MemoryCatalog(broadcasts),
    timeZone: "UTC",
    today: () => TODAY,
  });
  return { archive, retriever };
}

async function installTool(archive: StreamArchive): Promise<LlmTool> {
  const tool = await archive.recallTool();
  expect(tool).not.toBeNull();
  return tool as LlmTool;
}

function toolCall(
  tool: LlmTool,
  context: FakeContext,
  args: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal,
): Promise<ToolResult> {
  return tool.run({ arguments: args, context, signal }, NO_EFFECTS);
}

function ids(broadcasts: readonly Broadcast[]): Set<string> {
  return new Set(broadcasts.map((b) => b.id));
}

describe("StreamRecall (tests/test_stream_recall.py)", () => {
  test("test_weekly_recap_reads_every_matching_broadcast_without_search", async () => {
    const first = broadcast("2026-09-01", "BV1abc", 2);
    const second = broadcast("2026-09-06");
    const { recall, retriever } = recallOf([first, second, broadcast("2026-09-08")]);
    const query = "What did you stream last week?";
    const result = await recall.lookup(query, { scope: recall.resolve(query) });
    expect(result.overview).toBe(true);
    expect(ids(result.broadcasts)).toEqual(new Set([first.id, second.id]));
    expect(result.chunks).toEqual([]);
    expect(retriever.calls).toEqual([]);
  });

  test("test_date_details_cover_recording_parts_with_exact_date_boundaries", async () => {
    const latest = broadcast("2026-09-08", "BV1abc", 2);
    const { recall, retriever } = recallOf([latest, broadcast("2026-09-06")]);
    const query = "What did you say about ASMR on September 8?";
    const result = await recall.lookup(query, { scope: recall.resolve(query) });
    expect(result.overview).toBe(false);
    expect(result.chunks).toEqual(retriever.hits);
    expect(result.broadcasts[0]?.streamIds).toEqual(latest.streamIds);
    expect(retriever.calls).toEqual([
      {
        query,
        candidates: 15,
        topK: 3,
        datePrefilter: false,
        where: "stream_date >= '2026-09-08' AND stream_date < '2026-09-09'",
      },
    ]);
  });

  test("test_missing_catalog_uses_exact_dates_for_details_but_never_guesses_latest", async () => {
    const { recall, retriever } = recallOf([]);
    let query = "What did you say about ASMR on September 8?";
    await recall.lookup(query, { scope: recall.resolve(query) });
    expect(retriever.calls.at(-1)?.where).toBe(
      "stream_date >= '2026-09-08' AND stream_date < '2026-09-09'",
    );
    retriever.calls.length = 0;
    query = "What did you say about ASMR in your last stream?";
    let result = await recall.lookup(query, { scope: recall.resolve(query) });
    expect(retriever.calls).toEqual([]);
    expect(result.note).not.toBe("");
    query = "What did you stream last week?";
    result = await recall.lookup(query, { scope: recall.resolve(query) });
    expect(result.note).not.toBe("");
    expect(result.broadcasts).toEqual([]);
    expect(retriever.calls).toEqual([]);
  });

  test("test_date_absent_from_stale_catalog_still_searches_table_with_exact_date", async () => {
    const { recall, retriever } = recallOf([broadcast("2026-09-08")]);
    const query = "What did you say about ASMR on September 7?";
    const result = await recall.lookup(query, { scope: recall.resolve(query) });
    expect(retriever.calls.at(-1)?.where).toBe(
      "stream_date >= '2026-09-07' AND stream_date < '2026-09-08'",
    );
    expect(result.chunks).toEqual(retriever.hits);
    expect(result.broadcasts).toEqual([]);
  });

  test("test_latest_same_day_broadcasts_are_kept_together_without_invented_order", async () => {
    const first = broadcast("2026-09-08", "BV1abc");
    const second = broadcast("2026-09-08", "BV2def");
    const { recall, retriever } = recallOf([first, second, broadcast("2026-09-06")]);
    const query = "What was your last stream's content?";
    const result = await recall.lookup(query, { scope: recall.resolve(query) });
    expect(ids(result.broadcasts)).toEqual(new Set([first.id, second.id]));
    expect(retriever.calls).toEqual([]);
    expect(result.note).not.toBe("");
  });

  test("test_same_day_order_warning_survives_missing_details", async () => {
    const { recall, retriever } = recallOf([
      broadcast("2026-09-08", "BV1abc"),
      broadcast("2026-09-08", "BV2def"),
    ]);
    retriever.hits = [];
    const query = "What did you say about ASMR in your last stream?";
    const result = await recall.lookup(query, { scope: recall.resolve(query) });
    expect(result.note).toContain("先后");
    expect(result.note).toContain("没有找到");
  });

  test("test_latest_recall_keeps_dates_for_followup_week", async () => {
    const latest = broadcast("2026-09-08");
    const sameWeek = broadcast("2026-09-07");
    const { recall, retriever } = recallOf([latest, sameWeek, broadcast("2026-09-06")]);
    let query = "What was your last stream's content?";
    await recall.lookup(query, { scope: recall.resolve(query) });
    query = "What did you play that week?";
    const followup = recall.resolve(query);
    expect(followup).not.toBeNull();
    const result = await recall.lookup(query, { scope: followup });
    expect(ids(result.broadcasts)).toEqual(new Set([latest.id, sameWeek.id]));
    expect(retriever.calls.at(-1)?.where).toBe(
      "stream_date >= '2026-09-07' AND stream_date < '2026-09-14'",
    );
  });

  test("test_followup_details_stay_in_previously_selected_week", async () => {
    const { recall, retriever } = recallOf([
      broadcast("2026-09-01"),
      broadcast("2026-09-06"),
      broadcast("2026-09-08"),
    ]);
    let query = "What did you stream last week?";
    await recall.lookup(query, { scope: recall.resolve(query) });
    query = "What did you say about ASMR that week?";
    await recall.lookup(query, { scope: recall.resolve(query) });
    expect(retriever.calls.at(-1)?.where).toBe(
      "stream_date >= '2026-08-31' AND stream_date < '2026-09-07'",
    );
  });
});

describe("StreamArchive (tests/test_stream_recall.py)", () => {
  function hasScopeBlock(context: FakeContext): boolean {
    return context.contents().some((content) => content.includes("查询范围"));
  }

  test("test_arbitrary_biographical_date_does_not_reuse_archive_scope", async () => {
    const { archive, retriever } = archiveOf([broadcast("2026-09-08")]);
    const first = "What was your last stream's content?";
    const context = new FakeContext([{ role: "user", content: first }]);
    await archive.enhance(context, first);
    retriever.calls.length = 0;
    const query = "I was born on September 8.";
    context.add({ role: "user", content: query });
    await archive.enhance(context, query);
    expect(retriever.calls.every((call) => (call.where ?? null) === null)).toBe(true);
    expect(hasScopeBlock(context)).toBe(false);
  });

  test("test_short_chinese_followup_resolves_latest_turn_without_history_conflict", async () => {
    const { archive, retriever } = archiveOf([broadcast("2026-09-08"), broadcast("2026-09-01")]);
    const context = new FakeContext([{ role: "user", content: "你2026年9月8日直播播了什么？" }]);
    await archive.onContext(turnOf(context));
    context.add({ role: "assistant", content: "聊了 ASMR 和游戏。" });
    context.add({ role: "user", content: "那周呢？" });
    await archive.onContext(turnOf(context));
    expect(retriever.calls).toEqual([]);
    expect(archive.recall.selectedScope?.startDate).toBe("2026-09-07");
    expect(archive.recall.selectedScope?.endDate).toBe("2026-09-14");
  });

  test("test_same_text_new_user_turn_retrieves_again_without_accumulating_blocks", async () => {
    const { archive, retriever } = archiveOf([broadcast("2026-09-08")]);
    const query = "What did you say about ASMR on September 8?";
    const context = new FakeContext([
      { role: "system", content: "Keep persona rules" },
      { role: "user", content: query },
    ]);
    await archive.onContext(turnOf(context));
    await archive.onContext(turnOf(context));
    expect(retriever.calls).toHaveLength(1);
    context.add({ role: "assistant", content: "聊了 ASMR。" });
    context.add({ role: "user", content: query });
    await archive.onContext(turnOf(context));
    expect(retriever.calls).toHaveLength(2);
    const contents = context.contents();
    expect(contents.filter((c) => c.startsWith("最近已归档的直播概览："))).toHaveLength(1);
    expect(contents.filter((c) => c.startsWith("本次直播回忆查询："))).toHaveLength(1);
    expect(contents).toContain("Keep persona rules");
  });

  const invalid: Record<string, unknown>[] = [
    { query: "", mode: "overview", period: "latest" },
    { query: "x", mode: "invent", period: "latest" },
    { query: "x", mode: "overview", period: "past_days", days: 367 },
    { query: "x", mode: "overview", period: "latest", sql: "DROP TABLE" },
  ];
  for (const args of invalid) {
    test(`test_tool_rejects_invalid_requests_without_retrieval[${JSON.stringify(args)}]`, async () => {
      const { archive, retriever } = archiveOf([broadcast("2026-09-08")]);
      const tool = await installTool(archive);
      const context = new FakeContext([{ role: "user", content: "Recall a stream" }]);
      const result = await toolCall(tool, context, args);
      expect(result).toHaveProperty("error");
      expect(retriever.calls).toEqual([]);
    });
  }

  const unscoped: [Record<string, unknown>, string][] = [
    [{ period: "selected" }, "还没有已选定的场次，请给出日期范围或使用 latest"],
    [{ period: "date_range" }, "date_range 需要 start_date"],
    [
      { period: "date_range", start_date: "2026-09-09", end_date: "2026-09-08" },
      "end_date 必须晚于 start_date，且不包含该日",
    ],
  ];
  for (const [fields, reason] of unscoped) {
    test(`test_tool_scope_requires_available_selection_or_valid_dates[${JSON.stringify(fields)}]`, async () => {
      const { archive, retriever } = archiveOf([]);
      const tool = await installTool(archive);
      const context = new FakeContext([{ role: "user", content: "Recall a stream" }]);
      const result = await toolCall(tool, context, { query: "recap", mode: "overview", ...fields });
      expect(result).toEqual({ error: "直播查询未完成", reason });
      expect(retriever.calls).toEqual([]);
    });
  }

  test("test_tool_budget_retains_voice_and_custom_tools_then_resets_next_user_turn", async () => {
    const { archive, retriever } = archiveOf([broadcast("2026-09-08")]);
    const tool = await installTool(archive);
    const context = new FakeContext([{ role: "user", content: "Recall a stream" }]);
    const args = { query: "recap", mode: "overview", period: "latest" };
    expect(await toolCall(tool, context, args)).toHaveProperty("content");
    expect(await toolCall(tool, context, args)).toHaveProperty("content");
    expect(await toolCall(tool, context, args)).toHaveProperty("error");
    // Runtime keeps every other tool, custom tools included; only recall_streams is hidden.
    expect(context.hidden).toEqual([RECALL_TOOL_NAME]);
    expect(context.advertised(ALL_TOOLS)).toEqual(["change_voice_style"]);
    context.add({ role: "assistant", content: "聊了 ASMR。" });
    context.add({ role: "user", content: "Recall a stream" });
    expect(await toolCall(tool, context, args)).toHaveProperty("content");
    expect(new Set(context.advertised(ALL_TOOLS))).toEqual(new Set(ALL_TOOLS));
    expect(retriever.calls).toEqual([]);
    expect(await archive.recallTool()).toBe(tool);
  });

  test("test_tool_selected_scope_cannot_widen_details_to_other_dates", async () => {
    const selected = broadcast("2026-09-01", "BV1abc", 2);
    const { archive, retriever } = archiveOf([selected, broadcast("2026-09-08")]);
    archive.recall.selectedScope = scope({ streamIds: [selected.id], label: "selected" });
    const tool = await installTool(archive);
    const context = new FakeContext([{ role: "user", content: "Tell me about ASMR" }]);
    const result = await toolCall(tool, context, {
      query: "ASMR",
      mode: "details",
      period: "selected",
    });
    expect(result).toHaveProperty("content");
    expect(retriever.calls.at(-1)?.where).toBe(
      "stream_id IN ('2026-09-01-BV1abc_p1', '2026-09-01-BV1abc_p2')",
    );
  });

  test("test_tool_is_not_advertised_without_catalog_or_archive_table", async () => {
    const retriever = new FakeRetriever();
    retriever.hasTable = false;
    const archive = new StreamArchive({
      retriever,
      catalog: new MemoryCatalog([], false),
      timeZone: "UTC",
    });
    expect(await archive.recallTool()).toBeNull();
  });

  test("test_tool_broadcast_selection_rejects_any_unknown_id", async () => {
    const chosen = broadcast("2026-09-08", "BV1abc", 2);
    const { archive, retriever } = archiveOf([chosen]);
    const tool = await installTool(archive);
    const context = new FakeContext([{ role: "user", content: "Tell me about that broadcast" }]);
    const args: Record<string, unknown> = {
      query: "ASMR",
      mode: "details",
      period: "broadcasts",
      broadcast_ids: [chosen.id, "invented-broadcast"],
    };
    expect(await toolCall(tool, context, args)).toHaveProperty("error");
    expect(retriever.calls).toEqual([]);
    args.broadcast_ids = [chosen.id];
    const response = await toolCall(tool, context, args);
    expect(response.broadcast_ids).toEqual([chosen.id]);
    expect(retriever.calls.at(-1)?.where).toBe(
      "stream_id IN ('2026-09-08-BV1abc_p1', '2026-09-08-BV1abc_p2')",
    );
  });

  for (const query of ["Tell me more", "展开说说"]) {
    test(`test_elaboration_followup_never_searches_global_archive[${query}]`, async () => {
      const { archive, retriever } = archiveOf([
        broadcast("2026-09-08", "BV1abc", 2),
        broadcast("2026-09-01"),
      ]);
      await installTool(archive);
      const initial = "What was your last stream's content?";
      const context = new FakeContext([{ role: "user", content: initial }]);
      await archive.enhance(context, initial);
      context.add({ role: "assistant", content: "聊了 ASMR 和游戏。" });
      context.add({ role: "user", content: query });
      await archive.enhance(context, query);
      for (const call of retriever.calls) {
        expect(call.where).toBe("stream_id IN ('2026-09-08-BV1abc_p1', '2026-09-08-BV1abc_p2')");
      }
    });
  }

  test("test_recap_pipeline_skips_facts_on_first_pass_and_tool_continuation", async () => {
    const { archive, retriever: archiveRetriever } = archiveOf([broadcast("2026-09-08")]);
    const factsRetriever = new FakeRetriever([{ text: "喜欢奶茶", date: "2026-09-01" }]);
    const facts = new PersonaFacts({ retriever: factsRetriever });
    let pushed = 0;
    const frame = async (context: FakeContext): Promise<void> => {
      const metadata = {};
      await archive.onContext(turnOf(context, metadata));
      await facts.onContext(turnOf(context, metadata));
      pushed++;
    };
    const context = new FakeContext([
      { role: "user", content: "What was your last stream's content?" },
    ]);
    await frame(context);
    expect(archiveRetriever.calls).toEqual([]);
    expect(factsRetriever.calls).toEqual([]);
    context.add({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "recall-1",
          type: "function",
          function: {
            name: RECALL_TOOL_NAME,
            arguments: '{"query":"ASMR","mode":"details","period":"selected"}',
          },
        },
      ],
    });
    context.add({ role: "tool", tool_call_id: "recall-1", content: "聊了喜欢的 ASMR。" });
    await frame(context);
    expect(archiveRetriever.calls).toEqual([]);
    expect(factsRetriever.calls).toEqual([]);
    context.add({ role: "user", content: "What is your favorite food?" });
    await frame(context);
    expect(pushed).toBe(3);
    expect(factsRetriever.calls).toHaveLength(1);
    expect(factsRetriever.calls[0]?.query).toBe("What is your favorite food?");
  });

  test("test_elaboration_after_unrelated_birthday_does_not_reopen_archive_scope", async () => {
    const { archive, retriever } = archiveOf([broadcast("2026-09-08")]);
    await installTool(archive);
    const first = "What was your last stream's content?";
    const context = new FakeContext([{ role: "user", content: first }]);
    await archive.enhance(context, first);
    context.add({ role: "assistant", content: "聊了 ASMR。" });
    const unrelated = "My birthday is on September 8.";
    context.add({ role: "user", content: unrelated });
    await archive.enhance(context, unrelated);
    context.add({ role: "assistant", content: "那时候一起庆祝生日吧。" });
    const query = "Tell me more";
    context.add({ role: "user", content: query });
    retriever.calls.length = 0;
    await archive.enhance(context, query);
    expect(retriever.calls.every((call) => (call.where ?? null) === null)).toBe(true);
    expect(hasScopeBlock(context)).toBe(false);
  });

  test("test_cancelled_recall_tool_does_not_replace_selected_scope", async () => {
    const { archive, retriever } = archiveOf([broadcast("2026-09-08"), broadcast("2026-09-01")]);
    const previous = scope({ streamIds: ["2026-09-01-BV1abc"], label: "previous selection" });
    archive.recall.selectedScope = previous;
    const tool = await installTool(archive);
    const context = new FakeContext([{ role: "user", content: "ASMR in the latest stream" }]);
    const started = deferred<void>();
    retriever.search = () => {
      started.resolve();
      return new Promise(() => {});
    };
    const controller = new AbortController();
    const pending = toolCall(
      tool,
      context,
      { query: "ASMR", mode: "details", period: "latest" },
      controller.signal,
    );
    await started.promise;
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(archive.recall.selectedScope).toEqual(previous);
  });

  test("test_ambiguous_broadcast_followup_requests_tool_selection_without_global_search", async () => {
    const { archive, retriever } = archiveOf([broadcast("2026-09-01"), broadcast("2026-09-06")]);
    await installTool(archive);
    const first = "你上周直播播了什么？";
    const context = new FakeContext([{ role: "user", content: first }]);
    await archive.enhance(context, first);
    expect(archive.recall.selectedScope?.streamIds).toHaveLength(2);
    context.add({ role: "assistant", content: "有两场，聊了 ASMR 和游戏。" });
    const query = "那场再多说一点";
    context.add({ role: "user", content: query });
    await archive.enhance(context, query);
    expect(retriever.calls).toEqual([]);
    const blocks = context.contents().filter((c) => c.startsWith("本次直播回忆查询："));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain(RECALL_TOOL_NAME);
  });

  test("a recap sets the overview flag the facts provider reads", async () => {
    const { archive } = archiveOf([broadcast("2026-09-08")]);
    const metadata: Record<string, unknown> = {};
    const context = new FakeContext([
      { role: "user", content: "What was your last stream's content?" },
    ]);
    await archive.onContext(turnOf(context, metadata));
    expect(metadata[OVERVIEW_FRAME_KEY]).toBe(true);
  });
});

describe("StreamRecall.select", () => {
  test("latest picks every broadcast of the newest date up to today", async () => {
    const { recall } = recallOf([
      broadcast("2026-09-10"),
      broadcast("2026-09-08", "BV1abc"),
      broadcast("2026-09-08", "BV2def"),
      broadcast("2026-09-06"),
    ]);
    expect(ids(await recall.select(scope({ latest: 1 })))).toEqual(
      new Set(["2026-09-08-BV1abc", "2026-09-08-BV2def"]),
    );
    // Python's quirk: "previous" is the second entry, so a shared newest date comes back again.
    expect(ids(await recall.select(scope({ latest: 2 })))).toEqual(
      new Set(["2026-09-08-BV1abc", "2026-09-08-BV2def"]),
    );
  });

  test("latest past the end of the catalog selects nothing", async () => {
    const { recall } = recallOf([broadcast("2026-09-08")]);
    expect(await recall.select(scope({ latest: 2 }))).toEqual([]);
  });

  test("ranges and ids go through the catalog", async () => {
    const { recall } = recallOf([
      broadcast("2026-09-08", "BV1abc", 2),
      broadcast("2026-09-06"),
      broadcast("2026-09-01"),
    ]);
    expect(
      ids(await recall.select(scope({ startDate: "2026-09-01", endDate: "2026-09-07" }))),
    ).toEqual(new Set(["2026-09-06-BV1abc", "2026-09-01-BV1abc"]));
    expect(ids(await recall.select(scope({ streamIds: ["2026-09-08-BV1abc_p2"] })))).toEqual(
      new Set(["2026-09-08-BV1abc"]),
    );
  });

  test("remembering a result without broadcasts keeps its scope as is", () => {
    const { recall } = recallOf([]);
    const chosen = scope({ latest: 1, label: "最近一次直播" });
    recall.remember({ scope: chosen, overview: true, broadcasts: [], chunks: [], note: "" });
    expect(recall.selectedScope).toBe(chosen);
    recall.remember({ scope: null, overview: true, broadcasts: [], chunks: [], note: "" });
    expect(recall.selectedScope).toBe(chosen);
  });
});

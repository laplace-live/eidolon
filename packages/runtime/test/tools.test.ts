import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LlmTool, ToolCall, ToolEffects, ToolResult } from "@eidolon/core";
import { CancelledError, createTask } from "@pipedog/asyncio";
import { type Frame, TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { RTVIServerMessageFrame } from "@pipedog/core/processors/frameworks/rtvi/frames";
import {
  FunctionCallParams,
  type FunctionCallRegistryItem,
  type LLMService,
} from "@pipedog/core/services/llm_service";
import type { FishAudioTTSSettings } from "@pipedog/fish/tts";
import { OpenRouterLLMService } from "@pipedog/openrouter/llm";
import { SessionTools } from "../src/adapters/tools.ts";
import { captureLogs, deferred, type LogCapture, PassThrough } from "./support.ts";

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => logs.restore());

function tool(
  name: string,
  options: { cancelOnInterruption?: boolean; timeoutSecs?: number | null } = {},
  run: (call: ToolCall, effects: ToolEffects) => Promise<ToolResult> = async () => ({ ok: true }),
): LlmTool {
  return {
    schema: {
      name,
      description: `${name} description`,
      properties: { style: { type: "string", enum: ["default", "gentle"] } },
      required: ["style"],
    },
    cancelOnInterruption: options.cancelOnInterruption ?? true,
    timeoutSecs: options.timeoutSecs ?? null,
    run,
  };
}

function session() {
  const llm = new OpenRouterLLMService({ apiKey: "test-key" });
  const tts = new PassThrough("tts");
  return { llm, tts, tools: new SessionTools(llm, tts) };
}

function registry(llm: LLMService<any>, name: string): FunctionCallRegistryItem {
  const item = (llm as any)._functions.get(name) as FunctionCallRegistryItem | undefined;
  if (!item) throw new Error(`${name} is not registered`);
  return item;
}

function names(context: LLMContext): string[] {
  const tools = context.tools as { standardTools?: { name: string }[] };
  return tools.standardTools?.map((schema) => schema.name) ?? [];
}

/** Calls `name`'s handler in its own task, as pipedog's function-call runner does. */
function call(llm: LLMService<any>, name: string, context = new LLMContext()) {
  const events: [string, unknown][] = [];
  const params = new FunctionCallParams({
    functionName: name,
    toolCallId: "call-1",
    arguments: { style: "gentle" },
    llm: {
      pushFrame: async (frame: Frame) => {
        events.push(["push", frame]);
      },
    } as unknown as LLMService<any>,
    pipelineWorker: null as never,
    context,
    resultCallback: async (result) => {
      events.push(["result", result]);
    },
  });
  const handler = registry(llm, name).handler as (p: FunctionCallParams) => Promise<void>;
  const task = createTask(() => handler(params), "function-call");
  return { task, events, params };
}

describe("SessionTools", () => {
  test("registers each tool with its own interruption and timeout options", () => {
    const { llm, tools } = session();
    tools.register(tool("change_voice_style"));
    tools.register(tool("take_selfie", { cancelOnInterruption: false, timeoutSecs: 120 }));
    tools.register(tool("recall_streams"));
    expect(registry(llm, "change_voice_style").cancelOnInterruption).toBe(true);
    expect(registry(llm, "change_voice_style").timeoutSecs).toBeNull();
    expect(registry(llm, "take_selfie").cancelOnInterruption).toBe(false);
    expect(registry(llm, "take_selfie").timeoutSecs).toBe(120);
    expect(registry(llm, "recall_streams").cancelOnInterruption).toBe(true);
    expect(registry(llm, "recall_streams").cancellableByLlm).toBe(false);
  });

  test("advertises advertise-only schemas in registration order", () => {
    const { tools } = session();
    expect(tools.size).toBe(0);
    for (const name of ["change_voice_style", "take_selfie", "recall_streams"]) {
      tools.register(tool(name));
    }
    const schema = tools.toolsSchema();
    expect(schema.standardTools.map((s) => s.name)).toEqual([
      "change_voice_style",
      "take_selfie",
      "recall_streams",
    ]);
    expect(schema.standardTools.every((s) => s.handler === null)).toBe(true);
    expect(schema.standardTools[0]?.toDefaultDict()).toEqual({
      name: "change_voice_style",
      description: "change_voice_style description",
      parameters: {
        type: "object",
        properties: { style: { type: "string", enum: ["default", "gentle"] } },
        required: ["style"],
      },
    });
  });

  test("setHiddenTools hides from the full list and [] restores it", () => {
    const { tools } = session();
    tools.register(tool("change_voice_style"));
    tools.register(tool("recall_streams"));
    const context = new LLMContext({ tools: tools.toolsSchema() });
    const conversation = tools.conversation(context);
    conversation.setHiddenTools(["recall_streams"]);
    expect(names(context)).toEqual(["change_voice_style"]);
    conversation.setHiddenTools(["recall_streams"]);
    expect(names(context)).toEqual(["change_voice_style"]);
    conversation.setHiddenTools([]);
    expect(names(context)).toEqual(["change_voice_style", "recall_streams"]);
    conversation.setHiddenTools(["change_voice_style", "recall_streams"]);
    expect(names(context)).toEqual([]);
  });

  test("the conversation is the live message list", () => {
    const { tools } = session();
    const context = new LLMContext({ messages: [{ role: "user", content: "hi" }] });
    const conversation = tools.conversation(context);
    expect(conversation.getMessages()).toBe(context.getMessages());
    const live = context.getMessages();
    conversation.setMessages([{ role: "system", content: "s" }, ...live]);
    expect(context.getMessages()).toBe(live);
    expect(live).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
    ]);
  });

  test("switchVoice reaches this session's TTS ahead of the result", async () => {
    const { llm, tts, tools } = session();
    let seen: ToolCall | undefined;
    tools.register(
      tool("change_voice_style", {}, async (c, effects) => {
        seen = c;
        await effects.switchVoice("ref-gentle");
        return { ok: true, style: "gentle" };
      }),
    );
    const { task, events, params } = call(llm, "change_voice_style");
    await task;
    expect(events.map(([kind]) => kind)).toEqual(["push", "result"]);
    const frame = events[0]?.[1] as TTSUpdateSettingsFrame;
    expect(frame).toBeInstanceOf(TTSUpdateSettingsFrame);
    expect((frame.delta as FishAudioTTSSettings).voice).toBe("ref-gentle");
    expect(frame.service).toBe(tts);
    expect(events[1]?.[1]).toEqual({ ok: true, style: "gentle" });
    expect(seen?.arguments).toBe(params.arguments);
    expect(seen?.signal).toBe(task.signal);
    expect(seen?.context.getMessages()).toBe(params.context.getMessages());
  });

  test("sendServerMessage pushes an RTVI server message ahead of the result", async () => {
    const { llm, tools } = session();
    tools.register(
      tool("take_selfie", { cancelOnInterruption: false, timeoutSecs: 120 }, async (_, effects) => {
        await effects.sendServerMessage({ type: "selfie", urls: ["/api/selfie/abc.png"] });
        return { ok: true, count: 1 };
      }),
    );
    const { task, events } = call(llm, "take_selfie");
    await task;
    expect(events.map(([kind]) => kind)).toEqual(["push", "result"]);
    const frame = events[0]?.[1] as RTVIServerMessageFrame;
    expect(frame).toBeInstanceOf(RTVIServerMessageFrame);
    expect(frame.data).toEqual({ type: "selfie", urls: ["/api/selfie/abc.png"] });
  });

  test("a server message is also handed to the session's hook, which may throw without failing the tool", async () => {
    const llm = new OpenRouterLLMService({ apiKey: "test-key" });
    const reported: unknown[] = [];
    const tools = new SessionTools(llm, new PassThrough("tts"), (data) => {
      reported.push(data);
      if (reported.length === 2) throw new Error("the chat is gone");
    });
    tools.register(
      tool("take_selfie", { cancelOnInterruption: false, timeoutSecs: 120 }, async (_, effects) => {
        await effects.sendServerMessage({ type: "selfie", urls: ["/api/selfie/abc.png"] });
        return { ok: true, count: 1 };
      }),
    );
    for (const _ of [1, 2]) {
      const { task, events } = call(llm, "take_selfie");
      await task;
      expect(events.map(([kind]) => kind)).toEqual(["push", "result"]);
      const frame = events[0]?.[1] as RTVIServerMessageFrame;
      expect(frame.data).toEqual({ type: "selfie", urls: ["/api/selfie/abc.png"] });
    }
    expect(reported).toEqual([
      { type: "selfie", urls: ["/api/selfie/abc.png"] },
      { type: "selfie", urls: ["/api/selfie/abc.png"] },
    ]);
    expect(logs.messages("ERROR")).toEqual(["Could not report a server message: the chat is gone"]);
  });

  test("cancelling the call aborts the tool's signal and reports no result", async () => {
    const { llm, tools } = session();
    const started = deferred<AbortSignal>();
    tools.register(
      tool("recall_streams", {}, (c) => {
        started.resolve(c.signal);
        return new Promise((_, reject) => {
          c.signal.addEventListener("abort", () => reject(c.signal.reason));
        });
      }),
    );
    const { task, events } = call(llm, "recall_streams");
    const signal = await started.promise;
    task.cancel();
    await expect(task.promise).rejects.toBeInstanceOf(CancelledError);
    expect(task.cancelled()).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(events).toEqual([]);
  });
});

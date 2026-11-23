// Task notifications: what each says, under her name, in both languages, and what its click asks
// of the page.
import { describe, expect, test } from "vitest";
import type { BackendState, ReadyState } from "../src/main/controller.ts";
import type { BackendFetch, BackendResponse } from "../src/main/quit-check.ts";
import { STRINGS } from "../src/main/strings.ts";
import { followBackend, type Notice, noticeCommand, noticeText } from "../src/main/task-notices.ts";

const en = STRINGS.en;
const zh = STRINGS["zh-Hans"];
const CHAT = "0b7f5f2e-3c1d-4e8a-9f60-1a2b3c4d5e6f";
const TASK = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

const notice: Notice = {
  task: TASK,
  chat: CHAT,
  persona: "Milky Green",
  kind: "start",
  goal: "Write a React TodoMVC in one index.html",
};

describe("noticeText", () => {
  test("is titled with her name, and says the kind's line, then her goal", () => {
    expect(noticeText(notice, en)).toEqual({
      title: "Milky Green",
      body: "Waiting for your OK to start a task\nWrite a React TodoMVC in one index.html",
    });
    expect(noticeText({ ...notice, kind: "succeeded" }, en)).toEqual({
      title: "Milky Green",
      body: "Finished the task\nWrite a React TodoMVC in one index.html",
    });
  });

  test("says the line alone when there is no goal", () => {
    expect(noticeText({ ...notice, kind: "failed", goal: "" }, en).body).toBe("The task failed");
    expect(noticeText({ ...notice, kind: "failed", goal: "  " }, en).body).toBe("The task failed");
  });

  test("is titled Eidolon when her name is unknown", () => {
    expect(noticeText({ ...notice, persona: null }, en).title).toBe("Eidolon");
    expect(noticeText({ ...notice, persona: "" }, en).title).toBe("Eidolon");
    expect(noticeText({ ...notice, persona: null }, zh).title).toBe("Eidolon");
  });

  test("speaks the shell's language, her goal and name as they are", () => {
    const goal = "写一个 React TodoMVC，单文件 index.html";
    expect(noticeText({ ...notice, persona: "奶绿", kind: "command", goal }, zh)).toEqual({
      title: "奶绿",
      body: `等你同意运行一条命令\n${goal}`,
    });
    expect(noticeText({ ...notice, kind: "cancelled", goal: "" }, zh).body).toBe("任务已停止");
  });

  test("has a line for every kind, in both languages", () => {
    const kinds = Object.keys(en.notice);
    for (const strings of [en, zh]) {
      const bodies = kinds.map(
        (kind) => noticeText({ ...notice, kind: kind as Notice["kind"], goal: "" }, strings).body,
      );
      expect(new Set(bodies).size).toBe(kinds.length);
    }
  });
});

/** A server whose status answers `body`, recording each path asked for. */
function server(body: unknown, status = 200): { fetch: BackendFetch; paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    fetch: async (path): Promise<BackendResponse> => {
      paths.push(path);
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    },
  };
}

describe("noticeCommand", () => {
  test("opens the task in its chat, or the Tasks page for a task without one", async () => {
    const { fetch, paths } = server({ activeCalls: 0 });
    expect(await noticeCommand(notice, fetch)).toBe(`open-task:${CHAT}:${TASK}`);
    expect(await noticeCommand({ ...notice, chat: null }, fetch)).toBe("tasks");
    expect(paths).toEqual(["/api/local/status", "/api/local/status"]);
  });

  test("asks nothing of the page while a call is live, or when the status doesn't count calls", async () => {
    for (const body of [{ activeCalls: 1 }, {}, { activeCalls: "0" }, null, []]) {
      expect(await noticeCommand(notice, server(body).fetch)).toBeNull();
    }
  });

  test("rejects when the status can't be read, or its ids aren't the server's", async () => {
    await expect(noticeCommand(notice, server({}, 503).fetch)).rejects.toThrow(
      "GET /api/local/status answered 503",
    );
    const failing: BackendFetch = async () => {
      throw new Error("no server is ready");
    };
    await expect(noticeCommand(notice, failing)).rejects.toThrow("no server is ready");
    await expect(
      noticeCommand({ ...notice, task: "../settings" }, server({ activeCalls: 0 }).fetch),
    ).rejects.toThrow();
  });
});

describe("followBackend", () => {
  const ready = (pid: number, owned = false): ReadyState => ({
    phase: "ready",
    origin: "http://127.0.0.1:7860",
    token: {} as ReadyState["token"],
    owned,
    pid,
  });

  /** What the watch is told across `states`. */
  function told(states: readonly BackendState[]): string[] {
    const calls: string[] = [];
    const follow = followBackend({
      ready: () => calls.push("ready"),
      stop: () => calls.push("stop"),
    });
    for (const state of states) follow(state);
    return calls;
  }

  test("a server's first ready starts the watch, and an attached server's idle hold leaves it be", () => {
    expect(
      told([
        { phase: "starting" },
        ready(41),
        { phase: "holding", owned: false },
        ready(41),
        { phase: "holding", owned: false },
        ready(41),
      ]),
    ).toEqual(["stop", "ready"]);
  });

  test("another server after a hold, a restart's included, starts it on a new baseline", () => {
    expect(told([ready(41), { phase: "holding", owned: false }, ready(42)])).toEqual([
      "ready",
      "ready",
    ]);
    expect(told([ready(41, true), { phase: "holding", owned: true }, ready(43, true)])).toEqual([
      "ready",
      "ready",
    ]);
    // Our own server at the attached one's address and process isn't the one followed.
    expect(told([ready(41), ready(41, true)])).toEqual(["ready", "ready"]);
  });

  test("no server stops it, and the same server after that starts it again", () => {
    const failed: BackendState = {
      phase: "failed",
      failure: { reason: "exited", code: 1, signal: null, stderr: [] },
    };
    expect(told([ready(41), failed, ready(41), { phase: "stopped" }])).toEqual([
      "ready",
      "stop",
      "ready",
      "stop",
    ]);
  });
});

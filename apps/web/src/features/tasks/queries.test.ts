import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TaskSnapshot, TaskStatus } from "@/lib/api";
import { linguiMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
const { stoppedByTurningOff, tasksQuery } = await import("./queries");

afterEach(() => {
  vi.restoreAllMocks();
});

const STATUSES: readonly TaskStatus[] = [
  "awaiting-approval",
  "running",
  "paused",
  "interrupted",
  "succeeded",
  "failed",
  "cancelled",
];

function task(id: string, status: TaskStatus): TaskSnapshot {
  return {
    v: 1,
    id,
    createdAt: Number(id),
    status,
    chat: { id: "chat", persona: "mio", call: `call-${id}` },
    brief: { goal: id, deliverable: id, folder: "/Users/me/todo", check: "Check it" },
    model: { account: "openrouter", model: "x-ai/grok-5" },
    grants: [],
    spendPauseUsd: 1,
    spentUsd: 0,
    files: { read: [], written: [] },
  };
}

/** The API holding `tasks`: GET tasks lists them, and GET status counts the running ones. */
function serve(tasks: readonly TaskSnapshot[]) {
  const running = tasks.filter((entry) => entry.status === "running").length;
  const answer = async (input: RequestInfo | URL): Promise<Response> => {
    switch (String(input)) {
      case "/api/local/tasks":
        return Response.json({ tasks });
      case "/api/local/status":
        return Response.json({ assistant: { enabled: true, ready: true, problem: null, running } });
      default:
        return Response.json(
          { error: { code: "not-found", message: "No such route" } },
          { status: 404 },
        );
    }
  };
  return vi.spyOn(globalThis, "fetch").mockImplementation(answer as typeof fetch);
}

describe("what turning Assistant Mode off stops", () => {
  test("a task waiting for the owner's OK, though none runs", async () => {
    serve([task("1", "awaiting-approval")]);
    expect(await stoppedByTurningOff(new QueryClient())).toBe(1);
  });

  test("every task that hasn't ended: running, waiting to start, paused or interrupted", async () => {
    serve(STATUSES.map((status, i) => task(String(i + 1), status)));
    expect(await stoppedByTurningOff(new QueryClient())).toBe(4);
  });

  test("is read afresh, not from the list the nav last read", async () => {
    const client = new QueryClient();
    client.setQueryData(tasksQuery.queryKey, { tasks: [] });
    serve([task("1", "paused")]);
    expect(await stoppedByTurningOff(client)).toBe(1);
  });

  test("is unknown while the tasks can't be read", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        { error: { code: "internal", message: "Eidolon hit an error" } },
        { status: 500 },
      ),
    );
    expect(await stoppedByTurningOff(new QueryClient())).toBeNull();
  });
});

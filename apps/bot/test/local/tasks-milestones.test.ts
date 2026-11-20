// What makes a milestone of her task's plan for a verbose chat's call, and how far apart a call's
// milestones are, with explicit times.
import { describe, expect, test } from "vitest";
import type { TaskSnapshot, TaskStatus, TaskTodoStatus } from "../../src/local/api.ts";
import {
  doneOf,
  gapPassed,
  MILESTONE_GAP_MS,
  milestoneOf,
} from "../../src/local/tasks/milestones.ts";

/** A task of `status`, its plan's items in `steps`' statuses; no plan for null. */
function task(steps: readonly TaskTodoStatus[] | null, status: TaskStatus = "running") {
  const snapshot: TaskSnapshot = {
    v: 1,
    id: "0190f5c8-0000-7000-8000-00000000a001",
    createdAt: 1000,
    status,
    brief: { goal: "写一个待办网页", deliverable: "写一个待办网页", folder: "/site", check: "c" },
    model: { account: "openrouter", model: "test/model" },
    grants: [],
    spendPauseUsd: 1,
    spentUsd: 0,
    files: { read: [], written: [] },
    ...(steps === null
      ? {}
      : { todo: steps.map((each, n) => ({ text: `第${n}步`, status: each })) }),
  };
  return snapshot;
}

describe("a milestone", () => {
  test("is the plan's done count once it rises past the count last handed", () => {
    expect(milestoneOf(task(["done", "in_progress", "pending"]), 0)).toBe(1);
    expect(milestoneOf(task(["done", "done", "pending"]), 0)).toBe(2);
    expect(milestoneOf(task(["done", "done", "pending"]), 1)).toBe(2);
  });

  test("is none at or below the count last handed, as after a plan written over", () => {
    expect(milestoneOf(task(["done", "in_progress", "pending"]), 1)).toBeNull();
    expect(milestoneOf(task(["done", "pending", "pending", "pending"]), 2)).toBeNull();
  });

  test("is none for the plan's last item, which her end tells", () => {
    expect(milestoneOf(task(["done", "done", "done"]), 2)).toBeNull();
    expect(milestoneOf(task(["done"]), 0)).toBeNull();
  });

  test("is none for a task without a plan, or with an empty one", () => {
    expect(milestoneOf(task(null), 0)).toBeNull();
    expect(milestoneOf(task([]), 0)).toBeNull();
  });

  test("is none once the task isn't running: a pause or an end is told instead", () => {
    for (const status of ["paused", "awaiting-approval", "interrupted", "succeeded"] as const) {
      expect([status, milestoneOf(task(["done", "pending"], status), 0)]).toEqual([status, null]);
    }
  });

  test("counts done items alone, in any order", () => {
    expect(doneOf(task(["pending", "done", "in_progress", "done"]).todo)).toBe(2);
    expect(doneOf(undefined)).toBe(0);
  });
});

describe("the gap between a call's milestones", () => {
  test("lets a call's first through at once", () => {
    expect(gapPassed(null, 0)).toBe(true);
  });

  test("holds the next back until 30 s after the last one handed", () => {
    expect(MILESTONE_GAP_MS).toBe(30_000);
    const last = 1_700_000_000_000;
    expect(gapPassed(last, last + 10_000)).toBe(false);
    expect(gapPassed(last, last + 29_999)).toBe(false);
    expect(gapPassed(last, last + 30_000)).toBe(true);
    expect(gapPassed(last, last + 31_000)).toBe(true);
  });
});

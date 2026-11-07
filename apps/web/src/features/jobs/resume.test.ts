import { expect, test } from "bun:test";
import { canResume } from "./resume";

const job = { ephemeral: false, resumedBy: null };

test("a job that didn't finish resumes, once", () => {
  for (const outcome of ["interrupted", "cancelled", "failed", "crashed"] as const) {
    expect(canResume(job, outcome)).toBe(true);
    expect(canResume({ ...job, resumedBy: "20261107T085207-ABCDEF" }, outcome)).toBe(false);
  }
  expect(canResume(job, "running")).toBe(false);
  expect(canResume(job, "succeeded")).toBe(false);
});

test("a plan or a link check never resumes", () => {
  expect(canResume({ ephemeral: true, resumedBy: null }, "interrupted")).toBe(false);
});

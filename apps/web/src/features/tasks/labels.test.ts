import { expect, mock, test } from "bun:test";
import { linguiMacro } from "@/test/lingui-macro";
import { WEB_MODES } from "./choice";

mock.module("@lingui/core/macro", linguiMacro);
const {
  PAUSE_REASONS,
  pathGrant,
  STATUS_LABELS,
  TODO_STATUS_LABELS,
  WEB_MODE_HELP,
  WEB_MODE_LABELS,
} = await import("./labels");
const { t } = linguiMacro();

const english = (labels: Readonly<Record<string, { readonly message?: string }>>) =>
  Object.fromEntries(Object.entries(labels).map(([code, label]) => [code, label.message]));

test("each status has its name, the ones the owner waits on said as such", () => {
  expect(english(STATUS_LABELS)).toEqual({
    "awaiting-approval": "Awaiting Approval",
    running: "Running",
    paused: "Paused",
    interrupted: "Interrupted",
    succeeded: "Done",
    failed: "Failed",
    cancelled: "Stopped",
  });
  // Shared with the jobs' "Done", which a context keeps apart.
  expect(STATUS_LABELS.succeeded).toMatchObject({ context: "task status" });
});

test("the web access choices, Ask for Each Site first, each with what it means", () => {
  expect(WEB_MODES.map((mode) => WEB_MODE_LABELS[mode].message)).toEqual([
    "Ask for Each Site",
    "Any Site",
    "No Web",
  ]);
  for (const mode of WEB_MODES) expect(WEB_MODE_HELP[mode].message).toMatch(/\.$/);
});

test("a path's question names what an Allow grants, and with which access: its folder, or the file", () => {
  const said = (pending: Parameters<typeof pathGrant>[0]) => {
    const { line, allow, always } = pathGrant(pending);
    return [t(line), t(allow), always && t(always)];
  };
  // The file needn't exist: an Allow still grants all of its folder.
  const pdf = {
    path: "/Users/me/Documents/tax-2025.pdf",
    access: "read",
    folder: "/Users/me/Documents",
  } as const;
  expect(said(pdf)).toEqual([
    "Waiting for your OK to read everything in /Users/me/Documents",
    "Allow Once lets this task read everything in /Users/me/Documents until it ends; Deny tells it it can't.",
    // A read is this task's alone: assistant.folders would let every task write there.
    null,
  ]);
  const [line, allow, always] = said({ ...pdf, access: "write" });
  expect([line, allow]).toEqual([
    "Waiting for your OK to read and write everything in /Users/me/Documents",
    "Allow Once lets this task read and write everything in /Users/me/Documents until it ends; Deny tells it it can't.",
  ]);
  // assistant.folders are read-write grants for every run, and a task in one starts without an OK.
  expect(always).toContain("adds /Users/me/Documents to Assistant Mode's folders");
  expect(always).toContain("every task may read and write in it");
  expect(always).toContain("without asking");
  // Home can't be granted, so a file right in it is granted alone, and Always adds nothing.
  expect(said({ path: "/Users/me/.zshrc", access: "write" })).toEqual([
    "Waiting for your OK to read and write /Users/me/.zshrc",
    "Allow Once lets this task read and write /Users/me/.zshrc alone until it ends; Deny tells it it can't.",
    null,
  ]);
  expect(said({ path: "/Users/me/.zshrc", access: "read" }).slice(0, 2)).toEqual([
    "Waiting for your OK to read /Users/me/.zshrc",
    "Allow Once lets this task read /Users/me/.zshrc alone until it ends; Deny tells it it can't.",
  ]);
});

test("a plan's steps and a pause's reason have words of their own", () => {
  expect(Object.keys(TODO_STATUS_LABELS)).toEqual(["pending", "in_progress", "done"]);
  for (const reason of Object.values(PAUSE_REASONS)) expect(reason.message).toMatch(/\.$/);
});

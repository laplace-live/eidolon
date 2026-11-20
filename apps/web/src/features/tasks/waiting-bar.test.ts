// The waiting bar answers a task as its card does, so it lists the lines she passed on that an
// Allow or a Continue lets the task read, as text: rendered to markup, with the macros stubbed.
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";
import type { TaskSnapshot } from "@/lib/api";
import { statusQuery } from "@/lib/query";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";
import { STEER_PREFIX } from "../../../../bot/src/local/api.ts";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
// The drafts' store has no server snapshot, and they aren't what this checks.
vi.doMock("./draft", () => ({
  useDraft: <T>(_key: string, initial: T) => [initial, () => {}] as const,
}));
const { WaitingBar } = await import("./waiting-bar");
const { TaskCard } = await import("./task-card");
const { chatTasksQuery } = await import("./queries");

const CHAT = "chat-1";
const LINE = "页面标题写成<b>今天的事</b>";
const TASK: TaskSnapshot = {
  v: 1,
  id: "0190f5c8-0000-7000-8000-00000000a001",
  createdAt: 1000,
  status: "awaiting-approval",
  pending: { kind: "start" },
  chat: { id: CHAT, persona: "milky-green", call: "c1" },
  brief: {
    goal: "写一个待办网页",
    deliverable: "index.html",
    folder: "/Users/me/site",
    check: "c",
  },
  model: { account: "openrouter", model: "test/model" },
  grants: [],
  spendPauseUsd: 1,
  spentUsd: 0,
  files: { read: [], written: [] },
  inbox: {
    steer: [`${STEER_PREFIX}${LINE}`, "The owner allowed read access to /x."],
    followUp: [],
  },
};

function render(node: ReactNode, tasks: readonly TaskSnapshot[] = [TASK]): string {
  const client = new QueryClient();
  client.setQueryData(statusQuery.queryKey, {
    assistant: {
      enabled: true,
      ready: true,
      problem: null,
      running: 0,
      search: { on: false, problem: null },
      kinds: { quick: null, coding: null, research: null },
    },
  } as never);
  client.setQueryData(chatTasksQuery(CHAT).queryKey, { tasks });
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(I18nProvider, { i18n }, createElement(QueryClientProvider, { client }, node)),
    ),
  );
}

const QUOTED = "<blockquote";
const ESCAPED = "页面标题写成&lt;b&gt;今天的事&lt;/b&gt;";

/** The classes of the element that lists her lines in `markup`. */
const queuedClasses = (markup: string): string[] =>
  /<div class="([^"]*)" data-queued/.exec(markup)?.[1]?.split(" ") ?? [];

test("the waiting bar lists her lines the task hasn't read above its answers, as text", () => {
  const bar = render(createElement(WaitingBar, { task: TASK, others: 0, onShow: () => {} }));
  expect(bar).toContain('data-answer="once"');
  expect(bar).toContain("data-queued");
  expect(bar).toContain(ESCAPED);
  expect(bar.indexOf(ESCAPED)).toBeLessThan(bar.indexOf('data-answer="once"'));
  expect(bar).not.toContain("The owner allowed");
  expect(bar.split(QUOTED)).toHaveLength(2);
  // Lines up to 2,000 characters each would push the composer, the dock and the answers off the
  // chat pane: the bar's list scrolls within a bounded height.
  expect(queuedClasses(bar)).toContain("overflow-y-auto");
  expect(queuedClasses(bar).some((name) => name.startsWith("max-h-"))).toBe(true);
});

test("so does the task's card", () => {
  const card = render(
    createElement(TaskCard, {
      chatId: CHAT,
      display: "normal",
      item: {
        kind: "task",
        seq: 3,
        persona: "milky-green",
        task: TASK.id,
        call: {
          seq: 3,
          callId: "c1",
          persona: "milky-green",
          goal: TASK.brief.goal,
          folder: TASK.brief.folder,
          task: TASK.id,
          final: null,
        },
      },
    }),
  );
  expect(card).toContain("data-queued");
  expect(card).toContain(ESCAPED);
  expect(card.indexOf(ESCAPED)).toBeLessThan(card.indexOf('data-answer="once"'));
  // The card sits in the scrolling log, which shows its lines whole.
  expect(queuedClasses(card)).toEqual(["flex", "flex-col", "gap-1.5"]);
});

/** The classes of the element marked `attribute` in `markup`. */
const classesOf = (markup: string, attribute: string): string[] =>
  new RegExp(`<\\w+ ${attribute}="?[^"]*"? class="([^"]*)"`).exec(markup)?.[1]?.split(" ") ??
  new RegExp(`<\\w+ class="([^"]*)" ${attribute}`).exec(markup)?.[1]?.split(" ") ??
  [];

const COMMAND: TaskSnapshot = {
  ...TASK,
  id: "0190f5c8-0000-7000-8000-00000000a002",
  status: "paused",
  pending: { kind: "command", call: "c9", command: "echo ok\u202E; rm -rf ~/x", timeout: 120 },
  inbox: undefined,
};

test("a command's bar shows it whole and escaped, in a box that scrolls, with its three answers", () => {
  const bar = render(createElement(WaitingBar, { task: COMMAND, others: 0, onShow: () => {} }), [
    COMMAND,
  ]);
  expect(bar).toContain("Waiting for your OK to run a command in /Users/me/site");
  // The bidi control would turn the rest around on screen: it shows spelled out instead.
  expect(bar).toContain("echo ok");
  expect(bar).toContain("\\u{202E}</mark>");
  expect(bar).not.toContain("\u202E");
  expect(bar).toContain("; rm -rf ~/x");
  // Its size, so a tail out of the box's view is never news.
  expect(bar).toContain("20 characters");
  // Never cut off: the box wraps and scrolls within the bar's height.
  const box = classesOf(bar, "data-command");
  expect(box).toContain("overflow-y-auto");
  expect(box).toContain("whitespace-pre-wrap");
  expect(box.some((name) => name.startsWith("max-h-"))).toBe(true);
  const answers = [...bar.matchAll(/data-answer="(\w+)"[^>]*>(?:<[^>]+>)*([^<]+)</g)].map(
    ([, answer, label]) => [answer, label],
  );
  expect(answers).toEqual([
    ["deny", "Deny"],
    ["always", "Always in This Folder"],
    ["once", "Run Once"],
  ]);
});

const MCP: TaskSnapshot = {
  ...COMMAND,
  id: "0190f5c8-0000-7000-8000-00000000a003",
  pending: {
    kind: "mcp",
    server: "fs",
    tool: "write_file",
    call: "c10",
    key: "0123456789abcdef0123456789abcdef",
    args: [
      { name: "path", head: "~/.zshrc", chars: 8, lines: 1 },
      { name: "content", head: "x".repeat(300), chars: 3000, lines: 40 },
    ],
    hint: "destructive",
  },
};

test("a tool call's bar names its server's tool and every argument with its size", () => {
  const bar = render(createElement(WaitingBar, { task: MCP, others: 0, onShow: () => {} }), [MCP]);
  expect(bar).toContain("Waiting for your OK to run write_file on fs");
  expect(bar).toContain("path");
  expect(bar).toContain("8 characters");
  expect(bar).toContain("content");
  expect(bar).toContain("3,000 characters · 40 lines");
  const answers = [...bar.matchAll(/data-answer="(\w+)"/g)].map(([, answer]) => answer);
  expect(answers).toEqual(["deny", "always", "once"]);
  expect(bar).toContain("Always Allow This Tool");
  expect(bar).toContain("Run Once");
});

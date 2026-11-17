// The waiting bar answers a task as its card does, so it lists the lines she passed on that an
// Allow or a Continue lets the task read, as text: rendered to markup, with the macros stubbed.
import { expect, mock, test } from "bun:test";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { TaskSnapshot } from "@/lib/api";
import { statusQuery } from "@/lib/query";
import { linguiMacro } from "@/test/lingui-macro";
import { STEER_PREFIX } from "../../../../bot/src/local/api.ts";

mock.module("@lingui/core/macro", linguiMacro);
mock.module("@lingui/react/macro", () => {
  const { t } = linguiMacro();
  const translate = (descriptor: unknown) =>
    typeof descriptor === "string"
      ? descriptor
      : ((descriptor as { message?: string }).message ?? "");
  return {
    useLingui: () => ({ t, i18n: { _: translate, locale: "en" } }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});
// The drafts' store has no server snapshot, and they aren't what this checks.
mock.module("./draft", () => ({
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

function render(node: ReactNode): string {
  const client = new QueryClient();
  client.setQueryData(statusQuery.queryKey, {
    assistant: { enabled: true, ready: true, problem: null, running: 0 },
  } as never);
  client.setQueryData(chatTasksQuery(CHAT).queryKey, { tasks: [TASK] });
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

test("the waiting bar lists her lines the task hasn't read above its answers, as text", () => {
  const bar = render(createElement(WaitingBar, { task: TASK, others: 0, onShow: () => {} }));
  expect(bar).toContain('data-answer="once"');
  expect(bar).toContain("data-queued");
  expect(bar).toContain(ESCAPED);
  expect(bar.indexOf(ESCAPED)).toBeLessThan(bar.indexOf('data-answer="once"'));
  expect(bar).not.toContain("The owner allowed");
  expect(bar.split(QUOTED)).toHaveLength(2);
});

test("so does the task's card", () => {
  const card = render(
    createElement(TaskCard, {
      chatId: CHAT,
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
});

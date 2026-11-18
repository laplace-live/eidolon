// A task's card opens its steps as the chat's display says: rendered to markup, with the macros
// stubbed.
import { expect, mock, test } from "bun:test";
import type { ChatDisplay } from "@eidolon/chat";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { TaskSnapshot, TaskStatus } from "@/lib/api";
import { statusQuery } from "@/lib/query";
import { linguiMacro } from "@/test/lingui-macro";

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
const { TaskCard } = await import("./task-card");
const { chatTasksQuery } = await import("./queries");

const CHAT = "chat-1";

function task(n: number, status: TaskStatus): TaskSnapshot {
  return {
    v: 1,
    id: `0190f5c8-0000-7000-8000-00000000a00${n}`,
    createdAt: 1000 + n,
    status,
    chat: { id: CHAT, persona: "milky-green", call: `c${n}` },
    brief: { goal: `goal ${n}`, deliverable: "index.html", folder: "/Users/me/site", check: "c" },
    model: { account: "openrouter", model: "test/model" },
    grants: [],
    spendPauseUsd: 1,
    spentUsd: 0,
    files: { read: [], written: [] },
  };
}

/** The markup of `shown`'s card, with the chat's tasks `tasks`. */
function card(display: ChatDisplay, tasks: readonly TaskSnapshot[], shown: TaskSnapshot): string {
  const client = new QueryClient();
  client.setQueryData(statusQuery.queryKey, {
    assistant: { enabled: true, ready: true, problem: null, running: 0 },
  } as never);
  client.setQueryData(chatTasksQuery(CHAT).queryKey, { tasks });
  const item = {
    kind: "task",
    seq: 3,
    persona: "milky-green",
    task: shown.id,
    call: {
      seq: 3,
      callId: "c1",
      persona: "milky-green",
      goal: shown.brief.goal,
      folder: shown.brief.folder,
      task: shown.id,
      final: null,
    },
  } as const;
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        I18nProvider,
        { i18n },
        createElement(
          QueryClientProvider,
          { client },
          createElement(TaskCard, { chatId: CHAT, item, display }),
        ),
      ),
    ),
  );
}

const STEPS = 'role="log" aria-label="Steps"';
const opens = (markup: string) => markup.includes(STEPS) && markup.includes('aria-expanded="true"');

const older = task(1, "running");
const newest = task(2, "running");
const waiting = task(3, "paused");
const done = task(4, "succeeded");
const tasks = [older, newest, waiting, done];

test("in verbose, only the newest running task's card opens its steps", () => {
  expect(opens(card("verbose", tasks, newest))).toBe(true);
  for (const other of [older, waiting, done]) {
    expect([other.status, opens(card("verbose", tasks, other))]).toEqual([other.status, false]);
  }
});

test("in normal and focus, no card opens its steps by itself", () => {
  for (const display of ["normal", "focus"] as const) {
    for (const shown of tasks) {
      const markup = card(display, tasks, shown);
      expect([display, shown.status, markup.includes(STEPS)]).toEqual([
        display,
        shown.status,
        false,
      ]);
      expect(markup).toContain('aria-expanded="false"');
    }
  }
});

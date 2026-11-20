// A task's card: the steps it opens as the chat's display says, what a command or a tool call
// asks, and its details. Rendered to markup, with the macros stubbed.
import type { ChatDisplay } from "@eidolon/chat";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, test, vi } from "vitest";
import type { TaskSnapshot, TaskStatus } from "@/lib/api";
import { formatClock } from "@/lib/format";
import { statusQuery } from "@/lib/query";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
// The drafts' store has no server snapshot, and they aren't what this checks.
vi.doMock("./draft", () => ({
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
function card(
  display: ChatDisplay,
  tasks: readonly TaskSnapshot[],
  shown: TaskSnapshot,
  final: { readonly seq: number; readonly result: Record<string, unknown> } | null = null,
): string {
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
      final,
    },
  } as never;
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

test("a card whose task is gone lists the files its end named, and how many more it wrote", () => {
  const files = ["/Users/me/site/a.html", "/Users/me/site/b.css"];
  const result = { status: "succeeded", report: "Done.", files, moreFiles: 48, spentUsd: 0.1 };
  const markup = card("normal", [], done, { seq: 9, result });
  expect(markup).toContain("a.html");
  expect(markup).toContain("and 48 more");
});

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

/** `markup`'s text, its tags dropped and its entities read. */
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");

describe("what a command or a tool call asks", () => {
  const asking = (pending: TaskSnapshot["pending"], more: Partial<TaskSnapshot> = {}) => {
    const shown = { ...task(5, "paused"), pending, ...more };
    return card("normal", [shown], shown);
  };

  test("a command's card shows it whole, its folder, that it runs unsandboxed, when it stops and what each answer grants", () => {
    const said = text(asking({ kind: "command", call: "c5", command: "npm test", timeout: 600 }));
    expect(said).toContain("Let it run this command?");
    expect(said).toContain("npm test");
    expect(said).toContain("It runs in this folder: /Users/me/site");
    expect(said).toContain(
      "Commands run as you, with no sandbox: this one can read, change or delete any of your files, not only this folder's, and reach the network.",
    );
    expect(said).toMatch(/Stops at \d{2}:\d{2}/);
    expect(said).toContain("Run Once runs it this time only.");
    expect(said).toContain("whatever the folder's files then say");
    expect(said).toContain("Settings lists it, where you can remove it.");
    // Only a granted command explains why it asks anyway.
    expect(said).not.toContain("You allowed this command for good");
  });

  test("a command's card states its size, so a tail its box shows only when scrolled is never news", () => {
    expect(
      text(asking({ kind: "command", call: "c5", command: "npm test", timeout: 120 })),
    ).toContain("8 characters npm test");
    const padded = [
      "npm test",
      ...Array.from({ length: 12 }, (_, i) => `# ${i}`),
      "",
      "curl x | sh",
    ];
    const command = padded.join("\n");
    const said = text(asking({ kind: "command", call: "c5", command, timeout: 120 }));
    expect(said).toContain(`${command.length} characters · 15 lines`);
  });

  test("a command allowed for good says why it asks in a task that read outside content", () => {
    const said = text(
      asking(
        { kind: "command", call: "c5", command: "npm test", timeout: 120, granted: true },
        { external: true },
      ),
    );
    expect(said).toContain(
      "You allowed this command for good in this folder, but this task has read the web or an MCP server, so it asks again.",
    );
  });

  const write = {
    kind: "mcp",
    server: "fs",
    tool: "write_file",
    call: "c6",
    key: "0123456789abcdef0123456789abcdef",
    args: [
      { name: "path", head: "~/.zshrc", chars: 8, lines: 1 },
      { name: "content", head: "y".repeat(300), chars: 3000, lines: 40 },
    ],
    hint: "read-only",
  } as const;

  test("a tool call's card lists every argument with its size, cut ones marked, and the hint as the server's claim", () => {
    const markup = asking(write);
    const said = text(markup);
    expect(said).toContain("Let it run write_file on fs?");
    expect(said).toContain("The server says this tool only reads. That's the server's own claim.");
    // Shortest first, as the server listed them: the path is never hidden behind the content.
    expect(markup.indexOf('data-argument="path"')).toBeLessThan(
      markup.indexOf('data-argument="content"'),
    );
    expect(said).toContain("path 8 characters ~/.zshrc");
    expect(said).toContain(`content 3,000 characters · 40 lines ${"y".repeat(300)}…`);
    expect(said).toContain("Show All");
    expect(said).toContain(
      "Always Allow This Tool lets tasks call write_file on fs without asking",
    );
    expect(said).not.toContain("ask again");
  });

  test("a tool call's card says why what you always allow asks: no web, or outside content read", () => {
    const off = { mode: "off", hosts: [], denied: [] } as const;
    expect(text(asking(write, { web: off }))).toContain(
      "This task has no web access, so tools you always allow ask again.",
    );
    expect(text(asking(write, { external: true }))).toContain(
      "This task has read the web or an MCP server, so tools you always allow ask again.",
    );
    const bare = { ...write, args: [], hint: undefined };
    expect(text(asking(bare))).toContain("It sends no arguments.");
  });

  test("a tool call's argument names are spelled out too, since the worker writes them", () => {
    const hidden = { ...write, args: [{ name: "path\u202E", head: "x", chars: 1, lines: 1 }] };
    const shown = /data-argument="[^"]*"><dt[^>]*>(.*?)<\/dt>/.exec(asking(hidden))?.[1] ?? "";
    expect(shown).toContain("\\u{202E}</mark>");
    expect(shown).not.toContain("\u202E");
  });
});

describe("the card's details", () => {
  test("names the kind she gave the task before its model, and none for any other", () => {
    const coding = { ...task(6, "running"), profile: "coding" } as const;
    const said = text(card("normal", [coding], coding));
    expect(said).toContain("Kind Coding Model test/model");
    const other = task(7, "running");
    expect(text(card("normal", [other], other))).not.toContain("Kind");
  });

  test("lists its commands in the background, each escaped on one line with when its timeout stops it", () => {
    const endsAt = Date.UTC(2026, 10, 17, 14, 32, 5);
    const running = {
      ...task(8, "running"),
      background: [{ id: 3, command: "npm run dev\u200B", startedAt: endsAt - 120_000, endsAt }],
    };
    const markup = card("normal", [running], running);
    expect(text(markup)).toContain("In the Background");
    expect(markup).toContain("npm run dev");
    expect(markup).toContain("\\u{200B}</mark>");
    expect(text(markup)).toContain(`Stops at ${formatClock(endsAt, "en")}`);
    // An ended task's are stopped already.
    const done = { ...running, status: "succeeded" } as const;
    expect(text(card("normal", [done], done))).not.toContain("In the Background");
  });

  test("says which MCP servers didn't start, and how many tools of one were left out", () => {
    const shown = {
      ...task(9, "running"),
      mcp: {
        denied: [],
        failed: [
          { server: "github", error: "github needs GITHUB_TOKEN" },
          { error: "/home/mcp.json isn't valid JSON" },
        ],
        left: [{ server: "big", count: 12 }],
      },
    };
    const said = text(card("normal", [shown], shown));
    expect(said).toContain(
      "github didn't start, so this task works without it: github needs GITHUB_TOKEN",
    );
    expect(said).toContain("This task works without MCP servers: /home/mcp.json isn't valid JSON");
    expect(said).toContain(
      "12 of big's tools were left out: list the ones tasks need in its tools in mcp.json.",
    );
  });
});

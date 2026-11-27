import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { Router, type RouterOptions } from "wouter";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";
import { ApiError, type Memory, type Status } from "../../lib/api";
import { memoryView, shownMemories } from "./memory";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { MemoryPanel } = await import("./memory-panel");
const { ReadinessList } = await import("./readiness-list");

describe("what the memory panel shows", () => {
  const pending = { status: "pending", error: null } as const;
  const listed = { status: "success", error: null } as const;
  const failed = (status: number, code: "unavailable" | "upstream-failed") =>
    ({ status: "error", error: new ApiError(status, code, "") }) as const;

  test("off while memory is disabled, whatever else holds", () => {
    expect(memoryView({ configured: false, ready: false, problem: null }, pending)).toBe("off");
    expect(memoryView({ configured: false, ready: true, problem: null }, listed)).toBe("off");
  });

  test("not-ready when enabled without required keys", () => {
    expect(memoryView({ configured: true, ready: false, problem: "missing key" }, pending)).toBe(
      "not-ready",
    );
  });

  test("loading, list, unavailable on 503, and failed on 502 once ready", () => {
    const ready = { configured: true, ready: true, problem: null } as const;
    expect(memoryView(ready, pending)).toBe("loading");
    expect(memoryView(ready, listed)).toBe("list");
    expect(memoryView(ready, failed(503, "unavailable"))).toBe("unavailable");
    expect(memoryView(ready, failed(502, "upstream-failed"))).toBe("failed");
  });
});

test("memories show newest first, and empty ones not at all", () => {
  const memory = (
    id: string,
    text: string | null,
    updated: string | null,
    created: string | null,
  ) => ({ id, memory: text, updated_at: updated, created_at: created, categories: null }) as Memory;
  const shown = shownMemories([
    memory("old", "likes tea", null, "2026-10-01T00:00:00Z"),
    memory("blank", "  ", null, "2026-11-04T00:00:00Z"),
    memory("none", null, null, null),
    memory("undated", "has a cat", null, null),
    memory("new", "lives in Shanghai", "2026-11-03T00:00:00Z", "2026-09-01T00:00:00Z"),
  ]);
  expect(shown.map((entry) => entry.id)).toEqual(["new", "old", "undated"]);
});

function renderHome(node: ReactNode): string {
  const client = new QueryClient();
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(
      Router as FunctionComponent<RouterOptions>,
      { ssrPath: "/" },
      createElement(
        I18nProvider,
        { i18n },
        createElement(QueryClientProvider, { client }, createElement(TooltipProvider, null, node)),
      ),
    ),
  );
}

describe("home setup guards during a call", () => {
  const persona: Status["persona"] = {
    id: "milky-green",
    name: "明前奶绿",
    shortName: "奶绿",
    avatar: false,
    appearance: { model: null },
    voice: { id: "a".repeat(32), source: "persona", ok: true, provider: "fish", account: "fish" },
  };
  const off = { configured: false, ready: false, problem: null } as const;

  test("MemoryPanel links to /setup?step=memory while idle, and disables Turn On Memory while calling", () => {
    const idle = renderHome(createElement(MemoryPanel, { persona, memory: off, calling: false }));
    expect(idle).toContain('href="/setup?step=memory"');
    expect(idle).toContain("Turn On Memory");

    const calling = renderHome(createElement(MemoryPanel, { persona, memory: off, calling: true }));
    expect(calling).not.toContain('href="/setup');
    expect(calling).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Turn On Memory<\/button>/);
  });

  test("ReadinessList disables /setup fixes while calling", () => {
    const items = [
      {
        id: "memory" as const,
        tone: "info" as const,
        text: "home.ready.memory.off" as const,
        fix: { kind: "link" as const, to: "/setup?step=memory", label: "home.fix.memory" as const },
      },
    ];
    const idle = renderHome(
      createElement(ReadinessList, { items, calling: false, onPickVoice: () => {} }),
    );
    expect(idle).toContain('href="/setup?step=memory"');

    const calling = renderHome(
      createElement(ReadinessList, { items, calling: true, onPickVoice: () => {} }),
    );
    expect(calling).not.toContain('href="/setup');
    expect(calling).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Turn On<\/button>/);
  });
});

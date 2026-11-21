// In the desktop app a page scrolls in a box below the row its window drags by, so no scrollbar runs
// under Windows' caption buttons, which take a press over them: rendered to markup, with the macros
// stubbed.
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { expect, test, vi } from "vitest";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
// Their stores have no server snapshot, and neither a phone's sheet nor the theme is checked here.
vi.doMock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.doMock("@/components/preferences", () => ({
  LanguageSwitch: () => null,
  ThemeMenu: () => null,
}));
const { PageLayout } = await import("./app-shell");
const { SidebarProvider } = await import("./ui/sidebar");
const { Component: Setup } = await import("@/features/setup/route");

function render(path: string, node: ReactNode): string {
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n },
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(MemoryRouter, { initialEntries: [path] }, node),
      ),
    ),
  );
}

const classesOf = (tag: string): string[] => tag.match(/ class="([^"]*)"/)?.[1]?.split(" ") ?? [];

/** Where the opening tag of the first element with `className` starts, and its classes. */
function element(markup: string, className: string): { at: number; classes: string[] } {
  const tags = [...markup.matchAll(/<\w+[^>]*>/g)];
  const found = tags.find((tag) => classesOf(tag[0]).includes(className));
  return { at: found?.index ?? -1, classes: found ? classesOf(found[0]) : [] };
}

/** Every drag row comes before the box that scrolls in the desktop app, and none is in it. */
function expectRowsAbove(markup: string, scroller: number): void {
  expect(scroller).toBeGreaterThan(0);
  const rows = [...markup.matchAll(/data-window-drag/g)].map((row) => row.index);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.filter((row) => row > scroller)).toEqual([]);
}

test("a page scrolls below MobileBar, in the box the skip link focuses", () => {
  const markup = render(
    "/settings",
    createElement(
      SidebarProvider,
      null,
      createElement(
        Routes,
        null,
        createElement(
          Route,
          { element: createElement(PageLayout) },
          createElement(Route, { path: "settings", element: createElement("p", null, "Settings") }),
        ),
      ),
    ),
  );
  const box = element(markup, "shell:overflow-y-auto");
  expect(box.classes).toEqual(expect.arrayContaining(["shell:min-h-0", "shell:flex-1"]));
  expectRowsAbove(markup, box.at);
  expect(markup.slice(box.at)).toMatch(/^<div id="content" tabindex="-1"/);
  expect(markup.indexOf("<p>Settings</p>")).toBeGreaterThan(box.at);
});

test("setup scrolls below its header, in a window-high frame", () => {
  // React puts the logo's preload ahead of the page.
  const markup = render("/setup", createElement(Setup)).replace(/^(<link [^>]*>)*/, "");
  expect(element(markup, "shell:h-svh").at).toBe(0);
  const box = element(markup, "shell:overflow-y-auto");
  expect(box.classes).toEqual(expect.arrayContaining(["shell:min-h-0", "flex-1"]));
  expectRowsAbove(markup, box.at);
  expect(markup.indexOf("<main")).toBeGreaterThan(box.at);
});

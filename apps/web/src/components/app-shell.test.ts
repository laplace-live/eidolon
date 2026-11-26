// A page has no row the window drags by: the desktop app's strip, above the frame the page scrolls
// in, stands in for the title bar, and an error there gets no strip of its own. Setup, outside the
// frame, scrolls below its own header, so no scrollbar runs under Windows' caption buttons, which
// take a press over them. Rendered to markup, with the macros stubbed.
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { Route, Router, type RouterOptions, Switch } from "wouter";
import { createBrowserHistory } from "@/lib/navigation";
import { mountFakeDom } from "@/test/fake-dom";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
// Their stores have no server snapshot, and neither a phone's sheet nor the theme is checked here.
vi.doMock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.doMock("@/components/preferences", () => ({
  LanguageSwitch: () => null,
  ThemeMenu: () => null,
}));
// The call's engine and the sidebar's queries aren't what the frame's error checks.
vi.doMock("@/features/call/call-provider", () => ({
  CallProvider: ({ children }: { readonly children: ReactNode }) => children,
}));
vi.doMock("@/features/call/call-bar", () => ({ CallBar: () => null }));
vi.doMock("@/components/app-sidebar", () => ({ AppSidebar: () => null }));
const { AppShell, PageLayout } = await import("./app-shell");
const { SidebarProvider } = await import("./ui/sidebar");
const { TooltipProvider } = await import("./ui/tooltip");
const { Component: Setup } = await import("@/features/setup/route");
const { RouteError } = await import("./route-error");

function render(path: string, node: ReactNode): string {
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n },
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(Router as FunctionComponent<RouterOptions>, { ssrPath: path }, node),
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

test("a page has no row the window drags by, and sits in the box the skip link focuses", () => {
  const markup = render(
    "/settings",
    createElement(
      SidebarProvider,
      null,
      createElement(
        Switch,
        null,
        createElement(
          Route,
          { path: "/settings" },
          createElement(PageLayout, null, createElement("p", null, "Settings")),
        ),
      ),
    ),
  );
  expect(markup).not.toContain("data-window-drag");
  const box = markup.indexOf('<div id="content" tabindex="-1"');
  expect(box).toBeGreaterThan(0);
  expect(markup.indexOf("<p>Settings</p>")).toBeGreaterThan(box);
});

test("setup scrolls below its header, in a window-high frame", () => {
  // React puts the logo's preload ahead of the page.
  const markup = render("/setup", createElement(Setup)).replace(/^(<link [^>]*>)*/, "");
  expect(element(markup, "shell:h-svh").at).toBe(0);
  const box = element(markup, "shell:overflow-y-auto");
  expect(box.classes).toEqual(expect.arrayContaining(["shell:min-h-0", "flex-1"]));
  expect(markup).toContain("data-window-drag");
  expect(markup.lastIndexOf("data-window-drag")).toBeLessThan(box.at);
  expect(markup.indexOf("<main")).toBeGreaterThan(box.at);
});

test("an error in the frame gets no drag strip below the title strip, and one outside it does", async () => {
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  const history = createBrowserHistory(null);
  const Boom = () => {
    throw new Error("boom");
  };
  const mounted = await mountFakeDom(
    createElement(
      I18nProvider,
      { i18n },
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(
          TooltipProvider,
          null,
          createElement(
            Router as FunctionComponent<RouterOptions>,
            { hook: history.hook, searchHook: history.searchHook },
            createElement(AppShell, null, createElement(Boom)),
          ),
        ),
      ),
    ),
  );
  try {
    const inside = mounted.container.innerHTML;
    expect(inside).toContain("Something went wrong");
    const rows = [...inside.matchAll(/<[^>]*data-window-drag[^>]*>/g)].map((row) => row[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("data-title-strip");
  } finally {
    history.dispose();
    await mounted.unmount();
  }

  const outside = renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n },
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(
          TooltipProvider,
          null,
          createElement(
            Router as FunctionComponent<RouterOptions>,
            { ssrPath: "/outside" },
            createElement(RouteError, { error: new Error("boom") }),
          ),
        ),
      ),
    ),
  );
  expect(outside).toContain("data-window-drag");
});

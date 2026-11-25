// The desktop app's strip, the row its window drags by: Back and Forward go only where the Navigation
// API's entries do, never to the loading page before the app's first. Rendered to markup, with the
// macros stubbed.
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
// Its store has no server snapshot, and a phone's sheet isn't checked here.
vi.doMock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
const { TitleStrip, traverse } = await import("./title-strip");
const { SidebarProvider } = await import("./ui/sidebar");
const { TooltipProvider } = await import("./ui/tooltip");

afterEach(() => {
  vi.unstubAllGlobals();
});

function render(): string {
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n },
      createElement(
        TooltipProvider,
        null,
        createElement(SidebarProvider, null, createElement(TitleStrip)),
      ),
    ),
  );
}

/** Whether the button named `label` is disabled. */
function disabled(markup: string, label: string): boolean {
  const tag = [...markup.matchAll(/<button[^>]*>/g)]
    .map((match) => match[0])
    .find((tag) => tag.includes(`aria-label="${label}"`));
  if (tag === undefined) throw new Error(`no button named ${label}`);
  return / disabled=""/.test(tag);
}

function entries(canGoBack: boolean, canGoForward: boolean) {
  return {
    canGoBack,
    canGoForward,
    back: vi.fn(() => ({
      committed: Promise.reject(new Error("aborted")),
      finished: Promise.reject(new Error("aborted")),
    })),
    forward: vi.fn(() => ({ committed: Promise.resolve(), finished: Promise.resolve() })),
  };
}

test("the strip drags the window, Back, Forward and the sidebar's toggle in it", () => {
  vi.stubGlobal("navigation", entries(false, false));
  const markup = render();
  const strip = markup.match(/<div [^>]*data-title-strip[^>]*>/)?.[0] ?? "";
  expect(strip).toContain("data-window-drag");
  expect([...markup.matchAll(/<button/g)]).toHaveLength(3);
  expect(markup).toContain("Toggle Sidebar");
});

test("Back and Forward follow the Navigation API's entries", () => {
  vi.stubGlobal("navigation", entries(true, false));
  const markup = render();
  expect(disabled(markup, "Go Back")).toBe(false);
  expect(disabled(markup, "Go Forward")).toBe(true);
});

test("without the Navigation API, neither goes anywhere", () => {
  vi.stubGlobal("navigation", undefined);
  const markup = render();
  expect(disabled(markup, "Go Back")).toBe(true);
  expect(disabled(markup, "Go Forward")).toBe(true);
});

test("a step goes through the Navigation API, and one that doesn't happen rejects nothing unhandled", async () => {
  const navigation = entries(true, true);
  const history = vi.fn();
  vi.stubGlobal("navigation", navigation);
  vi.stubGlobal("history", { back: history, forward: history, go: history });
  traverse("back");
  traverse("forward");
  expect(navigation.back).toHaveBeenCalledOnce();
  expect(navigation.forward).toHaveBeenCalledOnce();
  expect(history).not.toHaveBeenCalled();
  // An unhandled rejection would fail the run once the microtasks settle.
  await new Promise((done) => setTimeout(done, 0));
});

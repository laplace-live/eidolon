// The settings page's sections as it lists and opens them: Desktop only in a desktop app that offers
// its options. Rendered to markup, with the macros stubbed.
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { Router, type RouterOptions } from "wouter";
import type { EidolonDesktop } from "@/lib/desktop";
import { statusQuery } from "@/lib/query";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
// Its picture's store has no server snapshot, and no picture is checked here.
vi.doMock("@/components/avatar", () => ({ PersonaAvatar: () => null }));
const { Component: Settings } = await import("./route");

const ignore = () => {};
const older: EidolonDesktop = {
  platform: "darwin",
  version: "0.2.0",
  serverVersion: "0.14.0",
  setTheme: ignore,
  setLanguage: ignore,
  onCommand: ignore,
};
const off = { state: "off" } as const;
const absent = { state: "absent", path: "/usr/local/bin/eidolon" } as const;
const current: EidolonDesktop = {
  ...older,
  loginItem: async () => off,
  setLoginItem: async () => off,
  terminalCommand: async () => absent,
  setTerminalCommand: async () => ({ command: absent }),
};

afterEach(() => {
  globalThis.eidolonDesktop = undefined;
});

/** The page at `path`, in `app` or a browser. */
function render(path: string, app: EidolonDesktop | undefined): string {
  globalThis.eidolonDesktop = app;
  const client = new QueryClient();
  // The page reads only the persona from the status.
  const status: readonly unknown[] = statusQuery.queryKey;
  client.setQueryData(status, {
    persona: { id: "milky-green", name: "明前奶绿", shortName: "奶绿", avatar: false },
  });
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(
      Router as FunctionComponent<RouterOptions>,
      { ssrPath: path },
      createElement(
        I18nProvider,
        { i18n },
        createElement(QueryClientProvider, { client }, createElement(Settings)),
      ),
    ),
  );
}

/** The sections the nav links to, in order. */
const tabs = (markup: string) =>
  [...markup.matchAll(/href="[^"]*\?tab=([a-z]+)"/g)].map((m) => m[1]);

test("the nav lists Desktop, before Advanced, only in a desktop app that offers its options", () => {
  const others = ["providers", "general", "memory", "downloads", "assistant", "skills", "advanced"];
  expect(tabs(render("/settings?tab=general", undefined))).toEqual(others);
  expect(tabs(render("/settings?tab=general", older))).toEqual(others);
  expect(tabs(render("/settings?tab=general", current))).toEqual([
    ...others.slice(0, -1),
    "desktop",
    "advanced",
  ]);
});

test("?tab=desktop opens the Desktop App card there, and leads elsewhere in a browser", () => {
  expect(render("/settings?tab=desktop", current)).toContain("Desktop App");
  // Redirect renders nothing: the page goes to the section resolveSection names instead.
  expect(render("/settings?tab=desktop", undefined)).toBe("");
  expect(render("/settings?tab=desktop", older)).toBe("");
});

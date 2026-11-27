// The settings page's sections as it lists and opens them: Desktop only in a desktop app that offers
// its options. Rendered to markup, with the macros stubbed.
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { Router, type RouterOptions, type SsrContext } from "wouter";
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
const withPermissions: EidolonDesktop = {
  ...current,
  permissions: async () => ({
    background: false,
    items: [{ id: "microphone", status: "granted" }],
  }),
  requestPermission: async (id) => ({ id, status: "granted", openedSettings: false }),
  openPermissionSettings: async () => true,
  testLocalNetwork: async ({ host, port }) => ({ ok: true, host, port, testedAt: 1 }),
};

afterEach(() => {
  globalThis.eidolonDesktop = undefined;
});

/** The page at `path`, in `app` or a browser. */
function render(path: string, app: EidolonDesktop | undefined) {
  globalThis.eidolonDesktop = app;
  const client = new QueryClient();
  // The page reads only the persona from the status.
  const status: readonly unknown[] = statusQuery.queryKey;
  client.setQueryData(status, {
    persona: { id: "milky-green", name: "明前奶绿", shortName: "奶绿", avatar: false },
  });
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  const ssrContext: SsrContext = {};
  const html = renderToStaticMarkup(
    createElement(
      Router as FunctionComponent<RouterOptions>,
      { ssrPath: path, ssrContext },
      createElement(
        I18nProvider,
        { i18n },
        createElement(QueryClientProvider, { client }, createElement(Settings)),
      ),
    ),
  );
  return { html, redirectTo: ssrContext.redirectTo };
}

/** The sections the nav links to, in order. */
const tabs = (markup: string) =>
  [...markup.matchAll(/href="[^"]*\?tab=([a-z]+)"/g)].map((m) => m[1]);

test("the nav lists Desktop, before Advanced, only in a desktop app that offers its options", () => {
  const others = [
    "providers",
    "general",
    "memory",
    "downloads",
    "assistant",
    "skills",
    "subspace",
    "advanced",
  ];
  expect(tabs(render("/settings?tab=general", undefined).html)).toEqual(others);
  expect(tabs(render("/settings?tab=general", older).html)).toEqual(others);
  expect(tabs(render("/settings?tab=general", current).html)).toEqual([
    ...others.slice(0, -1),
    "desktop",
    "advanced",
  ]);
  expect(tabs(render("/settings?tab=general", withPermissions).html)).toEqual([
    ...others.slice(0, -1),
    "desktop",
    "permissions",
    "advanced",
  ]);
});

test("?tab=desktop opens the Desktop App card there, and leads elsewhere in a browser", () => {
  const desktop = render("/settings?tab=desktop", current);
  expect(desktop.redirectTo).toBeUndefined();
  expect(desktop.html).toContain("Desktop App");

  const browser = render("/settings?tab=desktop", undefined);
  expect(browser.html).toBe("");
  expect(browser.redirectTo).toBe("?tab=providers");

  const stale = render("/settings?tab=desktop", older);
  expect(stale.html).toBe("");
  expect(stale.redirectTo).toBe("?tab=providers");
});

test("?tab=permissions opens the Permissions card when supported, and leads elsewhere otherwise", () => {
  const perms = render("/settings?tab=permissions", withPermissions);
  expect(perms.redirectTo).toBeUndefined();
  expect(perms.html).toContain("Permissions");

  const browser = render("/settings?tab=permissions", undefined);
  expect(browser.html).toBe("");
  expect(browser.redirectTo).toBe("?tab=providers");

  const stale = render("/settings?tab=permissions", current);
  expect(stale.html).toBe("");
  expect(stale.redirectTo).toBe("?tab=providers");
});

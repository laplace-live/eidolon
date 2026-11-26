import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { Router, type RouterOptions } from "wouter";
import { ApiError, type Status } from "@/lib/api";
import { statusQuery } from "@/lib/query";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
vi.doMock("@/components/preferences", () => ({
  LanguageSwitch: () => null,
  ThemeMenu: () => null,
}));
const { createSessionStore, SessionGate } = await import("./router");
const { RouteError } = await import("@/components/route-error");

function statusFixture(keysMissing: boolean): Status {
  return {
    version: "0.14.0",
    activeCalls: 0,
    persona: {
      id: "milky-green",
      name: "明前奶绿",
      shortName: "奶绿",
      avatar: false,
      voice: { provider: "fish", id: "v1", account: "fish", ok: true, source: "persona" },
      appearance: { model: null },
    },
    keys: [
      {
        account: "openrouter",
        name: "OpenRouter",
        provider: "openrouter",
        roles: ["mind"],
        set: !keysMissing,
      },
    ],
    call: { realtime: false },
    memory: { configured: false, ready: false, problem: null },
    selfieReferences: 0,
    lastSessionError: null,
    assistant: {
      enabled: false,
      ready: false,
      problem: null,
      running: 0,
      search: { on: false, problem: null },
      kinds: { quick: null, coding: null, research: null },
    },
  } as unknown as Status;
}

function renderGate(path: string, client: QueryClient, node: ReactNode): string {
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n },
      createElement(
        QueryClientProvider,
        { client },
        createElement(Router as FunctionComponent<RouterOptions>, { ssrPath: path }, node),
      ),
    ),
  );
}

test("session store primes statusQuery on success and transitions loading -> ready", async () => {
  const client = new QueryClient();
  const status = statusFixture(false);
  const store = createSessionStore({
    queryClient: client,
    exchanged: Promise.resolve(null),
    fetchStatus: async () => status,
  });

  expect(store.getSnapshot()).toEqual({ kind: "loading" });
  expect(store.hasStarted()).toBe(false);

  await store.revalidate();
  expect(store.hasStarted()).toBe(true);
  expect(store.getSnapshot()).toEqual({ kind: "ready" });
  expect(client.getQueryData(statusQuery.queryKey)).toEqual(status);
});

test("session store marks 401 expired only when the initial link-code exchange failed", async () => {
  const client = new QueryClient();
  const store = createSessionStore({
    queryClient: client,
    exchanged: Promise.resolve(new ApiError(401, "link-expired", "expired")),
    fetchStatus: async () => {
      throw new ApiError(401, "unauthorized", "nope");
    },
  });

  await store.revalidate();
  expect(store.getSnapshot()).toEqual({ kind: "locked", expired: true });

  const afterSession = createSessionStore({
    queryClient: client,
    exchanged: Promise.resolve(new ApiError(401, "link-expired", "expired")),
    fetchStatus: async () => statusFixture(false),
  });
  await afterSession.revalidate();
  expect(afterSession.getSnapshot()).toEqual({ kind: "ready" });

  // Signing out after a valid session never blames the initial boot link code.
  let fail = false;
  const flaky = createSessionStore({
    queryClient: client,
    exchanged: Promise.resolve(new ApiError(401, "link-expired", "expired")),
    fetchStatus: async () => {
      if (fail) throw new ApiError(401, "unauthorized", "expired cookie");
      return statusFixture(false);
    },
  });
  await flaky.revalidate();
  expect(flaky.getSnapshot()).toEqual({ kind: "ready" });
  fail = true;
  await flaky.revalidate();
  expect(flaky.getSnapshot()).toEqual({ kind: "locked", expired: false });
});

test("session store captures non-401 errors", async () => {
  const client = new QueryClient();
  const boom = new Error("server down");
  const store = createSessionStore({
    queryClient: client,
    exchanged: Promise.resolve(null),
    fetchStatus: async () => {
      throw boom;
    },
  });
  await store.revalidate();
  expect(store.getSnapshot()).toEqual({ kind: "error", error: boom });
});

test("SessionGate renders locked screen, errors, redirects to /setup when keys miss, and 404 RouteError", async () => {
  const client = new QueryClient();

  const lockedStore = createSessionStore({
    queryClient: client,
    exchanged: Promise.resolve(new ApiError(401, "link-expired", "expired")),
    fetchStatus: async () => {
      throw new ApiError(401, "unauthorized", "no session");
    },
  });
  await lockedStore.revalidate();
  const lockedHtml = renderGate(
    "/",
    client,
    createElement(SessionGate, { store: lockedStore }, createElement("p", null, "App")),
  );
  expect(lockedHtml).toContain("Open Eidolon from Your Terminal");
  expect(lockedHtml).toContain("That link has expired");

  const missingKeyStore = createSessionStore({
    queryClient: client,
    exchanged: Promise.resolve(null),
    fetchStatus: async () => statusFixture(true),
  });
  await missingKeyStore.revalidate();
  // Redirect renders null instead of the protected children.
  expect(
    renderGate(
      "/",
      client,
      createElement(SessionGate, { store: missingKeyStore }, createElement("p", null, "App")),
    ),
  ).toBe("");
  expect(
    renderGate(
      "/setup",
      client,
      createElement(SessionGate, { store: missingKeyStore }, createElement("p", null, "Wizard")),
    ),
  ).toBe("<p>Wizard</p>");

  expect(renderGate("/missing", client, createElement(RouteError, { status: 404 }))).toContain(
    "This page doesn&#x27;t exist.",
  );
});

// The voice step while the account her voice names waits on the accounts list. Rendered to markup,
// with the macros stubbed.
import { SETTINGS } from "@eidolon/config";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";
import type { AccountView, SettingRow } from "@/lib/api";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
const { VoiceStep } = await import("./voice-step");
const { settingsQuery } = await import("@/components/settings-form/queries");
const { accountsQuery } = await import("@/lib/accounts");

const persona = { id: "milky-green", name: "明前奶绿", shortName: "奶绿" };

// Her voice is on an account of OpenAI's that only the accounts list names.
const rows: SettingRow[] = SETTINGS.map((setting) => ({
  ...setting,
  value: setting.path === "voice.provider" ? "speech" : null,
  source: setting.path === "voice.provider" ? "persona" : "default",
  envValue: null,
  envName: null,
  envOverride: false,
  productionOnly: false,
  readOnly: false,
}));

const speech: AccountView = {
  id: "speech",
  provider: "openai",
  name: "Speech",
  isDefault: false,
  saved: true,
  key: { value: null, source: "account" },
  baseUrl: { value: null, source: null },
  options: {},
  uses: [],
  needed: true,
};

function render(accounts: "pending" | "failed" | "loaded"): string {
  // A retry on mount would render a failed request as loading again.
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  client.setQueryData(settingsQuery(persona.id).queryKey, {
    persona: persona.id,
    settings: rows,
    voiceStyles: { own: [], environment: [], builtInHints: {} },
    warnings: [],
    restartRequired: false,
  });
  if (accounts === "loaded") client.setQueryData(accountsQuery.queryKey, { accounts: [speech] });
  if (accounts === "failed") {
    const query = client.getQueryCache().build(client, { queryKey: [...accountsQuery.queryKey] });
    query.setState({
      ...query.state,
      status: "error",
      error: new Error("accounts are down"),
      errorUpdatedAt: 1,
      errorUpdateCount: 1,
    });
  }
  const step = createElement(VoiceStep, {
    target: { kind: "existing", persona },
    onBack: () => {},
    onDone: () => {},
  });
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(I18nProvider, { i18n }, createElement(QueryClientProvider, { client }, step)),
    ),
  );
}

/** Whether the step's Continue button is off. */
const continueOff = (markup: string) =>
  /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Continue<\/button>/.test(markup);

test("an account's voices wait for the accounts list, not Fish's library in its place", () => {
  const pending = render("pending");
  expect(pending).not.toContain("Search Voices");
  expect(pending).not.toContain("accounts are down");
  expect(continueOff(pending)).toBe(true);

  const failed = render("failed");
  expect(failed).not.toContain("Search Voices");
  expect(failed).toContain("accounts are down");
  expect(continueOff(failed)).toBe(true);

  const loaded = render("loaded");
  expect(loaded).toContain("One of OpenAI&#x27;s voices.");
  expect(loaded).not.toContain("Search Voices");
});

// NewPersonaDialog Create readiness: only blocked by accounts while voice is on.
import { SETTINGS } from "@eidolon/config";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { AccountView, SettingRow } from "@/lib/api";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
vi.doMock("@/features/call/call-context", () => ({ useCallPresence: () => ({ up: false }) }));
vi.doMock("./avatar-picker", () => ({ AvatarPicker: () => null }));
vi.doMock("./voice-choice", () => ({ VoiceChoice: () => null }));
vi.doMock("@/components/ui/switch", () => ({
  Switch: ({ id }: { readonly id?: string }) =>
    createElement("button", { type: "button", role: "switch", id }),
}));
vi.doMock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { readonly open: boolean; readonly children?: ReactNode }) =>
    open ? createElement("div", { "data-slot": "dialog" }, children) : null,
  DialogContent: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  DialogDescription: ({ children }: { readonly children?: ReactNode }) =>
    createElement("p", null, children),
  DialogFooter: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  DialogHeader: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  DialogTitle: ({ children }: { readonly children?: ReactNode }) =>
    createElement("h2", null, children),
}));

const { NewPersonaDialog } = await import("./new-persona");
const { settingsQuery } = await import("@/components/settings-form/queries");
const { accountsQuery } = await import("@/lib/accounts");

function settingsRows(voiceProvider: string): SettingRow[] {
  return SETTINGS.map((setting) => ({
    ...setting,
    value: setting.path === "voice.provider" ? voiceProvider : null,
    source: setting.path === "voice.provider" ? "persona" : "default",
    envValue: null,
    envName: null,
    envOverride: false,
    productionOnly: false,
    readOnly: false,
  }));
}

const fishAccount: AccountView = {
  id: "fish",
  provider: "fish",
  name: "Fish Audio",
  isDefault: true,
  saved: true,
  key: { value: null, source: "account" },
  baseUrl: { value: null, source: null },
  options: {},
  uses: [],
  needed: true,
};

function render(voiceProvider: string | null, accountsLoaded: boolean): string {
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  if (voiceProvider !== null) {
    client.setQueryData(settingsQuery().queryKey, {
      persona: "milky-green",
      settings: settingsRows(voiceProvider),
      voiceStyles: { own: [], environment: [], builtInHints: {} },
      warnings: [],
      restartRequired: false,
    });
  }
  if (accountsLoaded) {
    client.setQueryData(accountsQuery.queryKey, { accounts: [fishAccount] });
  }
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n },
      createElement(
        QueryClientProvider,
        { client },
        createElement(NewPersonaDialog, { open: true, onOpenChange: () => {} }),
      ),
    ),
  );
}

const createOff = (markup: string) =>
  /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Create<\/button>/.test(markup);

describe("NewPersonaDialog Create readiness", () => {
  test("stays disabled while settings are pending", () => {
    const html = render(null, true);
    expect(createOff(html)).toBe(true);
  });

  test("enables Create for a text-only persona even while accounts are pending", () => {
    const html = render("none", false);
    expect(html).toContain("Create</button>");
    expect(createOff(html)).toBe(false);
  });

  test("waits on accounts when voice is enabled and unlocks once loaded", () => {
    expect(createOff(render("fish", false))).toBe(true);
    const loaded = render("fish", true);
    expect(loaded).toContain("Create</button>");
    expect(createOff(loaded)).toBe(false);
  });
});

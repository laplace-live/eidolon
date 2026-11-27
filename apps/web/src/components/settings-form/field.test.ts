import { SETTINGS } from "@eidolon/config";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, Fragment, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { Router, type RouterOptions } from "wouter";
import type { SettingRow } from "@/lib/api";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
vi.doMock("@/components/ui/select", () => ({
  Select: ({ children }: { readonly children?: ReactNode }) => createElement("div", null, children),
  SelectTrigger: ({ children }: { readonly children?: ReactNode }) =>
    createElement(Fragment, null, children),
  SelectValue: () => null,
  SelectContent: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  SelectItem: ({ value, children }: { readonly value: string; readonly children?: ReactNode }) =>
    createElement("div", { "data-option": value }, children),
}));
const { SettingField } = await import("./field");
const { accountsQuery } = await import("@/lib/accounts");
const { OFF_PROVIDER } = await import("@/lib/providers");

function settingRow(path: string, patch: Partial<SettingRow> = {}): SettingRow {
  const base = SETTINGS.find((entry) => entry.path === path);
  if (!base) throw new Error(`missing setting ${path}`);
  return {
    ...base,
    value: null,
    source: "default",
    envValue: null,
    envName: null,
    envOverride: false,
    productionOnly: false,
    readOnly: false,
    ...patch,
  };
}

function renderField(props: {
  readonly row: SettingRow;
  readonly provider?: string | null;
  readonly draft?: string;
}): string {
  const client = new QueryClient();
  client.setQueryData(accountsQuery.queryKey, { accounts: [] });
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(
      Router as FunctionComponent<RouterOptions>,
      { ssrPath: "/" },
      createElement(
        I18nProvider,
        { i18n },
        createElement(
          QueryClientProvider,
          { client },
          createElement(SettingField, {
            row: props.row,
            provider: props.provider ?? null,
            draft: props.draft ?? "",
            error: null,
            onDraft: () => {},
            personaName: "奶绿",
          }),
        ),
      ),
    ),
  );
}

test("ModelPicker receives null instead of OFF_PROVIDER when a role is turned off", () => {
  const markup = renderField({ row: settingRow("voice.model"), provider: OFF_PROVIDER });
  expect(markup).not.toContain("Asking the provider for its models");
});

test("provider field uses the localized off label instead of Default (none) when inherited from env", () => {
  const markup = renderField({
    row: settingRow("voice.provider", { envValue: OFF_PROVIDER }),
  });
  expect(markup).toContain("Default (Off: Text Only)");
  expect(markup).not.toContain("Default (none)");
});

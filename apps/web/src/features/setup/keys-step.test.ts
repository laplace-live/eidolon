// RolePicker's Model input and default hint in setup: default models stay visible under overrides,
// and switching providers clears orphaned saved models.
import { SETTINGS } from "@eidolon/config";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { AccountView, SettingRow } from "@/lib/api";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
vi.doMock("@/components/ui/select", () => ({
  Select: ({ children }: { readonly children?: ReactNode }) => createElement("div", null, children),
  SelectContent: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  SelectItem: ({ children, value }: { readonly children?: ReactNode; readonly value: string }) =>
    createElement("div", { "data-select-value": value }, children),
  SelectTrigger: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  SelectValue: () => null,
}));

const { RolePicker } = await import("./keys-step");

function rows(values: Readonly<Record<string, Partial<SettingRow>>> = {}): SettingRow[] {
  return SETTINGS.map((setting) => ({
    ...setting,
    value: null,
    source: "default",
    envValue: null,
    envName: null,
    envOverride: false,
    productionOnly: false,
    readOnly: false,
    ...values[setting.path],
  }));
}

function account(id: string, provider: string): AccountView {
  return {
    id,
    provider,
    name: id,
    isDefault: id === provider,
    saved: true,
    key: { value: null, source: null },
    baseUrl: { value: "http://127.0.0.1:8000/v1", source: "account" },
    options: {},
    uses: [],
    needed: true,
  };
}

function renderPicker(
  role: "hearing" | "voice" | "mind",
  values: Readonly<Record<string, Partial<SettingRow>>>,
  drafts: Readonly<Record<string, string>> = {},
  accounts: readonly AccountView[] = [account("openai-compatible", "openai-compatible")],
  invalid = false,
): string {
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n },
      createElement(RolePicker, {
        role,
        rows: rows(values),
        drafts,
        accounts,
        invalid,
        disabled: false,
        onDraft: () => {},
      }),
    ),
  );
}

describe("RolePicker Model input", () => {
  test("keeps the fallback Default hint when an openai-compatible model is saved or typed", () => {
    const base = {
      "hearing.provider": { value: "openai-compatible", source: "persona" as const },
      "hearing.model": { value: "Systran/faster-whisper-large-v3", source: "persona" as const },
    };
    const saved = renderPicker("hearing", base);
    expect(saved).toContain('value="Systran/faster-whisper-large-v3"');
    expect(saved).toContain('placeholder="whisper-1"');
    expect(saved).toContain("Default: whisper-1. Leave blank to use it");

    const drafted = renderPicker("hearing", base, { "hearing.model": "custom-stt" });
    expect(drafted).toContain('value="custom-stt"');
    expect(drafted).toContain('placeholder="whisper-1"');
    expect(drafted).toContain("Default: whisper-1. Leave blank to use it");
  });

  test("hides an old provider's saved model after switching into openai-compatible", () => {
    const accounts = [
      account("openai-compatible", "openai-compatible"),
      account("local-2", "openai-compatible"),
    ];
    const switched = renderPicker(
      "voice",
      {
        "voice.provider": { value: "openai", source: "persona" },
        "voice.model": { value: "gpt-4o-mini-tts", source: "persona" },
      },
      { "voice.provider": "openai-compatible" },
      accounts,
    );
    expect(switched).toContain('value=""');
    expect(switched).not.toContain("gpt-4o-mini-tts");
    expect(switched).toContain("Default: tts-1. Leave blank to use it");

    const sameProvider = renderPicker(
      "voice",
      {
        "voice.provider": { value: "openai-compatible", source: "persona" },
        "voice.model": { value: "custom-tts", source: "persona" },
      },
      { "voice.provider": "local-2" },
      accounts,
    );
    expect(sameProvider).toContain('value="custom-tts"');
  });

  test("keeps the no-default guidance on mind even while a custom model is typed", () => {
    const html = renderPicker(
      "mind",
      { "mind.provider": { value: "openai-compatible", source: "persona" } },
      { "mind.model": "qwen-2.5" },
      [account("openai-compatible", "openai-compatible")],
      true,
    );
    expect(html).toContain('value="qwen-2.5"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("This account has no default model, so name the one to use.");
    expect(html).not.toContain("Default:");
  });
});

import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);

const { Markdown, TranscriptLog } = await import("./transcript-view");

function render(node: ReactNode): string {
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(createElement(I18nProvider, { i18n }, node));
}

describe("a task's steps", () => {
  test("a call's target spells out its hidden characters, as its card does", () => {
    const command = "cat notes\u202Etxt.exe";
    const markup = render(
      createElement(TranscriptLog, {
        rows: [
          {
            kind: "tool",
            key: "c1",
            callId: "c1",
            name: "bash",
            label: "bash",
            head: command,
            arguments: { command },
            unparsed: null,
            started: true,
            result: null,
          },
        ],
        running: true,
        loading: false,
      }),
    );
    expect(markup).toContain("\\u{202E}");
    expect(markup).not.toContain("\u202E");
  });

  test("a report's headings are headings, at their level", () => {
    const markup = render(createElement(Markdown, { text: "# Done\n\n### Files\nok" }));
    expect(markup).toMatch(/<h1[^>]*>(<[^>]+>)*Done/);
    expect(markup).toMatch(/<h3[^>]*>(<[^>]+>)*Files/);
  });
});

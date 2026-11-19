// Chat Settings' Task Display field: rendered to markup, with the macros stubbed.
import { expect, mock, test } from "bun:test";
import type { ChatDisplay } from "@eidolon/chat";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

mock.module("@lingui/core/macro", linguiMacro);
mock.module("@lingui/react/macro", linguiReactMacro);
const { DisplayField } = await import("./chat-settings");
const { DISPLAY_HELP } = await import("./labels");

function field(display: ChatDisplay | null, fallback: ChatDisplay): string {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(DisplayField, { id: "chat-1", display, fallback }),
    ),
  );
}

/** The label of the item pressed, or null. */
const chosen = (markup: string): string | null =>
  /aria-checked="true"[^>]*>([^<]+)</.exec(markup)?.[1] ?? null;

const LABELS = { focus: "Focus", normal: "Normal", verbose: "Verbose" } as const;

test("a chat that sets no display names the app's it follows, and none is chosen", () => {
  const markup = field(null, "verbose");
  expect(markup).toContain("Until you choose, this chat follows Settings: Verbose.");
  expect(chosen(markup)).toBeNull();
  expect(markup).toContain("You can also type /focus, /normal or /verbose in the message box.");
});

test("a chat's own display is chosen, and says what it shows", () => {
  for (const display of ["focus", "normal", "verbose"] as const) {
    const markup = field(display, "normal");
    expect(chosen(markup)).toBe(LABELS[display]);
    expect(markup).toContain(DISPLAY_HELP[display].message?.replaceAll("'", "&#x27;") ?? "?");
    expect(markup).not.toContain("Until you choose");
  }
});

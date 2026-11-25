// The call bar shows the tab's call wherever no view of it is mounted, and keeps an ending's reason
// until Close: rendered to markup, with the macros and her picture stubbed.
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";
import { statusQuery } from "@/lib/query";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";
import { type CallPhase, IDLE, type PhaseEvent, reducePhase } from "./phase";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
// Her picture's version store has no server snapshot, and the bar's picture isn't checked here.
vi.doMock("@/components/avatar", () => ({ PersonaAvatar: () => null }));
const { CallBar } = await import("./call-bar");
const { ShellCallContext } = await import("./call-context");
const { CallSignals } = await import("./signals");
const { CallStages } = await import("./stages");
const { chatTarget, isUp } = await import("./target");
const { NO_CALL } = await import("./use-call");
const { TooltipProvider } = await import("@/components/ui/tooltip");

function run(...events: PhaseEvent[]): CallPhase {
  return events.reduce(reducePhase, IDLE);
}

const LIVE = run({ type: "start", at: 1 }, { type: "dial" }, { type: "ready" });
const DROPPED = reducePhase(LIVE, {
  type: "disconnected",
  at: 9,
  end: { kind: "dropped", byBot: false },
});
const HUNG_UP = run(
  { type: "start", at: 1 },
  { type: "dial" },
  { type: "ready" },
  { type: "hang-up" },
  { type: "disconnected", at: 9, end: { kind: "hung-up" } },
);

const MILKY = {
  id: "milky-green",
  name: "明前奶绿",
  shortName: "奶绿",
  avatar: false,
  appearance: { model: null },
};

function render(phase: CallPhase, shown: boolean): string {
  const signals = new CallSignals();
  const call = {
    ...NO_CALL,
    phase,
    target: chatTarget("c1", MILKY, null),
    up: isUp(phase),
    serverCall: null,
    layout: "screen" as const,
    video: false,
    shown,
    start: () => {},
    close: () => {},
    setLayout: () => {},
    show: () => () => {},
    signals,
    stages: new CallStages(signals),
  };
  const client = new QueryClient();
  client.setQueryData(statusQuery.queryKey, {
    persona: { id: "milky-green", voice: { ok: true } },
    lastSessionError: null,
  } as never);
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n },
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          TooltipProvider,
          null,
          createElement(
            MemoryRouter,
            null,
            createElement(ShellCallContext.Provider, { value: call }, createElement(CallBar)),
          ),
        ),
      ),
    ),
  );
}

const classesOf = (tag: string): string[] => tag.match(/ class="([^"]*)"/)?.[1]?.split(" ") ?? [];

test("hides while a view shows the call", () => {
  expect(render(LIVE, true)).toBe("");
});

test("shows a live call on any other page, or on its own page while that throws", () => {
  const markup = render(LIVE, false);
  const section = markup.match(/<section[^>]*>/)?.[0] ?? "";
  expect(section).toContain('aria-label="Ongoing Call"');
  expect(classesOf(section)).toContain("mt-auto");
  expect(markup).not.toContain("data-window-drag");
  expect(markup).toMatch(/<a [^>]*href="\/chats\/c1"[^>]*>.*Return to Call.*<\/a>/);
  expect(markup).toContain("Hang Up");
  expect(markup).not.toMatch(/>Call</);
});

test("keeps a call that ended on its own, with its reason, until Close", () => {
  const markup = render(DROPPED, false);
  expect(markup).toContain('aria-label="Close"');
  expect(markup).toContain("The connection dropped.");
  expect(markup).toMatch(/<a [^>]*href="\/chats\/c1"[^>]*>.*Return to Call.*<\/a>/);
  expect(markup).not.toContain("Hang Up");
});

test("leaves nothing of a call the viewer hung up", () => {
  expect(render(HUNG_UP, false)).toBe("");
  expect(render(HUNG_UP, true)).toBe("");
});

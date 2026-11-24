// The dock offers her model, and with it the screen, only while a call that opened as video is up,
// and the header's Call waits while the tab's call is elsewhere: rendered to markup, with the
// macros, her picture and her stage stubbed.
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { type CallPhase, IDLE, type PhaseEvent, reducePhase } from "@/features/call/phase";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
// Her picture's version store has no server snapshot.
vi.doMock("@/components/avatar", () => ({ PersonaAvatar: () => null }));
vi.doMock("@/features/call/avatar-view", () => ({ AvatarView: () => null }));
const { CallButton, CallDock } = await import("./call-dock");
const { CallPresenceContext, ShellCallContext } = await import("@/features/call/call-context");
const { CallSignals } = await import("@/features/call/signals");
const { CallStages } = await import("@/features/call/stages");
const { chatTarget, isUp } = await import("@/features/call/target");
const { NO_CALL } = await import("@/features/call/use-call");
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

const MILKY = {
  id: "milky-green",
  name: "明前奶绿",
  shortName: "奶绿",
  avatar: false,
  appearance: { model: null },
};
const KURO = {
  id: "kuro",
  name: "黑川茶茶",
  shortName: "茶茶",
  avatar: false,
  appearance: { model: null },
};

function wrapped(node: ReactNode): string {
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(I18nProvider, { i18n }, createElement(TooltipProvider, null, node)),
  );
}

function dock(phase: CallPhase, video: boolean): string {
  const signals = new CallSignals();
  const call = {
    ...NO_CALL,
    phase,
    target: chatTarget("c1", MILKY, null),
    up: isUp(phase),
    serverCall: null,
    layout: "dock" as const,
    video,
    shown: true,
    start: () => {},
    close: () => {},
    setLayout: () => {},
    show: () => () => {},
    signals,
    stages: new CallStages(signals),
  };
  return wrapped(
    createElement(
      CallPresenceContext.Provider,
      { value: call },
      createElement(
        ShellCallContext.Provider,
        { value: call },
        createElement(CallDock, { status: undefined, onCallAgain: () => {} }),
      ),
    ),
  );
}

test("a call up with her model offers Expand, which holds her stage", () => {
  const markup = dock(LIVE, true);
  expect(markup).toContain('aria-label="Call with 奶绿"');
  expect(markup).toMatch(/<button [^>]*aria-label="Expand"/);
  expect(markup).toContain("Hang Up");
});

test("a call whose stages all failed or found none offers no Expand", () => {
  expect(dock(LIVE, false)).not.toContain('aria-label="Expand"');
});

test("the dock's region can take the focus the screen or the bar's Return to Call leaves", () => {
  for (const video of [true, false]) {
    const region = dock(LIVE, video).match(/<section [^>]*>/)?.[0] ?? "";
    expect(region).toContain('aria-label="Call with 奶绿"');
    expect(region).toContain('tabindex="-1"');
  }
});

test("a call that ended never offers Expand, but Call Again and Close", () => {
  const markup = dock(DROPPED, true);
  expect(markup).not.toContain('aria-label="Expand"');
  expect(markup).toContain("Call Again");
  expect(markup).toContain('aria-label="Close"');
  expect(markup).not.toContain("Hang Up");
});

function button(personas: readonly (typeof MILKY)[], unavailable: string | null): string {
  return wrapped(
    createElement(CallButton, {
      personas,
      groupCall: true,
      disabled: false,
      unavailable,
      onCall: () => {},
    }),
  );
}

test("the header's Call waits, with no menu, while the tab's call is elsewhere", () => {
  const reason = "You're already in a call. Hang up first.";
  for (const personas of [[MILKY], [MILKY, KURO]]) {
    const markup = button(personas, reason);
    expect(markup).toMatch(/<button [^>]*aria-disabled="true"[^>]*>.*Call.*<\/button>/);
    expect(markup).not.toContain("aria-haspopup");
    expect(markup).not.toContain(" disabled=");
  }
  expect(button([MILKY, KURO], null)).toContain("aria-haspopup");
  expect(button([MILKY], null)).not.toContain("aria-disabled");
});

// The video screen names the call as the dock does, keeps its controls and a chat's waiting bar in
// reach, and holds /call's transcript in a panel that never covers them: rendered to markup, with
// the macros, her picture and her stage stubbed.
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";
import type { Status } from "@/lib/api";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";
import { type CallPhase, IDLE, type PhaseEvent, reducePhase } from "./phase";
import type { CallTarget, CastMember } from "./target";
import { EMPTY_TRANSCRIPT, reduceTranscript, type Transcript } from "./transcript";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
// Her picture's version store has no server snapshot, and her stage needs a browser.
vi.doMock("@/components/avatar", () => ({ PersonaAvatar: () => null }));
vi.doMock("./avatar-view", () => ({ AvatarView: () => null }));
vi.doMock("./call-tiles", () => ({ CallTiles: () => null }));
const { VideoCall } = await import("./video-call");
const { CallPresenceContext, ShellCallContext } = await import("./call-context");
const { CallSignals } = await import("./signals");
const { CallStages } = await import("./stages");
const { chatTarget, isUp, soloTarget } = await import("./target");
const { NO_CALL } = await import("./use-call");
const { TooltipProvider } = await import("@/components/ui/tooltip");

function run(...events: PhaseEvent[]): CallPhase {
  return events.reduce(reducePhase, IDLE);
}

const LIVE = run({ type: "start", at: 1 }, { type: "dial" }, { type: "ready" });

const member = (id: string, name: string, shortName: string): CastMember => ({
  id,
  name,
  shortName,
  avatar: false,
  appearance: {
    model: {
      id: "tml",
      name: "TML",
      kind: "psd2live",
      sha256: "0".repeat(64),
      updatedAt: "2026-11-23T00:00:00.000Z",
    },
  },
});
const MILKY = member("milky-green", "明前奶绿", "奶绿");
const MINT = member("mint", "薄荷", "薄荷");

const STATUS = {
  persona: { id: "milky-green", voice: { ok: true } },
  lastSessionError: null,
} as unknown as Status;

interface Render {
  readonly target?: CallTarget;
  readonly transcript?: Transcript;
  readonly thinking?: boolean;
  readonly botSpeaking?: boolean;
  readonly props?: Partial<Parameters<typeof VideoCall>[0]>;
}

function render({
  target = chatTarget("c1", MILKY, null),
  transcript = EMPTY_TRANSCRIPT,
  thinking = false,
  botSpeaking = false,
  props,
}: Render = {}): string {
  const signals = new CallSignals();
  const call = {
    ...NO_CALL,
    phase: LIVE,
    transcript,
    wait: { thinking, stuck: false },
    botSpeaking,
    target,
    up: isUp(LIVE),
    serverCall: null,
    layout: "screen" as const,
    video: true,
    shown: true,
    start: () => {},
    close: () => {},
    setLayout: () => {},
    show: () => () => {},
    signals,
    stages: new CallStages(signals),
  };
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n },
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(
          TooltipProvider,
          null,
          createElement(
            MemoryRouter,
            null,
            createElement(
              CallPresenceContext.Provider,
              { value: call },
              createElement(
                ShellCallContext.Provider,
                { value: call },
                createElement(VideoCall, { status: STATUS, titled: true, ...props }),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

const classesOf = (tag: string): string[] => tag.match(/ class="([^"]*)"/)?.[1]?.split(" ") ?? [];

test("names the call as the dock does, and is never a drag row", () => {
  const markup = render({ props: { onShrink: () => {} } });
  expect(markup.match(/aria-label="Call with [^"]*"/g)).toEqual(['aria-label="Call with 奶绿"']);
  expect(markup.match(/<section [^>]*>/)?.[0]).toContain("data-call-screen");
  expect(markup).not.toContain("data-window-drag");
  expect(markup).toContain("明前奶绿");
  expect(markup).toContain('aria-label="Captions"');
  expect(markup).toContain('aria-label="Shrink"');
  expect(markup).toContain("Hang Up");
  expect(markup).not.toContain("Type a Message");
  expect(markup).not.toContain('aria-label="Transcript"');
  expect(markup).not.toContain("data-call-transcript");
});

test("offers Shrink only where the call can dock", () => {
  expect(render()).not.toContain("Shrink");
  expect(render({ props: { onShrink: null } })).not.toContain("Shrink");
});

test("keeps /call's transcript mounted beside the call, or below it, never over its controls", () => {
  const markup = render({
    target: soloTarget(MILKY),
    props: {
      titled: false,
      typing: true,
      transcript: createElement("div", { role: "log" }, "她说的话"),
    },
  });
  expect(markup).toContain('aria-label="Type a Message"');
  expect(markup).toContain('aria-label="Transcript"');
  expect(markup).not.toContain("明前奶绿");
  const at = markup.indexOf("<div data-call-transcript");
  expect(at).toBeGreaterThan(-1);
  const panel = markup.slice(at);
  const tag = panel.match(/^<div [^>]*>/)?.[0] ?? "";
  expect(tag).toContain(' hidden=""');
  expect(classesOf(tag)).toContain("max-md:h-[55%]");
  expect(classesOf(tag)).not.toContain("absolute");
  expect(panel).toContain("她说的话");
  expect(panel).not.toContain("Hang Up");
  expect(markup.indexOf("Hang Up")).toBeLessThan(at);
});

test("holds a chat's waiting bar opaque, and the one part that scrolls", () => {
  const markup = render({
    props: { waiting: createElement("section", { "data-waiting": "t1" }, "Waiting for You") },
  });
  const wrapper = markup.match(/<div class="([^"]*)"><section data-waiting="t1"/)?.[1]?.split(" ");
  expect(wrapper).toEqual(expect.arrayContaining(["bg-background", "overflow-y-auto", "min-h-0"]));
});

test("waits for one persona by her name, and for a group's reply without one", () => {
  expect(render({ thinking: true })).toContain("奶绿 is thinking…");
  const group = render({ target: chatTarget("c1", MILKY, [MILKY, MINT]), thinking: true });
  expect(group).toContain('aria-label="Call with 奶绿, 薄荷"');
  expect(group).toContain("Waiting for a reply…");
  expect(group).not.toContain("is thinking…");
});

test("captions her last sentence while she says it, and asks a group call to start", () => {
  const announced = reduceTranscript(EMPTY_TRANSCRIPT, {
    type: "bot-output",
    data: {
      text: "[开心地] 看得到呀，你也在笑！",
      segment_id: 1,
      output_type: "sentence",
      will_be_spoken: true,
      spoken_status: "new",
    },
  });
  const markup = render({ transcript: announced, botSpeaking: true });
  expect(markup).toMatch(/<p data-captions="true" data-live="true"[^>]*>/);
  expect(markup).toContain('<span data-caption-text="true">看得到呀，你也在笑！</span>');
  expect(render({ transcript: announced })).toContain('data-live="false"');
  const quiet = render({ target: chatTarget("c1", MILKY, [MILKY, MINT]) });
  expect(quiet).toContain("Everyone can hear you. Say something to start.");
  expect(quiet).not.toContain("data-captions");
});

test("shows her newest photo in the corner while the call is up", () => {
  const shot = reduceTranscript(EMPTY_TRANSCRIPT, {
    type: "selfie",
    paths: ["/api/selfie/a.png"],
  });
  const markup = render({ transcript: shot });
  expect(markup).toMatch(/<img src="\/api\/selfie\/a.png" alt="A selfie from 奶绿"/);
  expect(render()).not.toContain("<img");
});

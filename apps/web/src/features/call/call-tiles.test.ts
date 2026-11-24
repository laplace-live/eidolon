// A group call's tiles, and the stage view in each, follow their own persona's direction: rendered
// to markup over a call's real signals and stages, with the macros and her picture stubbed.
import type { AvatarModel, ResolvedSetup } from "@laplace.live/eidolon-sdk/avatar";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import type { ActiveCharacterModel } from "@/lib/api";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";
import type { CallSignals as Signals } from "./signals";
import type { StageLike, CallStages as Stages } from "./stages";
import type { CallTarget, CastMember } from "./target";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
// Her picture's version store has no server snapshot: a mark stands in for her picture.
vi.doMock("@/components/avatar", () => ({
  PersonaAvatar: ({ persona }: { readonly persona: { readonly id: string } }) =>
    createElement("i", { "data-face": persona.id }),
}));
const { CallTiles } = await import("./call-tiles");
const { AvatarView } = await import("./avatar-view");
const { CallPresenceContext } = await import("./call-context");
const { CallSignals } = await import("./signals");
const { CallStages } = await import("./stages");
const { chatTarget, soloTarget } = await import("./target");
const { NO_CALL } = await import("./use-call");

const MODEL: ActiveCharacterModel = {
  id: "tml",
  name: "TML",
  kind: "psd2live",
  sha256: "0".repeat(64),
  updatedAt: "2026-11-23T00:00:00.000Z",
};

function member(id: string, model: ActiveCharacterModel | null = MODEL): CastMember {
  return { id, name: `${id} name`, shortName: id, avatar: false, appearance: { model } };
}

const MILKY = member("milky-green");
const MINT = member("mint");
const PLAIN = member("plain", null);
const BROKEN = member("broken");

const STAGE: StageLike = {
  show() {},
  frame() {},
  direct() {},
  mouth() {},
  wear() {},
  dispose() {},
};

/**
 * Stages on fake parts: `ready` loads at once, `failing` is refused, any other member's load never
 * ends.
 */
function staged(
  signals: Signals,
  target: CallTarget,
  ready: readonly string[],
  failing: readonly string[] = [],
): Stages {
  const stages = new CallStages(signals, {
    canvas: () => ({ remove() {} }) as unknown as HTMLCanvasElement,
    stage: async () => STAGE,
  });
  stages.load(target, {
    load: (who) =>
      ready.includes(who.id)
        ? Promise.resolve({
            model: { dispose() {} } as unknown as AvatarModel,
            setup: {} as ResolvedSetup,
            box: { x: 0, y: 0, width: 1, height: 1 },
            outfit: null,
          })
        : failing.includes(who.id)
          ? Promise.reject(new Error("load refused"))
          : new Promise(() => {}),
    reducedMotion: false,
  });
  return stages;
}

function render(target: CallTarget, signals: Signals, stages: Stages, node: ReactNode): string {
  const presence = {
    ...NO_CALL,
    target,
    up: true,
    serverCall: null,
    layout: "screen" as const,
    video: true,
    shown: true,
    start: () => {},
    close: () => {},
    setLayout: () => {},
    show: () => () => {},
    signals,
    stages,
  };
  return renderToStaticMarkup(
    createElement(CallPresenceContext.Provider, { value: presence }, node),
  );
}

/** The markup of the tile for `id`, up to the next tile. */
function tile(markup: string, id: string): string {
  const at = markup.indexOf(`<div data-tile="${id}"`);
  const next = markup.indexOf("<div data-tile=", at + 1);
  return at === -1 ? "" : markup.slice(at, next === -1 ? undefined : next);
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const quiet = () => ({ now: () => 0, every: () => () => {} });

test("a tile per persona, host first: her model once it draws, else her picture", async () => {
  const target = chatTarget("c1", MILKY, [MINT, MILKY, PLAIN, BROKEN]);
  const signals = new CallSignals(quiet());
  const stages = staged(signals, target, ["milky-green"], ["broken"]);
  await settled();
  const markup = render(target, signals, stages, createElement(CallTiles, { cast: target.cast }));

  expect([...markup.matchAll(/data-tile="([^"]+)"/g)].map((match) => match[1])).toEqual([
    "milky-green",
    "mint",
    "plain",
    "broken",
  ]);
  expect(markup.match(/^<div class="([^"]*)"/)?.[1]?.split(" ")).toContain("grid-cols-2");
  const host = tile(markup, "milky-green");
  expect(host).toContain('data-avatar="milky-green" data-state="ready"');
  expect(host).not.toContain("data-face");
  const loading = tile(markup, "mint");
  expect(loading).toContain('data-avatar="mint" data-state="loading"');
  expect(loading).toContain('data-face="mint"');
  const plain = tile(markup, "plain");
  expect(plain).not.toContain("data-avatar");
  expect(plain).toContain('data-face="plain"');
  const failed = tile(markup, "broken");
  expect(failed).toContain('data-avatar="broken" data-state="failed"');
  expect(failed).toContain('data-face="broken"');
  expect(markup).not.toContain('data-speaking="true"');
});

test("only the speaking persona's tile lights, with her mood on her stage", async () => {
  const target = chatTarget("c1", MILKY, [MILKY, MINT]);
  const signals = new CallSignals(quiet());
  const stages = staged(signals, target, ["milky-green", "mint"]);
  await settled();
  signals.feed({ type: "speaker", at: 1, persona: "mint" });
  signals.feed({ type: "bot-started-speaking", at: 2 });
  signals.feed({
    type: "bot-output",
    at: 3,
    segment: 1,
    text: "[开心地] 看得到呀，你也在笑！",
    status: "new",
  });
  const markup = render(target, signals, stages, createElement(CallTiles, { cast: target.cast }));

  expect(markup.match(/^<div class="([^"]*)"/)?.[1]).toContain("grid-cols-1 sm:grid-cols-2");
  expect(tile(markup, "mint")).toMatch(/^<div data-tile="mint" data-speaking="true"/);
  expect(tile(markup, "mint")).toContain(
    'data-avatar="mint" data-state="ready" data-speaking="true" data-mood="happy"',
  );
  expect(tile(markup, "milky-green")).toMatch(
    /^<div data-tile="milky-green" data-speaking="false"/,
  );
  expect(tile(markup, "milky-green")).toContain('data-speaking="false" data-mood=""');
});

test("a view with no stage of hers shows her picture, as none", () => {
  const target = soloTarget(PLAIN);
  const signals = new CallSignals(quiet());
  const stages = new CallStages(signals, {
    canvas: () => ({ remove() {} }) as unknown as HTMLCanvasElement,
    stage: async () => STAGE,
  });
  const markup = render(
    target,
    signals,
    stages,
    createElement(AvatarView, { member: PLAIN, face: "sm", className: "absolute inset-0" }),
  );
  expect(markup).toMatch(
    /^<div data-avatar="plain" data-state="none"[^>]* class="absolute inset-0">/,
  );
  expect(markup).toContain('data-face="plain"');
  expect(markup).not.toContain("data-mouth");
});

// When the desktop companion is made, loaded, shown and closed, where her window goes, what her menu
// does and when the main window keeps drawing for her; and the port's pairing. A fake io records
// every call, and the test runs its timers.
import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, test } from "vitest";
import {
  COMPANION_LINES,
  type CompanionSettings,
  companionSize,
  DEFAULT_ASPECT,
  DEFAULT_COMPANION,
  DRAW_TIMEOUT_MS,
  feetOf,
  MENU_SETTLE_MS,
  POP_TIMEOUT_MS,
  placement,
  RETRY_MS,
} from "../src/main/companion.ts";
import {
  Companion,
  type CompanionFlowOptions,
  type CompanionIo,
  CompanionLink,
} from "../src/main/companion-flow.ts";
import { STRINGS } from "../src/main/strings.ts";
import type { Rectangle } from "../src/main/window-options.ts";
import type { CompanionMenuState } from "../src/shared/bridge.ts";

/** A laptop's display, and its work area under macOS's menu bar and above its Dock: the primary. */
const LAPTOP_DISPLAY = { x: 0, y: 0, width: 1512, height: 982 };
const LAPTOP = { x: 0, y: 25, width: 1512, height: 875 };
/** A second display to its right, under its own menu bar. */
const EXTERNAL_DISPLAY = { x: 1512, y: -225, width: 2560, height: 1440 };
const EXTERNAL = { x: 1512, y: -200, width: 2560, height: 1415 };
/** Her first place on the laptop, at the medium size for a full-length figure. */
const FIRST = { x: 1286, y: 420, width: 202, height: 480 };

interface Timer {
  readonly ms: number;
  readonly run: () => void;
  cancelled: boolean;
  fired: boolean;
}

/** The items of `items` and their submenus, in order. */
function flat(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...flat(Array.isArray(item.submenu) ? (item.submenu as MenuItemConstructorOptions[]) : []),
  ]);
}

/** A companion on a fake io, with `settings` over the defaults, outside background mode. */
function companion(
  settings: Partial<CompanionSettings> = {},
  options: Partial<Pick<CompanionFlowOptions, "background" | "atLogin">> = {},
) {
  const calls: unknown[][] = [];
  const lines: string[] = [];
  const timers: Timer[] = [];
  let window: Rectangle | null = null;
  let areas: readonly Rectangle[] = [LAPTOP, EXTERNAL];
  let displays: readonly Rectangle[] = [LAPTOP_DISPLAY, EXTERNAL_DISPLAY];
  /** The label of the item the next popup clicks; null clicks nothing. */
  let clicking: string | null = null;
  /** The last popup's items. */
  let popped: readonly MenuItemConstructorOptions[] = [];
  const clickIn = (items: readonly MenuItemConstructorOptions[], label: string) => {
    const item = flat(items).find((entry) => entry.label === label);
    if (item === undefined) throw new Error(`her menu has no ${label}`);
    (item.click as () => void)();
  };
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const io: CompanionIo = {
    open: (bounds) => {
      calls.push(["open", bounds]);
      window ??= bounds;
    },
    close: () => {
      calls.push(["close"]);
      window = null;
    },
    show: record("show"),
    hide: record("hide"),
    bounds: () => window,
    setBounds: (bounds) => {
      calls.push(["setBounds", bounds]);
      if (window !== null) window = bounds;
    },
    setAlwaysOnTop: record("setAlwaysOnTop"),
    passClicks: record("passClicks"),
    cursor: record("cursor"),
    throttle: record("throttle"),
    areas: () => areas,
    displays: () => displays,
    save: record("save"),
    popup: async (items) => {
      calls.push(["popup"]);
      popped = items;
      if (clicking !== null) clickIn(items, clicking);
    },
    menus: record("menus"),
    openMain: record("openMain"),
    hideMain: record("hideMain"),
    command: record("command"),
    pick: record("pick"),
    after: (ms, run) => {
      const timer: Timer = { ms, run, cancelled: false, fired: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    log: {
      info: (line) => void lines.push(line),
      warn: (line) => void lines.push(`warn: ${line}`),
    },
  };
  const flow = new Companion(io, {
    settings: { ...DEFAULT_COMPANION, ...settings },
    background: false,
    atLogin: false,
    strings: () => STRINGS.en,
    ...options,
  });
  return {
    flow,
    calls,
    lines,
    /** The calls' names, in order. */
    names: () => calls.map(([name]) => name),
    /** Each value `name` was called with, in order. */
    values: (name: string) => calls.filter(([called]) => called === name).map(([, value]) => value),
    /** Runs each pending timer of `ms`. */
    fire: (ms: number) => {
      for (const timer of timers.filter((t) => t.ms === ms && !t.cancelled && !t.fired)) {
        timer.fired = true;
        timer.run();
      }
    },
    window: () => window,
    /** Her window closed by something other than the flow. */
    closeWindow: () => {
      window = null;
    },
    /** The displays' work areas, and their bounds. */
    setScreens: (nextAreas: readonly Rectangle[], nextDisplays: readonly Rectangle[]) => {
      areas = nextAreas;
      displays = nextDisplays;
    },
    click: (label: string | null) => {
      clicking = label;
    },
    /** Clicks `label` in the last popup, as a click delivered after its close. */
    clickLate: (label: string) => clickIn(popped, label),
    /** Clears what was recorded so far. */
    reset: () => {
      calls.length = 0;
      lines.length = 0;
    },
  };
}

type Fake = ReturnType<typeof companion>;

/** She is on, her page drew her and she shows. */
function shownCompanion(
  settings: Partial<CompanionSettings> = {},
  options: Partial<Pick<CompanionFlowOptions, "background" | "atLogin">> = {},
): Fake {
  const fake = companion({ on: true, ...settings }, options);
  fake.flow.appPage();
  fake.flow.drawn("model");
  return fake;
}

describe("her showing", () => {
  test("turned on before the app page, she opens only with it, hidden, at her first place, and shows once drawn", () => {
    const { flow, calls, lines, names } = companion();
    flow.setOn(true);
    expect(names()).toEqual(["save", "menus"]);
    flow.appPage();
    expect(FIRST).toEqual(
      placement(
        null,
        companionSize("medium", { kind: "model", aspect: DEFAULT_ASPECT }, LAPTOP),
        [LAPTOP, EXTERNAL],
        [LAPTOP_DISPLAY, EXTERNAL_DISPLAY],
      ),
    );
    expect(calls.slice(2)).toEqual([
      ["open", FIRST],
      ["passClicks", true],
      ["setAlwaysOnTop", true],
    ]);
    flow.drawn("model");
    expect(calls.slice(5)).toEqual([["show"]]);
    expect(lines).toEqual([
      COMPANION_LINES.on,
      COMPANION_LINES.drawn("model"),
      COMPANION_LINES.shown,
    ]);
  });

  test("in background mode she opens and draws, but is never shown, floated or followed", () => {
    const { flow, lines, names } = shownCompanion({}, { background: true });
    flow.follow(true);
    flow.shape({ kind: "picture" });
    expect(names()).toEqual(["open", "passClicks", "setBounds"]);
    expect(lines).toEqual([COMPANION_LINES.drawn("model"), COMPANION_LINES.offScreen]);
    flow.shellPage();
    expect(lines.at(-1)).toBe(COMPANION_LINES.hidden);
    expect(names()).not.toContain("hide");
  });

  test("a shell page hides her, and the next app page loads her page again, hidden until drawn", () => {
    const { flow, calls, lines, names, reset } = shownCompanion();
    reset();
    flow.shellPage();
    expect(names()).toEqual(["hide"]);
    flow.appPage();
    expect(calls.slice(1)).toEqual([
      ["open", FIRST],
      ["passClicks", true],
      ["setAlwaysOnTop", true],
    ]);
    flow.drawn("model");
    expect(calls.at(-1)).toEqual(["show"]);
    expect(lines).toEqual([
      COMPANION_LINES.hidden,
      COMPANION_LINES.drawn("model"),
      COMPANION_LINES.shown,
    ]);
  });

  test("drawn(null) hides her without closing her window, passing clicks again, until she is drawn", () => {
    const { flow, calls, names, reset } = shownCompanion();
    flow.hit(true);
    expect(calls.at(-1)).toEqual(["passClicks", false]);
    reset();
    flow.drawn(null);
    expect(calls).toEqual([["passClicks", true], ["hide"]]);
    flow.drawn("picture");
    expect(calls).toEqual([["passClicks", true], ["hide"], ["show"]]);
    expect(names()).not.toContain("close");
  });

  test("a new document in her window hides her until it says she is drawn, passing clicks", () => {
    const { flow, calls, lines, reset } = shownCompanion();
    reset();
    flow.pageReplaced();
    expect(calls).toEqual([["passClicks", true], ["hide"]]);
    flow.drawn("model");
    expect(calls.at(-1)).toEqual(["show"]);
    expect(lines).toEqual([
      COMPANION_LINES.hidden,
      COMPANION_LINES.drawn("model"),
      COMPANION_LINES.shown,
    ]);
  });

  test("before her page loads, and with her off, drawn and a new document change nothing", () => {
    const { flow, calls } = companion();
    flow.appPage();
    flow.drawn("model");
    flow.pageReplaced();
    flow.hit(true);
    expect(calls).toEqual([]);
  });

  test("at a launch at login she waits for the window's first showing, unless Show at Login is on", () => {
    const held = shownCompanion({ showAtLogin: false }, { atLogin: true });
    expect(held.names()).not.toContain("show");
    held.flow.mainShown(true);
    expect(held.calls.at(-1)).toEqual(["show"]);
    // The window has shown once this run: she stays when it hides.
    held.flow.mainShown(false);
    expect(held.names().filter((name) => name === "hide")).toEqual([]);
    const shows = shownCompanion({ showAtLogin: true }, { atLogin: true });
    expect(shows.calls.at(-1)).toEqual(["show"]);
    expect([...held.names(), ...shows.names()]).not.toContain("openMain");
  });

  test("a page that draws nothing within 30 s is logged, and a later drawn still shows her", () => {
    const { flow, lines, calls, fire } = companion({ on: true });
    flow.appPage();
    fire(DRAW_TIMEOUT_MS);
    expect(lines).toEqual([`warn: ${COMPANION_LINES.late}`]);
    flow.drawn("model");
    expect(calls.at(-1)).toEqual(["show"]);
  });

  test("a drawn page cancels the draw timer", () => {
    const { lines, fire } = shownCompanion();
    fire(DRAW_TIMEOUT_MS);
    expect(lines).not.toContain(`warn: ${COMPANION_LINES.late}`);
  });
});

describe("turning her on and off", () => {
  test("off, her window closes and the menus follow; on again while the app page shows, it opens", () => {
    const { flow, calls, lines, names, reset } = shownCompanion();
    reset();
    flow.setOn(false);
    expect(names()).toEqual(["save", "menus", "close", "hide"]);
    expect(calls[0]).toEqual(["save", { ...DEFAULT_COMPANION, on: false }]);
    expect(lines).toEqual([COMPANION_LINES.off, COMPANION_LINES.hidden]);
    flow.setOn(false);
    expect(names()).toHaveLength(4);
    flow.setOn(true);
    expect(names().slice(4)).toEqual(["save", "menus", "open", "passClicks", "setAlwaysOnTop"]);
    expect(flow.state()).toEqual({ on: true, showAtLogin: true, background: false });
  });

  test("off while a call of hers goes on in a window that doesn't show, she brings the window back first", () => {
    const popped = shownCompanion();
    popped.flow.feeding(true);
    popped.flow.mainShown(false);
    popped.reset();
    popped.flow.setOn(false);
    expect(popped.names().slice(0, 4)).toEqual(["save", "menus", "openMain", "close"]);
    for (const [feeding, shows] of [
      [true, true],
      [false, false],
    ] as const) {
      const other = shownCompanion();
      other.flow.feeding(feeding);
      other.flow.mainShown(shows);
      other.flow.setOn(false);
      expect([feeding, shows, other.names().includes("openMain")]).toEqual([feeding, shows, false]);
    }
  });

  test("Settings' change saves Show at Login, turns her on or off, and answers her state", () => {
    const { flow, calls, names } = companion();
    expect(flow.change({ showAtLogin: false })).toEqual({
      on: false,
      showAtLogin: false,
      background: false,
    });
    expect(calls).toEqual([["save", { ...DEFAULT_COMPANION, showAtLogin: false }]]);
    expect(flow.change({ on: true })).toEqual({ on: true, showAtLogin: false, background: false });
    expect(names()).toEqual(["save", "save", "menus"]);
    expect(companion({}, { background: true }).flow.state()).toEqual({
      on: false,
      showAtLogin: true,
      background: true,
    });
  });
});

describe("her window", () => {
  test("her picture's shape makes it 128 DIP square, at her first place while she has no feet of her own", () => {
    const { flow, calls } = companion({ on: true });
    flow.appPage();
    expect(flow.shape({ kind: "picture" })).toEqual({ width: 128, height: 128 });
    // Her window's right edge 24 DIP in, as for a full-length figure's.
    expect(calls.at(-1)).toEqual(["setBounds", { x: 1360, y: 772, width: 128, height: 128 }]);
  });

  test("once drawn, a new shape grows from her feet, as it does from feet she was left on", () => {
    const { flow, calls } = companion({ on: true });
    flow.appPage();
    flow.drawn("model");
    flow.shape({ kind: "picture" });
    const feet = feetOf(FIRST);
    expect(calls.at(-1)).toEqual([
      "setBounds",
      { x: feet.x - 64, y: feet.y - 128, width: 128, height: 128 },
    ]);
    const saved = companion({ on: true, feet: { x: 300, y: 900 } });
    saved.flow.appPage();
    saved.flow.shape({ kind: "picture" });
    expect(saved.calls.at(-1)).toEqual(["setBounds", { x: 236, y: 772, width: 128, height: 128 }]);
  });

  test("she opens where her feet were left, on the display that holds them", () => {
    const { flow, calls } = companion({ on: true, feet: { x: 3000, y: 1215 } });
    flow.appPage();
    expect(calls[0]).toEqual(["open", { x: 2899, y: 735, width: 202, height: 480 }]);
  });

  test("she opens at her first place once the display her feet were left on is gone, though her window would reach onto the laptop's", () => {
    // A display to the laptop's left, unplugged since: her feet were 10 DIP past their shared edge.
    const { flow, calls, setScreens } = companion({ on: true, feet: { x: -10, y: 900 } });
    setScreens([LAPTOP], [LAPTOP_DISPLAY]);
    flow.appPage();
    expect(calls[0]).toEqual(["open", FIRST]);
  });

  test("a drag moves her with the pointer, and a drop near the bottom stands her on it and keeps her feet", () => {
    const { flow, calls, names, reset } = shownCompanion();
    reset();
    flow.drag({ phase: "move", x: 900, y: 500 });
    flow.drag({ phase: "end", x: 900, y: 500 });
    expect(names()).toEqual([]);
    flow.drag({ phase: "start", x: 1387, y: 600 });
    flow.drag({ phase: "move", x: 1300, y: 560 });
    flow.drag({ phase: "move", x: 1200, y: 500 });
    flow.drag({ phase: "end", x: 1200, y: 590 });
    expect(calls).toEqual([
      ["setBounds", { x: 1199, y: 380, width: 202, height: 480 }],
      ["setBounds", { x: 1099, y: 320, width: 202, height: 480 }],
      ["setBounds", { x: 1099, y: 420, width: 202, height: 480 }],
      ["save", { ...DEFAULT_COMPANION, on: true, feet: { x: 1200, y: 900 } }],
    ]);
    flow.drag({ phase: "move", x: 0, y: 0 });
    expect(calls).toHaveLength(4);
  });

  test("a drop is where she stands: her picture then stands on the feet it left", () => {
    const { flow, values } = shownCompanion();
    flow.drag({ phase: "start", x: 1387, y: 600 });
    flow.drag({ phase: "move", x: 1087, y: 500 });
    flow.drag({ phase: "end", x: 1087, y: 590 });
    expect(values("setBounds").at(-1)).toEqual({ x: 986, y: 420, width: 202, height: 480 });
    flow.shape({ kind: "picture" });
    expect(values("setBounds").at(-1)).toEqual({ x: 1023, y: 772, width: 128, height: 128 });
  });

  test("a new window stands on her saved feet, not where a display change left the last one", () => {
    const { flow, values, setScreens } = shownCompanion({ feet: { x: 300, y: 900 } });
    const saved = { x: 199, y: 420, width: 202, height: 480 };
    expect(values("open")).toEqual([saved]);
    setScreens(
      [{ ...LAPTOP, height: LAPTOP.height - 75 }, EXTERNAL],
      [LAPTOP_DISPLAY, EXTERNAL_DISPLAY],
    );
    flow.displaysChanged();
    setScreens([LAPTOP, EXTERNAL], [LAPTOP_DISPLAY, EXTERNAL_DISPLAY]);
    flow.displaysChanged();
    expect(values("setBounds").at(-1)).toEqual({ ...saved, y: 825 - 480 });
    flow.setOn(false);
    flow.setOn(true);
    expect(values("open")).toEqual([saved, saved]);
  });

  test("a reshape during a drag stands her where the drag has her, and the drag goes on at her new size", () => {
    const { flow, values } = shownCompanion();
    flow.drag({ phase: "start", x: 1387, y: 600 });
    flow.drag({ phase: "move", x: 1187, y: 600 });
    flow.shape({ kind: "picture" });
    // Displays that change nothing under her move nothing either.
    flow.displaysChanged();
    flow.drag({ phase: "move", x: 1137, y: 560 });
    flow.drag({ phase: "end", x: 1137, y: 600 });
    const picture = { x: 1123, y: 772, width: 128, height: 128 };
    expect(values("setBounds")).toEqual([
      { x: 1086, y: 420, width: 202, height: 480 },
      picture,
      picture,
      { x: 1073, y: 732, width: 128, height: 128 },
      { x: 1073, y: 772, width: 128, height: 128 },
    ]);
    expect(values("save").at(-1)).toEqual({
      ...DEFAULT_COMPANION,
      on: true,
      feet: { x: 1137, y: 900 },
    });
  });

  test("a hit makes her window take clicks, and a miss passes them, while it exists", () => {
    const { flow, values } = shownCompanion();
    flow.hit(true);
    flow.hit(false);
    flow.setOn(false);
    flow.hit(true);
    expect(values("passClicks")).toEqual([true, false, true]);
  });

  test("a display that goes takes her back to her first place on the primary's", () => {
    const { flow, calls, setScreens, window } = companion({ on: true, feet: { x: 3000, y: 1215 } });
    flow.appPage();
    setScreens([LAPTOP], [LAPTOP_DISPLAY]);
    flow.displaysChanged();
    expect(calls.at(-1)).toEqual(["setBounds", FIRST]);
    expect(window()).toEqual(FIRST);
    // With her window still on a display, she stays.
    flow.displaysChanged();
    expect(calls.at(-1)).toEqual(["setBounds", FIRST]);
    // She stands there now: her picture's window keeps her feet.
    flow.shape({ kind: "picture" });
    const feet = feetOf(FIRST);
    expect(calls.at(-1)).toEqual([
      "setBounds",
      { x: feet.x - 64, y: feet.y - 128, width: 128, height: 128 },
    ]);
  });

  test("reshaped between odd and even widths, she stands on her own feet, never drifting", () => {
    // Where a drag of her 205-DIP-wide model left her feet: half a DIP into a pixel.
    const feet = { x: 700.5, y: 900 };
    const model = { kind: "model", aspect: 0.427 } as const;
    const { flow, values } = shownCompanion({ feet });
    expect(flow.shape(model)).toEqual({ width: 205, height: 480 });
    const standing = values("setBounds").at(-1);
    expect(standing).toEqual({ x: 598, y: 420, width: 205, height: 480 });
    for (let trip = 0; trip < 5; trip++) {
      flow.shape({ kind: "picture" });
      // Displays that change nothing under her move nothing either.
      flow.displaysChanged();
      flow.shape(model);
      expect([trip, values("setBounds").at(-1)]).toEqual([trip, standing]);
    }
  });

  test("a Dock that grew under her pushes her up onto its edge, rather than off to her first place", () => {
    const { flow, calls, setScreens } = shownCompanion({ feet: { x: 300, y: 900 } });
    setScreens(
      [{ ...LAPTOP, height: LAPTOP.height - 75 }, EXTERNAL],
      [LAPTOP_DISPLAY, EXTERNAL_DISPLAY],
    );
    flow.displaysChanged();
    const onItsEdge = { x: 199, y: 825 - 480, width: 202, height: 480 };
    expect(calls.at(-1)).toEqual(["setBounds", onItsEdge]);
    // She stands there now, as a drag would leave her, and stays once it shrinks back.
    setScreens([LAPTOP, EXTERNAL], [LAPTOP_DISPLAY, EXTERNAL_DISPLAY]);
    flow.displaysChanged();
    expect(calls.at(-1)).toEqual(["setBounds", onItsEdge]);
  });
});

describe("her eyes on the cursor", () => {
  test("follow while she shows starts the poll; a drag stops it until it ends", () => {
    const { flow, values } = shownCompanion();
    flow.follow(true);
    expect(values("cursor")).toEqual([true]);
    flow.drag({ phase: "start", x: 1387, y: 600 });
    expect(values("cursor")).toEqual([true, false]);
    flow.drag({ phase: "end", x: 1387, y: 600 });
    expect(values("cursor")).toEqual([true, false, true]);
    flow.follow(false);
    expect(values("cursor")).toEqual([true, false, true, false]);
  });

  test("a new page, a failure or a closed window forget the old page's follow and drag", () => {
    for (const gone of ["replaced", "failed", "closed"] as const) {
      const { flow, values, closeWindow } = shownCompanion();
      flow.follow(true);
      flow.drag({ phase: "start", x: 1387, y: 600 });
      if (gone === "replaced") flow.pageReplaced();
      else if (gone === "failed") flow.failed("the page's renderer is gone (crashed)");
      else {
        closeWindow();
        flow.closed();
        flow.appPage();
      }
      flow.drawn("model");
      expect([gone, values("cursor")]).toEqual([gone, [true, false]]);
      const moves = values("setBounds").length;
      flow.drag({ phase: "move", x: 1000, y: 300 });
      expect([gone, values("setBounds").length]).toEqual([gone, moves]);
      flow.follow(true);
      expect([gone, values("cursor")]).toEqual([gone, [true, false, true]]);
    }
  });

  test("never in background mode", () => {
    const { flow, names } = shownCompanion({}, { background: true });
    flow.follow(true);
    expect(names()).not.toContain("cursor");
  });
});

describe("the main window's throttling", () => {
  test("off only while she shows and a call of hers is up; a new main window sets it afresh", () => {
    const { flow, values, lines } = companion({ on: true });
    flow.appPage();
    flow.feeding(true);
    expect(values("throttle")).toEqual([]);
    flow.drawn("model");
    expect(values("throttle")).toEqual([false]);
    expect(lines.at(-1)).toBe(COMPANION_LINES.unthrottled);
    flow.feeding(false);
    expect(values("throttle")).toEqual([false, true]);
    expect(lines.at(-1)).toBe(COMPANION_LINES.throttled);
    flow.mainWindowMade();
    expect(values("throttle")).toEqual([false, true, true]);
    flow.feeding(true);
    expect(values("throttle")).toEqual([false, true, true, false]);
    // A new window's page has no call yet.
    flow.mainWindowMade();
    expect(values("throttle")).toEqual([false, true, true, false, true]);
    expect(lines.at(-1)).toBe(COMPANION_LINES.throttled);
  });

  test("back on when she hides", () => {
    const { flow, values } = shownCompanion();
    flow.feeding(true);
    flow.shellPage();
    expect(values("throttle")).toEqual([false, true]);
  });
});

describe("her menu", () => {
  const idle: CompanionMenuState = {
    call: "idle",
    live: false,
    micOn: true,
    models: [{ id: "milky", name: "奶绿" }],
    model: "milky",
    outfits: [],
    outfit: null,
  };
  const up: CompanionMenuState = { ...idle, call: "up", live: true };

  /** Opens her menu, the popup clicking `label`, and waits for her answer. */
  async function choose(fake: Fake, state: CompanionMenuState, label: string | null) {
    fake.click(label);
    const answer = fake.flow.menu(state);
    await new Promise((settle) => setTimeout(settle, 0));
    fake.fire(MENU_SETTLE_MS);
    return answer;
  }

  test("Hide turns her off", async () => {
    const fake = shownCompanion();
    expect(await choose(fake, idle, "Hide")).toBe("hide");
    expect(fake.flow.on).toBe(false);
    expect(fake.names()).toContain("close");
  });

  test("Large saves her size and grows her window from her feet", async () => {
    const feet = { x: 700, y: 900 };
    const fake = shownCompanion({ feet });
    fake.reset();
    expect(await choose(fake, idle, "Large")).toBe("size:large");
    const large = companionSize("large", { kind: "model", aspect: DEFAULT_ASPECT }, LAPTOP);
    expect(large.height).toBe(640);
    expect(fake.calls).toEqual([
      ["popup"],
      ["save", { ...DEFAULT_COMPANION, on: true, feet, size: "large" }],
      ["setBounds", { x: Math.round(feet.x - large.width / 2), y: 900 - 640, ...large }],
    ]);
  });

  test("Always on Top turns floating off, and saves it", async () => {
    const fake = shownCompanion();
    fake.reset();
    expect(await choose(fake, idle, "Always on Top")).toBe("always-on-top");
    expect(fake.calls).toEqual([
      ["popup"],
      ["save", { ...DEFAULT_COMPANION, on: true, alwaysOnTop: false }],
      ["setAlwaysOnTop", false],
    ]);
  });

  test("Call while /call can't call opens it in the window, and hands the page no pick", async () => {
    const fake = shownCompanion();
    fake.reset();
    expect(await choose(fake, { ...idle, call: "open" }, "Call")).toBe("call");
    expect(fake.calls).toEqual([["popup"], ["openMain"], ["command", "call"]]);
  });

  test("Call while /call can call brings the window forward, then hands its page the pick", async () => {
    const fake = shownCompanion();
    fake.reset();
    expect(await choose(fake, idle, "Call")).toBe("call");
    expect(fake.calls).toEqual([["popup"], ["openMain"], ["pick", "call"]]);
  });

  test("Hang Up and Mute go to the call's page alone, bringing nothing forward", async () => {
    const fake = shownCompanion();
    fake.reset();
    expect(await choose(fake, up, "Hang Up")).toBe("hang-up");
    expect(await choose(fake, up, "Mute Microphone")).toBe("mute");
    expect(await choose(fake, { ...up, micOn: false }, "Unmute Microphone")).toBe("unmute");
    expect(fake.calls).toEqual([
      ["popup"],
      ["pick", "hang-up"],
      ["popup"],
      ["pick", "mute"],
      ["popup"],
      ["pick", "unmute"],
    ]);
  });

  test("Open Eidolon brings the window forward; a model or an outfit is the page's", async () => {
    const fake = shownCompanion();
    fake.reset();
    expect(await choose(fake, idle, "Open Eidolon")).toBe("open");
    expect(await choose(fake, idle, "奶绿")).toBe("model:milky");
    expect(fake.calls).toEqual([["popup"], ["openMain"], ["popup"]]);
  });

  test("a second menu while one is open answers null at once, and one closed with no pick answers null", async () => {
    const fake = shownCompanion();
    fake.click("Hide");
    const first = fake.flow.menu(idle);
    expect(await fake.flow.menu(idle)).toBeNull();
    await new Promise((settle) => setTimeout(settle, 0));
    fake.fire(MENU_SETTLE_MS);
    expect(await first).toBe("hide");
    const again = shownCompanion();
    again.reset();
    expect(await choose(again, idle, null)).toBeNull();
    expect(again.calls).toEqual([["popup"]]);
  });

  test("a click that comes after the menu's close still counts, within the settle", async () => {
    const fake = shownCompanion();
    fake.click(null);
    const answer = fake.flow.menu(idle);
    // The popup has closed with no click; the click arrives before the settle ends.
    await new Promise((settle) => setTimeout(settle, 0));
    fake.clickLate("Hide");
    fake.fire(MENU_SETTLE_MS);
    expect(await answer).toBe("hide");
    expect(fake.flow.on).toBe(false);
  });
});

describe("Pop Out", () => {
  test("turns her on, and hides the window once she is drawn", () => {
    const { flow, names, lines } = companion();
    flow.appPage();
    expect(flow.popOut()).toEqual({ on: true, showAtLogin: true, background: false });
    expect(names()).not.toContain("hideMain");
    flow.drawn("model");
    expect(names().slice(-2)).toEqual(["show", "hideMain"]);
    expect(lines.at(-1)).toBe(COMPANION_LINES.poppedOut);
  });

  test("leaves the window when she draws nothing within 10 s", () => {
    const { flow, names, lines, fire } = companion();
    flow.appPage();
    flow.popOut();
    fire(POP_TIMEOUT_MS);
    expect(lines.at(-1)).toBe(`warn: ${COMPANION_LINES.popLate}`);
    flow.drawn("model");
    expect(names()).not.toContain("hideMain");
  });

  test("while she shows, hides the window at once", () => {
    const { flow, names, lines, reset } = shownCompanion();
    reset();
    flow.popOut();
    expect(names()).toEqual(["hideMain"]);
    expect(lines).toEqual([COMPANION_LINES.poppedOut]);
  });

  test("hides the window in background mode too, where only main's record moves", () => {
    const { flow, names } = companion({}, { background: true });
    flow.appPage();
    flow.popOut();
    flow.drawn("picture");
    expect(names()).toContain("hideMain");
    expect(names()).not.toContain("show");
  });
});

describe("failures", () => {
  test("a failed page loads once more after 2 s; a second failure before she draws opens nothing more", () => {
    const { flow, lines, fire, values } = companion({ on: true });
    flow.appPage();
    const detail = "ERR_CONNECTION_REFUSED (-102) loading eidolon-app://app/companion";
    flow.failed(detail);
    expect(lines).toEqual([`warn: ${COMPANION_LINES.failed(detail)}`]);
    expect(values("open")).toHaveLength(1);
    fire(RETRY_MS);
    expect(lines.at(-1)).toBe(COMPANION_LINES.again);
    expect(values("open")).toHaveLength(2);
    flow.failed(detail);
    fire(RETRY_MS);
    expect(values("open")).toHaveLength(2);
    // Drawn again, a later failure has its retry.
    flow.drawn("model");
    flow.failed(detail);
    fire(RETRY_MS);
    expect(values("open")).toHaveLength(3);
  });

  test("a retry waiting when she is turned off never opens her", () => {
    const { flow, fire, values } = companion({ on: true });
    flow.appPage();
    flow.failed("the preload failed: x");
    flow.setOn(false);
    fire(RETRY_MS);
    expect(values("open")).toHaveLength(1);
  });

  test("a failure hides her", () => {
    const { flow, calls } = shownCompanion();
    flow.failed("the page's renderer is gone (crashed)");
    expect(calls.at(-1)).toEqual(["hide"]);
  });
});

describe("the quit", () => {
  test("closes her, and nothing makes her again", () => {
    const { flow, names, values } = shownCompanion();
    flow.quit();
    expect(names().slice(-2)).toEqual(["close", "hide"]);
    flow.appPage();
    flow.popOut();
    flow.setOn(false);
    flow.setOn(true);
    expect(values("open")).toHaveLength(1);
  });

  test("with her off, a later turn-on opens nothing", () => {
    const { flow, values } = companion();
    flow.appPage();
    flow.quit();
    flow.setOn(true);
    flow.appPage();
    expect(values("open")).toEqual([]);
  });
});

describe("CompanionLink", () => {
  test("pairs once both pages have asked, again at each ask, and with a page that went only once it asks again", () => {
    let pairs = 0;
    const link = new CompanionLink(() => {
      pairs++;
    });
    link.appAsks();
    expect(pairs).toBe(0);
    link.companionAsks();
    expect(pairs).toBe(1);
    // A reload, or StrictMode's second mount, asks again: both get a fresh pair.
    link.companionAsks();
    expect(pairs).toBe(2);
    link.appAsks();
    expect(pairs).toBe(3);
    link.appGone();
    link.companionAsks();
    expect(pairs).toBe(3);
    link.appAsks();
    expect(pairs).toBe(4);
    link.companionGone();
    link.appAsks();
    expect(pairs).toBe(4);
  });
});

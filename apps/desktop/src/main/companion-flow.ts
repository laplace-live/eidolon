// When the desktop companion is made, loaded, shown and closed, where her window goes, what her
// menu does, and when the main window keeps drawing for her; and the port between the two windows'
// pages. Electron-free: index.ts drives it, companion-window.ts carries it out.
import type { MenuItemConstructorOptions } from "electron";
import {
  type CompanionCallPick,
  type CompanionChange,
  type CompanionDrag,
  type CompanionDrawn,
  type CompanionMenuState,
  type CompanionPick,
  type CompanionShape,
  type CompanionState,
  type DesktopCommand,
  isCompanionSize,
  type WindowSize,
} from "../shared/bridge.ts";
import {
  areaAt,
  COMPANION_LINES,
  type CompanionSettings,
  companionLine,
  companionSize,
  DEFAULT_ASPECT,
  DRAW_TIMEOUT_MS,
  dragged,
  feetOf,
  MENU_SETTLE_MS,
  POP_TIMEOUT_MS,
  type Point,
  placement,
  RETRY_MS,
  settled,
  standing,
} from "./companion.ts";
import { companionMenu } from "./menus.ts";
import type { Strings } from "./strings.ts";
import type { Rectangle } from "./window-options.ts";

export interface CompanionIo {
  /** Makes her window, hidden, at `bounds` when there is none, then loads COMPANION_PAGE; with one, loads it again. */
  open(bounds: Rectangle): void;
  /** Closes her window, when there is one. */
  close(): void;
  /** showInactive(), or hide(). Never called in background mode. */
  show(): void;
  hide(): void;
  /** Her window's bounds; null with none. */
  bounds(): Rectangle | null;
  setBounds(bounds: Rectangle): void;
  /** setAlwaysOnTop(on, "floating"). Never called in background mode. */
  setAlwaysOnTop(on: boolean): void;
  /** setIgnoreMouseEvents(pass, pass && forwards ? {forward: true} : undefined), `forwards` from companionWindowSetup. */
  passClicks(pass: boolean): void;
  /** The cursor poll that feeds her eyes. Never on in background mode. */
  cursor(on: boolean): void;
  /** The main window's setBackgroundThrottling(allowed). */
  throttle(allowed: boolean): void;
  /** The displays' work areas, the primary's first (window-options.ts's workAreas). */
  areas(): readonly Rectangle[];
  /** The displays' bounds: her feet on none of them send her to her first place. */
  displays(): readonly Rectangle[];
  save(settings: CompanionSettings): void;
  /** Pops `items` up over her window, at the cursor; resolves once the menu has closed. */
  popup(items: readonly MenuItemConstructorOptions[]): Promise<void>;
  /** Rebuilds the application menu and the tray's, whose Desktop Companion item follows her. */
  menus(): void;
  /** index.ts's openWindow: the main window forward, the held update check released. */
  openMain(): void;
  /** window.ts's hideWindow. */
  hideMain(): void;
  /** PageCommands.send. */
  command(command: DesktopCommand): void;
  /**
   * chrome.ts's sendCompanionPick: a pick from her menu the app page's call acts on. Sent now, never
   * held: one no app page listens for is dropped, so it never places a call on a page loaded later.
   */
  pick(pick: CompanionCallPick): void;
  /** Runs `run` once after `ms`; the function it returns cancels it. */
  after(ms: number, run: () => void): () => void;
  readonly log: { info(line: string): void; warn(line: string): void };
}

export interface CompanionFlowOptions {
  readonly settings: CompanionSettings;
  readonly background: boolean;
  readonly platform: NodeJS.Platform;
  /** This launch is the login item's. */
  readonly atLogin: boolean;
  readonly strings: () => Strings;
}

export class Companion {
  readonly #io: CompanionIo;
  readonly #background: boolean;
  readonly #platform: NodeJS.Platform;
  readonly #atLogin: boolean;
  readonly #strings: () => Strings;
  #settings: CompanionSettings;
  /** The main window shows the app's page. */
  #app = false;
  #page: "none" | "loading" | "drawn" = "none";
  #shape: CompanionShape = { kind: "model", aspect: DEFAULT_ASPECT };
  /**
   * Where she stands while her window is there, unrounded: read back from a window's whole-DIP
   * bounds, her feet would move half a DIP at each reshape between an odd and an even width.
   */
  #feet: Point | null = null;
  /** Main's record of her showing. */
  #shown = false;
  /** The main window shows now, as mainShown last said. */
  #mainShows = false;
  /** The main window has shown this run. */
  #mainOpened = false;
  #following = false;
  /** A call she is on is up in the main window. */
  #feeding = false;
  /** What io.throttle was last given. */
  #throttled = true;
  /** What io.cursor was last given. */
  #cursor = false;
  /** A drag under way: her window and the pointer as it started, or as main last placed her in it. */
  #dragStart: { readonly window: Rectangle; readonly pointer: Point } | null = null;
  /** The pointer at the drag's last step. */
  #dragAt: Point = { x: 0, y: 0 };
  #menuOpen = false;
  #quitting = false;
  /** A failure's one retry has run since she was last drawn. */
  #retried = false;
  #drawTimer: (() => void) | null = null;
  /** Set while a Pop Out waits for her to show. */
  #popTimer: (() => void) | null = null;
  #retryTimer: (() => void) | null = null;

  constructor(io: CompanionIo, options: CompanionFlowOptions) {
    this.#io = io;
    this.#settings = options.settings;
    this.#background = options.background;
    this.#platform = options.platform;
    this.#atLogin = options.atLogin;
    this.#strings = options.strings;
  }

  /** For Settings. */
  state(): CompanionState {
    const { on, showAtLogin } = this.#settings;
    return { on, showAtLogin, background: this.#background };
  }

  get on(): boolean {
    return this.#settings.on;
  }

  /** The main window shows the app's page: loaded, or loaded again for another server. */
  appPage(): void {
    this.#app = true;
    if (this.#settings.on) this.#open();
    this.#sync();
  }

  /** The main window shows a shell page: the loading page or the failure page. */
  shellPage(): void {
    this.#app = false;
    this.#sync();
  }

  change(change: CompanionChange): CompanionState {
    const { showAtLogin } = change;
    if (showAtLogin !== undefined && showAtLogin !== this.#settings.showAtLogin) {
      this.#save({ showAtLogin });
    }
    if (change.on !== undefined) this.setOn(change.on);
    this.#sync();
    return this.state();
  }

  setOn(on: boolean): void {
    if (on === this.#settings.on) return;
    this.#save({ on });
    this.#io.log.info(on ? COMPANION_LINES.on : COMPANION_LINES.off);
    this.#io.menus();
    if (on) {
      if (this.#app) this.#open();
    } else {
      // A call she carried goes on in a window that doesn't show, as after Pop Out.
      if (this.#feeding && !this.#mainShows) this.#io.openMain();
      this.#cancelTimers();
      this.#io.close();
      this.#page = "none";
      this.#following = false;
      this.#dragStart = null;
    }
    this.#sync();
  }

  drawn(kind: CompanionDrawn | null): void {
    if (this.#page === "none") return;
    if (kind === null) {
      this.#page = "loading";
      this.#io.passClicks(true);
    } else {
      const before = this.#page;
      this.#page = "drawn";
      this.#retried = false;
      this.#cancelDrawTimer();
      if (before !== "drawn") this.#io.log.info(COMPANION_LINES.drawn(kind));
    }
    this.#sync();
  }

  shape(shape: CompanionShape): WindowSize {
    this.#shape = shape;
    const { size, bounds } = this.#placed();
    this.#setBounds(bounds);
    this.#sync();
    return size;
  }

  hit(over: boolean): void {
    if (this.#io.bounds() !== null) this.#io.passClicks(!over);
  }

  drag(drag: CompanionDrag): void {
    const pointer = { x: drag.x, y: drag.y };
    if (drag.phase === "start") {
      const window = this.#io.bounds();
      if (window !== null) this.#dragStart = { window, pointer };
      this.#dragAt = pointer;
    } else if (this.#dragStart !== null) {
      this.#dragAt = pointer;
      const areas = this.#io.areas();
      const moved = dragged(this.#dragStart, pointer, areas);
      if (drag.phase === "move") {
        this.#io.setBounds(moved);
        // She stands where the drag has her, should she be reshaped before the drop.
        this.#feet = feetOf(moved);
      } else {
        const dropped = settled(moved, areas);
        this.#io.setBounds(dropped);
        this.#dragStart = null;
        this.#feet = feetOf(dropped);
        this.#save({ feet: this.#feet });
      }
    }
    this.#sync();
  }

  follow(on: boolean): void {
    this.#following = on;
    this.#sync();
  }

  async menu(state: CompanionMenuState): Promise<CompanionPick | null> {
    if (this.#menuOpen) return null;
    this.#menuOpen = true;
    let picked = null as CompanionPick | null;
    try {
      const own = { size: this.#settings.size, alwaysOnTop: this.#settings.alwaysOnTop };
      const items = companionMenu(this.#strings(), state, own, this.#platform, (pick) => {
        picked = pick;
      });
      await this.#io.popup(items);
      await new Promise<void>((settle) => this.#io.after(MENU_SETTLE_MS, settle));
    } finally {
      this.#menuOpen = false;
    }
    this.#act(picked, state);
    return picked;
  }

  /** A call she is on is up in the main window. */
  feeding(on: boolean): void {
    this.#feeding = on;
    this.#sync();
  }

  /** The main window's showing, as window.ts keeps it. */
  mainShown(shows: boolean): void {
    this.#mainShows = shows;
    if (shows) this.#mainOpened = true;
    this.#sync();
  }

  /** A main window was made: throttling is set on its webContents afresh. */
  mainWindowMade(): void {
    this.#feeding = false;
    const allowed = !(this.#shown && this.#feeding);
    this.#io.throttle(allowed);
    if (allowed !== this.#throttled) {
      this.#io.log.info(allowed ? COMPANION_LINES.throttled : COMPANION_LINES.unthrottled);
    }
    this.#throttled = allowed;
    this.#sync();
  }

  displaysChanged(): void {
    const before = this.#io.bounds();
    if (before === null) return;
    const { bounds } = this.#placed();
    this.#setBounds(bounds);
    // A display that went, or a Dock that grew under her, moved her: she stands there now.
    if (bounds.x !== before.x || bounds.y !== before.y) this.#feet = feetOf(bounds);
  }

  popOut(): CompanionState {
    this.setOn(true);
    this.#cancelPopTimer();
    if (this.#shown) {
      this.#io.hideMain();
      this.#io.log.info(COMPANION_LINES.poppedOut);
    } else {
      this.#popTimer = this.#io.after(POP_TIMEOUT_MS, () => {
        this.#popTimer = null;
        this.#io.log.warn(COMPANION_LINES.popLate);
      });
    }
    return this.state();
  }

  /** Her page failed: a load, the preload, or the renderer gone. */
  failed(detail: string): void {
    this.#io.log.warn(COMPANION_LINES.failed(detail));
    this.#page = "loading";
    this.#following = false;
    this.#dragStart = null;
    if (!this.#retried && this.#settings.on && this.#app) {
      this.#retried = true;
      this.#retryTimer = this.#io.after(RETRY_MS, () => {
        this.#retryTimer = null;
        if (!this.#settings.on || !this.#app) return;
        this.#io.log.info(COMPANION_LINES.again);
        this.#open();
        this.#sync();
      });
    }
    this.#sync();
  }

  /** Her window committed a new document (did-navigate), main's load or her guard's. */
  pageReplaced(): void {
    if (this.#io.bounds() === null) return;
    // She hides until the new document says she's drawn, and it starts with the pointer off her.
    this.#page = "loading";
    this.#io.passClicks(true);
    this.#following = false;
    this.#dragStart = null;
    this.#sync();
  }

  /** Her window closed by something other than this flow, as quitAndInstall closes every window. */
  closed(): void {
    this.#page = "none";
    this.#following = false;
    this.#dragStart = null;
    this.#cancelDrawTimer();
    this.#sync();
  }

  /** The quit is approved: she goes, and nothing makes her again. */
  quit(): void {
    this.#quitting = true;
    this.#cancelTimers();
    this.#io.close();
    this.#page = "none";
    this.#sync();
  }

  #open(): void {
    if (this.#quitting) return;
    this.#page = "loading";
    // A new window stands where her settings left her; one loaded again keeps her place.
    if (this.#io.bounds() === null) this.#feet = null;
    this.#io.open(this.#placed().bounds);
    this.#io.passClicks(true);
    if (!this.#background) this.#io.setAlwaysOnTop(this.#settings.alwaysOnTop);
    this.#cancelDrawTimer();
    this.#drawTimer = this.#io.after(DRAW_TIMEOUT_MS, () => {
      this.#drawTimer = null;
      this.#io.log.warn(COMPANION_LINES.late);
    });
  }

  /** Her window's size and bounds as her settings and shape have them, standing where she stood. */
  #placed(): { readonly size: WindowSize; readonly bounds: Rectangle } {
    const areas = this.#io.areas();
    const displays = this.#io.displays();
    const feet = this.#feet ?? this.#settings.feet;
    const area = feet === null ? areas[0] : areaAt(feet, areas);
    const size = companionSize(this.#settings.size, this.#shape, area);
    this.#feet = standing(feet, size, areas, displays);
    return { size, bounds: placement(this.#feet, size, areas, displays) };
  }

  /** Places her window; a drag under way goes on from there, at its size. */
  #setBounds(bounds: Rectangle): void {
    this.#io.setBounds(bounds);
    if (this.#dragStart !== null) this.#dragStart = { window: bounds, pointer: this.#dragAt };
  }

  #act(pick: CompanionPick | null, state: CompanionMenuState): void {
    switch (pick) {
      case null:
        return;
      case "open":
        this.#io.openMain();
        return;
      case "call":
        // The call's notices live in the main window, so a call never starts where nobody sees it.
        this.#io.openMain();
        if (state.call === "idle") this.#io.pick("call");
        else this.#io.command("call");
        return;
      case "hang-up":
      case "mute":
      case "unmute":
        this.#io.pick(pick);
        return;
      case "always-on-top": {
        const alwaysOnTop = !this.#settings.alwaysOnTop;
        this.#save({ alwaysOnTop });
        if (!this.#background) this.#io.setAlwaysOnTop(alwaysOnTop);
        return;
      }
      case "hide":
        this.setOn(false);
        return;
    }
    const size = pick.startsWith("size:") ? pick.slice("size:".length) : null;
    if (isCompanionSize(size)) {
      this.#save({ size });
      this.shape(this.#shape);
    }
    // A model or an outfit is the page's to apply.
  }

  #save(change: Partial<CompanionSettings>): void {
    this.#settings = { ...this.#settings, ...change };
    this.#io.save(this.#settings);
  }

  /** Moves main's record of her showing, and what follows from it, to what the state says. */
  #sync(): void {
    const { on, showAtLogin } = this.#settings;
    const shown =
      on &&
      this.#app &&
      this.#page === "drawn" &&
      !this.#quitting &&
      (!this.#atLogin || showAtLogin || this.#mainOpened);
    if (shown !== this.#shown) {
      this.#shown = shown;
      this.#io.log.info(companionLine(shown, this.#background));
      if (!this.#background) {
        if (shown) this.#io.show();
        else this.#io.hide();
      }
    }
    const cursor = !this.#background && shown && this.#following && this.#dragStart === null;
    if (cursor !== this.#cursor) {
      this.#cursor = cursor;
      this.#io.cursor(cursor);
    }
    const allowed = !(shown && this.#feeding);
    if (allowed !== this.#throttled) {
      this.#throttled = allowed;
      this.#io.throttle(allowed);
      this.#io.log.info(allowed ? COMPANION_LINES.throttled : COMPANION_LINES.unthrottled);
    }
    if (this.#popTimer !== null && shown) {
      this.#cancelPopTimer();
      this.#io.hideMain();
      this.#io.log.info(COMPANION_LINES.poppedOut);
    }
  }

  #cancelDrawTimer(): void {
    this.#drawTimer?.();
    this.#drawTimer = null;
  }

  #cancelPopTimer(): void {
    this.#popTimer?.();
    this.#popTimer = null;
  }

  #cancelTimers(): void {
    this.#cancelDrawTimer();
    this.#cancelPopTimer();
    this.#retryTimer?.();
    this.#retryTimer = null;
  }
}

/** The port between the two windows' pages: each asks for one, and main pairs them once both have. */
export class CompanionLink {
  readonly #pair: () => void;
  #app = false;
  #companion = false;

  constructor(pair: () => void) {
    this.#pair = pair;
  }

  /** The app page asked (link-companion): pairs when the companion's page has asked too. */
  appAsks(): void {
    this.#app = true;
    if (this.#companion) this.#pair();
  }

  /** The companion's page asked (link-app): pairs when the app page has asked too. */
  companionAsks(): void {
    this.#companion = true;
    if (this.#app) this.#pair();
  }

  /** The app page's document went (did-navigate in the main window, or its window closed). */
  appGone(): void {
    this.#app = false;
  }

  /** Her page's document went (did-navigate in her window, or her window closed). */
  companionGone(): void {
    this.#companion = false;
  }
}

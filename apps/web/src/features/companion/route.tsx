// The desktop companion's page: the active persona's model, or her picture, alone in a transparent
// window of the desktop app, which main shows once she is drawn. Her mood and mouth come from the
// main window over the port; her pointer, drag and menu go to main. In a browser it renders nothing.
import type { AvatarStage, Bounds, Box } from "@laplace.live/eidolon-sdk/avatar";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { type RefObject, useEffect, useRef, useState } from "react";
import { PersonaAvatar } from "@/components/avatar";
import { avatarChanged, avatarsResetForHost } from "@/components/avatar/version";
import { MouthTap } from "@/features/call/signals";
import { subspaceQuery } from "@/features/subspace/queries";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import {
  asApiError,
  type CharacterModel,
  type CharacterModels,
  call,
  type Status,
  setExpectedSubspaceHost,
} from "@/lib/api";
import { characterModelFileQuery, characterModelsQuery } from "@/lib/character-models";
import {
  type CompanionCursor,
  type CompanionMenuState,
  companion,
  type EidolonCompanion,
  onCompanionPort,
  type WindowSize,
} from "@/lib/desktop";
import { statusQuery } from "@/lib/query";
import { COMPANION_TICK_MS, CompanionDirector, type TapArea } from "./director";
import { CURSOR_REST_MS, eyePoint, gazeToward, nearHead } from "./gaze";
import { handshake, SIZE_WAIT_MS } from "./handshake";
import {
  type MenuTarget,
  menuState,
  menuTarget,
  type PageAction,
  pageAction,
  pickHolds,
} from "./menu";
import { PortMouth, VoiceTimeline } from "./mouths";
import { PagePort } from "./page-port";
import { HeardPictures } from "./pictures";
import { HoverProbe, onPicture, Press, tapArea } from "./pointer";
import {
  appearanceStamp,
  type CompanionCall,
  NO_COMPANION_CALL,
  type ToCompanion,
} from "./protocol";
import { type CompanionView, useCompanionStage } from "./use-companion-stage";
import { voiceOpeningsOf } from "./voice-file";

/** How long her menu waits on reading her models again before it opens with the list she has. */
const MENU_READ_MS = 250;

export function Component() {
  const bridge = companion();
  if (bridge === null) return null;
  return <CompanionPage bridge={bridge} />;
}

/** What the page renders now, for what runs between renders. */
interface Live {
  readonly view: CompanionView;
  readonly stage: AvatarStage | null;
  readonly box: Box | null;
  readonly head: Bounds | null;
  readonly frames: () => number;
  readonly persona: Status["persona"] | undefined;
  readonly model: CharacterModel | null;
  readonly models: CharacterModels | undefined;
  readonly reducedMotion: boolean;
}

type VoiceFact = Extract<ToCompanion, { type: "voice" }>;

/** Resolves once the window is `size`, or after SIZE_WAIT_MS. */
function windowSized(size: WindowSize): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      removeEventListener("resize", check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (innerWidth === size.width && innerHeight === size.height) done();
    };
    const timer = setTimeout(done, SIZE_WAIT_MS);
    addEventListener("resize", check);
    check();
  });
}

/** Two animation frames: her picture painted. */
function painted(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** One frame of her model drawn: alphaAt answers after the next draw, and at once if she failed. */
async function drawnFrame(stage: AvatarStage | null): Promise<void> {
  if (stage === null) throw new Error("no stage");
  await stage.alphaAt(0, 0);
  if (stage.model === null) throw new Error("her model stopped drawing");
}

/**
 * Everything her page does between renders: her direction and mouth, the pointer over her, her
 * menu, the port, and the tick that writes her root's data attributes. One per page.
 */
class Control {
  readonly director = new CompanionDirector(performance.now());
  readonly portMouth = new PortMouth();
  readonly timeline = new VoiceTimeline();
  readonly tap = new MouthTap();
  readonly probe: HoverProbe;
  readonly port: PagePort;
  #live: Live = {
    view: "loading",
    stage: null,
    box: null,
    head: null,
    frames: () => 0,
    persona: undefined,
    model: null,
    models: undefined,
    reducedMotion: false,
  };
  readonly #bridge: EidolonCompanion;
  readonly #queryClient: QueryClient;
  readonly #root: RefObject<HTMLDivElement | null>;
  readonly #pictures = new HeardPictures();
  #call: CompanionCall = NO_COMPANION_CALL;
  #press: Press | null = null;
  /** The last point a drag was sent at, where a cancelled one ends. */
  #dragAt: { readonly x: number; readonly y: number } | null = null;
  #menuOpen = false;
  /** Whether her window takes clicks, as main was last told. */
  #hit = false;
  /** Whether she follows the cursor, as main was last told. */
  #following = false;
  #moves = 0;
  #cursor: (CompanionCursor & { readonly at: number }) | null = null;
  /** The voice message the timeline holds, and its latest ask. */
  #voiceFile: string | null = null;
  #asks = 0;

  constructor(
    bridge: EidolonCompanion,
    queryClient: QueryClient,
    root: RefObject<HTMLDivElement | null>,
  ) {
    this.#bridge = bridge;
    this.#queryClient = queryClient;
    this.#root = root;
    this.probe = new HoverProbe(
      (x, y) => this.#alphaAt(x, y),
      (over) => {
        if (!this.#held()) this.#tell(over);
      },
    );
    this.port = new PagePort({
      message: (message) => this.#message(message),
      linked: (on) => this.#linked(on),
    });
  }

  /**
   * What the page rendered: a stage made anew plays no gesture made before it, and another active
   * persona starts her direction over.
   */
  rendered(live: Live): void {
    const before = this.#live;
    this.#live = live;
    if (live.stage !== before.stage) this.director.newStage();
    const persona = live.persona?.id;
    if (before.persona !== undefined && persona !== undefined && persona !== before.persona.id) {
      this.director.newPersona(performance.now());
    }
  }

  tick(): void {
    const at = performance.now();
    const { director } = this;
    const live = this.#live;
    director.tick(at);
    const direction = director.direction(at);
    live.stage?.direct(direction);

    const following =
      director.follows(at) && !live.reducedMotion && !this.#held() && live.view === "model";
    if (following !== this.#following) {
      this.#following = following;
      this.#bridge.follow(following);
    }
    const eye =
      live.box === null
        ? { x: innerWidth / 2, y: innerHeight / 2 }
        : eyePoint(live.head, live.box, { width: innerWidth, height: innerHeight });
    const cursor = this.#cursor;
    const toCursor = following && cursor !== null && at - cursor.at < CURSOR_REST_MS;
    live.stage?.gaze(toCursor ? gazeToward(cursor, eye) : "direction");

    const call = this.#call;
    this.tap.source =
      call.hers && call.live ? this.portMouth : director.voicing !== null ? this.timeline : null;

    const root = this.#root.current;
    if (root === null) return;
    const data = root.dataset;
    data.view = live.view;
    data.persona = live.persona?.id ?? "";
    data.mood = direction.mood.join(" ");
    data.pulse = direction.pulse ?? "";
    data.speaking = String(direction.speaking);
    data.mouth = this.tap.take().toFixed(2);
    data.frames = String(live.frames());
    data.hit = String(this.#hit);
    data.moves = String(this.#moves);
    data.dragging = String(this.#press?.dragging ?? false);
    data.dozing = String(director.dozing(at));
    data.follow = String(following);
    data.gaze = toCursor ? "cursor" : "direction";
    data.call = this.#menu().call;
    data.linked = String(this.port.linked);
    data.probe = live.view === "loading" ? "" : `${Math.round(eye.x)},${Math.round(eye.y)}`;
  }

  cursorAt(cursor: CompanionCursor): void {
    this.#cursor = { x: cursor.x, y: cursor.y, at: performance.now() };
  }

  mouseMove(event: MouseEvent): void {
    this.#moves += 1;
    this.probe.move(event.clientX, event.clientY);
  }

  pointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !this.probe.over || this.#held()) return;
    this.#root.current?.setPointerCapture(event.pointerId);
    this.#press = new Press(event.screenX, event.screenY);
  }

  pointerMove(event: PointerEvent): void {
    const press = this.#press;
    if (press === null) return;
    const step = press.move(event.screenX, event.screenY);
    if (step === "none") return;
    if (step === "drag-start") {
      // From where she was grabbed, so her window follows the pointer, the slop's travel included.
      this.#bridge.drag({ phase: "start", ...press.start });
      this.director.pickUp(performance.now());
      this.#mark("dragging", true);
    }
    this.#dragAt = { x: event.screenX, y: event.screenY };
    this.#bridge.drag({ phase: "move", ...this.#dragAt });
  }

  pointerUp(event: PointerEvent): void {
    const press = this.#press;
    if (press === null || event.button !== 0) return;
    this.#press = null;
    if (press.end() === "drag-end") {
      this.#bridge.drag({ phase: "end", x: event.screenX, y: event.screenY });
      this.#mark("dragging", false);
    } else if (this.#live.view === "model") {
      this.director.tap(this.#tapArea(event), performance.now());
    } else {
      this.director.touch(performance.now());
    }
    this.#release();
  }

  pointerCancel(): void {
    const press = this.#press;
    if (press === null) return;
    this.#press = null;
    if (press.dragging && this.#dragAt !== null) {
      this.#bridge.drag({ phase: "end", ...this.#dragAt });
      this.#mark("dragging", false);
    }
    this.#release();
  }

  contextMenu(event: MouseEvent): void {
    event.preventDefault();
    if (!this.probe.over || this.#held()) return;
    this.director.touch(performance.now());
    this.#menuOpen = true;
    this.#tell(true);
    let listed: MenuTarget | null = null;
    void this.#listedModels()
      .then((models) => {
        listed = menuTarget(this.#live.persona?.id, models);
        return this.#bridge.menu(this.#menu(models));
      })
      .catch(() => null)
      .then((pick) => {
        this.#menuOpen = false;
        // Main resized her under a still pointer.
        if (pick?.startsWith("size:")) this.probe.leave();
        this.#release();
        const action = pageAction(pick);
        if (action !== null && listed !== null && pickHolds(listed, this.#target(), action)) {
          void this.#act(action, listed);
        }
      });
  }

  #target(): MenuTarget {
    return { persona: this.#live.persona?.id, model: this.#live.model?.id };
  }

  /**
   * Her models, read again for her menu: an import makes no model active, so nothing else tells her
   * page of it. A read slower than MENU_READ_MS keeps the list she has.
   */
  async #listedModels(): Promise<CharacterModels | undefined> {
    const persona = this.#live.persona?.id;
    if (persona === undefined) return this.#live.models;
    const read = this.#queryClient
      .query({ ...characterModelsQuery(persona), staleTime: 0 })
      .catch(() => undefined);
    const late = new Promise<undefined>((settle) => setTimeout(settle, MENU_READ_MS));
    return (await Promise.race([read, late])) ?? this.#live.models;
  }

  #held(): boolean {
    return this.#press !== null || this.#menuOpen;
  }

  #tell(over: boolean): void {
    this.#hit = over;
    this.#mark("hit", over);
    this.#bridge.hit(over);
  }

  /** A press or her menu held her window solid: the pointer's state goes to main again. */
  #release(): void {
    if (!this.#held()) this.#tell(this.probe.over);
  }

  /** At once, for the cursor index.css gives her; the tick writes every attribute anyway. */
  #mark(name: "hit" | "dragging", on: boolean): void {
    const root = this.#root.current;
    if (root !== null) root.dataset[name] = String(on);
  }

  #alphaAt(x: number, y: number): Promise<number> {
    const { view, stage } = this.#live;
    if (view === "model" && stage !== null) return stage.alphaAt(x, y);
    if (view === "picture") return Promise.resolve(onPicture(x, y, innerWidth) ? 1 : 0);
    return Promise.resolve(0);
  }

  #tapArea(event: PointerEvent): TapArea {
    const { stage, head, box } = this.#live;
    const model = stage?.model ?? null;
    if (model === null) return "body";
    let hit: string | null = null;
    try {
      hit = model.hitTest(event.clientX, event.clientY);
    } catch {
      // A model that traps is the stage's to report; the tap still lands on her.
    }
    const point = { x: event.clientX, y: event.clientY };
    const near =
      box !== null && nearHead(point, head, box, { width: innerWidth, height: innerHeight });
    return tapArea(hit, model.inventory, near);
  }

  #menu(models = this.#live.models): CompanionMenuState {
    return menuState({ linked: this.port.linked, call: this.#call, models });
  }

  /** A pick of hers, on the persona and model her menu listed. */
  async #act(action: PageAction, { persona, model }: MenuTarget): Promise<void> {
    if (persona === undefined) return;
    try {
      if (action.kind === "model") {
        await call("PUT /api/local/settings", {
          body: { scope: "persona", persona, values: { "appearance.model": action.id } },
        });
      } else if (model !== undefined) {
        await call("PATCH /api/local/personas/:id/models/:model", {
          params: { id: persona, model },
          body: { outfit: action.id },
        });
      } else {
        return;
      }
    } catch (error) {
      console.warn(
        `Eidolon: her menu couldn't change her ${action.kind}: ${asApiError(error).code}`,
      );
      return;
    }
    void this.#queryClient.invalidateQueries({
      queryKey: characterModelsQuery(persona).queryKey,
      exact: true,
    });
    void this.#queryClient.invalidateQueries({ queryKey: statusQuery.queryKey });
    this.port.send({ type: "appearance", persona });
  }

  #message(message: ToCompanion): void {
    const at = performance.now();
    switch (message.type) {
      case "persona": {
        if (this.#pictures.changed(message.id, message.picture)) {
          avatarChanged(message.id);
          // Whether she has a picture at all is status's.
          void this.#queryClient.invalidateQueries({ queryKey: statusQuery.queryKey });
        }
        const persona = this.#live.persona;
        const stamp = persona === undefined ? null : appearanceStamp(persona.appearance.model);
        if (persona?.id === message.id && stamp === message.stamp) return;
        void this.#queryClient.invalidateQueries({ queryKey: statusQuery.queryKey });
        void this.#queryClient.invalidateQueries({
          queryKey: characterModelsQuery(message.id).queryKey,
          exact: true,
        });
        return;
      }
      case "call":
        this.#call = message.call;
        this.director.call(message.call, at);
        return;
      case "direction":
        this.director.callDirection(message.direction);
        return;
      case "mouth":
        this.portMouth.set(message.level);
        return;
      case "said":
        this.director.said(message, at);
        return;
      case "voice":
        this.director.voice(message, message.state === "playing", at);
        this.#voice(message);
        return;
    }
  }

  #voice(fact: VoiceFact): void {
    const file = `${fact.chat}/${fact.file}`;
    if (fact.state !== "playing") {
      if (file === this.#voiceFile) this.timeline.stop();
      return;
    }
    if (file !== this.#voiceFile) {
      this.#voiceFile = file;
      this.timeline.load(null);
      const ask = ++this.#asks;
      void voiceOpeningsOf(fact.chat, fact.file).then((openings) => {
        if (ask === this.#asks) this.timeline.load(openings);
      });
    }
    this.timeline.play(fact.position);
  }

  #linked(on: boolean): void {
    if (on) {
      this.director.joined();
      return;
    }
    const at = performance.now();
    this.#call = NO_COMPANION_CALL;
    this.director.call(NO_COMPANION_CALL, at);
    // A window that reloaded mid-message ends no voice message: none plays there now.
    const voicing = this.director.voicing;
    if (voicing !== null) this.director.voice({ ...voicing, text: "" }, false, at);
    this.timeline.stop();
  }
}

function CompanionPage({ bridge }: { readonly bridge: EidolonCompanion }) {
  const queryClient = useQueryClient();
  const reducedMotion = useReducedMotion();
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const previousHostId = useRef<string | null | undefined>(undefined);
  const [control] = useState(() => new Control(bridge, queryClient, root));

  const subspace = useQuery(subspaceQuery);
  const activeHostId = subspace.data?.activeHostId;
  useEffect(() => {
    if (activeHostId === undefined) return;
    setExpectedSubspaceHost(activeHostId);
    if (previousHostId.current !== undefined && previousHostId.current !== activeHostId) {
      const nonSubspace = (query: { readonly queryKey: readonly unknown[] }) =>
        query.queryKey[0] !== "subspace";
      avatarsResetForHost();
      void (async () => {
        await queryClient.cancelQueries({ predicate: nonSubspace });
        queryClient.removeQueries({ predicate: nonSubspace, type: "inactive" });
        await queryClient.resetQueries({ predicate: nonSubspace });
      })();
    }
    previousHostId.current = activeHostId;
  }, [activeHostId, queryClient]);

  const status = useQuery(statusQuery);
  const persona = status.data?.persona;
  const models = useQuery({
    ...characterModelsQuery(persona?.id ?? ""),
    enabled: persona !== undefined,
  });
  const list = models.data;
  const model = list?.models.find(({ id }) => id === list.active) ?? null;
  const file = useQuery({
    ...characterModelFileQuery(persona?.id ?? "", model?.id ?? "", model?.sha256 ?? ""),
    enabled: persona !== undefined && model !== null,
  });
  // On means on screen: a model that won't come is her picture, and only a status that can't be
  // read keeps her hidden.
  const none =
    (list === undefined ? models.isError : model === null) ||
    (file.data === undefined && file.isError);
  const statusFailed = status.data === undefined && status.isError;

  const stage = useCompanionStage(host, {
    model,
    bytes: file.data,
    none,
    reducedMotion,
    mouth: control.tap,
    loading: () => control.probe.leave(),
  });
  const { view, box, stage: shown } = stage;

  useEffect(() => {
    control.rendered({
      view: stage.view,
      stage: stage.stage,
      box: stage.box,
      head: stage.head,
      frames: stage.frames,
      persona,
      model,
      models: list,
      reducedMotion,
    });
  });

  useEffect(() => {
    if (!statusFailed) return;
    control.probe.leave();
    bridge.drawn(null);
  }, [bridge, control, statusFailed]);

  useEffect(() => {
    if (view === "loading") return;
    const controller = new AbortController();
    void handshake(
      view,
      box,
      {
        shape: (shape) => bridge.shape(shape),
        sized: windowSized,
        hidden: () => document.hidden,
        frame: (drawn) => (drawn === "model" ? drawnFrame(shown) : painted()),
        drawn: (drawn) => bridge.drawn(drawn),
      },
      controller.signal,
    );
    return () => controller.abort();
  }, [bridge, view, box, shown]);

  useEffect(() => {
    const stop = onCompanionPort((port) => control.port.connect(port));
    bridge.link();
    return () => {
      stop();
      control.port.close();
    };
  }, [bridge, control]);

  useEffect(() => {
    // The bridge keeps its callback for the page's life, so a remount's earlier one goes quiet.
    let live = true;
    bridge.onCursor((cursor) => {
      if (live) control.cursorAt(cursor);
    });
    return () => {
      live = false;
    };
  }, [bridge, control]);

  useEffect(() => {
    const element = root.current;
    if (element === null) return;
    const mouseMove = (event: MouseEvent) => control.mouseMove(event);
    const mouseLeave = () => control.probe.leave();
    const pointerDown = (event: PointerEvent) => control.pointerDown(event);
    const pointerMove = (event: PointerEvent) => control.pointerMove(event);
    const pointerUp = (event: PointerEvent) => control.pointerUp(event);
    const pointerCancel = () => control.pointerCancel();
    const contextMenu = (event: MouseEvent) => control.contextMenu(event);
    document.addEventListener("mousemove", mouseMove);
    element.addEventListener("mouseleave", mouseLeave);
    element.addEventListener("pointerdown", pointerDown);
    element.addEventListener("pointermove", pointerMove);
    element.addEventListener("pointerup", pointerUp);
    element.addEventListener("pointercancel", pointerCancel);
    element.addEventListener("contextmenu", contextMenu);
    return () => {
      document.removeEventListener("mousemove", mouseMove);
      element.removeEventListener("mouseleave", mouseLeave);
      element.removeEventListener("pointerdown", pointerDown);
      element.removeEventListener("pointermove", pointerMove);
      element.removeEventListener("pointerup", pointerUp);
      element.removeEventListener("pointercancel", pointerCancel);
      element.removeEventListener("contextmenu", contextMenu);
    };
  }, [control]);

  useEffect(() => {
    control.tick();
    const timer = setInterval(() => control.tick(), COMPANION_TICK_MS);
    return () => clearInterval(timer);
  }, [control]);

  return (
    <div ref={root} data-companion-root="" className="fixed inset-0 select-none">
      <div ref={host} className="absolute inset-0" />
      {view === "picture" && persona !== undefined && (
        <PersonaAvatar
          persona={persona}
          size="xl"
          className="absolute inset-1 size-auto [[data-speaking=true]_&]:ring-4 [[data-speaking=true]_&]:ring-success"
        />
      )}
    </div>
  );
}

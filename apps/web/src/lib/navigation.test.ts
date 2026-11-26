import { describe, expect, test, vi } from "vitest";
import { type BrowserWindow, createBrowserHistory } from "./navigation";

interface Entry {
  readonly href: string;
  state: unknown;
}

function createFakeWindow(initialHref = "http://localhost:7860/", initialState: unknown = null) {
  const entries: Entry[] = [{ href: initialHref, state: initialState }];
  let cursor = 0;
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  let goQueue: Promise<void> = Promise.resolve();

  const currentUrl = () => new URL(entries[cursor]!.href, "http://localhost:7860");
  const emit = (type: string, event: unknown = {}) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  };

  const win: BrowserWindow = {
    location: {
      get href() {
        return currentUrl().href;
      },
      get pathname() {
        return currentUrl().pathname;
      },
      get search() {
        return currentUrl().search;
      },
    },
    history: {
      get state() {
        return entries[cursor]!.state;
      },
      pushState(state, _unused, url) {
        const next = new URL(String(url ?? ""), currentUrl().href).href;
        entries.splice(cursor + 1, entries.length - cursor - 1, { href: next, state });
        cursor += 1;
      },
      replaceState(state, _unused, url) {
        const next =
          url === undefined || url === null
            ? entries[cursor]!.href
            : new URL(String(url), currentUrl().href).href;
        entries[cursor] = { href: next, state };
      },
      go(delta = 0) {
        if (delta === 0) return;
        const next = cursor + delta;
        if (next < 0 || next >= entries.length) return;
        goQueue = goQueue.then(async () => {
          cursor = next;
          emit("popstate");
        });
      },
    },
    addEventListener(type, listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };

  return {
    win,
    entries: () => entries,
    cursor: () => cursor,
    flush: async () => {
      await goQueue;
      await Promise.resolve();
      await goQueue;
    },
  };
}

describe("createBrowserHistory", () => {
  test("stamps idx: 0 at start and resolves relative ?tab= navigations against current path", () => {
    const fake = createFakeWindow("eidolon-app://app/settings");
    const history = createBrowserHistory(fake.win);
    expect(fake.win.history.state).toEqual({ idx: 0 });

    const onNavigate = vi.fn();
    const stop = history.subscribeNavigate(onNavigate);

    history.navigate("?tab=general");
    expect(fake.win.location.pathname).toBe("/settings");
    expect(fake.win.location.search).toBe("?tab=general");
    expect(fake.win.history.state).toEqual({ usr: null, idx: 1 });
    expect(onNavigate).toHaveBeenCalledTimes(1);

    history.navigate("?tab=providers", { replace: true });
    expect(fake.win.location.search).toBe("?tab=providers");
    expect(fake.win.history.state).toEqual({ usr: null, idx: 1 });
    expect(fake.entries()).toHaveLength(2);

    // Same-URL link clicks still notify navigation listeners (e.g. closing the mobile sheet).
    history.navigate("/settings?tab=providers");
    expect(onNavigate).toHaveBeenCalledTimes(3);

    stop();
    history.dispose();
  });

  test("blocks push/replace navigations while dirty and supports reset and proceed", () => {
    const fake = createFakeWindow("http://localhost:7860/personas/milky-green/prompt");
    const history = createBrowserHistory(fake.win);
    const id = Symbol("editor");
    history.setBlockerDirty(id, true);

    history.navigate("/");
    expect(fake.win.location.pathname).toBe("/personas/milky-green/prompt");
    expect(history.getBlocker().state).toBe("blocked");

    history.getBlocker().reset?.();
    expect(history.getBlocker().state).toBe("unblocked");
    expect(fake.win.location.pathname).toBe("/personas/milky-green/prompt");

    history.navigate("/chats/c1", { state: { from: "prompt" } });
    expect(history.getBlocker().state).toBe("blocked");

    history.getBlocker().proceed?.();
    expect(history.getBlocker().state).toBe("unblocked");
    expect(fake.win.location.pathname).toBe("/chats/c1");
    expect(fake.win.history.state).toEqual({ usr: { from: "prompt" }, idx: 1 });

    history.dispose();
  });

  test("blocks popstate back/forward while dirty, restores browser entry, and advances on proceed", async () => {
    const fake = createFakeWindow("eidolon-app://app/");
    const history = createBrowserHistory(fake.win);
    history.navigate("/personas/milky-green");
    history.navigate("/personas/milky-green/prompt");
    expect(fake.cursor()).toBe(2);

    const id = Symbol("editor");
    history.setBlockerDirty(id, true);

    // User clicks Back: browser temporarily moves to idx 1 and fires popstate.
    fake.win.history.go(-1);
    await fake.flush();

    // History reversal put the browser back at idx 2 while prompting.
    expect(fake.cursor()).toBe(2);
    expect(fake.win.location.pathname).toBe("/personas/milky-green/prompt");
    expect(history.getBlocker().state).toBe("blocked");

    // Keep Editing stays on Prompt.
    history.getBlocker().reset?.();
    expect(history.getBlocker().state).toBe("unblocked");
    expect(fake.cursor()).toBe(2);

    // Back again, then Discard Changes advances to /personas/milky-green and keeps Forward available.
    fake.win.history.go(-1);
    await fake.flush();
    expect(history.getBlocker().state).toBe("blocked");

    history.getBlocker().proceed?.();
    expect(history.getBlocker().state).toBe("proceeding");
    await fake.flush();

    expect(fake.cursor()).toBe(1);
    expect(fake.win.location.pathname).toBe("/personas/milky-green");
    expect(history.getBlocker().state).toBe("unblocked");

    // Clean Forward still reaches Prompt.
    history.removeBlocker(id);
    fake.win.history.go(1);
    await fake.flush();
    expect(fake.cursor()).toBe(2);
    expect(fake.win.location.pathname).toBe("/personas/milky-green/prompt");

    history.dispose();
  });

  test("clears an open blocker when dirty becomes false or unmounts", () => {
    const fake = createFakeWindow("http://localhost:7860/personas/milky-green/prompt");
    const history = createBrowserHistory(fake.win);
    const id = Symbol("editor");
    history.setBlockerDirty(id, true);
    history.navigate("/");
    expect(history.getBlocker().state).toBe("blocked");

    history.setBlockerDirty(id, false);
    expect(history.getBlocker().state).toBe("unblocked");

    history.setBlockerDirty(id, true);
    history.navigate("/");
    expect(history.getBlocker().state).toBe("blocked");
    history.removeBlocker(id);
    expect(history.getBlocker().state).toBe("unblocked");

    history.dispose();
  });
});

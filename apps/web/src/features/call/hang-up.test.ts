import type { TransportState } from "@laplace.live/eidolon-sdk";
import { afterEach, expect, test, vi } from "vitest";
import { type Ending, hangUpClient, LINGER_MS } from "./hang-up";

afterEach(() => {
  vi.useRealTimers();
});

function client(state: TransportState) {
  const done: string[] = [];
  let listener: ((state: TransportState) => void) | null = null;
  const fake: Ending & { move(state: TransportState): void; listening(): boolean } = {
    state,
    on(_event, handler) {
      listener = handler;
      return () => {
        listener = null;
      };
    },
    enableMic: (enable) => done.push(`mic ${enable}`),
    disconnect: async () => {
      done.push("disconnect");
    },
    move: (next) => listener?.(next),
    listening: () => listener !== null,
  };
  return { fake, done };
}

test("a call that is up, or not yet dialing, disconnects at once", async () => {
  for (const state of ["ready", "connected", "initializing", "initialized"] as const) {
    const { fake, done } = client(state);
    const hanging = hangUpClient(fake);
    expect(hanging.lingers).toBe(false);
    await hanging.done;
    expect(done).toEqual(["disconnect"]);
  }
});

test("one whose offer may be out mutes, and disconnects once its connection comes up", async () => {
  vi.useFakeTimers();
  const { fake, done } = client("connecting");
  const hanging = hangUpClient(fake);
  expect(hanging.lingers).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(done).toEqual(["mic false"]);
  fake.move("connected");
  await hanging.done;
  expect(done).toEqual(["mic false", "disconnect"]);
  expect(fake.listening()).toBe(false);
  await vi.advanceTimersByTimeAsync(LINGER_MS);
  expect(done).toEqual(["mic false", "disconnect"]);
});

test("or once its connect fails", async () => {
  const { fake, done } = client("connecting");
  const hanging = hangUpClient(fake);
  fake.move("error");
  await hanging.done;
  expect(done).toEqual(["mic false", "disconnect"]);
});

test("or when its connection hasn't come up within LINGER_MS", async () => {
  vi.useFakeTimers();
  const { fake, done } = client("connecting");
  const hanging = hangUpClient(fake);
  await vi.advanceTimersByTimeAsync(LINGER_MS - 1);
  expect(done).toEqual(["mic false"]);
  await vi.advanceTimersByTimeAsync(1);
  await hanging.done;
  expect(done).toEqual(["mic false", "disconnect"]);
  expect(fake.listening()).toBe(false);
});

test("a disconnect that fails still settles", async () => {
  const { fake } = client("ready");
  const failing: Ending = { ...fake, disconnect: () => Promise.reject(new Error("gone")) };
  await expect(hangUpClient(failing).done).resolves.toBeUndefined();
});

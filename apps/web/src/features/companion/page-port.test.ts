import { describe, expect, test } from "vitest";
import { PagePort, type PortLike } from "./page-port";
import type { ToCompanion } from "./protocol";

/** One end of a port: what this side posted, and the other side's messages and close by hand. */
function fakePort() {
  const posted: unknown[] = [];
  const closers: (() => void)[] = [];
  let closed = false;
  const port: PortLike = {
    onmessage: null,
    postMessage: (message) => posted.push(message),
    close: () => {
      closed = true;
    },
    addEventListener: (type, listener) => {
      if (type === "close") closers.push(listener);
    },
  };
  return {
    port,
    posted,
    get closed() {
      return closed;
    },
    deliver: (data: unknown) => port.onmessage?.({ data } as MessageEvent),
    /** The other end went. */
    end: () => {
      for (const listener of closers) listener();
    },
  };
}

function pagePort() {
  const messages: ToCompanion[] = [];
  const links: boolean[] = [];
  const page = new PagePort({
    message: (message) => messages.push(message),
    linked: (on) => links.push(on),
  });
  return { page, messages, links };
}

const MOUTH = { type: "mouth", level: 0.5 } as const;

describe("PagePort", () => {
  test("a connected port links her page and brings what reads", () => {
    const { page, messages, links } = pagePort();
    expect(page.linked).toBe(false);
    const one = fakePort();
    page.connect(one.port);
    expect(page.linked).toBe(true);
    expect(links).toEqual([true]);
    one.deliver(MOUTH);
    one.deliver({ type: "turn" });
    one.deliver({ type: "mouth", level: "loud" });
    expect(messages).toEqual([MOUTH]);
  });

  test("a second port closes the first, whose later messages are ignored", () => {
    const { page, messages, links } = pagePort();
    const one = fakePort();
    const two = fakePort();
    page.connect(one.port);
    page.connect(two.port);
    expect(one.closed).toBe(true);
    expect(two.closed).toBe(false);
    one.deliver(MOUTH);
    // The old port's own close event unlinks nothing.
    one.end();
    expect(messages).toEqual([]);
    expect(page.linked).toBe(true);
    expect(links).toEqual([true, true]);
    two.deliver(MOUTH);
    expect(messages).toEqual([MOUTH]);
  });

  test("the other end going unlinks her page, and nothing more is sent", () => {
    const { page, links } = pagePort();
    const one = fakePort();
    page.connect(one.port);
    one.end();
    expect(page.linked).toBe(false);
    expect(links).toEqual([true, false]);
    expect(page.send({ type: "appearance", persona: "milky-green" })).toBe(false);
    expect(one.posted).toEqual([]);
  });

  test("send reaches the port while linked, and close() unlinks once", () => {
    const { page, links } = pagePort();
    expect(page.send({ type: "appearance", persona: "milky-green" })).toBe(false);
    const one = fakePort();
    page.connect(one.port);
    expect(page.send({ type: "appearance", persona: "milky-green" })).toBe(true);
    expect(one.posted).toEqual([{ type: "appearance", persona: "milky-green" }]);
    page.close();
    page.close();
    expect(one.closed).toBe(true);
    expect(page.linked).toBe(false);
    expect(links).toEqual([true, false]);
  });
});

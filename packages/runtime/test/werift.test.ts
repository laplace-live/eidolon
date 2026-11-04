import { describe, expect, test } from "bun:test";
import { Connection } from "werift";
import { closeWhenDtlsCloses } from "../src/webrtc/handler.ts";

test("a connection with no STUN server gathers host candidates only, without waiting", async () => {
  const connection = new Connection(true, { useIpv6: false });
  const started = performance.now();
  await connection.gatherCandidates();
  expect(performance.now() - started).toBeLessThan(1000);
  expect(connection.stunServer).toBeUndefined();
  expect(connection.localCandidates.map((candidate) => candidate.type)).not.toContain("srflx");
  await connection.close();
});

test("a configured STUN server is kept", async () => {
  const connection = new Connection(true, {
    stunServer: ["stun.example", 3478],
    useIpv4: false,
    useIpv6: false,
  });
  await connection.gatherCandidates();
  expect(connection.stunServer).toEqual(["stun.example", 3478]);
  await connection.close();
});

function fakeConnection(states: string[]) {
  const handlers: ((state: string) => void)[] = [];
  const transports = states.map((state) => ({
    state,
    onStateChange: { subscribe: (handler: (state: string) => void) => handlers.push(handler) },
  }));
  const peer = { connectionState: "connected", dtlsTransports: transports };
  let disconnects = 0;
  const connection = {
    pc: { native: peer },
    disconnect: async () => {
      disconnects++;
    },
  };
  closeWhenDtlsCloses(connection);
  const close = (index: number) => {
    (transports[index] as { state: string }).state = "closed";
    for (const handler of handlers) handler("closed");
  };
  return { peer, close, disconnects: () => disconnects };
}

describe("closeWhenDtlsCloses", () => {
  test("the remote closing the only DTLS transport disconnects the peer", async () => {
    const fake = fakeConnection(["connected"]);
    fake.close(0);
    await Bun.sleep(0);
    expect(fake.disconnects()).toBe(1);
  });

  test("waits until every DTLS transport has closed", async () => {
    const fake = fakeConnection(["connected", "connected"]);
    fake.close(0);
    await Bun.sleep(0);
    expect(fake.disconnects()).toBe(0);
    fake.close(1);
    await Bun.sleep(0);
    expect(fake.disconnects()).toBe(1);
  });

  test("a peer already closing on its own is left alone", async () => {
    const fake = fakeConnection(["connected"]);
    fake.peer.connectionState = "closed";
    fake.close(0);
    await Bun.sleep(0);
    expect(fake.disconnects()).toBe(0);
  });
});

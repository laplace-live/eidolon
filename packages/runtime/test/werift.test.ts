// The werift corrections on each transport (transports.ts): both patch one werift, each patch
// once, whichever loads first.
import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { TRANSPORTS, type Transport } from "./transports.ts";

const RUNTIME_SRC = join(import.meta.dir, "..", "src");
const WEBRTC_SRC = join(import.meta.dir, "..", "..", "webrtc", "src");

/** werift as each transport's package resolves it. */
async function weriftOf(transport: Transport): Promise<typeof import("werift")> {
  return import(Bun.resolveSync("werift", transport.name === "pipedog" ? RUNTIME_SRC : WEBRTC_SRC));
}

test("both transports patch the one werift, and loading a patch again changes nothing", async () => {
  const fromRuntime = Bun.resolveSync("werift", RUNTIME_SRC);
  const fromWebrtc = Bun.resolveSync("werift", WEBRTC_SRC);
  expect(realpathSync(dirname(fromWebrtc))).toBe(realpathSync(dirname(fromRuntime)));
  const werift = await import(fromRuntime);
  expect((await import(fromWebrtc)).Connection).toBe(werift.Connection);
  const gatherCandidates = werift.Connection.prototype.gatherCandidates;
  const udpInit = werift.UdpTransport.prototype.init;
  // Each module that patches, evaluated a second time, as a second copy of its package would be.
  await import(`${join(RUNTIME_SRC, "webrtc", "handler.ts")}?again`);
  await import(`${join(WEBRTC_SRC, "patches.ts")}?again`);
  await import(`${join(WEBRTC_SRC, "peer.ts")}?again`);
  expect(werift.Connection.prototype.gatherCandidates).toBe(gatherCandidates);
  expect(werift.UdpTransport.prototype.init).toBe(udpInit);
});

describe.each(TRANSPORTS)("on $name's transport", (transport) => {
  test("a connection with no STUN server gathers host candidates only, without waiting", async () => {
    const { Connection } = await weriftOf(transport);
    const connection = new Connection(true, { useIpv6: false });
    const started = performance.now();
    await connection.gatherCandidates();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(connection.stunServer).toBeUndefined();
    expect(connection.localCandidates.map((candidate) => candidate.type)).not.toContain("srflx");
    await connection.close();
  });

  test("a configured STUN server is kept", async () => {
    const { Connection } = await weriftOf(transport);
    const connection = new Connection(true, {
      stunServer: ["stun.example", 3478],
      useIpv4: false,
      useIpv6: false,
    });
    await connection.gatherCandidates();
    expect(connection.stunServer).toEqual(["stun.example", 3478]);
    await connection.close();
  });

  function fakePeer(states: string[]) {
    const handlers: ((state: string) => void)[] = [];
    const transports = states.map((state) => ({
      state,
      onStateChange: { subscribe: (handler: (state: string) => void) => handlers.push(handler) },
    }));
    const peer = { connectionState: "connected", dtlsTransports: transports };
    let disconnects = 0;
    transport.closeWhenDtlsCloses(peer, async () => {
      disconnects++;
    });
    const close = (index: number) => {
      (transports[index] as { state: string }).state = "closed";
      for (const handler of handlers) handler("closed");
    };
    return { peer, close, disconnects: () => disconnects };
  }

  describe("closeWhenDtlsCloses", () => {
    test("the remote closing the only DTLS transport disconnects the peer", async () => {
      const fake = fakePeer(["connected"]);
      fake.close(0);
      await Bun.sleep(0);
      expect(fake.disconnects()).toBe(1);
    });

    test("waits until every DTLS transport has closed", async () => {
      const fake = fakePeer(["connected", "connected"]);
      fake.close(0);
      await Bun.sleep(0);
      expect(fake.disconnects()).toBe(0);
      fake.close(1);
      await Bun.sleep(0);
      expect(fake.disconnects()).toBe(1);
    });

    test("a peer already closing on its own is left alone", async () => {
      const fake = fakePeer(["connected"]);
      fake.peer.connectionState = "closed";
      fake.close(0);
      await Bun.sleep(0);
      expect(fake.disconnects()).toBe(0);
    });
  });
});

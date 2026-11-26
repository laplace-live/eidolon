// @eidolon/webrtc's werift configuration and corrections (docs/typescript.md).
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { Connection, UdpTransport } from "werift";
import { closeWhenDtlsCloses } from "../src/patches.ts";

describe("the werift corrections", () => {
  test("a connection with useDefaultStunServer: false gathers host candidates only, without waiting", async () => {
    const connection = new Connection(true, { useDefaultStunServer: false, useIpv6: false });
    const started = performance.now();
    await connection.gatherCandidates();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(connection.stunServers).toEqual([]);
    expect(connection.localCandidates.map((candidate) => candidate.type)).not.toContain("srflx");
    await connection.close();
  });

  test("a configured STUN server is kept", async () => {
    const connection = new Connection(true, {
      stunServers: [["stun.example", 3478]],
      useDefaultStunServer: false,
      useIpv4: false,
      useIpv6: false,
    });
    await connection.gatherCandidates();
    expect(connection.stunServers).toEqual([["stun.example", 3478]]);
    await connection.close();
  });

  test("UdpTransport attaches an error listener to its socket", async () => {
    const transport = await UdpTransport.init("udp4");
    try {
      expect(transport.socket.listenerCount("error")).toBeGreaterThan(0);
    } finally {
      await transport.close();
    }
  });

  function fakePeer(states: string[]) {
    const handlers: ((state: string) => void)[] = [];
    const transports = states.map((state) => ({
      state,
      onStateChange: { subscribe: (handler: (state: string) => void) => handlers.push(handler) },
    }));
    const peer = { connectionState: "connected", dtlsTransports: transports };
    let disconnects = 0;
    closeWhenDtlsCloses({
      pc: peer,
      disconnect: async () => {
        disconnects++;
      },
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
      await delay(0);
      expect(fake.disconnects()).toBe(1);
    });

    test("waits until every DTLS transport has closed", async () => {
      const fake = fakePeer(["connected", "connected"]);
      fake.close(0);
      await delay(0);
      expect(fake.disconnects()).toBe(0);
      fake.close(1);
      await delay(0);
      expect(fake.disconnects()).toBe(1);
    });

    test("a peer already closing on its own is left alone", async () => {
      const fake = fakePeer(["connected"]);
      fake.peer.connectionState = "closed";
      fake.close(0);
      await delay(0);
      expect(fake.disconnects()).toBe(0);
    });
  });
});

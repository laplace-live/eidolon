// A real werift peer offers to each transport's signalling server (transports.ts) over this machine's
// own interfaces. A local STUN responder stands in for werift's default (stun.l.google.com), so
// nothing leaves the host.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import type { SignallingServer } from "@eidolon/webrtc";
import { RTCIceServer, RTCPeerConnection } from "@pipedog/transport-smallwebrtc/rtc";
import type { AnyCallBinding } from "../src/native/binding.ts";
import {
  admission,
  CAN_DIAL,
  captureLogs,
  type LogCapture,
  PASS_THROUGH_RULES,
  until,
} from "./support.ts";
import { type Connection, TRANSPORTS } from "./transports.ts";

/** Answers every STUN Binding Request with the sender's address (RFC 5389 §7.3.1). */
async function stunResponder(): Promise<{ url: string; close(): void }> {
  const socket = await Bun.udpSocket({
    hostname: "127.0.0.1",
    socket: {
      data(sock, request, port, address) {
        if (request.length < 20 || request.readUInt16BE(0) !== 0x0001) return;
        const response = Buffer.alloc(32);
        response.writeUInt16BE(0x0101, 0);
        response.writeUInt16BE(12, 2);
        request.copy(response, 4, 4, 20);
        response.writeUInt16BE(0x0020, 20);
        response.writeUInt16BE(8, 22);
        response.writeUInt8(0x01, 25);
        response.writeUInt16BE(port ^ 0x2112, 26);
        const ip = address.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
        response.writeUInt32BE((ip ^ 0x2112a442) >>> 0, 28);
        sock.send(response, port, address);
      },
    },
  });
  return { url: `stun:127.0.0.1:${socket.port}`, close: () => socket.close() };
}

/** A localhost TCP port nothing listens on, so a TURN allocation there is refused at once. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function connected(peer: RTCPeerConnection): Promise<void> {
  await until(() => peer.connectionState === "connected", 8000);
}

describe.each(TRANSPORTS)("on $name's transport", (transport) => {
  let logs: LogCapture;
  let stun: { url: string; close(): void };
  let client: RTCPeerConnection;
  let server: SignallingServer<AnyCallBinding>;
  let sessions: Connection[];

  beforeEach(async () => {
    logs = captureLogs();
    stun = await stunResponder();
    sessions = [];
    server = transport.createServer(
      {
        ice: {
          serverPlan: async () => ({
            iceServers: [{ urls: stun.url, username: null, credential: null }],
            relayOnly: false,
            turnUrl: null,
          }),
        },
      },
      {
        startSession: async (connection) => {
          sessions.push(connection);
        },
        candidates: PASS_THROUGH_RULES,
      },
    );
    client = new RTCPeerConnection({ iceServers: [new RTCIceServer({ urls: stun.url })] });
    client.addTransceiver("audio", { direction: "sendrecv" });
    client.createDataChannel("chat");
    await client.setLocalDescription(await client.createOffer());
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    stun.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    logs.restore();
  });

  describe.skipIf(!CAN_DIAL)("localhost loopback", () => {
    test("an offer carrying its candidates connects and starts one session", async () => {
      const offer = client.localDescription!.sdp;
      const result = await server.offer(admission({ sdp: offer, type: "offer" }));
      expect(result.status).toBe(200);
      const answer = result.body as { sdp: string; type: string; pc_id: string };
      expect(answer.pc_id).toMatch(/^SmallWebRTCConnection#\d+-[0-9a-f]{32}$/);
      expect(answer.sdp).toContain("a=candidate:");
      await client.setRemoteDescription({ sdp: answer.sdp, type: "answer" } as never);
      await connected(client);
      await until(() => sessions.length === 1);
      expect(sessions[0]?.pcId).toBe(answer.pc_id);
      expect(server.activeSessions).toBe(0);
    }, 15000);

    test("candidates trickled by PATCH alone are enough, as the browser sends them", async () => {
      // A browser offers before it gathers: no candidates, and no end-of-candidates either.
      const lines = client.localDescription!.sdp.split("\r\n");
      const candidates = lines.filter((line) => line.startsWith("a=candidate:"));
      const bare = lines
        .filter((line) => !line.startsWith("a=candidate:") && line !== "a=end-of-candidates")
        .join("\r\n");
      expect(candidates.length).toBeGreaterThan(0);
      const result = await server.offer(admission({ sdp: bare, type: "offer" }));
      const answer = result.body as { sdp: string; pc_id: string };
      await client.setRemoteDescription({ sdp: answer.sdp, type: "answer" } as never);
      const patch = await server.patch(
        JSON.stringify({
          pc_id: answer.pc_id,
          candidates: [
            ...candidates.map((line) => ({
              candidate: line.slice("a=".length),
              sdp_mid: "0",
              sdp_mline_index: 0,
            })),
            { candidate: "", sdp_mid: "0", sdp_mline_index: 0 },
          ],
        }),
      );
      expect(patch).toEqual({ status: 200, body: { status: "success" } });
      await connected(client);
    }, 15000);

    test("a restart's trickled candidates reach the peer it builds, however slow the plan", async () => {
      // A browser restarting (restart_pc) PATCHes its new candidates under the old pc_id until the
      // answer arrives, so the restart must not wait on a plan it never uses.
      let planDelay = 0;
      const connections: Connection[] = [];
      const restarting = transport.createServer(
        {
          ice: {
            serverPlan: async () => {
              await new Promise((resolve) => setTimeout(resolve, planDelay));
              return { iceServers: [], relayOnly: false, turnUrl: null };
            },
          },
        },
        {
          startSession: async (connection) => {
            connections.push(connection);
          },
          candidates: PASS_THROUGH_RULES,
        },
      );
      const second = new RTCPeerConnection({ iceServers: [] });
      try {
        const strip = (sdp: string) => {
          const lines = sdp.split("\r\n");
          return {
            bare: lines
              .filter((l) => !l.startsWith("a=candidate:") && l !== "a=end-of-candidates")
              .join("\r\n"),
            candidates: lines.filter((l) => l.startsWith("a=candidate:")).map((l) => l.slice(2)),
          };
        };
        const first = await restarting.offer(
          admission({ sdp: strip(client.localDescription!.sdp).bare, type: "offer" }),
        );
        const pcId = (first.body as { pc_id: string }).pc_id;
        await until(() => connections.length === 1);
        second.addTransceiver("audio", { direction: "sendrecv" });
        second.createDataChannel("chat");
        await second.setLocalDescription(await second.createOffer());
        const { bare, candidates } = strip(second.localDescription!.sdp);
        planDelay = 2000;
        const restart = restarting.offer(
          admission({ sdp: bare, type: "offer", pc_id: pcId, restart_pc: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        const patch = await restarting.patch(
          JSON.stringify({
            pc_id: pcId,
            candidates: candidates.map((candidate) => ({
              candidate,
              sdp_mid: "0",
              sdp_mline_index: 0,
            })),
          }),
        );
        expect(patch.status).toBe(200);
        expect((await restart).status).toBe(200);
        const peer = transport.werift(connections[0]!);
        const remote = peer.iceTransports.reduce(
          (n, transport) => n + transport.connection.remoteCandidates.length,
          0,
        );
        expect(remote).toBe(candidates.length);
      } finally {
        await second.close();
        await restarting.close();
      }
    }, 15000);

    test("relay-only advertises no host or srflx candidate when the relay can't allocate", async () => {
      const turn = `turn:127.0.0.1:${await closedPort()}?transport=tcp`;
      const relay = transport.createServer(
        {
          ice: {
            serverPlan: async () => ({
              // The STUN entry only matters if the policy is lost: then a srflx shows up, locally.
              iceServers: [
                { urls: stun.url, username: null, credential: null },
                { urls: turn, username: "user", credential: "secret" },
              ],
              relayOnly: true,
              turnUrl: turn,
            }),
          },
        },
        { startSession: async () => {}, candidates: PASS_THROUGH_RULES },
      );
      try {
        const result = await relay.offer(
          admission({ sdp: client.localDescription!.sdp, type: "offer" }),
        );
        expect(result.status).toBe(200);
        expect((result.body as { sdp: string }).sdp).not.toContain("a=candidate:");
      } finally {
        await relay.close();
      }
    }, 15000);
  });
});

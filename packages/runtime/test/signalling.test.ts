// POST and PATCH /api/offer on each transport (transports.ts), its connections' negotiation
// stood in for: the same answers, status codes and bodies, per-offer plans and relay-only rules.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type AllowedOffer, ANONYMOUS } from "@eidolon/access";
import type { ServerIcePlan } from "@eidolon/turn";
import type {
  CandidateRules,
  OpusCodec,
  OpusEncoder,
  OpusEncoderOptions,
  SignallingServer,
} from "@eidolon/webrtc";
import type { AnyCallBinding } from "../src/native/binding.ts";
import type { CallBinding } from "../src/session/session.ts";
import { captureLogs, type Deferred, deferred, type LogCapture, until } from "./support.ts";
import {
  type Candidate,
  type Connection,
  type ConnectionHooks,
  type DtlsPeer,
  type ServerDeps,
  TRANSPORTS,
} from "./transports.ts";

const RELAY_ANSWER =
  "v=0\r\n" +
  "a=candidate:1 1 udp 16777215 104.30.1.1 50000 typ relay raddr 203.0.113.7 rport 61234 generation 0 ufrag abc\r\n" +
  "a=end-of-candidates\r\n";

/** Stand-ins for @eidolon/turn's rules: 10/8, 192.168/16 and mDNS names are unreachable. */
const UNREACHABLE = /^(10\.|192\.168\.|.+\.local$)/;
const addressOf = (candidate: string) =>
  candidate
    .replace(/^(a=)?candidate:/, "")
    .trim()
    .split(/\s+/)[4] ?? "";
const rules: CandidateRules = {
  dropUnreachableCandidates(sdp) {
    const dropped: string[] = [];
    const kept = sdp.split("\n").filter((line) => {
      if (!line.startsWith("a=candidate:") || !UNREACHABLE.test(addressOf(line))) return true;
      dropped.push(addressOf(line));
      return false;
    });
    return { sdp: kept.join("\n"), dropped };
  },
  candidateReachable: (candidate) => !UNREACHABLE.test(addressOf(candidate)),
  scrubRelayRelatedAddresses: (sdp) =>
    sdp.replace(/ typ relay raddr \S+ rport \d+/g, " typ relay raddr 0.0.0.0 rport 0"),
};

const RELAY_PLAN: ServerIcePlan = {
  iceServers: [{ urls: "turn:turn.example:3478?transport=tcp", username: "u", credential: "c" }],
  relayOnly: true,
  turnUrl: "turn:turn.example:3478?transport=tcp",
};
const STUN_PLAN: ServerIcePlan = {
  iceServers: [{ urls: "stun:stun.example:3478", username: null, credential: null }],
  relayOnly: false,
  turnUrl: null,
};

const OFFER_WITH_CANDIDATES =
  "v=0\r\n" +
  "a=candidate:1 1 udp 2122260223 10.0.0.1 4000 typ host generation 0\r\n" +
  "a=candidate:2 1 udp 1686052607 8.8.4.4 4001 typ srflx raddr 0.0.0.0 rport 0 generation 0\r\n" +
  "a=candidate:3 1 udp 2122260223 abcd-1234.local 4002 typ host generation 0\r\n" +
  "a=end-of-candidates\r\n";

function recordingOpus(): { codec: OpusCodec; bitrates: (number | undefined)[] } {
  const bitrates: (number | undefined)[] = [];
  const codec: OpusCodec = {
    async createEncoder(options: OpusEncoderOptions) {
      bitrates.push(options.bitrate);
      return {} as OpusEncoder;
    },
    createDecoder: async () => {
      throw new Error("unused");
    },
  };
  return { codec, bitrates };
}

function admission(body: Record<string, unknown> | null, opusBitrateBps = 96000): AllowedOffer {
  return {
    allowed: true,
    user: ANONYMOUS,
    token: null,
    body,
    requestData: null,
    opusBitrateBps,
    clientIp: "203.0.113.1",
    quota: null,
  };
}

describe.each(TRANSPORTS)("on $name's transport", (transport) => {
  interface Built {
    readonly connection: Connection;
    readonly sdp: string;
  }

  interface Started {
    readonly connection: Connection;
    readonly admission: AllowedOffer;
    readonly binding: AnyCallBinding | undefined;
  }

  let logs: LogCapture;
  let built: Built[];
  let renegotiated: { connection: Connection; sdp: string; restartPc?: boolean }[];
  let added: (Candidate | null)[];
  let restore: () => void;
  let servers: SignallingServer<AnyCallBinding>[];
  let onRenegotiate: ConnectionHooks["renegotiate"];

  beforeEach(() => {
    logs = captureLogs();
    built = [];
    renegotiated = [];
    added = [];
    servers = [];
    onRenegotiate = async (connection, options) => {
      renegotiated.push({ connection, sdp: options.sdp, restartPc: options.restartPc });
    };
    restore = transport.mock({
      async initialize(connection, sdp) {
        built.push({ connection, sdp });
        if (sdp === "explode") throw new Error("boom");
        if (sdp === "conflict") throw transport.httpError(409, "busy");
        return { sdp: RELAY_ANSWER, type: "answer" };
      },
      renegotiate: (connection, options) => onRenegotiate(connection, options),
      async addIceCandidate(candidate) {
        added.push(candidate);
      },
    });
  });

  afterEach(async () => {
    for (const server of servers) await server.close();
    restore();
    logs.restore();
  });

  function server(
    plans: (ServerIcePlan | Deferred<ServerIcePlan>)[],
    deps: Partial<ServerDeps> = {},
  ): {
    signalling: SignallingServer<AnyCallBinding>;
    sessions: Started[];
    planCalls: () => number;
  } {
    const sessions: Started[] = [];
    let calls = 0;
    const signalling = transport.createServer(
      {
        ice: {
          serverPlan: async () => {
            const next = plans[Math.min(calls++, plans.length - 1)];
            if (next === undefined) throw new Error("no plan");
            return "promise" in next ? next.promise : next;
          },
        },
      },
      {
        startSession: async (connection, offer, binding) => {
          sessions.push({ connection, admission: offer, binding });
        },
        candidates: rules,
        ...deps,
      },
    );
    servers.push(signalling);
    return { signalling, sessions, planCalls: () => calls };
  }

  const urlsOf = (connection: Connection) => transport.iceServers(connection).map((s) => s.urls);

  describe("POST /api/offer", () => {
    test("answers with the pc_id and starts one background session", async () => {
      const { signalling, sessions } = server([STUN_PLAN]);
      const offer = admission({
        sdp: "offer",
        type: "offer",
        requestData: { audioQuality: "low" },
      });
      const result = await signalling.offer(offer);
      expect(result.status).toBe(200);
      const body = result.body as { sdp: string; type: string; pc_id: string };
      expect(Object.keys(body)).toEqual(["sdp", "type", "pc_id"]);
      expect(body.type).toBe("answer");
      expect(body.pc_id).toMatch(/^SmallWebRTCConnection#\d+-[0-9a-f]{32}$/);
      // The session starts in its own task, after the answer is on its way.
      await until(() => sessions.length > 0);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.admission).toBe(offer);
      expect(sessions[0]?.connection).toBe(built[0]?.connection as Connection);
      expect(sessions[0]?.connection.pcId).toBe(body.pc_id);
      expect(sessions[0]?.binding).toBeUndefined();
    });

    test("a bound offer hands its binding to the session it starts", async () => {
      const { signalling, sessions } = server([STUN_PLAN]);
      const binding: CallBinding = {
        persona: "bob",
        seedMessages: [],
        onTranscript: () => {},
        onEnded: () => {},
      };
      const result = await signalling.offer(admission({ sdp: "offer", type: "offer" }), binding);
      expect(result.status).toBe(200);
      await until(() => sessions.length > 0);
      expect(sessions[0]?.binding).toBe(binding);
    });

    test("every answer's relay raddr is scrubbed", async () => {
      const { signalling } = server([RELAY_PLAN]);
      const result = await signalling.offer(admission({ sdp: "offer", type: "offer" }));
      expect((result.body as { sdp: string }).sdp).toBe(
        "v=0\r\n" +
          "a=candidate:1 1 udp 16777215 104.30.1.1 50000 typ relay raddr 0.0.0.0 rport 0 generation 0 ufrag abc\r\n" +
          "a=end-of-candidates\r\n",
      );
    });

    test("two interleaved offers each build their connection from their own plan (W1a)", async () => {
      const opus = recordingOpus();
      const relay = deferred<ServerIcePlan>();
      const stun = deferred<ServerIcePlan>();
      const { signalling } = server([relay, stun], { opusCodec: opus.codec });
      const first = signalling.offer(admission({ sdp: "A", type: "offer" }, 8000));
      const second = signalling.offer(admission({ sdp: "B", type: "offer" }, 192000));
      await Promise.resolve();
      // Both continuations run back to back: B's right after A's.
      stun.resolve(STUN_PLAN);
      relay.resolve(RELAY_PLAN);
      await Promise.all([first, second]);

      const a = built.find((b) => b.sdp === "A")?.connection as Connection;
      const b = built.find((b) => b.sdp === "B")?.connection as Connection;
      expect(transport.iceServers(a)).toEqual([
        { urls: "turn:turn.example:3478?transport=tcp", username: "u", credential: "c" },
      ]);
      expect(transport.relayOnly(a)).toBe(true);
      expect(transport.iceServers(b)).toEqual([
        { urls: "stun:stun.example:3478", username: null, credential: null },
      ]);
      expect(transport.relayOnly(b)).toBe(false);

      await transport
        .opusCodec(a)
        .createEncoder({ sampleRate: 24000, channels: 1, bitrate: 96000 });
      await transport
        .opusCodec(b)
        .createEncoder({ sampleRate: 24000, channels: 1, bitrate: 96000 });
      expect(opus.bitrates).toEqual([8000, 192000]);
    });

    test("plans resolving in reverse order still land on their own connections", async () => {
      const opus = recordingOpus();
      const relay = deferred<ServerIcePlan>();
      const stun = deferred<ServerIcePlan>();
      const { signalling } = server([relay, stun], { opusCodec: opus.codec });
      const first = signalling.offer(admission({ sdp: "A", type: "offer" }, 8000));
      const second = signalling.offer(admission({ sdp: "B", type: "offer" }, 192000));
      stun.resolve(STUN_PLAN);
      await second;
      relay.resolve(RELAY_PLAN);
      await first;
      expect(built.map((b) => b.sdp)).toEqual(["B", "A"]);
      const [b, a] = built.map((entry) => entry.connection) as [Connection, Connection];
      expect(transport.relayOnly(a)).toBe(true);
      expect(urlsOf(b)).toEqual(["stun:stun.example:3478"]);
      await transport.opusCodec(a).createEncoder({ sampleRate: 24000, channels: 1 });
      await transport.opusCodec(b).createEncoder({ sampleRate: 24000, channels: 1 });
      expect(opus.bitrates).toEqual([8000, 192000]);
    });

    test("a relay-only offer loses its unreachable candidates before werift sees them", async () => {
      const { signalling } = server([RELAY_PLAN]);
      await signalling.offer(admission({ sdp: OFFER_WITH_CANDIDATES, type: "offer" }));
      expect(built[0]?.sdp).toBe(
        "v=0\r\n" +
          "a=candidate:2 1 udp 1686052607 8.8.4.4 4001 typ srflx raddr 0.0.0.0 rport 0 generation 0\r\n" +
          "a=end-of-candidates\r\n",
      );
      expect(logs.messages("DEBUG")).toContain(
        "[WebRTC] Dropping unroutable remote candidate: 10.0.0.1",
      );
      expect(logs.messages("DEBUG")).toContain(
        "[WebRTC] Dropping unroutable remote candidate: abcd-1234.local",
      );
    });

    test("a non-relay offer keeps every candidate", async () => {
      const { signalling } = server([STUN_PLAN]);
      await signalling.offer(admission({ sdp: OFFER_WITH_CANDIDATES, type: "offer" }));
      expect(built[0]?.sdp).toBe(OFFER_WITH_CANDIDATES);
    });

    test("a TURN URL without credentials warns once per new connection", async () => {
      const plan: ServerIcePlan = {
        iceServers: [{ urls: "turn:turn.example:3478", username: null, credential: null }],
        relayOnly: false,
        turnUrl: "turn:turn.example:3478",
      };
      const { signalling } = server([plan]);
      const first = await signalling.offer(admission({ sdp: "A", type: "offer" }));
      const pcId = (first.body as { pc_id: string }).pc_id;
      await signalling.offer(admission({ sdp: "A2", type: "offer", pc_id: pcId }));
      expect(logs.messages("WARNING")).toEqual([
        "[WebRTC] TURN server has no credentials; relay-only gathering is off",
      ]);
      expect(transport.relayOnly(built[0]?.connection as Connection)).toBe(false);
    });

    test("a known pc_id renegotiates: no new connection, no session, the original options", async () => {
      const opus = recordingOpus();
      const { signalling, sessions } = server([RELAY_PLAN, STUN_PLAN], { opusCodec: opus.codec });
      const first = await signalling.offer(admission({ sdp: "A", type: "offer" }, 8000));
      const pcId = (first.body as { pc_id: string }).pc_id;
      const again = await signalling.offer(
        admission(
          { sdp: OFFER_WITH_CANDIDATES, type: "offer", pc_id: pcId, restart_pc: true },
          192000,
        ),
      );
      expect(again.status).toBe(200);
      expect((again.body as { pc_id: string }).pc_id).toBe(pcId);
      expect(built).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(sessions).toHaveLength(1);
      expect(renegotiated).toHaveLength(1);
      expect(renegotiated[0]?.restartPc).toBe(true);
      // Still relay-only: the renegotiation's candidates are filtered too.
      expect(renegotiated[0]?.sdp).not.toContain("10.0.0.1");
      const connection = built[0]?.connection as Connection;
      expect(urlsOf(connection)).toEqual(["turn:turn.example:3478?transport=tcp"]);
      await transport.opusCodec(connection).createEncoder({ sampleRate: 24000, channels: 1 });
      expect(opus.bitrates).toEqual([8000]);
    });

    test("an offer for a live pc_id answers without waiting on a plan", async () => {
      const slow = deferred<ServerIcePlan>();
      const { signalling, planCalls } = server([RELAY_PLAN, slow]);
      const first = await signalling.offer(admission({ sdp: "A", type: "offer" }));
      const pcId = (first.body as { pc_id: string }).pc_id;
      const restart = await signalling.offer(
        admission({ sdp: "B", type: "offer", pc_id: pcId, restart_pc: true }),
      );
      expect(restart.status).toBe(200);
      expect(planCalls()).toBe(1);
      expect(renegotiated).toHaveLength(1);
      slow.resolve(STUN_PLAN);
    });

    test("restart_pc watches the DTLS transports of the peer it built", async () => {
      const { signalling } = server([STUN_PLAN]);
      const first = await signalling.offer(admission({ sdp: "A", type: "offer" }));
      const pcId = (first.body as { pc_id: string }).pc_id;
      const connection = built[0]!.connection;
      const disconnect = spyOn(connection, "disconnect").mockImplementation(async () => {});
      const handlers: ((state: string) => void)[] = [];
      const dtls = {
        state: "connected",
        onStateChange: { subscribe: (handler: (state: string) => void) => handlers.push(handler) },
      };
      const replacement: DtlsPeer = { connectionState: "connected", dtlsTransports: [dtls] };
      onRenegotiate = async (renegotiating) => transport.replaceWerift(renegotiating, replacement);
      await signalling.offer(admission({ sdp: "B", type: "offer", pc_id: pcId, restart_pc: true }));
      dtls.state = "closed";
      for (const handler of handlers) handler("closed");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(disconnect).toHaveBeenCalledTimes(1);
    });

    test("a pc_id whose connection closed gets a new connection with this offer's plan", async () => {
      const { signalling, sessions } = server([RELAY_PLAN, STUN_PLAN]);
      const first = await signalling.offer(admission({ sdp: "A", type: "offer" }));
      const pcId = (first.body as { pc_id: string }).pc_id;
      await built[0]!.connection.disconnect();
      const discarded = `Discarding peer connection for pc_id: ${pcId}`;
      await until(() => logs.messages("INFO").includes(discarded));
      const again = await signalling.offer(admission({ sdp: "B", type: "offer", pc_id: pcId }));
      expect(again.status).toBe(200);
      expect(built).toHaveLength(2);
      await until(() => sessions.length === 2);
      expect(renegotiated).toHaveLength(0);
      const second = built[1]?.connection as Connection;
      expect(urlsOf(second)).toEqual(["stun:stun.example:3478"]);
      expect(transport.relayOnly(second)).toBe(false);
    });

    test("a body that isn't a JSON object, or lacks sdp/type, is a 400", async () => {
      const { signalling } = server([STUN_PLAN]);
      expect(await signalling.offer(admission(null))).toEqual({
        status: 400,
        body: { detail: "Invalid WebRTC request: Error: expected a JSON object" },
      });
      expect(await signalling.offer(admission({ type: "offer" }))).toEqual({
        status: 400,
        body: { detail: "Invalid WebRTC request: sdp and type are required" },
      });
      expect(await signalling.offer(admission({ sdp: 5, type: "offer" }))).toEqual({
        status: 400,
        body: { detail: "Invalid WebRTC request: sdp and type are required" },
      });
      expect(built).toHaveLength(0);
    });

    test("an HTTP error keeps its status; anything else is a logged 500", async () => {
      const { signalling, sessions } = server([STUN_PLAN]);
      expect(await signalling.offer(admission({ sdp: "conflict", type: "offer" }))).toEqual({
        status: 409,
        body: { detail: "busy" },
      });
      expect(await signalling.offer(admission({ sdp: "explode", type: "offer" }))).toEqual({
        status: 500,
        body: { detail: "Internal Server Error" },
      });
      expect(logs.messages("ERROR")).toContain("SmallWebRTC signalling error: Error: boom");
      expect(sessions).toHaveLength(0);
    });
  });

  describe("PATCH /api/offer", () => {
    async function connected(plan: ServerIcePlan) {
      const setup = server([plan]);
      const result = await setup.signalling.offer(admission({ sdp: "A", type: "offer" }));
      return { ...setup, pcId: (result.body as { pc_id: string }).pc_id };
    }

    const patchBody = (pcId: unknown, candidates: string[]) =>
      JSON.stringify({
        pc_id: pcId,
        candidates: candidates.map((candidate) => ({
          candidate,
          sdp_mid: "0",
          sdp_mline_index: 0,
        })),
      });

    test("malformed bodies are 400s, as pipedog's PATCH branch answers", async () => {
      const { signalling } = server([STUN_PLAN]);
      const invalidJson = await signalling.patch("{");
      expect(invalidJson.status).toBe(400);
      expect((invalidJson.body as { detail: string }).detail).toStartWith(
        "Invalid WebRTC request: SyntaxError",
      );
      for (const text of ["5", "null", '"text"']) {
        expect(await signalling.patch(text)).toEqual({
          status: 400,
          body: { detail: "Invalid WebRTC request: Error: expected a JSON object" },
        });
      }
      for (const text of ["{}", '{"pc_id": 5}']) {
        expect(await signalling.patch(text)).toEqual({
          status: 400,
          body: { detail: "Invalid WebRTC request: pc_id is required" },
        });
      }
    });

    test("an unknown pc_id is a 404", async () => {
      const { signalling } = server([STUN_PLAN]);
      expect(await signalling.patch(patchBody("nope", []))).toEqual({
        status: 404,
        body: { detail: "Peer connection not found" },
      });
    });

    test("relay-only drops unreachable candidates and keeps end-of-candidates", async () => {
      const { signalling, pcId } = await connected(RELAY_PLAN);
      const result = await signalling.patch(
        patchBody(pcId, [
          "candidate:1 1 udp 2122260223 192.168.1.20 4000 typ host generation 0",
          "candidate:2 1 udp 1686052607 8.8.4.4 4001 typ srflx raddr 0.0.0.0 rport 0",
          "candidate:3 1 udp 2122260223 abcd-1234.local 4002 typ host",
          "",
        ]),
      );
      expect(result).toEqual({ status: 200, body: { status: "success" } });
      expect(added.map((c) => c?.ip ?? null)).toEqual(["8.8.4.4", null]);
      expect(added[0]?.sdpMid).toBe("0");
      expect(added[0]?.sdpMLineIndex).toBe(0);
      expect(logs.messages("DEBUG")).toEqual(
        expect.arrayContaining([
          "[WebRTC] Dropping unroutable remote candidate: 192.168.1.20",
          "[WebRTC] Dropping unroutable remote candidate: abcd-1234.local",
        ]),
      );
    });

    test("a connection that isn't relay-only gets every candidate", async () => {
      const { signalling, pcId } = await connected(STUN_PLAN);
      await signalling.patch(
        patchBody(pcId, ["candidate:1 1 udp 2122260223 192.168.1.20 4000 typ host", ""]),
      );
      expect(added.map((c) => c?.ip ?? null)).toEqual(["192.168.1.20", null]);
    });

    test("an unparseable candidate is a logged 500, as aiortc's parser failing was", async () => {
      const { signalling, pcId } = await connected(RELAY_PLAN);
      expect(await signalling.patch(patchBody(pcId, ["candidate:1 1 udp"]))).toEqual({
        status: 500,
        body: { detail: "Internal Server Error" },
      });
      expect(logs.messages("ERROR")).toContain(
        "SmallWebRTC signalling error: Error: SDP does not have enough properties",
      );
    });
  });

  describe("sessions and shutdown", () => {
    test("activeSessions counts sessions until they settle", async () => {
      const finish = deferred<void>();
      const { signalling } = server([STUN_PLAN], { startSession: () => finish.promise });
      await signalling.offer(admission({ sdp: "A", type: "offer" }));
      await signalling.offer(admission({ sdp: "B", type: "offer" }));
      expect(signalling.activeSessions).toBe(2);
      finish.resolve();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(signalling.activeSessions).toBe(0);
    });

    test("close() disconnects every peer and forgets them", async () => {
      const disconnect = spyOn(transport.Connection.prototype, "disconnect");
      try {
        const { signalling } = server([STUN_PLAN]);
        const a = await signalling.offer(admission({ sdp: "A", type: "offer" }));
        await signalling.offer(admission({ sdp: "B", type: "offer" }));
        await signalling.close();
        expect(disconnect).toHaveBeenCalledTimes(2);
        expect(await signalling.patch(JSON.stringify({ pc_id: (a.body as any).pc_id }))).toEqual({
          status: 404,
          body: { detail: "Peer connection not found" },
        });
      } finally {
        disconnect.mockRestore();
      }
    });
  });

  describe("with @eidolon/turn's own rules", () => {
    test("relay-only filters the offer and PATCHes and scrubs the answer", async () => {
      const { signalling } = server([RELAY_PLAN], { candidates: undefined });
      const result = await signalling.offer(
        admission({ sdp: OFFER_WITH_CANDIDATES, type: "offer" }),
      );
      expect(built[0]?.sdp).not.toContain("10.0.0.1");
      expect(built[0]?.sdp).not.toContain("abcd-1234.local");
      expect(built[0]?.sdp).toContain("8.8.4.4");
      const answer = result.body as { sdp: string; pc_id: string };
      expect(answer.sdp).toContain("typ relay raddr 0.0.0.0 rport 0");
      expect(answer.sdp).not.toContain("203.0.113.7");
      await signalling.patch(
        JSON.stringify({
          pc_id: answer.pc_id,
          candidates: [
            { candidate: "candidate:1 1 udp 2122260223 100.64.0.1 4000 typ host", sdp_mid: "0" },
            { candidate: "candidate:2 1 udp 1686052607 8.8.4.4 4001 typ srflx", sdp_mid: "0" },
            { candidate: "", sdp_mid: "0" },
          ],
        }),
      );
      expect(added.map((c) => c?.ip ?? null)).toEqual(["8.8.4.4", null]);
      expect(logs.messages("DEBUG")).toContain(
        "[WebRTC] Dropping unroutable remote candidate: 100.64.0.1",
      );
    });
  });
});

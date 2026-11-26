import { createSocket } from "node:dgram";
import { describe, expect, test } from "vitest";
import {
  acceptHostHandshake,
  ClientCallBridgePool,
  extractHostUdpPort,
  generateX25519KeyPair,
  importX25519PrivateKey,
  MAX_MUX_CHUNK,
  MuxEndpoint,
  openHostUdpBridge,
  rewriteSdpAnswer,
  startClientHandshake,
  utf8Decode,
  utf8Encode,
} from "../src/index.ts";

async function wiredMuxPair(
  onHttpRequest: NonNullable<ConstructorParameters<typeof MuxEndpoint>[0]["host"]>["onHttpRequest"],
) {
  const hostKp = await generateX25519KeyPair();
  const hostPriv = await importX25519PrivateKey(hostKp.privateKeyPkcs8B64);
  const clientHs = await startClientHandshake(hostKp.publicKeyB64);
  const { readyRaw, session: hostSession } = await acceptHostHandshake(
    { publicKeyB64: hostKp.publicKeyB64, privateKey: hostPriv },
    clientHs.helloRaw,
  );
  const clientSession = await clientHs.finish(readyRaw);

  let clientMux!: MuxEndpoint;
  const hostMux = new MuxEndpoint({
    sendFrame: (frame) =>
      hostSession.send(frame, async (sealed) => {
        const plain = await clientSession.open(sealed);
        await clientMux.handleFrame(plain);
      }),
    host: {
      onHttpRequest,
      onCallOpen: (_id, hostPort, bridge) => openHostUdpBridge(hostPort, bridge),
    },
  });
  clientMux = new MuxEndpoint({
    sendFrame: (frame) =>
      clientSession.send(frame, async (sealed) => {
        const plain = await hostSession.open(sealed);
        await hostMux.handleFrame(plain);
      }),
  });
  return { clientMux, hostMux };
}

describe("MuxEndpoint", () => {
  test("multiplexes concurrent streaming NDJSON, binary payloads > chunk limit, and abort cancellation", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let releaseAbort = () => {};
    const abortedOnHost = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });

    const { clientMux, hostMux } = await wiredMuxPair(async (head, body, signal) => {
      if (head.path === "/stream") {
        const resStream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(utf8Encode('{"chunk":1}\n'));
          },
        });
        return {
          status: 200,
          statusText: "OK",
          headers: [["content-type", "application/x-ndjson"]],
          body: resStream,
        };
      }
      if (head.path === "/echo") {
        const bytes =
          body === null
            ? new Uint8Array(0)
            : new Uint8Array(await new Response(body).arrayBuffer());
        return {
          status: 200,
          statusText: "OK",
          headers: [["content-type", "application/octet-stream"]],
          body: new Response(bytes).body,
        };
      }
      if (head.path === "/wait-abort") {
        signal.addEventListener("abort", () => releaseAbort(), { once: true });
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return { status: 404, statusText: "Not Found", headers: [], body: null };
    });

    try {
      // 1. Streaming response arrives before closing.
      const streamRes = await clientMux.request({
        method: "GET",
        path: "/stream",
        headers: [],
        body: null,
      });
      const reader = streamRes.body!.getReader();
      const first = await reader.read();
      expect(utf8Decode(first.value!)).toBe('{"chunk":1}\n');

      // 2. Concurrent binary upload larger than MAX_MUX_CHUNK completes while /stream stays open.
      const large = new Uint8Array(MAX_MUX_CHUNK + 4096);
      large.fill(0x5a);
      const echoRes = await clientMux.request({
        method: "POST",
        path: "/echo",
        headers: [["content-type", "application/octet-stream"]],
        body: new Response(large).body,
      });
      const echoed = new Uint8Array(await new Response(echoRes.body).arrayBuffer());
      expect(echoed.byteLength).toBe(large.byteLength);
      expect(echoed[0]).toBe(0x5a);
      expect(echoed[large.byteLength - 1]).toBe(0x5a);

      // Finish stream.
      streamController!.enqueue(utf8Encode('{"chunk":2}\n'));
      streamController!.close();
      const second = await reader.read();
      expect(utf8Decode(second.value!)).toBe('{"chunk":2}\n');
      expect((await reader.read()).done).toBe(true);

      // 3. Client abort sends REQ_ABORT to host request signal.
      const abortCtrl = new AbortController();
      const pendingAbort = clientMux.request({
        method: "GET",
        path: "/wait-abort",
        headers: [],
        body: null,
        signal: abortCtrl.signal,
      });
      const abortedCheck = expect(pendingAbort).rejects.toThrow("Request aborted");
      abortCtrl.abort();
      await abortedCheck;
      await abortedOnHost;
    } finally {
      clientMux.close();
      hostMux.close();
    }
  });
});

describe("WebRTC SDP rewrite & UDP call bridge", () => {
  const SAMPLE_SDP = [
    "v=0",
    "o=- 1 1 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "c=IN IP4 192.168.1.55",
    "a=candidate:1 1 udp 2122260223 127.0.0.1 45678 typ host generation 0",
    "a=candidate:2 1 udp 1686052607 203.0.113.9 45678 typ srflx raddr 127.0.0.1 rport 45678 generation 0",
    "a=end-of-candidates",
    "",
  ].join("\r\n");

  test("extracts host UDP port and rewrites candidates cleanly for Direct and Relay", () => {
    expect(extractHostUdpPort(SAMPLE_SDP)).toBe(45678);

    const relaySdp = rewriteSdpAnswer(SAMPLE_SDP, { localPort: 55100, mode: "relay" });
    expect(relaySdp).toContain("c=IN IP4 127.0.0.1");
    expect(relaySdp).toContain(
      "a=candidate:subspace 1 udp 2130706431 127.0.0.1 55100 typ host generation 0",
    );
    expect(relaySdp).not.toContain("203.0.113.9");
    expect(relaySdp).not.toContain("45678");

    const directSdp = rewriteSdpAnswer(SAMPLE_SDP, {
      localPort: 55100,
      mode: "direct",
      directHost: "100.64.0.12",
    });
    expect(directSdp).toContain("100.64.0.12 45678 typ host");
    expect(directSdp).toContain("127.0.0.1 55100 typ host");
  });

  test("forwards UDP datagrams bidirectionally over encrypted mux between browser loopback and host loopback", async () => {
    const hostEcho = createSocket("udp4");
    await new Promise<void>((resolve) => hostEcho.bind(0, "127.0.0.1", () => resolve()));
    const hostPort = hostEcho.address().port;
    hostEcho.on("message", (msg, rinfo) => {
      const reply = Buffer.from(`echo:${msg.toString("utf8")}`);
      hostEcho.send(reply, rinfo.port, rinfo.address);
    });

    const { clientMux, hostMux } = await wiredMuxPair(async () => ({
      status: 404,
      statusText: "Not Found",
      headers: [],
      body: null,
    }));
    const pool = new ClientCallBridgePool();
    const browserSock = createSocket("udp4");
    await new Promise<void>((resolve) => browserSock.bind(0, "127.0.0.1", () => resolve()));

    try {
      const sdp = SAMPLE_SDP.replaceAll("45678", String(hostPort));
      const fakeOfferRes = new Response(JSON.stringify({ pc_id: "pc-test-1", sdp }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      const adapted = await pool.adaptOfferResponse(fakeOfferRes, clientMux, { mode: "relay" });
      const adaptedJson = (await adapted.json()) as { sdp: string };
      const bridgePort = extractHostUdpPort(adaptedJson.sdp);
      expect(bridgePort).toBeNumber();
      expect(bridgePort).not.toBe(hostPort);

      const echoed = new Promise<string>((resolve) => {
        browserSock.once("message", (msg) => resolve(msg.toString("utf8")));
      });
      // Give host side a tick to process CALL_UDP_OPEN and bind its UDP socket.
      await new Promise((r) => setTimeout(r, 25));
      browserSock.send(Buffer.from("opus-packet"), bridgePort!, "127.0.0.1");
      expect(await echoed).toBe("echo:opus-packet");
    } finally {
      pool.closeAll();
      browserSock.close();
      hostEcho.close();
      clientMux.close();
      hostMux.close();
    }
  });
});

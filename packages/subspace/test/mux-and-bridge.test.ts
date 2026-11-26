import { createSocket } from "node:dgram";
import { describe, expect, test, vi } from "vitest";
import {
  acceptHostHandshake,
  ClientCallBridgePool,
  decodeMuxFrame,
  encodeMuxFrame,
  extractHostUdpPort,
  generateX25519KeyPair,
  importX25519PrivateKey,
  MAX_MUX_CHUNK,
  MUX_FRAME,
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

  test("enforces 4 MiB stream flow-control window with STREAM_CREDIT and rejects overflow", async () => {
    const STREAM_WINDOW = 4 * 1024 * 1024;
    const totalBytes = STREAM_WINDOW + 256 * 1024;
    let hostBodyFrames = 0;
    let clientCreditFrames = 0;

    let clientMux!: MuxEndpoint;
    let hostMux!: MuxEndpoint;
    const hostKp = await generateX25519KeyPair();
    const hostPriv = await importX25519PrivateKey(hostKp.privateKeyPkcs8B64);
    const clientHs = await startClientHandshake(hostKp.publicKeyB64);
    const { readyRaw, session: hostSession } = await acceptHostHandshake(
      { publicKeyB64: hostKp.publicKeyB64, privateKey: hostPriv },
      clientHs.helloRaw,
    );
    const clientSession = await clientHs.finish(readyRaw);

    hostMux = new MuxEndpoint({
      sendFrame: (frame) =>
        hostSession.send(frame, async (sealed) => {
          const plain = await clientSession.open(sealed);
          if (decodeMuxFrame(plain).type === MUX_FRAME.RES_BODY) hostBodyFrames += 1;
          await clientMux.handleFrame(plain);
        }),
      host: {
        onHttpRequest: async (head) => {
          if (head.path === "/large") {
            const payload = new Uint8Array(totalBytes);
            payload.fill(0x3c);
            return {
              status: 200,
              statusText: "OK",
              headers: [],
              body: new Response(payload).body,
            };
          }
          return { status: 404, statusText: "Not Found", headers: [], body: null };
        },
      },
    });
    clientMux = new MuxEndpoint({
      sendFrame: (frame) =>
        clientSession.send(frame, async (sealed) => {
          const plain = await hostSession.open(sealed);
          if (decodeMuxFrame(plain).type === MUX_FRAME.STREAM_CREDIT) clientCreditFrames += 1;
          await hostMux.handleFrame(plain);
        }),
    });

    try {
      const res = await clientMux.request({
        method: "GET",
        path: "/large",
        headers: [],
        body: null,
      });
      // Sender stops after sending the 4 MiB initial window before consumer reads.
      await vi.waitFor(() => {
        expect(hostBodyFrames).toBe(STREAM_WINDOW / MAX_MUX_CHUNK);
      });
      await new Promise((r) => setTimeout(r, 25));
      expect(hostBodyFrames).toBe(STREAM_WINDOW / MAX_MUX_CHUNK);
      expect(clientCreditFrames).toBe(0);

      // Reading from the response drains the buffer, returns STREAM_CREDIT, and completes all bytes.
      const received = new Uint8Array(await new Response(res.body).arrayBuffer());
      expect(received.byteLength).toBe(totalBytes);
      expect(clientCreditFrames).toBeGreaterThan(0);

      // Overflowing the 4 MiB receive window errors the stream and emits REQ_ABORT.
      const sentFrames: number[] = [];
      const standalone = new MuxEndpoint({
        sendFrame: async (frame) => {
          sentFrames.push(decodeMuxFrame(frame).type);
        },
      });
      const overflowReq = standalone.request({
        method: "GET",
        path: "/overflow",
        headers: [],
        body: null,
      });
      await standalone.handleFrame(
        encodeMuxFrame(
          MUX_FRAME.RES_HEAD,
          1,
          utf8Encode(JSON.stringify({ status: 200, statusText: "OK", headers: [] })),
        ),
      );
      const overflowRes = await overflowReq;
      const chunk = new Uint8Array(1024 * 1024);
      for (let i = 0; i < 4; i++) {
        await standalone.handleFrame(encodeMuxFrame(MUX_FRAME.RES_BODY, 1, chunk));
      }
      await standalone.handleFrame(encodeMuxFrame(MUX_FRAME.RES_BODY, 1, new Uint8Array([1])));
      await expect(overflowRes.body!.getReader().read()).rejects.toThrow("window");
      expect(sentFrames).toContain(MUX_FRAME.REQ_ABORT);
      standalone.close();
    } finally {
      clientMux.close();
      hostMux.close();
    }
  });

  test("immediately cancels idle response reader on abort and rejects pending request on upload stream error or invalid RES_ERR", async () => {
    let idleCancelled = false;
    const { clientMux, hostMux } = await wiredMuxPair(async (head) => {
      if (head.path === "/idle-sse") {
        return {
          status: 200,
          statusText: "OK",
          headers: [["content-type", "text/event-stream"]],
          body: new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(utf8Encode("data: hello\n\n"));
            },
            cancel() {
              idleCancelled = true;
            },
          }),
        };
      }
      if (head.path === "/wait-body") {
        return await new Promise<never>(() => {});
      }
      return { status: 404, statusText: "Not Found", headers: [], body: null };
    });

    try {
      // Cancelling an idle SSE response immediately cancels the host stream reader.
      const sseRes = await clientMux.request({
        method: "GET",
        path: "/idle-sse",
        headers: [],
        body: null,
      });
      const sseReader = sseRes.body!.getReader();
      expect(utf8Decode((await sseReader.read()).value!)).toBe("data: hello\n\n");
      await sseReader.cancel();
      await vi.waitFor(() => {
        expect(idleCancelled).toBe(true);
      });

      // An errored request body rejects request() immediately even before RES_HEAD arrives.
      const failingBody = new ReadableStream<Uint8Array>({
        pull() {
          throw new Error("upload stream failed");
        },
      });
      await expect(
        clientMux.request({
          method: "POST",
          path: "/wait-body",
          headers: [],
          body: failingBody,
        }),
      ).rejects.toThrow("upload stream failed");

      // Invalid UTF-8 in RES_ERR falls back cleanly without throwing out of handleFrame.
      const rawMux = new MuxEndpoint({ sendFrame: async () => {} });
      const pending = rawMux.request({ method: "GET", path: "/bad-err", headers: [], body: null });
      await rawMux.handleFrame(
        encodeMuxFrame(MUX_FRAME.RES_ERR, 1, new Uint8Array([0xff, 0xfe, 0x80])),
      );
      await expect(pending).rejects.toThrow("Remote request failed");
      rawMux.close();
    } finally {
      clientMux.close();
      hostMux.close();
    }
  });

  test("rejects >4 MiB upload with 413 without aborting host handler and stops client upload cleanly", async () => {
    let hostSignalAborted = false;
    let cancelledOnClient = false;
    const { clientMux, hostMux } = await wiredMuxPair(async (head, body, signal) => {
      signal.addEventListener("abort", () => {
        hostSignalAborted = true;
      });
      if (head.path === "/upload-limit" && body !== null) {
        const reader = body.getReader();
        const first = await reader.read();
        expect(first.value?.byteLength).toBeGreaterThan(0);
        await reader.cancel();
        return {
          status: 413,
          statusText: "Payload Too Large",
          headers: [["content-type", "application/json"]],
          body: new Response(JSON.stringify({ error: { code: "payload-too-large" } })).body,
        };
      }
      return { status: 404, statusText: "Not Found", headers: [], body: null };
    });

    try {
      let producedChunks = 0;
      const hugeUpload = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (producedChunks >= 48) {
            controller.close();
            return;
          }
          producedChunks += 1;
          controller.enqueue(new Uint8Array(256 * 1024));
        },
        cancel() {
          cancelledOnClient = true;
        },
      });
      const res = await clientMux.request({
        method: "POST",
        path: "/upload-limit",
        headers: [],
        body: hugeUpload,
      });
      expect(res.status).toBe(413);
      expect(JSON.parse(await new Response(res.body).text())).toEqual({
        error: { code: "payload-too-large" },
      });
      expect(hostSignalAborted).toBe(false);
      await vi.waitFor(() => {
        expect(cancelledOnClient).toBe(true);
      });
      expect(producedChunks).toBeLessThan(48);
    } finally {
      clientMux.close();
      hostMux.close();
    }
  });

  test("cancels unread unlocked request body immediately after onHttpRequest returns before long-lived response ends", async () => {
    let cancelledOnClient = false;
    let releaseResponse: (() => void) | null = null;
    const { clientMux, hostMux } = await wiredMuxPair(async (head) => {
      if (head.path === "/early-stream") {
        // Deliberately ignore request `body` and return an open SSE stream.
        const responseBody = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(utf8Encode("data: open\n\n"));
            releaseResponse = () => controller.close();
          },
        });
        return {
          status: 200,
          statusText: "OK",
          headers: [["content-type", "text/event-stream"]],
          body: responseBody,
        };
      }
      return { status: 404, statusText: "Not Found", headers: [], body: null };
    });

    try {
      let produced = 0;
      const uploadBody = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (produced >= 48) {
            controller.close();
            return;
          }
          produced += 1;
          controller.enqueue(new Uint8Array(256 * 1024));
        },
        cancel() {
          cancelledOnClient = true;
        },
      });
      const res = await clientMux.request({
        method: "POST",
        path: "/early-stream",
        headers: [],
        body: uploadBody,
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      expect(utf8Decode((await reader.read()).value!)).toBe("data: open\n\n");

      // REQ_STOP must cancel the client upload BEFORE the SSE response finishes!
      await vi.waitFor(() => {
        expect(cancelledOnClient).toBe(true);
      });
      releaseResponse!();
      expect((await reader.read()).done).toBe(true);
    } finally {
      clientMux.close();
      hostMux.close();
    }
  });

  test("isolates STREAM_CREDIT by direction so RES_BODY credits cannot replenish REQ_BODY uploads", async () => {
    let seenReqChunks = 0;
    const sentTypes: number[] = [];
    let unblockHostRead: (() => void) | null = null;
    const hostPaused = new Promise<void>((resolve) => {
      unblockHostRead = resolve;
    });

    let serverMux!: MuxEndpoint;
    const clientMux = new MuxEndpoint({
      sendFrame: async (frame) => {
        await serverMux.handleFrame(frame);
      },
    });
    serverMux = new MuxEndpoint({
      sendFrame: async (frame) => {
        sentTypes.push(decodeMuxFrame(frame).type);
        await clientMux.handleFrame(frame);
      },
      host: {
        onHttpRequest: async (_head, body) => {
          await hostPaused;
          const reader = body!.getReader();
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
            seenReqChunks += 1;
          }
          return { status: 200, statusText: "OK", headers: [], body: null };
        },
      },
    });

    try {
      let enqueued = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (enqueued >= 40) {
            controller.close();
            return;
          }
          enqueued += 1;
          controller.enqueue(new Uint8Array(128 * 1024));
        },
      });
      const reqPromise = clientMux.request({
        method: "POST",
        path: "/dir-credit",
        headers: [],
        body,
      });

      // Wait until the 4 MiB upload window saturates.
      await vi.waitFor(() => {
        expect(enqueued).toBeGreaterThanOrEqual(32);
      });
      const beforeSpoof = enqueued;

      // Spoof a RES_BODY credit frame on stream 1: must NOT unblock REQ_BODY upload window.
      const wrongDir = new Uint8Array(5);
      wrongDir[0] = MUX_FRAME.RES_BODY;
      new DataView(wrongDir.buffer).setUint32(1, 2 * 1024 * 1024, false);
      await clientMux.handleFrame(encodeMuxFrame(MUX_FRAME.STREAM_CREDIT, 1, wrongDir));
      await new Promise((r) => setTimeout(r, 25));
      expect(enqueued).toBe(beforeSpoof);

      unblockHostRead!();
      const res = await reqPromise;
      expect(res.status).toBe(200);
      await res.body?.cancel();
      expect(seenReqChunks).toBe(40);
      expect(sentTypes).toContain(MUX_FRAME.STREAM_CREDIT);
    } finally {
      clientMux.close();
      serverMux.close();
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
      expect(pool.activeCount).toBe(1);

      // Sending a DTLS close alert (>=13 bytes, byte[0] === 21) schedules bridge teardown.
      const dtlsAlert = new Uint8Array(15);
      dtlsAlert[0] = 21;
      browserSock.send(dtlsAlert, bridgePort!, "127.0.0.1");
      await vi.waitFor(() => {
        expect(pool.activeCount).toBe(0);
      });

      // Closed mux during adaptOfferResponse rejects cleanly without adding a bridge.
      clientMux.close();
      await expect(
        pool.adaptOfferResponse(
          new Response(JSON.stringify({ pc_id: "pc-closed", sdp }), { status: 200 }),
          clientMux,
          { mode: "relay" },
        ),
      ).rejects.toThrow("Subspace tunnel is closed");
      expect(pool.activeCount).toBe(0);
    } finally {
      pool.closeAll();
      browserSock.close();
      hostEcho.close();
      clientMux.close();
      hostMux.close();
    }
  });

  test("ignores epoch-0 warning DTLS alerts while closing on fatal/close_notify alerts", async () => {
    const hostEcho = createSocket("udp4");
    await new Promise<void>((resolve) => hostEcho.bind(0, "127.0.0.1", () => resolve()));
    const hostPort = hostEcho.address().port;
    hostEcho.on("message", (msg, rinfo) => {
      hostEcho.send(Buffer.from(`echo:${msg.toString("utf8")}`), rinfo.port, rinfo.address);
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
      const adapted = await pool.adaptOfferResponse(
        new Response(JSON.stringify({ pc_id: "pc-warn-alert", sdp }), { status: 200 }),
        clientMux,
        { mode: "relay" },
      );
      const { sdp: rewritten } = (await adapted.json()) as { sdp: string };
      const bridgePort = extractHostUdpPort(rewritten)!;

      // Plaintext epoch-0 DTLS warning alert (level=1, desc=100) must NOT tear down the bridge
      // even well past DTLS_ALERT_CLOSE_DELAY_MS (200 ms).
      const warnAlert = new Uint8Array(15);
      warnAlert[0] = 21;
      warnAlert[13] = 1;
      warnAlert[14] = 100;
      browserSock.send(warnAlert, bridgePort, "127.0.0.1");
      await new Promise((r) => setTimeout(r, 260));
      expect(pool.activeCount).toBe(1);
      const stillAlive = new Promise<string>((resolve) => {
        browserSock.once("message", (msg) => resolve(msg.toString("utf8")));
      });
      browserSock.send(Buffer.from("still-alive"), bridgePort, "127.0.0.1");
      expect(await stillAlive).toBe("echo:still-alive");

      // Fatal alert (level=2) on epoch 0 DOES tear down the bridge.
      const fatalAlert = new Uint8Array(15);
      fatalAlert[0] = 21;
      fatalAlert[13] = 2;
      fatalAlert[14] = 40;
      browserSock.send(fatalAlert, bridgePort, "127.0.0.1");
      await vi.waitFor(() => {
        expect(pool.activeCount).toBe(0);
      });
    } finally {
      pool.closeAll();
      browserSock.close();
      hostEcho.close();
      clientMux.close();
      hostMux.close();
    }
  });
});

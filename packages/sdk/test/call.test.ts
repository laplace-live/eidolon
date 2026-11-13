import { beforeAll, describe, expect, test } from "bun:test";
import React, { act, Suspense, startTransition, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  callErrorStatus,
  DEFAULT_ICE_SERVERS,
  DeviceError,
  EidolonApiError,
  EidolonClient,
  enumerateAudioInputs,
  fetchIceServers,
  forgetMemories,
  gatherNetworkInfo,
  isAudioQuality,
  isRateLimitCallError,
  type LocalChatOfferRequestData,
  listMemories,
  newChatHeader,
  normalizeDeviceErrorReason,
  parseBotReadyData,
  parseErrorMessage,
  parseMarkupWithState,
  parseServerMessage,
  RTVIEvent,
  resolveSelectedMicId,
  StartBotError,
  SYSTEM_DEFAULT_MIC_ID,
  speakerOf,
  toApiRequest,
  toLiveMicId,
  uuidv7,
} from "../src/index.ts";
import { type ConversationAction, dispatchSentText } from "../src/react/conversation.ts";
import {
  EidolonClientProvider,
  type EidolonConversationControls,
  type EidolonMicDevices,
  EMPTY_CONVERSATION_STATE,
  isBotOutputText,
  stepConversation,
  useEidolonConversation,
  useEidolonMicDevices,
} from "../src/react/index.ts";
import { runLiveMicSwap } from "../src/react/mic-devices.ts";

beforeAll(() => {
  // @pipecat-ai/client-js reads `window?.navigator?.userAgent` with an unguarded `window` identifier.
  if (typeof globalThis.window === "undefined") {
    Object.defineProperty(globalThis, "window", {
      value: globalThis,
      configurable: true,
    });
  }
});

describe("RTVI message parsers and call error classifiers", () => {
  test("parseServerMessage discriminates selfie, chat-line, speaker, and unknown payloads", () => {
    expect(
      parseServerMessage({
        type: "selfie",
        urls: ["/api/selfie/abc.png", "https://evil.example/steal.png"],
        persona: "milky-green",
      }),
    ).toEqual({
      type: "selfie",
      urls: ["/api/selfie/abc.png"],
      persona: "milky-green",
    });

    expect(parseServerMessage({ type: "selfie", urls: ["https://evil.example/x.png"] })).toEqual({
      type: "selfie",
      urls: [],
      persona: null,
    });

    const parsedSpeaker = parseServerMessage({
      type: "speaker",
      persona: "milky-green",
      name: "明前奶绿",
    });
    expect(parsedSpeaker).toEqual({
      type: "speaker",
      speaker: { persona: "milky-green", name: "明前奶绿" },
    });
    expect(speakerOf({ type: "speaker", persona: "milky-green", name: "明前奶绿" })).toEqual({
      persona: "milky-green",
      name: "明前奶绿",
    });
    expect(speakerOf(parsedSpeaker)).toEqual({ persona: "milky-green", name: "明前奶绿" });

    expect(
      parseServerMessage({
        type: "chat-line",
        event: {
          seq: 1,
          at: 100,
          type: "message",
          id: "m1",
          speaker: { kind: "user" },
          text: "你好",
          modality: "call",
        },
      }),
    ).toMatchObject({ type: "chat-line" });

    expect(parseServerMessage({ type: "custom-thing" })).toEqual({
      type: "unknown",
      raw: { type: "custom-thing" },
    });
  });

  test("parseBotReadyData, parseErrorMessage, device errors, and rate-limit detection", () => {
    expect(
      parseBotReadyData({
        version: "2.2.0",
        about: { library: "laplace-eidolon", library_version: "0.8.0" },
        capabilities: { metrics: true },
      }),
    ).toEqual({
      version: "2.2.0",
      about: { library: "laplace-eidolon", library_version: "0.8.0" },
      rawAbout: { library: "laplace-eidolon", library_version: "0.8.0" },
      capabilities: { metrics: true },
    });

    expect(
      parseErrorMessage({
        id: "e1",
        label: "rtvi-ai",
        type: "error",
        data: { error: "LLM failed", fatal: false },
      }),
    ).toEqual({
      id: "e1",
      type: "error",
      data: { error: "LLM failed", fatal: false },
      rawData: { error: "LLM failed", fatal: false },
    });

    expect(normalizeDeviceErrorReason("permissions")).toBe("blocked");
    expect(normalizeDeviceErrorReason("in-use")).toBe("already-in-use");
    expect(normalizeDeviceErrorReason("constraints")).toBe("invalid-constraints");
    expect(normalizeDeviceErrorReason("undefined-mediadevices")).toBe("not-supported");
    expect(normalizeDeviceErrorReason(new DeviceError(["mic"], "not-found").type)).toBe(
      "not-found",
    );
    expect(
      normalizeDeviceErrorReason("unknown", {
        sourceError: Object.assign(new Error("Denied"), { name: "NotAllowedError" }),
      }),
    ).toBe("blocked");
    expect(
      normalizeDeviceErrorReason("unknown", {
        sourceError: Object.assign(new Error("Busy"), { name: "NotReadableError" }),
      }),
    ).toBe("already-in-use");
    expect(
      normalizeDeviceErrorReason("unknown", {
        sourceError: Object.assign(new Error("Missing"), { name: "NotFoundError" }),
      }),
    ).toBe("not-found");
    expect(
      normalizeDeviceErrorReason("unknown", {
        sourceError: Object.assign(new Error("Constraint"), { name: "OverconstrainedError" }),
      }),
    ).toBe("invalid-constraints");

    const quotaErr = new StartBotError("Too many requests", 429);
    expect(callErrorStatus(quotaErr)).toBe(429);
    expect(isRateLimitCallError(quotaErr)).toBe(true);
    expect(isRateLimitCallError(new StartBotError("Bad gateway", 502))).toBe(false);
    expect(isRateLimitCallError(new Error("network down"))).toBe(false);
  });
});

describe("signalling, memories, devices, stats, and EidolonClient", () => {
  test("toApiRequest serializes ChatWindow and AudioQuality cleanly", () => {
    expect(isAudioQuality("best")).toBe(true);
    expect(isAudioQuality("medium")).toBe(true);
    expect(isAudioQuality("lossless")).toBe(false);

    const header = newChatHeader(["milky-green"], 100);
    const req = toApiRequest({
      endpoint: "https://bot.example/api/offer",
      requestData: {
        audioQuality: "best",
        loginSyncToken: "tok_123",
        persona: "milky-green",
        chat: { header, events: [] },
      },
    });
    expect(req.endpoint).toBe("https://bot.example/api/offer");
    expect(req.requestData).toMatchObject({
      audioQuality: "best",
      loginSyncToken: "tok_123",
      persona: "milky-green",
      chat: { header, events: [] },
    });
  });

  test("fetchIceServers, listMemories, and forgetMemories handle success and failures", async () => {
    const client = new EidolonClient({
      fetch: async (url) => {
        if (url.endsWith("/api/ice-servers")) {
          return Response.json({
            iceServers: [{ urls: "turn:turn.example.com:3478", username: "u", credential: "p" }],
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    expect(client.iceServers).toEqual([...DEFAULT_ICE_SERVERS]);
    const refreshed = await client.refreshIceServers("https://bot.example/");
    expect(refreshed).toEqual([
      { urls: "turn:turn.example.com:3478", username: "u", credential: "p" },
    ]);
    expect(client.iceServers).toEqual(refreshed);

    // An empty list is valid (localhost without TURN); HTTP 500 throws so connect() doesn't dial stale TURN.
    expect(
      await fetchIceServers("https://bot.example", {
        fetch: async () => Response.json({ iceServers: [] }),
      }),
    ).toEqual([]);
    await expect(
      fetchIceServers("https://bot.example", {
        fetch: async () => new Response("err", { status: 500 }),
      }),
    ).rejects.toThrow("HTTP 500");

    const unsub = client.on("connected", () => {});
    unsub();

    const listed = await listMemories({
      baseUrl: "https://bot.example/",
      token: "sync_tok",
      userId: "u_42",
      fetch: async (url, init) => {
        expect(url).toBe("https://bot.example/api/memories");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer sync_tok");
        return Response.json({
          user_id: "u_42",
          uname: "奶绿粉丝",
          count: 99,
          memories: [
            { id: "mem_1", memory: "Likes matcha", categories: ["food"] },
            { malformed: true },
          ],
        });
      },
    });
    expect(listed).toEqual({
      user_id: "u_42",
      uname: "奶绿粉丝",
      count: 1,
      memories: [{ id: "mem_1", memory: "Likes matcha", categories: ["food"] }],
    });

    const wiped = await forgetMemories({
      baseUrl: "https://bot.example/",
      token: "sync_tok",
      fetch: async () => Response.json({ ok: true, user_id: "u_42" }),
    });
    expect(wiped).toEqual({ ok: true, user_id: "u_42" });

    await expect(
      forgetMemories({
        baseUrl: "https://bot.example",
        fetch: async () => new Response("Unauthorized", { status: 401 }),
      }),
    ).rejects.toBeInstanceOf(EidolonApiError);

    // 2xx responses without `{ ok: true, user_id: string }` (such as an HTML proxy fallback) throw EidolonApiError.
    await expect(
      forgetMemories({
        baseUrl: "https://bot.example",
        fetch: async () => new Response("<!doctype html>", { status: 200 }),
      }),
    ).rejects.toBeInstanceOf(EidolonApiError);
    await expect(
      forgetMemories({
        baseUrl: "https://bot.example",
        fetch: async () => Response.json({ ok: false, user_id: "u_42" }),
      }),
    ).rejects.toBeInstanceOf(EidolonApiError);
    await expect(
      forgetMemories({
        baseUrl: "https://bot.example",
        fetch: async () => Response.json({ ok: true }),
      }),
    ).rejects.toBeInstanceOf(EidolonApiError);

    const validLocalOffer: LocalChatOfferRequestData = {
      chatId: "chat-1",
      persona: "milky-green",
    };
    expect(validLocalOffer.persona).toBe("milky-green");
    // @ts-expect-error local /api/offer requires persona even for group calls
    const _missingPersona: LocalChatOfferRequestData = { chatId: "chat-1" };
    void _missingPersona;
  });

  test("device selection helpers and gatherNetworkInfo", async () => {
    expect(toLiveMicId(SYSTEM_DEFAULT_MIC_ID)).toBe("");
    expect(toLiveMicId("usb-mic")).toBe("usb-mic");

    const fakeDevices = [
      {
        deviceId: "default",
        kind: "audioinput",
        label: "Default",
        groupId: "g1",
        toJSON: () => ({}),
      },
      {
        deviceId: "communications",
        kind: "audioinput",
        label: "Comms",
        groupId: "g1",
        toJSON: () => ({}),
      },
      {
        deviceId: "usb-1",
        kind: "audioinput",
        label: "USB Mic",
        groupId: "g2",
        toJSON: () => ({}),
      },
      { deviceId: "cam-1", kind: "videoinput", label: "Cam", groupId: "g3", toJSON: () => ({}) },
    ] as MediaDeviceInfo[];
    const mics = await enumerateAudioInputs({ enumerateDevices: async () => fakeDevices });
    expect(mics.map((m) => m.deviceId)).toEqual(["default", "usb-1"]);
    expect(resolveSelectedMicId(mics, "usb-1")).toBe("usb-1");
    expect(resolveSelectedMicId(mics, "unplugged")).toBe(SYSTEM_DEFAULT_MIC_ID);

    const statsMap = new Map<string, unknown>([
      ["transport-1", { id: "transport-1", type: "transport", selectedCandidatePairId: "pair-1" }],
      [
        "pair-1",
        {
          id: "pair-1",
          type: "candidate-pair",
          state: "succeeded",
          nominated: true,
          localCandidateId: "loc-1",
          remoteCandidateId: "rem-1",
          currentRoundTripTime: 0.032,
          bytesSent: 1024,
          bytesReceived: 4096,
        },
      ],
      [
        "loc-1",
        {
          id: "loc-1",
          type: "local-candidate",
          candidateType: "relay",
          protocol: "udp",
          relayProtocol: "tls",
          address: "203.0.113.10",
        },
      ],
      [
        "rem-1",
        {
          id: "rem-1",
          type: "remote-candidate",
          candidateType: "host",
          address: "198.51.100.5",
        },
      ],
    ]);
    const info = await gatherNetworkInfo({
      getStats: async () => statsMap as unknown as RTCStatsReport,
    } as RTCPeerConnection);
    expect(info).toEqual({
      localCandidateType: "relay",
      remoteCandidateType: "host",
      localAddress: "203.0.113.10",
      remoteAddress: "198.51.100.5",
      protocol: "udp",
      relayProtocol: "tls",
      currentRoundTripTime: 0.032,
      bytesSent: 1024,
      bytesReceived: 4096,
    });
  });

  test("EidolonClient bridges remote bot tracks, muted mic tracks, mediaState, and pre-PC disconnect", async () => {
    const client = new EidolonClient({ enableMic: false });
    const raw = client.rawClient as unknown as {
      emit: (event: string, ...args: unknown[]) => void;
    };

    const botTrack = { id: "bot-audio-1", kind: "audio", readyState: "live" } as MediaStreamTrack;
    const localTrack = {
      id: "local-audio-1",
      kind: "audio",
      enabled: true,
      readyState: "live",
      stop() {
        (this as { readyState: string }).readyState = "ended";
      },
    } as unknown as MediaStreamTrack;

    // Remote trackStarted populates client.tracks().bot.audio; local trackStopped does not wipe it.
    raw.emit(RTVIEvent.TrackStarted, botTrack, { id: "bot", name: "bot", local: false });
    expect(client.tracks().bot?.audio).toBe(botTrack);
    raw.emit(RTVIEvent.TrackStopped, localTrack, { id: "local", name: "", local: true });
    expect(client.tracks().bot?.audio).toBe(botTrack);

    // Local trackStarted while enableMic: false immediately forces track.enabled = false.
    raw.emit(RTVIEvent.TrackStarted, localTrack, { id: "local", name: "", local: true });
    expect(localTrack.enabled).toBe(false);

    // Without a live local mic track, connected state does NOT falsely promote "uninitialized" to "granted".
    Reflect.set(client.rawTransport, "_state", "connected");
    expect(client.mediaState.mic.state).toBe("uninitialized");

    // DeviceError with type "unknown" normalizes details.sourceError on mediaState.
    Reflect.set(client.rawClient, "_mediaState", {
      mic: {
        state: "error",
        reason: "unknown",
        details: { sourceError: Object.assign(new Error("Denied"), { name: "NotAllowedError" }) },
      },
      cam: { state: "uninitialized" },
    });
    expect(client.mediaState.mic).toMatchObject({ state: "error", reason: "blocked" });

    // Once a live mic stream exists on _wavRecorder, connected state promotes "uninitialized" to "granted",
    // muted selectLiveMic()/connect() still disable track.enabled + replace sender track when WavMediaManager
    // skips _startRecording(), and disconnect() with _initialized === false closes both stream and AudioContext.
    let endedCalls = 0;
    let closedContext = false;
    let replacedTrack: MediaStreamTrack | null = null;
    const makeFreshTrack = () =>
      ({
        id: "local-audio-1",
        kind: "audio",
        enabled: true,
        readyState: "live",
        stop() {
          (this as { readyState: string }).readyState = "ended";
        },
      }) as unknown as MediaStreamTrack;
    let activeTrack = makeFreshTrack();
    const mediaManager = Reflect.get(client.rawTransport, "mediaManager") as {
      connect: () => Promise<void>;
    };
    Reflect.set(mediaManager, "_wavStreamPlayer", {
      connect: async () => true,
      interrupt: async () => {},
    });
    const fakeRecorder: {
      getStatus: () => string;
      begin: () => Promise<boolean>;
      listenForDeviceChange: () => void;
      listenForDeviceErrors: () => void;
      end: () => Promise<void>;
      processor: { context: { state: string; close: () => Promise<void> } } | null;
      stream: {
        getTracks: () => MediaStreamTrack[];
        getAudioTracks: () => MediaStreamTrack[];
      } | null;
    } = {
      getStatus: () => (fakeRecorder.stream === null ? "ended" : "paused"),
      begin: async () => {
        activeTrack = makeFreshTrack();
        fakeRecorder.stream = {
          getTracks: () => [activeTrack],
          getAudioTracks: () => [activeTrack],
        };
        return true;
      },
      listenForDeviceChange: () => {},
      listenForDeviceErrors: () => {},
      end: async () => {
        endedCalls++;
        fakeRecorder.stream = null;
      },
      processor: {
        context: {
          state: "running",
          close: async () => {
            closedContext = true;
          },
        },
      },
      stream: {
        getTracks: () => [activeTrack],
        getAudioTracks: () => [activeTrack],
      },
    };
    Reflect.set(mediaManager, "_wavRecorder", fakeRecorder);
    class FakePeerConnection {
      close() {}
      getSenders() {
        return [];
      }
      getTransceivers() {
        return [
          {
            sender: {
              replaceTrack: async (t: MediaStreamTrack) => {
                replacedTrack = t;
              },
            },
          },
        ];
      }
    }
    const prevRTC = globalThis.RTCPeerConnection;
    Object.assign(globalThis, { RTCPeerConnection: FakePeerConnection });
    try {
      Reflect.set(client.rawTransport, "pc", new FakePeerConnection());
      await client.selectLiveMic("usb-1");
      expect(activeTrack.enabled).toBe(false);
      expect<MediaStreamTrack | null>(replacedTrack).toBe(activeTrack);
    } finally {
      Object.assign(globalThis, { RTCPeerConnection: prevRTC });
      Reflect.set(client.rawTransport, "pc", null);
    }
    Reflect.set(client.rawClient, "_mediaState", {
      mic: { state: "uninitialized" },
      cam: { state: "uninitialized" },
    });
    expect(client.mediaState.mic.state).toBe("granted");

    // _initialized is still false here; disconnect() must still release _wavRecorder and AudioContext.
    await client.disconnect();
    expect(endedCalls).toBe(2);
    expect(closedContext).toBe(true);
    expect(activeTrack.readyState).toBe("ended");

    // Muted connect() also disables the newly acquired getUserMedia track.
    await mediaManager.connect();
    expect(activeTrack.enabled).toBe(false);
    await client.disconnect();

    // An in-flight selectLiveMic() awaiting getUserMedia when disconnect() runs settles before
    // disconnect() resolves and stops the newly opened capture instead of leaving the mic live.
    Reflect.set(client.rawTransport, "_state", "connected");
    let markBeginStarted!: () => void;
    const beginStarted = new Promise<void>((resolve) => {
      markBeginStarted = resolve;
    });
    let beginCalls = 0;
    let finishBegin!: () => void;
    const origBegin = fakeRecorder.begin;
    fakeRecorder.begin = () => {
      beginCalls += 1;
      markBeginStarted();
      return new Promise<boolean>((resolve) => {
        finishBegin = () => {
          void origBegin().then(resolve);
        };
      });
    };
    let leakedTrackStarted = false;
    const offLeak = client.on("trackStarted", (_track, participant) => {
      if (participant?.local === true) leakedTrackStarted = true;
    });
    replacedTrack = null;
    Object.assign(globalThis, { RTCPeerConnection: FakePeerConnection });
    const origClientDisconnect = client.rawClient.disconnect.bind(client.rawClient);
    Reflect.set(client.rawClient, "disconnect", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
    try {
      Reflect.set(client.rawTransport, "pc", new FakePeerConnection());
      const pendingSwap = client.selectLiveMic("usb-1");
      const queuedSwap = client.selectLiveMic("usb-2");
      await beginStarted;
      let beginSettled = false;
      setTimeout(() => {
        beginSettled = true;
        finishBegin();
      }, 10);
      await client.disconnect();
      // disconnect() must wait for the in-flight swap, skip queued swaps, never replace RTP sender tracks, and stop capture.
      expect(beginSettled).toBe(true);
      expect(beginCalls).toBe(1);
      expect(replacedTrack).toBeNull();
      expect(activeTrack.readyState).toBe("ended");
      expect(fakeRecorder.stream).toBeNull();
      await Promise.all([pendingSwap, queuedSwap]);
    } finally {
      Reflect.set(client.rawClient, "disconnect", origClientDisconnect);
      Object.assign(globalThis, { RTCPeerConnection: prevRTC });
      Reflect.set(client.rawTransport, "pc", null);
    }
    offLeak();
    fakeRecorder.begin = origBegin;
    expect(activeTrack.readyState).toBe("ended");
    expect(fakeRecorder.stream).toBeNull();
    expect(leakedTrackStarted).toBe(false);

    // runLiveMicSwap catches selectLiveMic rejections and ignores stale swaps from an older client/generation.
    const swapErrors: string[] = [];
    let settledCount = 0;
    runLiveMicSwap(
      {
        selectLiveMic: async () => {
          throw "mic busy";
        },
      },
      "usb-2",
      {
        onError: (err) => swapErrors.push(err.message),
        onSettled: () => {
          settledCount++;
        },
      },
    );
    runLiveMicSwap(
      {
        selectLiveMic: async () => {
          throw new Error("stale client error");
        },
      },
      "usb-stale",
      {
        isCurrent: () => false,
        onError: (err) => swapErrors.push(err.message),
        onSettled: () => {
          settledCount++;
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(swapErrors).toEqual(["mic busy"]);
    expect(settledCount).toBe(2);

    // EidolonClient.sendText records run_immediately so queued sends do not interrupt active speech.
    Reflect.set(client.rawClient, "sendText", async (_content: string) => "msg_q1");
    const queuedId = await client.sendText("queued note", { run_immediately: false });
    expect(client.wasTextSentImmediately(queuedId)).toBe(false);
    Reflect.set(client.rawClient, "sendText", async (_content: string) => "msg_i1");
    const immediateId = await client.sendText("interrupt now");
    expect(client.wasTextSentImmediately(immediateId)).toBe(true);

    raw.emit(RTVIEvent.Disconnected);
    expect(client.tracks().bot).toBeUndefined();
  });

  test("EidolonClient.connect rejects promptly and releases audio contexts when AudioWorklet init fails", async () => {
    for (const enableMic of [true, false]) {
      const client = new EidolonClient({ enableMic });
      const manager = Reflect.get(client.rawTransport, "mediaManager") as object;
      let micTrackEnded = false;
      let recorderContextClosed = false;
      let playerContextClosed = false;

      const recorderStub: {
        getStatus: () => string;
        begin: () => Promise<boolean>;
        listenForDeviceChange: () => void;
        listenForDeviceErrors: () => void;
        end: () => Promise<void>;
        processor: { context: { state: string; close: () => Promise<void> } };
        stream: {
          getTracks: () => MediaStreamTrack[];
          getAudioTracks: () => MediaStreamTrack[];
        } | null;
      } = {
        getStatus: () => (recorderStub.stream === null ? "ended" : "paused"),
        begin: async () => {
          const track = {
            id: "init-mic",
            kind: "audio",
            enabled: true,
            readyState: "live",
            stop() {
              micTrackEnded = true;
              (this as { readyState: string }).readyState = "ended";
            },
          } as unknown as MediaStreamTrack;
          recorderStub.stream = { getTracks: () => [track], getAudioTracks: () => [track] };
          return true;
        },
        listenForDeviceChange: () => {},
        listenForDeviceErrors: () => {},
        end: async () => {
          recorderStub.stream = null;
        },
        processor: {
          context: {
            state: "running",
            close: async () => {
              recorderContextClosed = true;
            },
          },
        },
        stream: null,
      };
      const playerStub: {
        context: { state: string; close: () => Promise<void> } | null;
        connect: () => Promise<boolean>;
        interrupt: () => Promise<void>;
      } = {
        context: null,
        connect: async () => {
          playerStub.context = {
            state: "running",
            close: async () => {
              playerContextClosed = true;
            },
          };
          throw new Error("Could not add audioWorklet module");
        },
        interrupt: async () => {},
      };

      Reflect.set(manager, "_wavRecorder", recorderStub);
      Reflect.set(manager, "_wavStreamPlayer", playerStub);

      const outcome = await Promise.race([
        client
          .connect({ endpoint: "https://bot.example/api/offer" })
          .then(() => "resolved" as const)
          .catch((err: unknown) => (err instanceof Error ? err.message : String(err))),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 50)),
      ]);

      expect(outcome).toBe("Could not add audioWorklet module");
      expect(client.state).toBe("disconnected");
      expect(micTrackEnded).toBe(true);
      expect(recorderContextClosed).toBe(true);
      expect(playerContextClosed).toBe(true);
    }

    // When initDevices succeeds, connect() initializes devices once rather than re-entering
    // PipecatClient.connect()'s unguarded initDevices() branch.
    const okClient = new EidolonClient({ enableMic: true });
    const initStates: string[] = [];
    okClient.on("transportStateChanged", (state) => {
      if (state === "initializing") initStates.push(state);
    });
    const okManager = Reflect.get(okClient.rawTransport, "mediaManager") as object;
    let playerConnectCalls = 0;
    Reflect.set(okManager, "_wavRecorder", {
      getStatus: () => "ended",
      begin: async () => true,
      listenForDeviceChange: () => {},
      listenForDeviceErrors: () => {},
      end: async () => {},
      record: async () => true,
      processor: null,
      stream: null,
    });
    Reflect.set(okManager, "_wavStreamPlayer", {
      context: null,
      connect: async () => {
        playerConnectCalls += 1;
        return true;
      },
      interrupt: async () => {},
    });
    Reflect.set(okClient.rawTransport, "_connect", async () => {
      throw new Error("offer refused");
    });
    await expect(okClient.connect({ endpoint: "https://bot.example/api/offer" })).rejects.toThrow(
      "offer refused",
    );
    expect(initStates).toEqual(["initializing"]);
    expect(playerConnectCalls).toBe(1);
  });

  test("EidolonClient.disconnect cancels pending initDevices and transport connect without starting a call", async () => {
    const client = new EidolonClient({ enableMic: true });
    const manager = Reflect.get(client.rawTransport, "mediaManager") as object;
    const states: string[] = [];
    client.on("transportStateChanged", (state) => {
      states.push(state);
    });

    let markBeginStarted!: () => void;
    const beginStarted = new Promise<void>((resolve) => {
      markBeginStarted = resolve;
    });
    let finishBegin!: () => void;
    let micTrackEnded = false;
    let recorderContextClosed = false;
    let playerContextClosed = false;
    let offerConnectCalls = 0;

    const recorderStub: {
      getStatus: () => string;
      begin: () => Promise<boolean>;
      listenForDeviceChange: () => void;
      listenForDeviceErrors: () => void;
      end: () => Promise<void>;
      record: () => Promise<boolean>;
      processor: { context: { state: string; close: () => Promise<void> } } | null;
      stream: {
        getTracks: () => MediaStreamTrack[];
        getAudioTracks: () => MediaStreamTrack[];
      } | null;
    } = {
      getStatus: () => (recorderStub.stream === null ? "ended" : "paused"),
      begin: () => {
        markBeginStarted();
        return new Promise<boolean>((resolve) => {
          finishBegin = () => {
            micTrackEnded = false;
            recorderContextClosed = false;
            const track = {
              id: "late-init-mic",
              kind: "audio",
              enabled: true,
              readyState: "live",
              stop() {
                micTrackEnded = true;
                (this as { readyState: string }).readyState = "ended";
              },
            } as unknown as MediaStreamTrack;
            recorderStub.processor = {
              context: {
                state: "running",
                close: async () => {
                  recorderContextClosed = true;
                  if (recorderStub.processor) recorderStub.processor.context.state = "closed";
                },
              },
            };
            recorderStub.stream = { getTracks: () => [track], getAudioTracks: () => [track] };
            resolve(true);
          };
        });
      },
      listenForDeviceChange: () => {},
      listenForDeviceErrors: () => {},
      end: async () => {
        recorderStub.stream = null;
      },
      record: async () => true,
      processor: null,
      stream: null,
    };

    const playerStub: {
      context: { state: string; close: () => Promise<void> } | null;
      connect: () => Promise<boolean>;
      interrupt: () => Promise<void>;
    } = {
      context: null,
      connect: async () => {
        playerContextClosed = false;
        playerStub.context = {
          state: "running",
          close: async () => {
            playerContextClosed = true;
            if (playerStub.context) playerStub.context.state = "closed";
          },
        };
        return true;
      },
      interrupt: async () => {},
    };

    Reflect.set(manager, "_wavRecorder", recorderStub);
    Reflect.set(manager, "_wavStreamPlayer", playerStub);
    Reflect.set(client.rawTransport, "_connect", async () => {
      offerConnectCalls += 1;
    });

    const pendingConnect = client.connect({ endpoint: "https://bot.example/api/offer" });
    await beginStarted;

    // Hang up while the microphone permission prompt is still open.
    await client.disconnect();
    expect(client.state).toBe("disconnected");

    // Permission prompt resolves after hangup: capture and AudioContexts close immediately, and no offer goes out.
    finishBegin();
    await expect(pendingConnect).rejects.toThrow("Connection cancelled");
    expect(offerConnectCalls).toBe(0);
    expect(client.state).toBe("disconnected");
    expect(client.mediaState.mic.state).toBe("uninitialized");
    expect(states).not.toContain("initialized");
    expect(micTrackEnded).toBe(true);
    expect(recorderContextClosed).toBe(true);
    expect(playerContextClosed).toBe(true);

    // Even if a custom initDevices implementation resolves normally after disconnect(), connect() still aborts.
    const customInitClient = new EidolonClient({ enableMic: true });
    let resolveCustomInit!: () => void;
    let customConnectCalls = 0;
    Reflect.set(
      customInitClient.rawClient,
      "initDevices",
      () =>
        new Promise<void>((resolve) => {
          resolveCustomInit = () => {
            Reflect.set(customInitClient.rawTransport, "_state", "initialized");
            resolve();
          };
        }),
    );
    Reflect.set(customInitClient.rawClient, "connect", async () => {
      customConnectCalls += 1;
      return { version: "1.0.0" };
    });
    const pendingCustom = customInitClient.connect({ endpoint: "https://bot.example/api/offer" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await customInitClient.disconnect();
    resolveCustomInit();
    await expect(pendingCustom).rejects.toThrow("Connection cancelled");
    expect(customConnectCalls).toBe(0);
    expect(customInitClient.state).toBe("disconnected");

    // When devices were pre-initialized (_initialized === true) and connect() blocks inside
    // mediaManager.connect() (_wavRecorder.record()), hanging up closes capture and skips peer setup.
    const mutedInitClient = new EidolonClient({ enableMic: true });
    const mutedManager = Reflect.get(mutedInitClient.rawTransport, "mediaManager") as object;
    Reflect.set(mutedManager, "_initialized", true);
    Reflect.set(mutedInitClient.rawTransport, "_state", "initialized");
    let markRecordStarted!: () => void;
    const recordStarted = new Promise<void>((resolve) => {
      markRecordStarted = resolve;
    });
    let finishRecord!: () => void;
    let mutedPlayerClosed = false;
    let peerConnStarts = 0;
    Reflect.set(mutedManager, "_wavRecorder", {
      getStatus: () => "paused",
      begin: async () => true,
      listenForDeviceChange: () => {},
      listenForDeviceErrors: () => {},
      end: async () => {},
      record: () => {
        markRecordStarted();
        return new Promise<boolean>((resolve) => {
          finishRecord = () => resolve(true);
        });
      },
      processor: null,
      stream: null,
    });
    const mutedPlayerStub: {
      context: { state: string; close: () => Promise<void> } | null;
      connect: () => Promise<boolean>;
      interrupt: () => Promise<void>;
    } = {
      context: {
        state: "running",
        close: async () => {
          mutedPlayerClosed = true;
          if (mutedPlayerStub.context) mutedPlayerStub.context.state = "closed";
        },
      },
      connect: async () => true,
      interrupt: async () => {},
    };
    Reflect.set(mutedManager, "_wavStreamPlayer", mutedPlayerStub);
    Reflect.set(mutedInitClient.rawTransport, "startNewPeerConnection", async () => {
      peerConnStarts += 1;
    });
    const pendingMuted = mutedInitClient.connect({ endpoint: "https://bot.example/api/offer" });
    await recordStarted;
    await mutedInitClient.disconnect();
    finishRecord();
    await expect(pendingMuted).rejects.toThrow("Connection cancelled");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peerConnStarts).toBe(0);
    expect(mutedPlayerClosed).toBe(true);
    expect(mutedInitClient.state).toBe("disconnected");

    // Hang up after initDevices() while transport connect / bot-ready is pending also rejects connect() promptly.
    const midOfferClient = new EidolonClient({ enableMic: false });
    const midManager = Reflect.get(midOfferClient.rawTransport, "mediaManager") as object;
    Reflect.set(midManager, "_wavStreamPlayer", {
      context: null,
      connect: async () => true,
      interrupt: async () => {},
    });
    let markOfferEntered!: () => void;
    const offerEntered = new Promise<void>((resolve) => {
      markOfferEntered = resolve;
    });
    Reflect.set(midOfferClient.rawTransport, "_connect", async () => {
      markOfferEntered();
      // Mirrors SmallWebRTCTransport._connect returning early without rejecting when aborted.
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const pendingMidOffer = midOfferClient.connect({ endpoint: "https://bot.example/api/offer" });
    await offerEntered;
    await midOfferClient.disconnect();
    const midOfferOutcome = await Promise.race([
      pendingMidOffer
        .then(() => "resolved" as const)
        .catch((err: unknown) => (err instanceof Error ? err.message : String(err))),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 50)),
    ]);
    expect(midOfferOutcome).toBe("Connection cancelled");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(midOfferClient.state).toBe("disconnected");
  });
});

describe("stepConversation pure transcript reducer", () => {
  test("tracks CJK and English bot-output progress without stray CJK spaces", () => {
    let { state } = stepConversation(EMPTY_CONVERSATION_STATE, {
      type: "bot-output",
      now: "2026-11-12T00:00:01.000Z",
      data: { text: "你好。", spoken_status: "new", segment_id: 1, will_be_spoken: true },
    });
    state = stepConversation(state, {
      type: "bot-output",
      now: "2026-11-12T00:00:02.000Z",
      data: {
        text: "你好。",
        spoken_status: "completed",
        segment_id: 1,
        will_be_spoken: true,
      },
    }).state;
    state = stepConversation(state, {
      type: "bot-output",
      now: "2026-11-12T00:00:03.000Z",
      data: { text: "今天想聊什么？", spoken_status: "new", segment_id: 2, will_be_spoken: true },
    }).state;
    state = stepConversation(state, {
      type: "bot-output",
      now: "2026-11-12T00:00:04.000Z",
      data: {
        text: "今天想聊什么？",
        spoken_status: "in-progress",
        segment_id: 2,
        will_be_spoken: true,
        spoken_progress: { accumulated_text: "今天想", remaining_text: "聊什么？" },
      },
    }).state;

    const assistant = state.messages[0];
    expect(assistant?.parts).toHaveLength(2);
    expect(assistant?.parts[0]?.text).toEqual({ spoken: "你好。", unspoken: "" });
    expect(assistant?.parts[1]?.text).toEqual({ spoken: "今天想", unspoken: "聊什么？" });
    expect(isBotOutputText(assistant?.parts[1]?.text)).toBe(true);

    const interrupted = stepConversation(state, {
      type: "bot-interrupted",
      now: "2026-11-12T00:00:05.000Z",
    }).state;
    expect(interrupted.messages[0]?.final).toBe(true);
    expect(interrupted.messages[0]?.parts[1]?.text).toEqual({
      spoken: "今天想",
      unspoken: "聊什么？",
    });

    const snapped = stepConversation(state, {
      type: "bot-stopped-timeout",
      now: "2026-11-12T00:00:06.000Z",
    }).state;
    expect(snapped.messages[0]?.parts[1]?.text).toEqual({
      spoken: "今天想聊什么？",
      unspoken: "",
    });
  });

  test("joins English sentences with a space and tracks FIFO parallel tool calls and chat acks", () => {
    let { state } = stepConversation(EMPTY_CONVERSATION_STATE, {
      type: "bot-output",
      now: "2026-11-12T00:00:01.000Z",
      data: { text: "Hello.", spoken_status: "new", segment_id: 1, will_be_spoken: false },
    });
    state = stepConversation(state, {
      type: "bot-output",
      now: "2026-11-12T00:00:02.000Z",
      data: { text: "World!", spoken_status: "new", segment_id: 2, will_be_spoken: false },
    }).state;
    expect(state.messages[0]?.parts[1]?.text).toEqual({ spoken: " World!", unspoken: "" });

    // Out-of-order user-chat-echo arriving before send-text-resolved marks the sent line received.
    const msgId = uuidv7();
    state = stepConversation(state, {
      type: "user-chat-echo",
      text: "Typed line",
      msgId,
      now: "2026-11-12T00:00:03.000Z",
    }).state;
    state = stepConversation(state, {
      type: "send-text-resolved",
      text: "Typed line",
      msgId,
      now: "2026-11-12T00:00:04.000Z",
    }).state;
    expect(state.messages.at(-1)?.status).toBe("received");

    // Two parallel anonymous function-call-started events match in FIFO order.
    state = stepConversation(state, {
      type: "function-call-started",
      data: {},
      now: "2026-11-12T00:00:05.000Z",
    }).state;
    state = stepConversation(state, {
      type: "function-call-started",
      data: {},
      now: "2026-11-12T00:00:05.100Z",
    }).state;
    state = stepConversation(state, {
      type: "function-call-in-progress",
      data: { tool_call_id: "tc_1", function_name: "take_selfie" },
      now: "2026-11-12T00:00:05.200Z",
    }).state;
    state = stepConversation(state, {
      type: "function-call-stopped",
      data: { tool_call_id: "tc_1", cancelled: false },
      now: "2026-11-12T00:00:05.300Z",
    }).state;

    const toolCalls = state.messages.filter((msg) => msg.role === "function_call");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]?.functionCall).toMatchObject({
      tool_call_id: "tc_1",
      function_name: "take_selfie",
      status: "completed",
    });
    expect(toolCalls[1]?.functionCall?.status).toBe("started");
    // Typed user line finalized the open assistant bubble, so tool calls land after the user line.
    expect(state.messages.map((msg) => msg.role)).toEqual([
      "assistant",
      "user",
      "function_call",
      "function_call",
    ]);
    expect(state.segments.size).toBe(0);
  });

  test("handles direct user-chat-echo, legacy transcript dedup, turn markers, and mid-cue splits", () => {
    // Direct client.sendText() echoes user-chat-echo with an unseen msgId and renders immediately.
    let { state } = stepConversation(EMPTY_CONVERSATION_STATE, {
      type: "user-chat-echo",
      text: "Direct line",
      msgId: "msg_direct",
      now: "2026-11-12T00:00:01.000Z",
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      role: "user",
      msgId: "msg_direct",
      status: "received",
    });

    // Once user-input speech is seen, legacy user-transcription copies are ignored.
    state = stepConversation(state, {
      type: "user-transcription",
      text: "你好",
      final: true,
      fromUserInput: true,
      now: "2026-11-12T00:00:02.000Z",
    }).state;
    const afterLegacy = stepConversation(state, {
      type: "user-transcription",
      text: "你好",
      final: true,
      fromUserInput: false,
      now: "2026-11-12T00:00:02.100Z",
    });
    expect(afterLegacy.state).toBe(state);

    // Turn markers in accumulated_text do not shift spokenLength, and mid-cue splits snap past tags.
    state = stepConversation(state, {
      type: "bot-output",
      now: "2026-11-12T00:00:03.000Z",
      data: {
        text: "✓ <whisper>秘密</whisper>你好",
        spoken_status: "new",
        segment_id: 10,
        will_be_spoken: true,
      },
    }).state;
    state = stepConversation(state, {
      type: "bot-output",
      now: "2026-11-12T00:00:03.500Z",
      data: {
        text: "✓ <whisper>秘密</whisper>你好",
        spoken_status: "in-progress",
        segment_id: 10,
        will_be_spoken: true,
        // Slices partway into `</whisper>` without snapping if raw length were used blindly.
        spoken_progress: { accumulated_text: "✓ <whisper>秘密</whi", remaining_text: "sper>你好" },
      },
    }).state;

    const partText = state.messages.at(-1)?.parts[0]?.text;
    expect(partText).toEqual({
      spoken: "<whisper>秘密</whisper>",
      unspoken: "你好",
    });
    expect(state.messages.at(-1)?.parts[0]?.final).toBe(false);
    if (isBotOutputText(partText)) {
      const spokenParsed = parseMarkupWithState(partText.spoken);
      const unspokenParsed = parseMarkupWithState(partText.unspoken, {
        initialTags: spokenParsed.openTags,
      });
      expect(spokenParsed.tokens).toEqual([
        { kind: "text", start: 9, text: "秘密", tags: ["whisper"] },
      ]);
      expect(unspokenParsed.tokens).toEqual([{ kind: "text", start: 0, text: "你好", tags: [] }]);
    }
  });

  test("preserves open assistant reply across failed sends and run_immediately: false sends", () => {
    let { state } = stepConversation(EMPTY_CONVERSATION_STATE, {
      type: "bot-output",
      now: "2026-11-12T00:00:01.000Z",
      data: {
        text: "你好世界",
        spoken_status: "new",
        segment_id: 1,
        will_be_spoken: true,
      },
    });

    // A rejected send adds a failed user message without closing the active assistant turn or clearing segments.
    state = stepConversation(state, {
      type: "send-text-rejected",
      text: "没发出去",
      now: "2026-11-12T00:00:01.200Z",
    }).state;
    expect(state.messages.map((m) => [m.role, m.final, m.status])).toEqual([
      ["assistant", false, undefined],
      ["user", true, "failed"],
    ]);

    // A non-interrupting send (`run_immediately: false`) inserts before the open assistant turn and keeps it open.
    state = stepConversation(state, {
      type: "send-text-resolved",
      text: "顺便问一下",
      msgId: "queued_1",
      runImmediately: false,
      now: "2026-11-12T00:00:01.400Z",
    }).state;
    state = stepConversation(state, {
      type: "user-chat-echo",
      text: "第二句顺便",
      msgId: "queued_2",
      runImmediately: false,
      now: "2026-11-12T00:00:01.500Z",
    }).state;

    // Subsequent speech progress continues updating the still-open assistant reply.
    state = stepConversation(state, {
      type: "bot-output",
      now: "2026-11-12T00:00:02.000Z",
      data: {
        text: "你好世界",
        spoken_status: "in-progress",
        segment_id: 1,
        will_be_spoken: true,
        spoken_progress: { accumulated_text: "你好", remaining_text: "世界" },
      },
    }).state;

    const openAssistant = state.messages.find((m) => m.role === "assistant");
    expect(openAssistant?.final).toBe(false);
    expect(openAssistant?.parts[0]?.text).toEqual({ spoken: "你好", unspoken: "世界" });
    expect(state.messages.map((m) => [m.role, m.msgId, m.status])).toEqual([
      ["user", "queued_1", "sent"],
      ["user", "queued_2", "received"],
      ["assistant", undefined, undefined],
      ["user", undefined, "failed"],
    ]);
  });

  test("dispatchSentText isolates observer errors from transport failures and drops sends across resets", async () => {
    const actions: ConversationAction["type"][] = [];
    let state = EMPTY_CONVERSATION_STATE;
    await expect(
      dispatchSentText(
        { sendText: async () => "msg_obs" },
        "你好",
        undefined,
        (action) => {
          actions.push(action.type);
          const next = stepConversation(state, action);
          state = next.state;
          for (const eff of next.effects) {
            if (eff.kind === "created") throw new Error("observer boom");
          }
        },
        () => true,
        () => "2026-11-12T00:00:01.000Z",
      ),
    ).rejects.toThrow("observer boom");
    // Observer failure must not trigger send-text-rejected or append a duplicate failed message.
    expect(actions).toEqual(["send-text-resolved"]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.status).toBe("sent");

    // Conversation reset while sendText is pending suppresses both resolved and rejected dispatches
    // while preserving the returned message id or thrown transport error.
    const postResetActions: ConversationAction["type"][] = [];
    let current = true;
    const staleResolved = await dispatchSentText(
      {
        sendText: async () => {
          current = false;
          return "msg_stale";
        },
      },
      "旧会话消息",
      { run_immediately: false },
      (action) => postResetActions.push(action.type),
      () => current,
    );
    expect(staleResolved).toBe("msg_stale");
    expect(postResetActions).toEqual([]);

    await expect(
      dispatchSentText(
        {
          sendText: async () => {
            throw new Error("transport closed");
          },
        },
        "旧会话失败消息",
        undefined,
        (action) => postResetActions.push(action.type),
        () => false,
      ),
    ).rejects.toThrow("transport closed");
    expect(postResetActions).toEqual([]);
  });

  test("suspended React transition to client B does not drop committed client A sends or mic swap errors", async () => {
    const globals = globalThis as Record<string, unknown>;
    const prevAct = globals.IS_REACT_ACT_ENVIRONMENT;
    const win = globalThis.window as unknown as Record<string, unknown>;
    const prevIframe = win.HTMLIFrameElement;
    globals.IS_REACT_ACT_ENVIRONMENT = true;
    win.HTMLIFrameElement = class {};

    const doc = Object.assign(new EventTarget(), { activeElement: null, defaultView: win });
    const container = Object.assign(new EventTarget(), {
      nodeType: 1,
      nodeName: "DIV",
      tagName: "DIV",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      childNodes: [],
      firstChild: null,
      ownerDocument: doc,
      removeChild() {},
      appendChild() {},
      insertBefore() {},
    });

    const clientA = new EidolonClient({ enableMic: false });
    const clientB = new EidolonClient({ enableMic: false });

    let resolveSendA!: (msgId: string) => void;
    Reflect.set(
      clientA,
      "sendText",
      () =>
        new Promise<string>((resolve) => {
          resolveSendA = resolve;
        }),
    );
    let rejectSwapA!: (err: Error) => void;
    Reflect.set(
      clientA,
      "selectLiveMic",
      () =>
        new Promise<void>((_, reject) => {
          rejectSwapA = reject;
        }),
    );

    let finishSuspense!: () => void;
    const suspenseGate = new Promise<void>((resolve) => {
      finishSuspense = resolve;
    });
    let setTarget!: (next: { client: EidolonClient; suspend: boolean }) => void;
    let committedConv!: EidolonConversationControls;
    let committedMic!: EidolonMicDevices;
    let renderedClients: EidolonClient[] = [];

    function Child({ suspend, current }: { suspend: boolean; current: EidolonClient }) {
      renderedClients.push(current);
      const conv = useEidolonConversation();
      const mic = useEidolonMicDevices();
      if (suspend) throw suspenseGate;
      committedConv = conv;
      committedMic = mic;
      return null;
    }

    function App() {
      const [target, _setTarget] = useState({ client: clientA, suspend: false });
      setTarget = _setTarget;
      return React.createElement(
        Suspense,
        { fallback: null },
        React.createElement(
          EidolonClientProvider,
          { client: target.client },
          React.createElement(Child, { suspend: target.suspend, current: target.client }),
        ),
      );
    }

    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => {
        root.render(React.createElement(App));
      });

      // Start an in-flight text send and mic swap on committed client A.
      let pendingSend!: Promise<string>;
      await act(async () => {
        pendingSend = committedConv.sendText("来自A的消息");
        committedMic.selectMic("usb-a");
      });

      // Start a transition to client B that renders hooks with client B and then suspends without committing.
      renderedClients = [];
      await act(async () => {
        startTransition(() => {
          setTarget({ client: clientB, suspend: true });
        });
      });
      expect(renderedClients).toContain(clientB);

      // Client A remains committed: its settling send and mic error must be preserved, not dropped.
      await act(async () => {
        resolveSendA("msg_from_a");
        rejectSwapA(new Error("mic A unplugged"));
        await pendingSend;
      });
      expect(committedConv.messages.map((m) => [m.msgId, m.status])).toEqual([
        ["msg_from_a", "sent"],
      ]);
      expect(committedMic.swapError?.message).toBe("mic A unplugged");

      // Once the transition unsuspends and commits client B, conversation and mic error reset cleanly.
      await act(async () => {
        setTarget({ client: clientB, suspend: false });
        finishSuspense();
      });
      expect(committedConv.messages).toEqual([]);
      expect(committedMic.swapError).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      globals.IS_REACT_ACT_ENVIRONMENT = prevAct;
      win.HTMLIFrameElement = prevIframe;
    }
  });
});

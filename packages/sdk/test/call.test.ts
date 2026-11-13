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
  type NetworkInfo,
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
  EidolonClientAudio,
  type EidolonClientAudioHandle,
  EidolonClientProvider,
  type EidolonConversationControls,
  type EidolonMicDevices,
  EMPTY_CONVERSATION_STATE,
  isBotOutputText,
  stepConversation,
  useEidolonConversation,
  useEidolonMicDevices,
  useEidolonNetworkInfo,
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

    // Stale suspended connect/init/applyMicPreference attempts never block disconnect() or tear down a
    // replacement redial's active resources while a browser permission prompt stays open.
    for (const preferredMic of [null, SYSTEM_DEFAULT_MIC_ID, "usb-2"] as const) {
      const redialClient = new EidolonClient({ enableMic: true });
      if (preferredMic !== null) {
        redialClient.setPreferredMic(preferredMic);
        Reflect.set(redialClient.rawClient, "getAllMics", async () => [
          {
            deviceId: "usb-2",
            kind: "audioinput",
            label: "USB Mic",
            groupId: "g2",
            toJSON: () => ({}),
          },
        ]);
      }
      const redialManager = Reflect.get(redialClient.rawTransport, "mediaManager") as {
        initialize: () => Promise<void>;
        connect: () => Promise<void>;
        disconnect: () => Promise<void>;
        tracks: () => { local: { audio?: MediaStreamTrack } };
      };
      const origRecorder = Reflect.get(redialManager, "_wavRecorder") as object;
      const origPlayer = Reflect.get(redialManager, "_wavStreamPlayer") as object;
      const RecProto = Object.getPrototypeOf(origRecorder);
      const PlayProto = Object.getPrototypeOf(origPlayer);
      const origRecBegin = RecProto.begin;
      const origRecEnd = RecProto.end;
      const origRecRecord = RecProto.record;
      const origRecStatus = RecProto.getStatus;
      const origRecDeviceChange = RecProto.listenForDeviceChange;
      const origRecDeviceErrors = RecProto.listenForDeviceErrors;
      const origPlayConnect = PlayProto.connect;
      const origPlayInterrupt = PlayProto.interrupt;

      let beginInvocation = 0;
      let markAttemptABegin!: () => void;
      const attemptABegin = new Promise<void>((resolve) => {
        markAttemptABegin = resolve;
      });
      let finishAttemptABegin!: () => void;
      let attemptATrackEnded = false;
      let attemptAContextClosed = false;
      let attemptBTrackEnded = false;
      let attemptBContextClosed = false;
      let attemptBPlayerClosed = false;

      RecProto.begin = function (this: Record<string, unknown>) {
        if (this.processor) {
          return Promise.reject(
            new Error("Already connected: please call .end() to start a new session"),
          );
        }
        const idx = ++beginInvocation;
        if (idx === 1) {
          markAttemptABegin();
          return new Promise<boolean>((resolve) => {
            finishAttemptABegin = () => {
              const trackA = {
                id: "mic-attempt-a",
                kind: "audio",
                enabled: true,
                readyState: "live",
                stop() {
                  attemptATrackEnded = true;
                  (this as { readyState: string }).readyState = "ended";
                },
              } as unknown as MediaStreamTrack;
              this.stream = { getTracks: () => [trackA], getAudioTracks: () => [trackA] };
              this.processor = {
                context: {
                  state: "running",
                  close: async () => {
                    attemptAContextClosed = true;
                  },
                },
              };
              resolve(true);
            };
          });
        }
        const trackB = {
          id: "mic-attempt-b",
          kind: "audio",
          enabled: true,
          readyState: "live",
          stop() {
            attemptBTrackEnded = true;
            (this as { readyState: string }).readyState = "ended";
          },
        } as unknown as MediaStreamTrack;
        this.stream = { getTracks: () => [trackB], getAudioTracks: () => [trackB] };
        this.processor = {
          context: {
            state: "running",
            close: async () => {
              attemptBContextClosed = true;
            },
          },
        };
        return Promise.resolve(true);
      };
      RecProto.end = async function (this: Record<string, unknown>) {
        this.stream = null;
        this.processor = null;
      };
      RecProto.record = async () => true;
      RecProto.getStatus = function (this: Record<string, unknown>) {
        return this.stream ? "recording" : "ended";
      };
      RecProto.listenForDeviceChange = () => {};
      RecProto.listenForDeviceErrors = () => {};
      let playConnectCount = 0;
      PlayProto.connect = async function (this: Record<string, unknown>) {
        const n = ++playConnectCount;
        this.context = {
          state: "running",
          close: async () => {
            if (n === 1) attemptBPlayerClosed = true;
          },
        };
        return true;
      };
      PlayProto.interrupt = async () => {};

      Reflect.set(redialClient.rawTransport, "_connect", async () => {
        await redialManager.connect();
        Reflect.set(redialClient.rawTransport, "dc", {
          readyState: "open",
          send: () => {
            const onMessage = Reflect.get(redialClient.rawTransport, "_onMessage") as (
              msg: unknown,
            ) => void;
            Reflect.set(redialClient.rawTransport, "state", "ready");
            onMessage({
              label: "rtvi-ai",
              id: "1",
              type: "bot-ready",
              data: { version: "1.0.0" },
            });
          },
          close: () => {},
        });
        Reflect.set(redialClient.rawTransport, "state", "connected");
      });
      Reflect.set(redialClient.rawTransport, "_disconnect", async () => {
        Reflect.set(redialClient.rawTransport, "dc", null);
        Reflect.set(redialClient.rawTransport, "state", "disconnected");
        await redialManager.disconnect();
      });

      try {
        const attemptAConnect = redialClient.connect({
          endpoint: "https://bot.example/api/offer",
        });
        await attemptABegin;

        // Hangup and awaited redial must complete without waiting on Attempt A's open permission prompt.
        const redialOutcome = await Promise.race([
          (async () => {
            await redialClient.disconnect();
            return redialClient.connect({ endpoint: "https://bot.example/api/offer" });
          })(),
          new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
        ]);
        expect(redialOutcome).not.toBe("hung");
        if (redialOutcome === "hung")
          throw new Error("disconnect/redial hung on permission prompt");
        expect(redialOutcome.version).toBe("1.0.0");
        expect(redialClient.state).toBe("ready");
        expect(Reflect.get(redialManager, "_initialized")).toBe(true);
        expect(redialManager.tracks().local.audio?.id).toBe("mic-attempt-b");

        // Attempt A finally resolves: its detached mic/AudioContext close while Attempt B stays live in "ready".
        finishAttemptABegin();
        await expect(attemptAConnect).rejects.toThrow("Connection cancelled");
        expect(redialClient.state).toBe("ready");
        expect(Reflect.get(redialManager, "_initialized")).toBe(true);
        expect(attemptATrackEnded).toBe(true);
        expect(attemptAContextClosed).toBe(true);
        expect(attemptBTrackEnded).toBe(false);
        expect(attemptBContextClosed).toBe(false);
        expect(attemptBPlayerClosed).toBe(false);
        expect(redialManager.tracks().local.audio?.id).toBe("mic-attempt-b");
      } finally {
        try {
          await redialClient.disconnect();
        } finally {
          RecProto.begin = origRecBegin;
          RecProto.end = origRecEnd;
          RecProto.record = origRecRecord;
          RecProto.getStatus = origRecStatus;
          RecProto.listenForDeviceChange = origRecDeviceChange;
          RecProto.listenForDeviceErrors = origRecDeviceErrors;
          PlayProto.connect = origPlayConnect;
          PlayProto.interrupt = origPlayInterrupt;
        }
      }
    }

    // Shared custom recorder/player in connect(): stale Attempt A resuming after Attempt B starts
    // skips cleanup of resources now owned by Attempt B.
    const sharedClient = new EidolonClient({ enableMic: true });
    const sharedMgr = Reflect.get(sharedClient.rawTransport, "mediaManager") as {
      connect: () => Promise<void>;
    };
    Reflect.set(sharedMgr, "_initialized", true);
    let recordCall = 0;
    let markRecA!: () => void;
    const recAStarted = new Promise<void>((resolve) => {
      markRecA = resolve;
    });
    let finishRecA!: () => void;
    let sharedTrackStopped = false;
    let sharedPlayerClosed = false;
    const sharedTrack = {
      id: "shared-b",
      kind: "audio",
      enabled: true,
      readyState: "live",
      stop() {
        sharedTrackStopped = true;
        (this as { readyState: string }).readyState = "ended";
      },
    } as unknown as MediaStreamTrack;
    const sharedRecorder = {
      getStatus: () => "paused",
      begin: async () => true,
      listenForDeviceChange: () => {},
      listenForDeviceErrors: () => {},
      end: async () => {},
      record: () => {
        if (++recordCall === 1) {
          markRecA();
          return new Promise<boolean>((resolve) => {
            finishRecA = () => resolve(true);
          });
        }
        return Promise.resolve(true);
      },
      processor: null,
      stream: { getTracks: () => [sharedTrack], getAudioTracks: () => [sharedTrack] },
    };
    Reflect.set(sharedMgr, "_wavRecorder", sharedRecorder);
    Reflect.set(sharedMgr, "_wavStreamPlayer", {
      context: {
        state: "running",
        close: async () => {
          sharedPlayerClosed = true;
        },
      },
      connect: async () => true,
      interrupt: async () => {},
    });
    const staleConnectA = sharedMgr.connect();
    await recAStarted;
    await sharedClient.disconnect();
    // Restore Attempt B's live stream/context on the shared mock and run Attempt B's connect().
    sharedTrackStopped = false;
    sharedPlayerClosed = false;
    (sharedTrack as { readyState: string }).readyState = "live";
    sharedRecorder.stream = { getTracks: () => [sharedTrack], getAudioTracks: () => [sharedTrack] };
    Reflect.set(sharedMgr, "_initialized", true);
    await sharedMgr.connect();

    // Resuming stale Attempt A must NOT clear _initialized or close Attempt B's active track/player.
    finishRecA();
    await expect(staleConnectA).rejects.toThrow("Connection cancelled");
    expect(Reflect.get(sharedMgr, "_initialized")).toBe(true);
    expect(sharedTrackStopped).toBe(false);
    expect(sharedPlayerClosed).toBe(false);

    // Pre-connect applyMicPreference cancelled during getAllMics() never calls updateMic or initDevices after hangup.
    const prepClient = new EidolonClient({ enableMic: true });
    let resolvePrepMics!: (mics: MediaDeviceInfo[]) => void;
    let prepUpdateCalls = 0;
    let prepInitCalls = 0;
    Reflect.set(
      prepClient.rawClient,
      "getAllMics",
      () =>
        new Promise<MediaDeviceInfo[]>((resolve) => {
          resolvePrepMics = resolve;
        }),
    );
    Reflect.set(prepClient.rawTransport, "updateMic", async () => {
      prepUpdateCalls += 1;
    });
    Reflect.set(prepClient.rawClient, "initDevices", async () => {
      prepInitCalls += 1;
    });
    const pendingPrep = prepClient.applyMicPreference("usb-mic-9");
    await prepClient.disconnect();
    resolvePrepMics([
      {
        deviceId: "usb-mic-9",
        kind: "audioinput",
        label: "USB Mic 9",
        groupId: "g9",
        toJSON: () => ({}),
      },
    ]);
    await pendingPrep;
    expect(prepUpdateCalls).toBe(0);
    expect(prepInitCalls).toBe(0);
  });

  test("device unplug during pending player initialization defers fallback without replacing active manager", async () => {
    const initClient = new EidolonClient({ enableMic: false });
    const initManager = Reflect.get(initClient.rawTransport, "mediaManager") as object;
    const origRec = Reflect.get(initManager, "_wavRecorder") as Record<string, unknown>;
    const origPlay = Reflect.get(initManager, "_wavStreamPlayer") as Record<string, unknown>;
    const builtInDevice = {
      deviceId: "built-in",
      kind: "audioinput",
      label: "Built-in Mic",
      groupId: "g1",
      toJSON: () => ({}),
    } as MediaDeviceInfo;

    const openedDuringInit: string[] = [];
    const recordedDuringInit: string[] = [];
    let currentInitDevice = "";
    let beginGate: Promise<void> | null = null;
    let markBeginPending: (() => void) | null = null;
    let fallbackBeginGate: Promise<void> | null = null;
    let markFallbackBeginPending: (() => void) | null = null;
    let playerConnectCalls = 0;
    let onDeviceChangeCb = null as ((devices: MediaDeviceInfo[]) => void) | null;
    let markPlayerPending!: () => void;
    let playerPending = new Promise<void>((resolve) => {
      markPlayerPending = resolve;
    });
    let finishPlayer!: () => void;
    let rejectPlayer!: (error: Error) => void;

    let isRecording = false;
    origRec.processor = null;
    origRec.stream = null;
    origRec.deviceSelection = null;
    origRec.getStatus = () =>
      origRec.processor === null ? "ended" : isRecording ? "recording" : "paused";
    origRec.begin = async (deviceId?: string) => {
      if (origRec.processor) {
        throw new Error("Already connected: please call .end() to start a new session");
      }
      if (beginGate) {
        markBeginPending?.();
        await beginGate;
      }
      if (deviceId === "" && fallbackBeginGate) {
        markFallbackBeginPending?.();
        await fallbackBeginGate;
      }
      const resolved =
        deviceId === undefined
          ? ((origRec.deviceSelection as { deviceId?: string } | null)?.deviceId ?? "usb-2")
          : deviceId || "built-in";
      currentInitDevice = resolved;
      openedDuringInit.push(resolved);
      origRec.deviceSelection = {
        deviceId: resolved,
        kind: "audioinput",
        label: resolved,
      };
      const track = {
        id: `init-track-${resolved}`,
        kind: "audio",
        enabled: true,
        readyState: "live",
        stop() {
          (this as { readyState: string }).readyState = "ended";
        },
      } as unknown as MediaStreamTrack;
      origRec.processor = {
        context: {
          state: "running",
          close: async () => {
            const proc = origRec.processor as { context: { state: string } } | null;
            if (proc) proc.context.state = "closed";
          },
        },
      };
      origRec.stream = { getTracks: () => [track], getAudioTracks: () => [track] };
      return true;
    };
    origRec.end = async () => {
      const stream = origRec.stream as { getTracks: () => MediaStreamTrack[] } | null;
      for (const t of stream?.getTracks() ?? []) t.stop();
      origRec.stream = null;
      origRec.processor = null;
      isRecording = false;
    };
    origRec.record = async () => {
      if (origRec.processor === null) {
        throw new Error("Session ended: please call .begin() first");
      }
      if (isRecording) {
        throw new Error("Already recording: please call .pause() first");
      }
      isRecording = true;
      recordedDuringInit.push(currentInitDevice);
      return true;
    };
    origRec.pause = async () => {
      isRecording = false;
      return true;
    };
    origRec.listenForDeviceChange = (cb: ((devices: MediaDeviceInfo[]) => void) | null) => {
      onDeviceChangeCb = cb;
    };
    origRec.listenForDeviceErrors = () => {};

    origPlay.context = null;
    origPlay.connect = () => {
      playerConnectCalls += 1;
      markPlayerPending();
      return new Promise<boolean>((resolve, reject) => {
        finishPlayer = () => {
          origPlay.context = {
            state: "running",
            close: async () => {
              const ctx = origPlay.context as { state: string } | null;
              if (ctx) ctx.state = "closed";
            },
          };
          resolve(true);
        };
        rejectPlayer = reject;
      });
    };
    origPlay.interrupt = async () => {};

    // 1. Unplug while _wavStreamPlayer.connect() is pending defers fallback until initialize() settles,
    // preserving origRec/origPlay on the active WavMediaManager without aborting initDevices().
    const pendingInit = initClient.initDevices();
    await playerPending;
    expect(openedDuringInit).toEqual(["usb-2"]);
    expect(onDeviceChangeCb).not.toBeNull();

    onDeviceChangeCb?.([builtInDevice]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openedDuringInit).toEqual(["usb-2"]);
    expect(Reflect.get(initManager, "_wavRecorder")).toBe(origRec);
    expect(Reflect.get(initManager, "_wavStreamPlayer")).toBe(origPlay);

    finishPlayer();
    await pendingInit;
    expect(Reflect.get(initManager, "_wavRecorder")).toBe(origRec);
    expect(Reflect.get(initManager, "_wavStreamPlayer")).toBe(origPlay);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openedDuringInit).toEqual(["usb-2", "built-in"]);
    expect(initClient.appliedMicId).toBe(SYSTEM_DEFAULT_MIC_ID);
    expect(initClient.tracks().local.audio?.id).toBe("init-track-built-in");
    expect(initClient.tracks().local.audio?.enabled).toBe(false);

    await initClient.disconnect();

    // 2. Same-epoch direct updateMic while initialize() is pending also keeps activeInner intact.
    playerPending = new Promise<void>((resolve) => {
      markPlayerPending = resolve;
    });
    origRec.deviceSelection = { deviceId: "usb-2", kind: "audioinput", label: "usb-2" };
    const pendingInit2 = initClient.initDevices();
    await playerPending;
    const directSwap = initClient.rawTransport.updateMic("usb-3");
    finishPlayer();
    await Promise.all([pendingInit2, directSwap]);
    expect(Reflect.get(initManager, "_wavRecorder")).toBe(origRec);
    expect(openedDuringInit).toEqual(["usb-2", "built-in", "usb-2", "usb-3"]);

    await initClient.disconnect();

    // 3. If _wavStreamPlayer.connect() rejects after unplug during initDevices(), deferred fallback does not reopen capture.
    playerPending = new Promise<void>((resolve) => {
      markPlayerPending = resolve;
    });
    origRec.deviceSelection = { deviceId: "usb-2", kind: "audioinput", label: "usb-2" };
    const failingInit = initClient.initDevices();
    await playerPending;
    onDeviceChangeCb?.([builtInDevice]);
    const countBeforeReject = openedDuringInit.length;
    rejectPlayer(new Error("Player AudioWorklet failed"));
    await expect(failingInit).rejects.toThrow("Player AudioWorklet failed");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(openedDuringInit).toHaveLength(countBeforeReject);
    expect(origRec.stream).toBeNull();

    await initClient.disconnect();

    // 4. Concurrent same-epoch initDevices() calls coalesce onto a single begin() / player.connect(),
    // and initDevices() awaits an in-flight pre-connect mic acquisition rather than double-opening begin().
    playerPending = new Promise<void>((resolve) => {
      markPlayerPending = resolve;
    });
    let releaseBeginGate!: () => void;
    beginGate = new Promise<void>((resolve) => {
      releaseBeginGate = resolve;
    });
    origRec.deviceSelection = { deviceId: "usb-2", kind: "audioinput", label: "usb-2" };
    const opensBeforeCoalesce = openedDuringInit.length;
    const playersBeforeCoalesce = playerConnectCalls;
    const concurrentA = initClient.initDevices();
    const concurrentB = initClient.initDevices();
    releaseBeginGate();
    beginGate = null;
    await playerPending;
    finishPlayer();
    await Promise.all([concurrentA, concurrentB]);
    expect(openedDuringInit.slice(opensBeforeCoalesce)).toEqual(["usb-2"]);
    expect(playerConnectCalls - playersBeforeCoalesce).toBe(1);
    await initClient.disconnect();
    expect(origRec.stream).toBeNull();

    playerPending = new Promise<void>((resolve) => {
      markPlayerPending = resolve;
    });
    beginGate = new Promise<void>((resolve) => {
      releaseBeginGate = resolve;
    });
    const beginPending = new Promise<void>((resolve) => {
      markBeginPending = resolve;
    });
    const opensBeforePreConnectInit = openedDuringInit.length;
    const pendingPref = initClient.applyMicPreference(SYSTEM_DEFAULT_MIC_ID);
    await beginPending;
    markBeginPending = null;
    const initDuringPref = initClient.initDevices();
    releaseBeginGate();
    beginGate = null;
    await playerPending;
    finishPlayer();
    await Promise.all([pendingPref, initDuringPref]);
    expect(openedDuringInit.slice(opensBeforePreConnectInit)).toEqual(["built-in"]);
    await initClient.disconnect();

    // 5. connect() waits for a deferred unplug fallback's replacement begin("") before starting recording.
    playerPending = new Promise<void>((resolve) => {
      markPlayerPending = resolve;
    });
    let releaseFallbackBegin!: () => void;
    fallbackBeginGate = new Promise<void>((resolve) => {
      releaseFallbackBegin = resolve;
    });
    const fallbackBeginPending = new Promise<void>((resolve) => {
      markFallbackBeginPending = resolve;
    });
    initClient.enableMic(true);
    origRec.deviceSelection = { deviceId: "usb-2", kind: "audioinput", label: "usb-2" };
    const opensBeforeConnectRace = openedDuringInit.length;
    const pendingInitForConnect = initClient.initDevices();
    await playerPending;
    onDeviceChangeCb?.([builtInDevice]);
    finishPlayer();
    await pendingInitForConnect;

    let connectSettled = false;
    const pendingManagerConnect = (initManager as { connect: () => Promise<void> })
      .connect()
      .then(() => {
        connectSettled = true;
      });
    await fallbackBeginPending;
    expect(connectSettled).toBe(false);
    expect(recordedDuringInit).toEqual([]);

    releaseFallbackBegin();
    fallbackBeginGate = null;
    markFallbackBeginPending = null;
    await pendingManagerConnect;
    expect(connectSettled).toBe(true);
    expect(openedDuringInit.slice(opensBeforeConnectRace)).toEqual(["usb-2", "built-in"]);
    expect(recordedDuringInit).toEqual(["built-in"]);
    initClient.enableMic(false);
    await initClient.disconnect();

    // 6. Explicit updateMic during a pending initDevices() supersedes a deferred unplug fallback to default.
    playerPending = new Promise<void>((resolve) => {
      markPlayerPending = resolve;
    });
    origRec.deviceSelection = { deviceId: "usb-2", kind: "audioinput", label: "usb-2" };
    const opensBeforeSupersede = openedDuringInit.length;
    const pendingInitSupersede = initClient.initDevices();
    await playerPending;
    onDeviceChangeCb?.([builtInDevice]);
    const explicitChoice = initClient.rawTransport.updateMic("usb-3");
    finishPlayer();
    await Promise.all([pendingInitSupersede, explicitChoice]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(openedDuringInit.slice(opensBeforeSupersede)).toEqual(["usb-2", "usb-3"]);
    expect((origRec.deviceSelection as { deviceId?: string } | null)?.deviceId).toBe("usb-3");
    expect(initClient.tracks().local.audio?.id).toBe("init-track-usb-3");

    await initClient.disconnect();
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
    let committedNet = null as NetworkInfo | null;
    let renderedClients: EidolonClient[] = [];
    let gatherCallsB = 0;
    Reflect.set(clientA, "gatherNetworkInfo", async () => ({
      localCandidateType: "relay",
      currentRoundTripTime: 0.042,
    }));
    Reflect.set(
      clientB,
      "gatherNetworkInfo",
      () =>
        new Promise<NetworkInfo | null>(() => {
          gatherCallsB += 1;
        }),
    );
    Reflect.set(clientA.rawTransport, "state", "ready");
    Reflect.set(clientB.rawTransport, "state", "ready");

    function Child({ suspend, current }: { suspend: boolean; current: EidolonClient }) {
      renderedClients.push(current);
      const conv = useEidolonConversation();
      const mic = useEidolonMicDevices();
      const net = useEidolonNetworkInfo({ enabled: true, intervalMs: 60_000 });
      if (suspend) throw suspenseGate;
      committedConv = conv;
      committedMic = mic;
      committedNet = net;
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
      expect(committedNet).toEqual({
        localCandidateType: "relay",
        currentRoundTripTime: 0.042,
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
      expect(gatherCallsB).toBe(1);
      expect(committedNet).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      globals.IS_REACT_ACT_ENVIRONMENT = prevAct;
      win.HTMLIFrameElement = prevIframe;
    }
  });

  test("React bindings finalize text-only replies, close open messages on disconnect, update uncontrolled mic choice, and expose blocked audio retry", async () => {
    const globals = globalThis as Record<string, unknown>;
    const prevAct = globals.IS_REACT_ACT_ENVIRONMENT;
    const prevMediaStream = globals.MediaStream;
    const prevNavigator = globals.navigator;
    const win = globalThis.window as unknown as Record<string, unknown>;
    const prevIframe = win.HTMLIFrameElement;
    globals.IS_REACT_ACT_ENVIRONMENT = true;
    win.HTMLIFrameElement = class {};

    class FakeMediaStream {
      readonly #tracks: MediaStreamTrack[];
      constructor(tracks: MediaStreamTrack[] = []) {
        this.#tracks = [...tracks];
      }
      getAudioTracks() {
        return this.#tracks.filter((t) => t.kind === "audio");
      }
      getTracks() {
        return [...this.#tracks];
      }
    }
    globals.MediaStream = FakeMediaStream;
    Object.defineProperty(globalThis, "navigator", {
      value: {
        mediaDevices: Object.assign(new EventTarget(), {
          enumerateDevices: async () => [
            { deviceId: "default", kind: "audioinput", label: "Default", groupId: "g1" },
            { deviceId: "usb-2", kind: "audioinput", label: "USB Mic", groupId: "g2" },
            { deviceId: "usb-3", kind: "audioinput", label: "Headset Mic", groupId: "g3" },
          ],
        }),
      },
      configurable: true,
    });

    let blockNextPlay = true;
    let pendingPlayGate: Promise<void> | null = null;
    let playAttempts = 0;
    const createdAudioElements: unknown[] = [];
    const doc = Object.assign(new EventTarget(), {
      activeElement: null,
      defaultView: win,
      createElement(tag: string) {
        const el = Object.assign(new EventTarget(), {
          nodeType: 1,
          nodeName: tag.toUpperCase(),
          tagName: tag.toUpperCase(),
          namespaceURI: "http://www.w3.org/1999/xhtml",
          childNodes: [],
          firstChild: null,
          ownerDocument: doc,
          style: {},
          autoplay: false,
          srcObject: null as unknown,
          setAttribute() {},
          removeAttribute() {},
          removeChild() {},
          appendChild() {},
          insertBefore() {},
          play: async () => {
            playAttempts += 1;
            if (pendingPlayGate) {
              await pendingPlayGate;
            }
            if (blockNextPlay) {
              throw new DOMException("Autoplay blocked", "NotAllowedError");
            }
          },
        });
        if (tag.toLowerCase() === "audio") createdAudioElements.push(el);
        return el;
      },
    });
    const container = doc.createElement("div");

    const client = new EidolonClient({ enableMic: true });
    const updateMicCalls: string[] = [];
    const callOrder: string[] = [];
    Reflect.set(client.rawClient, "getAllMics", async () => [
      {
        deviceId: "default",
        kind: "audioinput",
        label: "Default",
        groupId: "g1",
        toJSON: () => ({}),
      },
      {
        deviceId: "usb-2",
        kind: "audioinput",
        label: "USB Mic",
        groupId: "g2",
        toJSON: () => ({}),
      },
      {
        deviceId: "usb-3",
        kind: "audioinput",
        label: "Headset Mic",
        groupId: "g3",
        toJSON: () => ({}),
      },
    ]);
    Reflect.set(client.rawClient, "initDevices", async () => {
      callOrder.push("initDevices");
      Reflect.set(client.rawTransport, "state", "initialized");
    });
    const mockRecorder = Reflect.get(
      Reflect.get(client.rawTransport, "mediaManager") as object,
      "_wavRecorder",
    ) as { stream: unknown; deviceSelection: unknown };
    Reflect.set(client.rawTransport, "updateMic", async (id: string) => {
      callOrder.push(`updateMic:${id}`);
      updateMicCalls.push(id);
      const track = {
        id: `track-${id || "default"}`,
        kind: "audio",
        enabled: client.isMicEnabled,
        readyState: "live",
        stop() {
          (this as { readyState: string }).readyState = "ended";
        },
      } as unknown as MediaStreamTrack;
      mockRecorder.stream = { getTracks: () => [track], getAudioTracks: () => [track] };
      mockRecorder.deviceSelection = id ? { deviceId: id, kind: "audioinput", label: id } : null;
    });
    Reflect.set(client.rawTransport, "_connect", async () => {
      Reflect.set(client.rawTransport, "dc", {
        readyState: "open",
        send: () => {
          const onMessage = Reflect.get(client.rawTransport, "_onMessage") as (
            msg: unknown,
          ) => void;
          Reflect.set(client.rawTransport, "state", "ready");
          onMessage({ label: "rtvi-ai", id: "1", type: "bot-ready", data: { version: "1.0.0" } });
        },
        close: () => {},
      });
      Reflect.set(client.rawTransport, "state", "connected");
      raw.emit(RTVIEvent.Connected);
    });
    Reflect.set(client.rawTransport, "_disconnect", async () => {
      Reflect.set(client.rawTransport, "dc", null);
      Reflect.set(client.rawTransport, "state", "disconnected");
    });
    const raw = client.rawClient as unknown as {
      emit: (event: string, ...args: unknown[]) => void;
    };
    const audioRef = React.createRef<EidolonClientAudioHandle>();
    const blockedEvents: [boolean, string | undefined][] = [];
    let conv!: EidolonConversationControls;
    let mic!: EidolonMicDevices;

    function Probe() {
      conv = useEidolonConversation();
      mic = useEidolonMicDevices();
      return React.createElement(EidolonClientAudio, {
        ref: audioRef,
        onBlockedChange: (blocked, err) => blockedEvents.push([blocked, err?.name]),
      });
    }

    const origSetTimeout = globalThis.setTimeout;
    const scheduledFinalize: (() => void)[] = [];
    globals.setTimeout = ((cb: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms === 2500) {
        scheduledFinalize.push(() => cb(...args));
        return origSetTimeout(() => {}, 0);
      }
      return origSetTimeout(cb, ms, ...args);
    }) as typeof setTimeout;

    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => {
        root.render(
          React.createElement(EidolonClientProvider, { client }, React.createElement(Probe)),
        );
      });
      await act(async () => {
        await new Promise((resolve) => origSetTimeout(resolve, 0));
      });

      // 1. Uncontrolled useEidolonMicDevices updates selectedMicId without opening capture while idle,
      // applies pre-connect choices in connect(), and applies mid-connect choices on "connected".
      expect(mic.selectedMicId).toBe("default");
      await act(async () => {
        mic.selectMic("usb-2");
      });
      expect(mic.selectedMicId).toBe("usb-2");
      expect(updateMicCalls).toEqual([]);

      await act(async () => {
        await client.connect({ endpoint: "https://bot.example/api/offer" });
        await new Promise((resolve) => origSetTimeout(resolve, 0));
      });
      expect(callOrder).toEqual(["updateMic:usb-2", "initDevices"]);
      expect(updateMicCalls).toEqual(["usb-2"]);
      expect(client.appliedMicId).toBe("usb-2");

      await act(async () => {
        await client.disconnect();
      });

      // Choice made while "connecting" (after connect() began) applies as soon as "connected" fires.
      await act(async () => {
        Reflect.set(client.rawTransport, "state", "connecting");
        mic.selectMic("usb-3");
      });
      expect(mic.selectedMicId).toBe("usb-3");
      expect(updateMicCalls).toEqual(["usb-2"]);

      await act(async () => {
        Reflect.set(client.rawTransport, "state", "connected");
        raw.emit(RTVIEvent.Connected);
        await new Promise((resolve) => origSetTimeout(resolve, 0));
      });
      expect(updateMicCalls).toEqual(["usb-2", "usb-3"]);
      expect(client.appliedMicId).toBe("usb-3");

      // 2. EidolonClientAudio surfaces blocked playback and clears it when retried via ref.current.play().
      const botTrack = { id: "bot-track-1", kind: "audio", readyState: "live" } as MediaStreamTrack;
      await act(async () => {
        raw.emit(RTVIEvent.TrackStarted, botTrack, { id: "bot", name: "bot", local: false });
        await new Promise((resolve) => origSetTimeout(resolve, 0));
      });
      expect(playAttempts).toBe(1);
      expect(blockedEvents).toEqual([[true, "NotAllowedError"]]);
      expect(audioRef.current?.element).toBe(
        createdAudioElements[0] as unknown as HTMLAudioElement,
      );

      blockNextPlay = false;
      await act(async () => {
        await audioRef.current?.play();
      });
      expect(playAttempts).toBe(2);
      expect(blockedEvents).toEqual([
        [true, "NotAllowedError"],
        [false, undefined],
      ]);

      // A pending play() retry aborted by hangup / track teardown does not re-report blocked=true.
      const botTrack2 = {
        id: "bot-track-2",
        kind: "audio",
        readyState: "live",
      } as MediaStreamTrack;
      blockNextPlay = true;
      await act(async () => {
        raw.emit(RTVIEvent.TrackStarted, botTrack2, { id: "bot", name: "bot", local: false });
        await new Promise((resolve) => origSetTimeout(resolve, 0));
      });
      expect(blockedEvents).toEqual([
        [true, "NotAllowedError"],
        [false, undefined],
        [true, "NotAllowedError"],
      ]);
      let rejectRetryGate!: (err: Error) => void;
      pendingPlayGate = new Promise<void>((_, reject) => {
        rejectRetryGate = reject;
      });
      let retryPromise!: Promise<void> | undefined;
      await act(async () => {
        retryPromise = audioRef.current?.play();
      });
      await act(async () => {
        raw.emit(RTVIEvent.TrackStopped, botTrack2, { id: "bot", name: "bot", local: false });
      });
      expect(blockedEvents).toEqual([
        [true, "NotAllowedError"],
        [false, undefined],
        [true, "NotAllowedError"],
        [false, undefined],
      ]);
      pendingPlayGate = null;
      await act(async () => {
        rejectRetryGate(new DOMException("The play() request was interrupted", "AbortError"));
        await retryPromise;
      });
      expect(blockedEvents).toEqual([
        [true, "NotAllowedError"],
        [false, undefined],
        [true, "NotAllowedError"],
        [false, undefined],
      ]);

      // 3. Text-only replies (will_be_spoken: false, no botStoppedSpeaking) arm the finalize timer and close cleanly.
      await act(async () => {
        raw.emit(RTVIEvent.BotOutput, {
          text: "纯文字回复。",
          spoken_status: "new",
          segment_id: 1,
          will_be_spoken: false,
        });
      });
      expect(conv.messages).toHaveLength(1);
      expect(conv.messages[0]?.final).toBe(false);
      expect(scheduledFinalize).toHaveLength(1);
      await act(async () => {
        scheduledFinalize.pop()?.();
      });
      expect(conv.messages[0]?.final).toBe(true);

      // 4. Hanging up mid-reply closes open user, assistant, and function_call entries without marking unheard words spoken.
      await act(async () => {
        raw.emit(RTVIEvent.UserInput, {
          text: "喂",
          final: false,
          input_type: "transcription",
        });
        raw.emit(RTVIEvent.LLMFunctionCallStarted, { function_name: "take_selfie" });
        raw.emit(RTVIEvent.BotOutput, {
          text: "前半句后半句",
          spoken_status: "new",
          segment_id: 2,
          will_be_spoken: true,
        });
        raw.emit(RTVIEvent.BotOutput, {
          text: "前半句后半句",
          spoken_status: "in-progress",
          segment_id: 2,
          will_be_spoken: true,
          spoken_progress: { accumulated_text: "前半句", remaining_text: "后半句" },
        });
      });
      expect(conv.messages.some((m) => m.final !== true)).toBe(true);

      await act(async () => {
        raw.emit(RTVIEvent.Disconnected);
      });
      expect(conv.messages.every((m) => m.final === true)).toBe(true);
      const hungUpAssistant = conv.messages.at(-1);
      expect(hungUpAssistant?.parts[0]?.text).toEqual({
        spoken: "前半句",
        unspoken: "后半句",
      });
      const hungUpTool = conv.messages.find((m) => m.role === "function_call");
      expect(hungUpTool?.functionCall).toMatchObject({
        function_name: "take_selfie",
        cancelled: true,
        status: "completed",
      });
    } finally {
      globals.setTimeout = origSetTimeout;
      await act(async () => {
        root.unmount();
      });
      globals.IS_REACT_ACT_ENVIRONMENT = prevAct;
      globals.MediaStream = prevMediaStream;
      Object.defineProperty(globalThis, "navigator", {
        value: prevNavigator,
        configurable: true,
      });
      win.HTMLIFrameElement = prevIframe;
    }
  });

  test("muted calls apply saved mics, reused clients reset to default, and busy mic failures never record appliedMicId", async () => {
    const globals = globalThis as Record<string, unknown>;
    const prevAct = globals.IS_REACT_ACT_ENVIRONMENT;
    const prevNavigator = globals.navigator;
    const win = globalThis.window as unknown as Record<string, unknown>;
    const prevIframe = win.HTMLIFrameElement;
    globals.IS_REACT_ACT_ENVIRONMENT = true;
    win.HTMLIFrameElement = class {};
    Object.defineProperty(globalThis, "navigator", {
      value: {
        mediaDevices: Object.assign(new EventTarget(), {
          // Safari/Firefox-style enumeration without a synthetic "default" hardware item.
          enumerateDevices: async () => [
            { deviceId: "built-in", kind: "audioinput", label: "Built-in Mic", groupId: "g1" },
            { deviceId: "usb-2", kind: "audioinput", label: "USB Mic", groupId: "g2" },
            { deviceId: "usb-busy", kind: "audioinput", label: "Busy Mic", groupId: "g3" },
          ],
        }),
      },
      configurable: true,
    });
    const doc = Object.assign(new EventTarget(), {
      activeElement: null,
      defaultView: win,
      createElement(tag: string) {
        return Object.assign(new EventTarget(), {
          nodeType: 1,
          nodeName: tag.toUpperCase(),
          tagName: tag.toUpperCase(),
          namespaceURI: "http://www.w3.org/1999/xhtml",
          childNodes: [],
          firstChild: null,
          ownerDocument: doc,
          style: {},
          setAttribute() {},
          removeAttribute() {},
          removeChild() {},
          appendChild() {},
          insertBefore() {},
        });
      },
    });
    const container = doc.createElement("div");

    const client = new EidolonClient({ enableMic: false });
    const manager = Reflect.get(client.rawTransport, "mediaManager") as object;
    const raw = client.rawClient as unknown as {
      emit: (event: string, ...args: unknown[]) => void;
    };
    const openedDevices: string[] = [];
    const recordedDevices: string[] = [];
    const createdContexts: Array<{ deviceId: string; state: string }> = [];
    const deviceErrors: unknown[] = [];
    client.on("deviceError", (err) => deviceErrors.push(err));
    let busyMics = new Set<string>(["usb-busy"]);
    let currentOpenedId = "";
    let deviceChangeListener = null as ((devices: MediaDeviceInfo[]) => void) | null;
    let deviceErrorListener = null as
      | ((err: { devices: Array<"cam" | "mic">; type: string; error?: Error }) => void)
      | null;
    const recorderStub: {
      deviceSelection: { deviceId: string; kind: string; label: string } | null;
      processor: { context: { state: string; close: () => Promise<void> } } | null;
      stream: {
        getTracks: () => MediaStreamTrack[];
        getAudioTracks: () => MediaStreamTrack[];
      } | null;
      listDevices: () => Promise<MediaDeviceInfo[]>;
      getStatus: () => string;
      begin: (deviceId?: string) => Promise<boolean>;
      record: () => Promise<boolean>;
      pause: () => Promise<boolean>;
      end: () => Promise<void>;
      listenForDeviceChange: (cb: ((devices: MediaDeviceInfo[]) => void) | null) => void;
      listenForDeviceErrors: (
        cb: ((err: { devices: Array<"cam" | "mic">; type: string; error?: Error }) => void) | null,
      ) => void;
    } = {
      deviceSelection: null,
      processor: null,
      stream: null,
      listDevices: async () =>
        [
          {
            deviceId: "built-in",
            kind: "audioinput",
            label: "Built-in Mic",
            groupId: "g1",
            toJSON: () => ({}),
          },
          {
            deviceId: "usb-2",
            kind: "audioinput",
            label: "USB Mic",
            groupId: "g2",
            toJSON: () => ({}),
          },
          {
            deviceId: "usb-busy",
            kind: "audioinput",
            label: "Busy Mic",
            groupId: "g3",
            toJSON: () => ({}),
          },
        ] as MediaDeviceInfo[],
      getStatus: () => (recorderStub.processor === null ? "ended" : "paused"),
      begin: async (deviceId?: string) => {
        if (recorderStub.processor) {
          throw new Error("Already connected: please call .end() to start a new session");
        }
        const effective = deviceId ?? recorderStub.deviceSelection?.deviceId ?? "";
        if (busyMics.has(effective)) {
          deviceErrorListener?.({
            devices: ["mic"],
            type: "unknown",
            error: new Error("Busy device"),
          });
          throw new Error("Could not start media stream");
        }
        if (effective === "usb-worklet-fail") {
          const leakedTrack = {
            id: "track-worklet-fail",
            kind: "audio",
            enabled: true,
            readyState: "live",
            stop() {
              (this as { readyState: string }).readyState = "ended";
            },
          } as unknown as MediaStreamTrack;
          recorderStub.stream = {
            getTracks: () => [leakedTrack],
            getAudioTracks: () => [leakedTrack],
          };
          throw new Error("Could not add audioWorklet module");
        }
        const resolved = effective || "built-in";
        currentOpenedId = resolved;
        openedDevices.push(resolved);
        // Matches WavRecorder.begin(): listDevices() resolves asynchronously after begin() returns.
        setTimeout(() => {
          if (recorderStub.stream) {
            recorderStub.deviceSelection = {
              deviceId: resolved,
              kind: "audioinput",
              label: resolved,
            };
          }
        }, 5);
        const track = {
          id: `track-${resolved}`,
          kind: "audio",
          enabled: true,
          readyState: "live",
          stop() {
            (this as { readyState: string }).readyState = "ended";
          },
        } as unknown as MediaStreamTrack;
        const ctx = {
          deviceId: resolved,
          state: "running",
          close: async () => {
            ctx.state = "closed";
          },
        };
        createdContexts.push(ctx);
        recorderStub.processor = {
          context: ctx,
        };
        recorderStub.stream = { getTracks: () => [track], getAudioTracks: () => [track] };
        return true;
      },
      record: async () => {
        recordedDevices.push(currentOpenedId);
        return true;
      },
      pause: async () => true,
      end: async () => {
        // Matches WavRecorder.end(): stops stream + clears processor without resetting deviceSelection.
        for (const t of recorderStub.stream?.getTracks() ?? []) t.stop();
        recorderStub.stream = null;
        recorderStub.processor = null;
      },
      listenForDeviceChange: (cb) => {
        deviceChangeListener = cb;
      },
      listenForDeviceErrors: (cb) => {
        deviceErrorListener = cb;
      },
    };
    Reflect.set(manager, "_wavRecorder", recorderStub);
    Reflect.set(manager, "_wavStreamPlayer", {
      context: null,
      connect: async () => true,
      interrupt: async () => {},
    });
    let selectedAtTransportConnect: string | undefined;
    Reflect.set(client.rawTransport, "_connect", async () => {
      selectedAtTransportConnect = client.selectedMic.deviceId;
      await (manager as { connect: () => Promise<void> }).connect();
      Reflect.set(client.rawTransport, "dc", {
        readyState: "open",
        send: () => {
          const onMessage = Reflect.get(client.rawTransport, "_onMessage") as (
            msg: unknown,
          ) => void;
          Reflect.set(client.rawTransport, "state", "ready");
          onMessage({ label: "rtvi-ai", id: "1", type: "bot-ready", data: { version: "1.0.0" } });
        },
        close: () => {},
      });
      Reflect.set(client.rawTransport, "state", "connected");
      raw.emit(RTVIEvent.Connected);
    });
    Reflect.set(client.rawTransport, "_disconnect", async () => {
      Reflect.set(client.rawTransport, "dc", null);
      Reflect.set(client.rawTransport, "state", "disconnected");
    });

    let setPersistedMic!: (id: string | null) => void;
    let micHook!: EidolonMicDevices;
    function App() {
      const [persisted, _setPersisted] = useState<string | null>("usb-2");
      setPersistedMic = _setPersisted;
      micHook = useEidolonMicDevices({
        persistedMicId: persisted,
        onPersistMicId: _setPersisted,
      });
      return null;
    }

    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => {
        root.render(
          React.createElement(EidolonClientProvider, { client }, React.createElement(App)),
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(micHook.selectedMicId).toBe("usb-2");
      expect(openedDevices).toEqual([]);

      // 1. Muted call still applies saved "usb-2" while keeping its track disabled until enableMic(true).
      await act(async () => {
        await client.connect({ endpoint: "https://bot.example/api/offer" });
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(openedDevices).toEqual(["usb-2"]);
      expect(recordedDevices).toEqual([]);
      expect(client.appliedMicId).toBe("usb-2");
      expect(client.tracks().local.audio?.id).toBe("track-usb-2");
      expect(client.tracks().local.audio?.enabled).toBe(false);

      await act(async () => {
        client.enableMic(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(client.tracks().local.audio?.id).toBe("track-usb-2");
      expect(client.tracks().local.audio?.enabled).toBe(true);
      expect(recordedDevices).toEqual(["usb-2"]);

      // 2. Mid-call swap to a busy or worklet-failing mic rejects through WavMediaManager.updateMic,
      // stops any stream opened before addModule failed, never records the failed device as applied,
      // and keeps WavRecorder's device-change / device-error listeners attached for retries and unplug fallback.
      expect(deviceChangeListener).not.toBeNull();
      expect(deviceErrorListener).not.toBeNull();
      await expect(client.selectLiveMic("usb-busy")).rejects.toThrow(
        "Could not start media stream",
      );
      expect(client.appliedMicId).toBeNull();
      expect(deviceErrors).toHaveLength(1);
      await expect(client.selectLiveMic("usb-worklet-fail")).rejects.toThrow(
        "Could not add audioWorklet module",
      );
      expect(client.appliedMicId).toBeNull();
      expect(recorderStub.stream).toBeNull();
      // Subsequent device errors still surface because failure cleanup kept _deviceErrorCallback attached.
      await expect(client.selectLiveMic("usb-busy")).rejects.toThrow(
        "Could not start media stream",
      );
      expect(deviceErrors).toHaveLength(2);
      expect(deviceChangeListener).not.toBeNull();
      expect(deviceErrorListener).not.toBeNull();

      // Recovery swap to "usb-2" followed by hot-unplug while muted still triggers automatic fallback
      // through the bridge (updating appliedMicId and keeping the fallback track disabled).
      await act(async () => {
        await client.selectLiveMic("usb-2");
        client.enableMic(false);
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(client.appliedMicId).toBe("usb-2");
      expect(recorderStub.deviceSelection?.deviceId).toBe("usb-2");
      await act(async () => {
        deviceChangeListener?.([
          {
            deviceId: "built-in",
            kind: "audioinput",
            label: "Built-in Mic",
            groupId: "g1",
            toJSON: () => ({}),
          } as MediaDeviceInfo,
        ]);
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(openedDevices).toEqual(["usb-2", "usb-2", "built-in"]);
      expect(recorderStub.deviceSelection?.deviceId).toBe("built-in");
      expect(client.appliedMicId).toBe(SYSTEM_DEFAULT_MIC_ID);
      expect(client.tracks().local.audio?.id).toBe("track-built-in");
      expect(client.tracks().local.audio?.enabled).toBe(false);

      // Re-select "usb-2" before hangup so disconnect() verifies sticky deviceSelection AND listener teardown.
      await act(async () => {
        await client.selectLiveMic("usb-2");
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      // Every outgoing AudioContext from prior swaps and unplug fallbacks was closed; only the current one runs.
      expect(createdContexts.length).toBeGreaterThanOrEqual(4);
      expect(createdContexts.slice(0, -1).every((c) => c.state === "closed")).toBe(true);
      expect(createdContexts.at(-1)?.state).toBe("running");
      await act(async () => {
        await client.disconnect();
      });
      expect(createdContexts.every((c) => c.state === "closed")).toBe(true);
      expect(deviceChangeListener).toBeNull();
      expect(deviceErrorListener).toBeNull();
      // WavRecorder.end() preserved deviceSelection from "usb-2" across hangup.
      expect(recorderStub.deviceSelection?.deviceId).toBe("usb-2");

      // 3. Reusing the same client after switching preference back to "default" clears sticky deviceSelection.
      await act(async () => {
        setPersistedMic(SYSTEM_DEFAULT_MIC_ID);
      });
      await act(async () => {
        await client.connect({ endpoint: "https://bot.example/api/offer" });
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(selectedAtTransportConnect).toBeUndefined();
      expect(openedDevices).toEqual(["usb-2", "usb-2", "built-in", "usb-2", "built-in"]);
      expect(client.appliedMicId).toBe(SYSTEM_DEFAULT_MIC_ID);

      await act(async () => {
        await client.disconnect();
      });

      // 4. Pre-connect busy mic leaves appliedMicId null, falls back to default, and does not block onConnected retry.
      await act(async () => {
        setPersistedMic("usb-busy");
      });
      await act(async () => {
        await client.applyMicPreference("usb-busy");
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(client.appliedMicId).toBeNull();
      expect(openedDevices).toEqual([
        "usb-2",
        "usb-2",
        "built-in",
        "usb-2",
        "built-in",
        "built-in",
      ]);

      // Once "usb-busy" becomes free while "connecting", onConnected applies it because appliedMicId was not poisoned.
      await act(async () => {
        await client.disconnect();
      });
      await act(async () => {
        Reflect.set(client.rawTransport, "state", "connecting");
        micHook.selectMic("usb-busy");
      });
      busyMics = new Set();
      await act(async () => {
        Reflect.set(client.rawTransport, "state", "connected");
        raw.emit(RTVIEvent.Connected);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(client.appliedMicId).toBe("usb-busy");
      expect(openedDevices).toEqual([
        "usb-2",
        "usb-2",
        "built-in",
        "usb-2",
        "built-in",
        "built-in",
        "usb-busy",
      ]);

      // 5. Unplug fallback routes through the bridge's serialized, epoch-checked updateMic path so a
      // delayed fallback getUserMedia never leaves capture active after disconnect(), and a stale
      // devicechange callback resolving after disconnect() completes never opens capture.
      await act(async () => {
        await client.disconnect();
      });
      await act(async () => {
        setPersistedMic("usb-2");
      });
      await act(async () => {
        await client.connect({ endpoint: "https://bot.example/api/offer" });
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(client.appliedMicId).toBe("usb-2");
      expect(recorderStub.deviceSelection?.deviceId).toBe("usb-2");
      const staleDeviceChange = deviceChangeListener;
      expect(staleDeviceChange).not.toBeNull();

      let markFallbackStarted!: () => void;
      const fallbackStarted = new Promise<void>((resolve) => {
        markFallbackStarted = resolve;
      });
      let fallbackFinished = false;
      const origRecorderBegin = recorderStub.begin;
      recorderStub.begin = async (deviceId?: string) => {
        markFallbackStarted();
        await new Promise((resolve) => setTimeout(resolve, 15));
        const ok = await origRecorderBegin(deviceId);
        fallbackFinished = true;
        return ok;
      };
      try {
        await act(async () => {
          deviceChangeListener?.([
            {
              deviceId: "built-in",
              kind: "audioinput",
              label: "Built-in Mic",
              groupId: "g1",
              toJSON: () => ({}),
            } as MediaDeviceInfo,
          ]);
          await fallbackStarted;
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        await act(async () => {
          await client.disconnect();
        });
        expect(fallbackFinished).toBe(true);
        expect(recorderStub.stream).toBeNull();
        expect(recorderStub.processor).toBeNull();
        expect(client.tracks().local.audio).toBeUndefined();
      } finally {
        recorderStub.begin = origRecorderBegin;
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(recorderStub.stream).toBeNull();

      recorderStub.deviceSelection = { deviceId: "usb-2", kind: "audioinput", label: "usb-2" };
      const opensBeforeStaleCallback = openedDevices.length;
      await act(async () => {
        staleDeviceChange?.([
          {
            deviceId: "built-in",
            kind: "audioinput",
            label: "Built-in Mic",
            groupId: "g1",
            toJSON: () => ({}),
          } as MediaDeviceInfo,
        ]);
        await new Promise((resolve) => setTimeout(resolve, 15));
      });
      expect(openedDevices).toHaveLength(opensBeforeStaleCallback);
      expect(recorderStub.stream).toBeNull();
      expect(client.appliedMicId).toBeNull();

      // 6. Clearing preference via setPersistedMic(null) / setPreferredMic(null) clears sticky
      // WavRecorder.deviceSelection and resets pre-connect hardware capture back to system default.
      expect(recorderStub.deviceSelection?.deviceId).toBe("usb-2");
      await act(async () => {
        setPersistedMic(null);
      });
      expect(micHook.selectedMicId).toBe("built-in");
      expect(recorderStub.deviceSelection).toBeNull();
      await act(async () => {
        await client.connect({ endpoint: "https://bot.example/api/offer" });
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(openedDevices.at(-1)).toBe("built-in");
      await act(async () => {
        await client.disconnect();
      });

      await act(async () => {
        await client.applyMicPreference("usb-2");
      });
      expect(openedDevices.at(-1)).toBe("usb-2");
      client.setPreferredMic(null);
      await act(async () => {
        await client.connect({ endpoint: "https://bot.example/api/offer" });
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(openedDevices.at(-1)).toBe("built-in");
      await act(async () => {
        await client.disconnect();
      });
      expect(createdContexts.every((c) => c.state === "closed")).toBe(true);

      // 7. Mounting useEidolonMicDevices while connect() is already in flight ("connecting")
      // preserves pendingPreConnectMicRef across effects and swaps to persistedMicId on connected.
      await act(async () => {
        root.render(React.createElement(EidolonClientProvider, { client }, null));
      });
      let finishMidConnect!: () => void;
      const midConnectGate = new Promise<void>((resolve) => {
        finishMidConnect = resolve;
      });
      const origConnectImpl = Reflect.get(client.rawTransport, "_connect") as (
        ...args: unknown[]
      ) => Promise<void>;
      Reflect.set(client.rawTransport, "_connect", async (...args: unknown[]) => {
        Reflect.set(client.rawTransport, "state", "connecting");
        await midConnectGate;
        await origConnectImpl(...args);
      });
      try {
        const midConnectPromise = client.connect({ endpoint: "https://bot.example/api/offer" });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
        expect(client.state).toBe("connecting");
        expect(openedDevices.at(-1)).toBe("built-in");

        await act(async () => {
          root.render(
            React.createElement(EidolonClientProvider, { client }, React.createElement(App)),
          );
        });
        await act(async () => {
          finishMidConnect();
          await midConnectPromise;
          await new Promise((resolve) => setTimeout(resolve, 15));
        });
        expect(openedDevices.at(-1)).toBe("usb-2");
        expect(client.appliedMicId).toBe("usb-2");
      } finally {
        Reflect.set(client.rawTransport, "_connect", origConnectImpl);
      }
      await act(async () => {
        await client.disconnect();
      });
      expect(createdContexts.every((c) => c.state === "closed")).toBe(true);
    } finally {
      await act(async () => {
        await client.disconnect();
        root.unmount();
      });
      globals.IS_REACT_ACT_ENVIRONMENT = prevAct;
      Object.defineProperty(globalThis, "navigator", {
        value: prevNavigator,
        configurable: true,
      });
      win.HTMLIFrameElement = prevIframe;
    }
  });
});

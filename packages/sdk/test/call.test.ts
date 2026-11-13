import { beforeAll, describe, expect, test } from "bun:test";
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
import { EMPTY_CONVERSATION_STATE, isBotOutputText, stepConversation } from "../src/react/index.ts";

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

    raw.emit(RTVIEvent.Disconnected);
    expect(client.tracks().bot).toBeUndefined();
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
});

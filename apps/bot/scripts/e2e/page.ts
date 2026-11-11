// Browser half of e2e-call: the /ai page's call flow from laplace's ai-chat-renderer.tsx and
// ai-chat-content.tsx, minus React, reporting everything it observes back to the runner.
import {
  type BotReadyData,
  type Participant,
  PipecatClient,
  RTVIEvent,
} from "@pipecat-ai/client-js";
import { SmallWebRTCTransport, WavMediaManager } from "@pipecat-ai/small-webrtc-transport";
import {
  type ConnectOptions,
  type ConnectResult,
  type E2EPage,
  type EntrySource,
  FLOOR_DB,
  LEVEL_INTERVAL_MS,
  type LevelSample,
} from "./protocol.ts";

// The /ai page's default `useAiChatAudioQuality`; an anonymous viewer sends no loginSyncToken.
const AUDIO_QUALITY = "medium";

const logView = document.getElementById("log");

function emit(source: EntrySource, event: string, data?: unknown): void {
  const entry = { at: Date.now(), source, event, data: toPlain(data) };
  if (logView && source !== "level") {
    logView.textContent += `${new Date(entry.at).toISOString().slice(11, 23)} ${source} ${event}\n`;
  }
  void window.e2eEmit?.(entry);
}

function toPlain(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return undefined;
  if (value instanceof MediaStreamTrack) {
    const { kind, id, label, enabled, muted, readyState } = value;
    return { kind, id, label, enabled, muted, readyState };
  }
  if (value instanceof MediaDeviceInfo) return value.toJSON();
  if (value instanceof Response) return { status: value.status, url: value.url };
  if (depth > 6) return "[nested]";
  if (Array.isArray(value)) return value.map((item) => toPlain(item, depth + 1));
  const plain: Record<string, unknown> = {};
  if (value instanceof Error) {
    plain.name = value.name;
    plain.message = value.message;
  }
  for (const [key, field] of Object.entries(value)) {
    const converted = toPlain(field, depth + 1);
    if (converted !== undefined) plain[key] = converted;
  }
  return plain;
}

/** `udp host 10.0.1.28:51234` from an SDP `candidate:` line. */
function describeCandidate(line: string): string {
  const parts = line.replace(/^a=/, "").split(" ");
  return `${parts[2]?.toLowerCase()} ${parts[7]} ${parts[4]}:${parts[5]}`;
}

function sdpCandidates(sdp: unknown): string[] {
  if (typeof sdp !== "string") return [];
  return sdp
    .split(/\r?\n/)
    .filter((line) => line.startsWith("a=candidate:"))
    .map(describeCandidate);
}

async function describeRequestBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const body = input instanceof Request ? await input.clone().text() : init?.body;
  if (typeof body !== "string" || body === "") return undefined;
  try {
    const { sdp, candidates, ...rest } = JSON.parse(body);
    return {
      ...rest,
      ...(sdp === undefined ? {} : { sdpCandidates: sdpCandidates(sdp) }),
      ...(Array.isArray(candidates)
        ? {
            candidates: candidates.map((c: { candidate?: string }) =>
              describeCandidate(`${c.candidate}`),
            ),
          }
        : {}),
    };
  } catch {
    return { bytes: body.length };
  }
}

const nativeFetch = window.fetch.bind(window);
let requestCount = 0;
// The cast drops `preconnect`, which bun-types adds to `typeof fetch` and browsers lack.
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const id = ++requestCount;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const url = input instanceof Request ? input.url : String(input);
  const started = performance.now();
  emit("http", "request", { id, method, url, body: await describeRequestBody(input, init) });
  try {
    const response = await nativeFetch(input, init);
    const ms = Math.round(performance.now() - started);
    emit("http", "response", { id, method, url, status: response.status, ms });
    if (method === "POST" && url.endsWith("/api/offer") && response.ok) {
      response
        .clone()
        .json()
        .then(({ pc_id, sdp }) =>
          emit("http", "answer", { id, pc_id, sdpCandidates: sdpCandidates(sdp) }),
        )
        .catch(() => undefined);
    }
    return response;
  } catch (error) {
    emit("http", "failed", { id, method, url, error, ms: Math.round(performance.now() - started) });
    throw error;
  }
}) as typeof fetch;

let peerCount = 0;
class ObservedPeerConnection extends RTCPeerConnection {
  constructor(config?: RTCConfiguration) {
    super(config);
    const pc = ++peerCount;
    emit("pc", "created", { pc, iceServers: config?.iceServers ?? [] });
    this.addEventListener("signalingstatechange", () =>
      emit("pc", "signalingState", { pc, state: this.signalingState }),
    );
    this.addEventListener("icegatheringstatechange", () =>
      emit("pc", "iceGatheringState", { pc, state: this.iceGatheringState }),
    );
    this.addEventListener("iceconnectionstatechange", () =>
      emit("pc", "iceConnectionState", { pc, state: this.iceConnectionState }),
    );
    this.addEventListener("connectionstatechange", () =>
      emit("pc", "connectionState", { pc, state: this.connectionState }),
    );
    this.addEventListener("icecandidate", ({ candidate }) => {
      if (candidate?.candidate) {
        emit("pc", "localCandidate", { pc, candidate: describeCandidate(candidate.candidate) });
      }
    });
    this.addEventListener("track", ({ track, transceiver }) =>
      emit("pc", "remoteTrack", { pc, kind: track.kind, mid: transceiver?.mid ?? null }),
    );
  }

  override createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel {
    const channel = super.createDataChannel(label, init);
    channel.addEventListener("open", () => emit("pc", "dataChannelOpen", { label }));
    channel.addEventListener("close", () => emit("pc", "dataChannelClose", { label }));
    // The bot's messages as sent, in order, for the RTVI invariants: client-js's events rename,
    // drop and reorder some of them.
    channel.addEventListener("message", ({ data }) => {
      if (typeof data !== "string" || data.startsWith("ping")) return;
      try {
        const message = JSON.parse(data);
        if (message?.label === "rtvi-ai") emit("wire", String(message.type), message.data);
      } catch {
        // Not JSON: nothing the bot sends.
      }
    });
    return channel;
  }
}
window.RTCPeerConnection = ObservedPeerConnection;

class LevelMeter {
  private readonly context: AudioContext;
  private readonly analyser: AnalyserNode;
  private readonly samples: Float32Array<ArrayBuffer>;
  private readonly span: number;
  private source: MediaStreamAudioSourceNode | undefined;

  constructor(context: AudioContext) {
    this.context = context;
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 8192;
    this.samples = new Float32Array(this.analyser.fftSize);
    this.span = Math.min(
      this.samples.length,
      Math.round((context.sampleRate * LEVEL_INTERVAL_MS) / 1000),
    );
  }

  attach(track: MediaStreamTrack): void {
    this.source?.disconnect();
    this.source = this.context.createMediaStreamSource(new MediaStream([track]));
    this.source.connect(this.analyser);
  }

  read(): number | null {
    if (!this.source) return null;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (let i = this.samples.length - this.span; i < this.samples.length; i++) {
      sum += this.samples[i]! ** 2;
    }
    const rms = Math.sqrt(sum / this.span);
    return rms > 0 ? Math.max(FLOOR_DB, Math.round(200 * Math.log10(rms)) / 10) : FLOOR_DB;
  }
}

const transport = new SmallWebRTCTransport({
  iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
  mediaManager: new WavMediaManager(),
});
const client = new PipecatClient({ transport, enableMic: true, enableCam: false });

for (const name of Object.values(RTVIEvent)) {
  client.on(name, (...args: unknown[]) => emit("rtvi", name, args.length > 1 ? args : args[0]));
}

// <PipecatClientAudio /> plays the bot through an autoplaying element. The level meter needs it too:
// Chrome feeds WebAudio silence from a remote WebRTC track no media element is playing.
// https://issues.chromium.org/issues/40094084
const botAudio = document.createElement("audio");
botAudio.autoplay = true;
document.body.append(botAudio);

// Built before any call: the first AudioContext blocks ~0.5 s while macOS brings up CoreAudio.
const context = new AudioContext();
const meters = { bot: new LevelMeter(context), mic: new LevelMeter(context) };
let sampler: ReturnType<typeof setInterval> | undefined;
let holdMic = false;

client.on(RTVIEvent.TrackStarted, (track: MediaStreamTrack, participant?: Participant) => {
  if (track.kind !== "audio") return;
  if (participant?.local !== true) {
    const playing = botAudio.srcObject instanceof MediaStream ? botAudio.srcObject : undefined;
    if (playing?.getAudioTracks()[0]?.id !== track.id) {
      botAudio.srcObject = new MediaStream([track]);
      botAudio.play().catch((error) => emit("harness", "botAudioPlayFailed", { error }));
    }
    meters.bot.attach(track);
    return;
  }
  meters.mic.attach(track);
  if (holdMic) {
    emit("harness", "micHeld");
    client.enableMic(false);
    return;
  }
  // ai-chat-content.tsx forwards a mid-call mic swap to the audio sender itself: WavMediaManager
  // drops the replaceTrack wiring the transport's default media manager carries.
  const pc = Reflect.get(transport, "pc");
  if (!(pc instanceof RTCPeerConnection)) return;
  pc.getTransceivers()[0]
    ?.sender.replaceTrack(track)
    .then(() => emit("harness", "micTrackReplaced", { track }))
    .catch((error) => emit("harness", "micTrackReplaceFailed", { error }));
});

function startSampling(): void {
  sampler ??= setInterval(() => {
    const sample: LevelSample = { bot: meters.bot.read(), mic: meters.mic.read() };
    if (sample.bot !== null || sample.mic !== null) emit("level", "sample", sample);
  }, LEVEL_INTERVAL_MS);
}

async function refreshIceServers(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/ice-servers`);
  if (!res.ok) throw new Error(`ICE servers unavailable (HTTP ${res.status})`);
  const { iceServers } = await res.json();
  if (!Array.isArray(iceServers)) throw new Error("ICE servers unavailable (malformed response)");
  transport.iceServers = iceServers;
}

async function connect({ baseUrl, holdMic: hold }: ConnectOptions): Promise<ConnectResult> {
  holdMic = hold;
  emit("harness", "connect", { baseUrl, holdMic: hold, clientVersion: client.version });
  startSampling();
  client.enableMic(true);
  try {
    await refreshIceServers(baseUrl);
    const botReady: BotReadyData = await client.connect({
      webrtcRequestParams: {
        endpoint: `${baseUrl}/api/offer`,
        requestData: { audioQuality: AUDIO_QUALITY },
      },
    });
    return { ok: true, botReady: toPlain(botReady) };
  } catch (error) {
    return { ok: false, error: toPlain(error) };
  }
}

async function sendText(text: string): Promise<string> {
  emit("harness", "askText", { text });
  return client.sendText(text, { run_immediately: true, audio_response: true });
}

/** Restart the capture so the fake device plays its file from the top, then unmute. */
async function askByVoice(): Promise<void> {
  holdMic = false;
  const selected = client.selectedMic;
  const micId = "deviceId" in selected ? selected.deviceId : "";
  emit("harness", "askVoice", { micId });
  await transport.updateMic(micId);
  client.enableMic(true);
}

/**
 * Plays the WAV at `url` into the call in place of the mic, as a caller talking over her, then
 * puts the mic back. WebAudio's track skips Chrome's capture AGC, so it arrives at its own level.
 */
async function bargeIn(url: string): Promise<{ durationMs: number }> {
  const pc = Reflect.get(transport, "pc");
  if (!(pc instanceof RTCPeerConnection)) throw new Error("no call to talk over");
  const sender = pc.getTransceivers()[0]?.sender;
  if (sender === undefined) throw new Error("the call has no audio sender");
  const buffer = await context.decodeAudioData(await (await fetch(url)).arrayBuffer());
  const destination = context.createMediaStreamDestination();
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(destination);
  const mic = sender.track;
  const voice = destination.stream.getAudioTracks()[0] as MediaStreamTrack;
  await sender.replaceTrack(voice);
  meters.mic.attach(voice);
  const durationMs = Math.round(buffer.duration * 1000);
  const played = new Promise<void>((resolve) => source.addEventListener("ended", () => resolve()));
  source.start();
  emit("harness", "bargeIn", { url, durationMs });
  await played;
  emit("harness", "bargeInEnded");
  await sender.replaceTrack(mic);
  if (mic) meters.mic.attach(mic);
  return { durationMs };
}

async function stats(): Promise<unknown> {
  const pc = Reflect.get(transport, "pc");
  if (!(pc instanceof RTCPeerConnection)) return null;
  const reports = await pc.getStats();
  const out: Record<string, unknown> = {};
  for (const report of reports.values()) {
    if (report.type === "transport" && report.selectedCandidatePairId) {
      const pair = reports.get(report.selectedCandidatePairId);
      const local = reports.get(pair?.localCandidateId);
      const remote = reports.get(pair?.remoteCandidateId);
      out.selectedPair = {
        local: `${local?.protocol} ${local?.candidateType} ${local?.address}:${local?.port}`,
        remote: `${remote?.protocol} ${remote?.candidateType} ${remote?.address}:${remote?.port}`,
        currentRoundTripTime: pair?.currentRoundTripTime,
      };
    } else if (report.type === "inbound-rtp" && report.kind === "audio") {
      out.inboundAudio = {
        codec: reports.get(report.codecId)?.mimeType,
        packetsReceived: report.packetsReceived,
        packetsLost: report.packetsLost,
        bytesReceived: report.bytesReceived,
        jitter: report.jitter,
        totalAudioEnergy: report.totalAudioEnergy,
        totalSamplesDuration: report.totalSamplesDuration,
        concealedSamples: report.concealedSamples,
      };
    } else if (report.type === "outbound-rtp" && report.kind === "audio") {
      out.outboundAudio = {
        codec: reports.get(report.codecId)?.mimeType,
        packetsSent: report.packetsSent,
        bytesSent: report.bytesSent,
      };
    }
  }
  return out;
}

async function disconnect(): Promise<void> {
  emit("harness", "disconnect");
  await client.disconnect();
  clearInterval(sampler);
  sampler = undefined;
}

const api: E2EPage = { connect, sendText, askByVoice, bargeIn, stats, disconnect };
window.e2e = api;
emit("harness", "pageReady", {
  clientVersion: client.version,
  userAgent: navigator.userAgent,
  meterSampleRate: context.sampleRate,
});

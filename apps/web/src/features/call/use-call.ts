// One call at a time, over SmallWebRTC to this server's /api/offer. Each call gets a fresh client
// and transport, so nothing a finished or cancelled call leaves running can reach the next one.
import { PipecatClient, RTVIEvent, type RTVIEvents, type RTVIMessage } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport, WavMediaManager } from "@pipecat-ai/small-webrtc-transport";
import { type RefObject, useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ChatCallRequestData } from "@/lib/api";
import { deviceProblemOf, type MicProblem, probeMic } from "./media";
import { type CallPhase, connectEnd, endOf, IDLE, reducePhase } from "./phase";
import { selfiePaths, selfiePersona } from "./selfie";
import { fetchIceServers, offerRequest } from "./signalling";
import { EMPTY_TRANSCRIPT, reduceTranscript, speakerOf, type Transcript } from "./transcript";
import { type WaitState, Watchdog } from "./watchdog";

export interface BotError {
  /** The latest error the bot reported, as it worded it. */
  readonly message: string;
  readonly count: number;
}

export interface Call {
  readonly phase: CallPhase;
  readonly transcript: Transcript;
  readonly wait: WaitState;
  readonly micOn: boolean;
  readonly userSpeaking: boolean;
  readonly botSpeaking: boolean;
  /** A mic that failed mid-call. */
  readonly micProblem: MicProblem | null;
  /** Errors the bot reported during the call, such as a TTS or LLM failure. */
  readonly botError: BotError | null;
  /** The browser wouldn't start the bot's audio without another click. */
  readonly audioBlocked: boolean;
  /** The element that plays the bot. */
  readonly audioRef: RefObject<HTMLAudioElement | null>;
  /** Calls the active persona, or with a target, a persona inside a chat. */
  start(target?: ChatCallRequestData): void;
  hangUp(): void;
  setMic(on: boolean): void;
  sendText(text: string): void;
  dismissBotError(): void;
  playAudio(): void;
}

interface ActiveCall {
  readonly client: PipecatClient;
  readonly transport: SmallWebRTCTransport;
  /** The bot said it was leaving before the transport went. */
  botLeft: boolean;
  /** When the call last heard speech, to tell the bot's idle timeout from other endings. */
  heardAt: number;
  detach(): void;
}

/**
 * WavMediaManager drops the replaceTrack wiring the transport's default media manager has, so a
 * mic it restarts (after a device change, say) would send silence. `pc` is private; the audio
 * transceiver is the first one the transport adds.
 */
function bridgeMic(transport: SmallWebRTCTransport, track: MediaStreamTrack): void {
  const pc: unknown = Reflect.get(transport, "pc");
  if (!(pc instanceof RTCPeerConnection)) return;
  pc.getTransceivers()[0]
    ?.sender.replaceTrack(track)
    .catch(() => undefined);
}

function errorText(message: RTVIMessage): string {
  const data = message.data as { error?: unknown; message?: unknown } | undefined;
  const text = data?.error ?? data?.message;
  return typeof text === "string" ? text : "";
}

function attach(client: PipecatClient, listeners: RTVIEvents): () => void {
  const pairs = Object.entries(listeners) as [keyof RTVIEvents, RTVIEvents[keyof RTVIEvents]][];
  for (const [event, listener] of pairs) client.on(event, listener);
  return () => {
    for (const [event, listener] of pairs) client.off(event, listener);
  };
}

export function useCall(): Call {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [phase, dispatchPhase] = useReducer(reducePhase, IDLE);
  const [transcript, dispatchTranscript] = useReducer(reduceTranscript, EMPTY_TRANSCRIPT);
  const [wait, setWait] = useState<WaitState>({ thinking: false, stuck: false });
  const [watchdog] = useState(() => new Watchdog(setWait));
  const [micOn, setMicOn] = useState(true);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [botSpeaking, setBotSpeaking] = useState(false);
  const [micProblem, setMicProblem] = useState<MicProblem | null>(null);
  const [botError, setBotError] = useState<BotError | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const activeRef = useRef<ActiveCall | null>(null);
  // Bumped by every start and hang-up: an older start stops at its next await.
  const attemptRef = useRef(0);
  const typedRef = useRef(0);

  const release = useCallback(
    (call: ActiveCall) => {
      if (activeRef.current === call) activeRef.current = null;
      call.detach();
      watchdog.clear();
      setUserSpeaking(false);
      setBotSpeaking(false);
      setAudioBlocked(false);
      if (audioRef.current) audioRef.current.srcObject = null;
    },
    [watchdog],
  );

  const playBot = useCallback((track: MediaStreamTrack) => {
    const audio = audioRef.current;
    if (audio === null) return;
    const playing = audio.srcObject instanceof MediaStream ? audio.srcObject : null;
    if (playing?.getAudioTracks()[0]?.id === track.id) return;
    audio.srcObject = new MediaStream([track]);
    audio
      .play()
      .then(() => setAudioBlocked(false))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "NotAllowedError")
          setAudioBlocked(true);
      });
  }, []);

  const listenersFor = useCallback(
    (call: ActiveCall): RTVIEvents => {
      const heard = () => {
        call.heardAt = Date.now();
      };
      return {
        [RTVIEvent.TrackStarted]: (track, participant) => {
          if (track.kind !== "audio") return;
          if (participant?.local) bridgeMic(call.transport, track);
          else playBot(track);
        },
        [RTVIEvent.BotStartedSpeaking]: () => {
          heard();
          watchdog.clear();
          setBotSpeaking(true);
          dispatchPhase({ type: "answered", at: Date.now() });
        },
        [RTVIEvent.BotStoppedSpeaking]: () => {
          heard();
          setBotSpeaking(false);
        },
        [RTVIEvent.UserStartedSpeaking]: () => {
          heard();
          watchdog.clear();
          setUserSpeaking(true);
        },
        [RTVIEvent.UserStoppedSpeaking]: () => {
          heard();
          setUserSpeaking(false);
          watchdog.arm();
        },
        [RTVIEvent.BotLlmStarted]: () => watchdog.llmStarted(),
        [RTVIEvent.UserInput]: (data) => {
          heard();
          dispatchTranscript({ type: "user-input", data });
        },
        [RTVIEvent.UserTranscript]: (data) => {
          heard();
          dispatchTranscript({ type: "user-transcript", data });
        },
        [RTVIEvent.BotOutput]: (data) => dispatchTranscript({ type: "bot-output", data }),
        [RTVIEvent.BotInterrupted]: () => dispatchTranscript({ type: "interrupted" }),
        [RTVIEvent.ServerMessage]: (data: unknown) => {
          const speaker = speakerOf(data);
          if (speaker !== null) {
            dispatchTranscript({ type: "speaker", speaker });
            return;
          }
          const paths = selfiePaths(data);
          if (paths.length > 0) {
            dispatchTranscript({ type: "selfie", paths, persona: selfiePersona(data) });
          }
        },
        [RTVIEvent.Error]: (message) => {
          watchdog.clear();
          const text = errorText(message);
          setBotError((last) => ({ message: text, count: (last?.count ?? 0) + 1 }));
        },
        [RTVIEvent.DeviceError]: (error) => {
          if (error.devices.includes("mic")) setMicProblem(deviceProblemOf(error));
        },
        [RTVIEvent.BotDisconnected]: () => {
          call.botLeft = true;
        },
        [RTVIEvent.Disconnected]: () => {
          // A failed connect rejects within this task, with the offer's status, and start()
          // reports that. A connect cut off after the data channel opened never settles.
          setTimeout(() => {
            if (activeRef.current !== call) return;
            release(call);
            const at = Date.now();
            dispatchPhase({
              type: "disconnected",
              at,
              end: endOf(call.botLeft, at - call.heardAt),
            });
          });
        },
      };
    },
    [playBot, release, watchdog],
  );

  const start = useCallback(
    async (target?: ChatCallRequestData) => {
      if (activeRef.current !== null) return;
      const attempt = ++attemptRef.current;
      const stale = () => attempt !== attemptRef.current;
      dispatchPhase({ type: "start", at: Date.now() });
      dispatchTranscript({ type: "reset" });
      watchdog.clear();
      setMicOn(true);
      setMicProblem(null);
      setBotError(null);

      const problem = await probeMic(navigator.mediaDevices);
      if (stale()) return;
      if (problem !== null) {
        dispatchPhase({ type: "failed", at: Date.now(), end: { kind: "mic", problem } });
        return;
      }
      let iceServers: RTCIceServer[];
      try {
        iceServers = await fetchIceServers();
      } catch (error) {
        if (stale()) return;
        const detail = error instanceof Error ? error.message : "";
        dispatchPhase({ type: "failed", at: Date.now(), end: { kind: "ice", detail } });
        return;
      }
      if (stale()) return;

      const transport = new SmallWebRTCTransport({
        iceServers,
        mediaManager: new WavMediaManager(),
      });
      const client = new PipecatClient({ transport, enableMic: true, enableCam: false });
      const call: ActiveCall = {
        client,
        transport,
        botLeft: false,
        heardAt: Date.now(),
        detach() {},
      };
      call.detach = attach(client, listenersFor(call));
      activeRef.current = call;
      dispatchPhase({ type: "dial" });
      try {
        await client.connect({ webrtcRequestParams: offerRequest(target) });
      } catch (error) {
        if (stale()) return;
        release(call);
        dispatchPhase({ type: "failed", at: Date.now(), end: connectEnd(error) });
        return;
      }
      if (stale()) return;
      call.heardAt = Date.now();
      dispatchPhase({ type: "ready" });
      // No one greets on a group call: it waits for the viewer, so it is answered as it comes up.
      if (target?.group) dispatchPhase({ type: "answered", at: Date.now() });
    },
    [listenersFor, release, watchdog],
  );

  const hangUp = useCallback(async () => {
    attemptRef.current++;
    dispatchPhase({ type: "hang-up" });
    const call = activeRef.current;
    if (call !== null) {
      release(call);
      await call.client.disconnect().catch(() => undefined);
    }
    dispatchPhase({ type: "disconnected", at: Date.now(), end: { kind: "hung-up" } });
  }, [release]);

  const setMic = useCallback((on: boolean) => {
    activeRef.current?.client.enableMic(on);
    setMicOn(on);
  }, []);

  const sendText = useCallback(
    (text: string) => {
      const call = activeRef.current;
      const trimmed = text.trim();
      if (call === null || trimmed === "") return;
      const key = `typed-${++typedRef.current}`;
      dispatchTranscript({ type: "typed", key, text: trimmed });
      call.heardAt = Date.now();
      // Typed text skips the bot's VAD, so no user-stopped-speaking starts the wait.
      watchdog.arm();
      call.client.sendText(trimmed, { run_immediately: true, audio_response: true }).catch(() => {
        watchdog.clear();
        dispatchTranscript({ type: "typed-failed", key });
      });
    },
    [watchdog],
  );

  const playAudio = useCallback(() => {
    audioRef.current
      ?.play()
      .then(() => setAudioBlocked(false))
      .catch(() => undefined);
  }, []);

  const dismissBotError = useCallback(() => setBotError(null), []);

  // Leaving the page hangs up and frees the mic.
  useEffect(
    () => () => {
      attemptRef.current++;
      watchdog.clear();
      const call = activeRef.current;
      activeRef.current = null;
      if (call === null) return;
      call.detach();
      void call.client.disconnect().catch(() => undefined);
    },
    [watchdog],
  );

  return {
    phase,
    transcript,
    wait,
    micOn,
    userSpeaking,
    botSpeaking,
    micProblem,
    botError,
    audioBlocked,
    audioRef,
    start: (target?: ChatCallRequestData) => void start(target),
    hangUp: () => void hangUp(),
    setMic,
    sendText,
    dismissBotError,
    playAudio,
  };
}

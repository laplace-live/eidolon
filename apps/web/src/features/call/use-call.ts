// One call at a time, over SmallWebRTC to this server's /api/offer. Each call gets a fresh client,
// so nothing a finished or cancelled call leaves running can reach the next one.
import { EidolonClient, type WaitState, Watchdog } from "@laplace.live/eidolon-sdk";
import { type RefObject, useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ChatCallRequestData } from "@/lib/api";
import { deviceProblemOf, type MicProblem, probeMic } from "./media";
import { type CallPhase, connectEnd, endOf, IDLE, reducePhase } from "./phase";
import { fetchIceServers, offerOptions } from "./signalling";
import { EMPTY_TRANSCRIPT, reduceTranscript, type Transcript } from "./transcript";
import { TurnWait } from "./turn-wait";

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
  readonly client: EidolonClient;
  /** The bot said it was leaving before the transport went. */
  botLeft: boolean;
  /** When the call last heard speech, to tell the bot's idle timeout from other endings. */
  heardAt: number;
  detach(): void;
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

  const subscribe = useCallback(
    (call: ActiveCall): (() => void) => {
      const { client } = call;
      const turn = new TurnWait(watchdog);
      const heard = () => {
        call.heardAt = Date.now();
      };
      const offs = [
        // The client hands its own mic to the peer connection; only the bot's audio is the page's.
        client.on("trackStarted", (track, participant) => {
          if (track.kind === "audio" && !participant?.local) playBot(track);
        }),
        client.on("botStartedSpeaking", () => {
          heard();
          turn.settled();
          setBotSpeaking(true);
          dispatchPhase({ type: "answered", at: Date.now() });
        }),
        client.on("botStoppedSpeaking", () => {
          heard();
          setBotSpeaking(false);
        }),
        client.on("userStartedSpeaking", () => {
          heard();
          turn.started();
          setUserSpeaking(true);
        }),
        client.on("userStoppedSpeaking", () => {
          heard();
          setUserSpeaking(false);
          turn.stopped();
        }),
        client.on("botLlmStarted", () => watchdog.llmStarted()),
        client.on("userInput", (data) => {
          heard();
          turn.heard(data);
          dispatchTranscript({ type: "user-input", data });
        }),
        client.on("userTranscript", (data) => {
          heard();
          turn.heard(data);
          dispatchTranscript({ type: "user-transcript", data });
        }),
        client.on("botOutput", (data) => dispatchTranscript({ type: "bot-output", data })),
        client.on("botInterrupted", () => dispatchTranscript({ type: "interrupted" })),
        client.on("serverMessage", (message) => {
          if (message.type === "speaker") {
            dispatchTranscript({ type: "speaker", speaker: message.speaker });
          } else if (message.type === "selfie" && message.urls.length > 0) {
            dispatchTranscript({ type: "selfie", paths: message.urls, persona: message.persona });
          }
        }),
        client.on("error", (message) => {
          turn.settled();
          const text = message.data.error;
          setBotError((last) => ({ message: text, count: (last?.count ?? 0) + 1 }));
        }),
        client.on("deviceError", (error) => {
          if (error.devices.includes("mic")) setMicProblem(deviceProblemOf(error));
        }),
        client.on("botDisconnected", () => {
          call.botLeft = true;
        }),
        client.on("disconnected", () => {
          // A failed connect rejects within this task, with the offer's status, and start()
          // reports that; so does one cut off before the bot was ready, on the next timer.
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
        }),
      ];
      return () => {
        for (const off of offs) off();
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

      const client = new EidolonClient({ iceServers, enableMic: true });
      const call: ActiveCall = {
        client,
        botLeft: false,
        heardAt: Date.now(),
        detach() {},
      };
      call.detach = subscribe(call);
      activeRef.current = call;
      dispatchPhase({ type: "dial" });
      try {
        await client.connect(offerOptions(target));
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
    [subscribe, release, watchdog],
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

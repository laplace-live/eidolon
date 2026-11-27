// One call at a time, over SmallWebRTC to this server's /api/offer; the app's shell holds the one
// call (call-provider.tsx). Each call gets a fresh client, so nothing a finished or cancelled call
// leaves running can reach the next one.
import { EidolonClient, type WaitState, Watchdog } from "@laplace.live/eidolon-sdk";
import { type RefObject, useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  type ChatCallRequestData,
  getExpectedSubspaceHost,
  notifyExpectedHostConflict,
  subscribeHostMutationEpoch,
} from "@/lib/api";
import { hangUpClient } from "./hang-up";
import { deviceProblemOf, type MicProblem, probeMic } from "./media";
import { type CallPhase, connectEnd, endOf, IDLE, reducePhase } from "./phase";
import { fetchIceServers, offerOptions } from "./signalling";
import { type CallSignals, outputEvent } from "./signals";
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

/** What a call's controls, notices and transcript read and do. */
export type CallHandle = Omit<Call, "start" | "audioRef">;

/** No call: what /call shows while the tab's call is a chat's, or with a persona no longer active. */
export const NO_CALL: CallHandle = {
  phase: IDLE,
  transcript: EMPTY_TRANSCRIPT,
  wait: { thinking: false, stuck: false },
  micOn: true,
  userSpeaking: false,
  botSpeaking: false,
  micProblem: null,
  botError: null,
  audioBlocked: false,
  hangUp() {},
  setMic() {},
  sendText() {},
  dismissBotError() {},
  playAudio() {},
};

/** The viewer's words came in: a final transcript with words, as TurnWait hears them. */
function worded(transcript: { readonly text: string; readonly final: boolean }): boolean {
  return transcript.final && transcript.text.trim() !== "";
}

interface ActiveCall {
  readonly client: EidolonClient;
  /** The bot said it was leaving before the transport went. */
  botLeft: boolean;
  /** When the call last heard speech, to tell the bot's idle timeout from other endings. */
  heardAt: number;
  detach(): void;
}

/** `signals`, which her stages follow, hears the call's events and taps the bot's track. */
export function useCall(signals: CallSignals): Call {
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
  const dialingAttemptRef = useRef(0);
  /** The last call hung up, until its client has disconnected. */
  const leavingRef = useRef<Promise<void>>(Promise.resolve());
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
      signals.listen(null);
    },
    [watchdog, signals],
  );

  const playBot = useCallback(
    (track: MediaStreamTrack) => {
      const audio = audioRef.current;
      if (audio === null) return;
      const playing = audio.srcObject instanceof MediaStream ? audio.srcObject : null;
      if (playing?.getAudioTracks()[0]?.id === track.id) return;
      audio.srcObject = new MediaStream([track]);
      signals.listen(track);
      audio
        .play()
        .then(() => setAudioBlocked(false))
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "NotAllowedError")
            setAudioBlocked(true);
        });
    },
    [signals],
  );

  const subscribe = useCallback(
    (call: ActiveCall): (() => void) => {
      const { client } = call;
      const turn = new TurnWait(watchdog);
      const heard = () => {
        call.heardAt = Date.now();
      };
      const cue = (
        type:
          | "bot-started-speaking"
          | "bot-stopped-speaking"
          | "user-started-speaking"
          | "user-stopped-speaking"
          | "user-words"
          | "bot-llm-started"
          | "bot-interrupted"
          | "function-call",
      ) => signals.feed({ type, at: signals.now() });
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
          cue("bot-started-speaking");
        }),
        client.on("botStoppedSpeaking", () => {
          heard();
          setBotSpeaking(false);
          cue("bot-stopped-speaking");
        }),
        client.on("userStartedSpeaking", () => {
          heard();
          turn.started();
          setUserSpeaking(true);
          cue("user-started-speaking");
        }),
        client.on("userStoppedSpeaking", () => {
          heard();
          setUserSpeaking(false);
          turn.stopped();
          cue("user-stopped-speaking");
        }),
        client.on("botLlmStarted", () => {
          turn.llmStarted();
          cue("bot-llm-started");
        }),
        client.on("userInput", (data) => {
          heard();
          turn.heard(data);
          dispatchTranscript({ type: "user-input", data });
          if (data.input_type === "transcription" && worded(data)) cue("user-words");
        }),
        client.on("userTranscript", (data) => {
          heard();
          turn.heard(data);
          dispatchTranscript({ type: "user-transcript", data });
          // Most transcriptions come as user-input too: words heard twice move her no further.
          if (worded(data)) cue("user-words");
        }),
        client.on("botOutput", (data) => {
          dispatchTranscript({ type: "bot-output", data });
          const event = outputEvent(data, signals.now());
          if (event !== null) signals.feed(event);
        }),
        client.on("botInterrupted", () => {
          dispatchTranscript({ type: "interrupted" });
          cue("bot-interrupted");
        }),
        client.on("llmFunctionCallStarted", () => cue("function-call")),
        client.on("serverMessage", (message) => {
          if (message.type === "speaker") {
            dispatchTranscript({ type: "speaker", speaker: message.speaker });
            signals.feed({ type: "speaker", at: signals.now(), persona: message.speaker.persona });
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
    [playBot, release, watchdog, signals],
  );

  const start = useCallback(
    async (target?: ChatCallRequestData) => {
      if (activeRef.current !== null) return;
      const attempt = ++attemptRef.current;
      dialingAttemptRef.current = attempt;
      const expectedHost = getExpectedSubspaceHost();
      const stale = () => attempt !== attemptRef.current;
      dispatchPhase({ type: "start", at: Date.now() });
      dispatchTranscript({ type: "reset" });
      watchdog.clear();
      setMicOn(true);
      setMicProblem(null);
      setBotError(null);

      try {
        // Until the server hears the last call go, it refuses another in the same chat.
        await leavingRef.current;
        if (stale()) return;
        const problem = await probeMic(navigator.mediaDevices);
        if (stale()) return;
        if (problem !== null) {
          dispatchPhase({ type: "failed", at: Date.now(), end: { kind: "mic", problem } });
          return;
        }
        let iceServers: RTCIceServer[];
        try {
          iceServers = await fetchIceServers(expectedHost);
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
          await client.connect(offerOptions(target, expectedHost));
        } catch (error) {
          if (stale()) return;
          release(call);
          const end = connectEnd(error);
          if (end.kind === "connect" && end.status === 409) notifyExpectedHostConflict();
          dispatchPhase({ type: "failed", at: Date.now(), end });
          return;
        }
        if (stale()) return;
        call.heardAt = Date.now();
        dispatchPhase({ type: "ready" });
        // No one greets on a group call: it waits for the viewer, so it is answered as it comes up.
        if (target?.group) dispatchPhase({ type: "answered", at: Date.now() });
      } finally {
        if (dialingAttemptRef.current === attempt) dialingAttemptRef.current = 0;
      }
    },
    [subscribe, release, watchdog],
  );

  const hangUp = useCallback(async () => {
    attemptRef.current++;
    dialingAttemptRef.current = 0;
    dispatchPhase({ type: "hang-up" });
    const call = activeRef.current;
    if (call !== null) {
      release(call);
      const hanging = hangUpClient(call.client);
      leavingRef.current = hanging.done;
      if (!hanging.lingers) await hanging.done;
    }
    dispatchPhase({ type: "disconnected", at: Date.now(), end: { kind: "hung-up" } });
  }, [release]);

  useEffect(
    () =>
      subscribeHostMutationEpoch(() => {
        if (dialingAttemptRef.current !== 0 || activeRef.current !== null) void hangUp();
      }),
    [hangUp],
  );

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
      signals.feed({ type: "user-words", at: signals.now() });
      call.heardAt = Date.now();
      // Typed text skips the bot's VAD, so no user-stopped-speaking starts the wait.
      watchdog.arm();
      call.client.sendText(trimmed, { run_immediately: true, audio_response: true }).catch(() => {
        watchdog.clear();
        dispatchTranscript({ type: "typed-failed", key });
      });
    },
    [watchdog, signals],
  );

  const playAudio = useCallback(() => {
    // In the click itself: a browser resumes an AudioContext it held back only within one.
    signals.wake();
    audioRef.current
      ?.play()
      .then(() => setAudioBlocked(false))
      .catch(() => undefined);
  }, [signals]);

  const dismissBotError = useCallback(() => setBotError(null), []);
  const dial = useCallback((target?: ChatCallRequestData) => void start(target), [start]);
  const end = useCallback(() => void hangUp(), [hangUp]);

  // The shell going away (the sign-in screen, setup, a reload) hangs up: the mic is muted at once
  // and freed as the call goes.
  useEffect(
    () => () => {
      attemptRef.current++;
      watchdog.clear();
      const call = activeRef.current;
      activeRef.current = null;
      if (call === null) return;
      call.detach();
      leavingRef.current = hangUpClient(call.client).done;
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
    start: dial,
    hangUp: end,
    setMic,
    sendText,
    dismissBotError,
    playAudio,
  };
}

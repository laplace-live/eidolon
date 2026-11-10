// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/core/src/turns/user_turn_controller.ts@ce8f8bc, packages/core/src/turns/user_stop/turn_analyzer_user_turn_stop_strategy.ts@ce8f8bc, packages/core/src/turns/user_start/vad_user_turn_start_strategy.ts@ce8f8bc, packages/core/src/turns/user_start/transcription_user_turn_start_strategy.ts@ce8f8bc and packages/core/src/processors/aggregators/llm_response_universal.ts@ce8f8bc
//
// When the caller's turn starts and ends: pipedog's user turn controller with the strategies a
// call runs (a VAD or transcript start, the Smart Turn stop) and its stop watchdog, plus an end as
// soon as the recognizer acknowledges the turn's finalize, words or none.
import type { Clock, EarEvent, JoinSegments } from "../types.ts";
import type { EndOfTurn } from "./smart_turn.ts";
import { VAD_STOP_SECS } from "./vad.ts";

/** A turn with no VAD edge or transcript for this long ends, once the VAD isn't hearing speech. */
const STOP_TIMEOUT_MS = 5_000;

/** Soniox's p99 from finalize() to its answer, plus 1 s: docs/benchmarks/2026-11-10-finalize-ack. */
export const FINALIZE_ACK_CAP_MS = 1_910;

export interface TurnDetectorOptions {
  readonly clock: Clock;
  /** The recognizer's p99 seconds from the end of speech to its last final. */
  readonly ttfsP99: number;
  readonly join: JoinSegments;
  readonly post: (event: EarEvent) => void;
  /** Smart Turn forgets the turn's speech when the turn ends. */
  readonly clearAnalyzer: () => void;
}

/**
 * The turn state machine, fed the VAD's edges, Smart Turn's verdicts and the transcripts. A turn
 * ends once Smart Turn calls it complete and the recognizer has acknowledged its finalize, said
 * nothing for FINALIZE_ACK_CAP_MS after it, or sent a final and had its p99; never while the VAD
 * hears speech.
 */
export class TurnDetector {
  readonly #options: TurnDetectorOptions;
  #inTurn = false;
  #vadSpeaking = false;
  /** The turn's non-blank finals. */
  #finals: string[] = [];
  #cancelWatchdog: (() => void) | null = null;

  // The stop strategy's state for the turn in progress.
  #text = "";
  #turnComplete = false;
  #vadStopped = false;
  /** A finalized final or a bare acknowledgement came, or the cap passed, and no interim since. */
  #acknowledged = false;
  #cancelAckCap: (() => void) | null = null;
  /** An interim has come since the last final: words the recognizer has yet to finish. */
  #wordsPending = false;
  #timeoutExpired = false;
  #cancelTimeout: (() => void) | null = null;
  // The last VAD stop's delay in seconds: 0 until the first one.
  #stopSecs = 0;
  #sttDeadline = 0;

  constructor(options: TurnDetectorOptions) {
    this.#options = options;
  }

  /** Whether the VAD's last edge was a start. */
  get vadSpeaking(): boolean {
    return this.#vadSpeaking;
  }

  speechStarted(): void {
    this.#vadSpeaking = true;
    this.#activity();
    this.#startTurn();
    this.#discardPendingEndOfTurn();
  }

  /** The VAD's stop edge, before Smart Turn's verdict on it (`analyzed`). */
  speechStopped(): void {
    this.#vadSpeaking = false;
    this.#activity();
    this.#stopSecs = VAD_STOP_SECS;
    this.#vadStopped = true;
    // The p99 counts from when speech ended, which the VAD reports its stop delay later.
    this.#sttDeadline = this.#options.clock.now() + (this.#options.ttfsP99 - this.#stopSecs) * 1000;
    // The Ear has just called finalize(): a recognizer silent past the cap has nothing to add.
    this.#cancelAckCap?.();
    this.#cancelAckCap = this.#options.clock.setTimer(FINALIZE_ACK_CAP_MS, () => {
      this.#cancelAckCap = null;
      // Words it heard and hasn't finished are still coming: their final, or the watchdog, ends it.
      if (!this.#wordsPending) this.#acknowledge();
    });
  }

  analyzed(state: EndOfTurn): void {
    this.#turnComplete = state === "complete";
    this.#armTimeout(Math.max(0, this.#sttDeadline - this.#options.clock.now()));
    this.#maybeStop();
  }

  /** Smart Turn's 3 s of silence after speech, which completes the turn without the model. */
  silenceComplete(): void {
    this.#turnComplete = true;
    this.#maybeStop();
  }

  interim(text: string): void {
    this.#activity();
    this.#startTurn();
    this.#options.post({ type: "interim", text });
    this.#wordsPending = true;
    // More words are coming, so an earlier acknowledgement no longer covers the speech, and their
    // final, not the cap, ends the turn.
    this.#acknowledged = false;
    this.#cancelAckCap?.();
    this.#cancelAckCap = null;
  }

  final(text: string, finalized: boolean): void {
    if (text.trim()) this.#finals.push(text);
    this.#activity();
    this.#startTurn();
    this.#options.post({ type: "final", text });
    this.#text = text;
    this.#wordsPending = false;
    if (finalized) {
      this.#acknowledge();
      if (!this.#inTurn) return;
    } else if (this.#timeoutExpired && this.#turnComplete) {
      this.#stop();
      return;
    }
    // A transcript with no VAD stop to time it: complete once the recognizer has had its p99.
    if (!this.#vadSpeaking && !this.#vadStopped) {
      this.#turnComplete = true;
      this.#armTimeout(Math.max(0, (this.#options.ttfsP99 - this.#stopSecs) * 1000));
    }
  }

  /**
   * The recognizer answered this stop's finalize() with no words. One that comes while the VAD
   * hears speech again answered an earlier stop's.
   */
  finalized(): void {
    if (this.#vadStopped) this.#acknowledge();
  }

  /** Cancels the timers. */
  close(): void {
    this.#cancelTimeout?.();
    this.#cancelTimeout = null;
    this.#cancelAckCap?.();
    this.#cancelAckCap = null;
    this.#cancelWatchdog?.();
    this.#cancelWatchdog = null;
  }

  #startTurn(): void {
    if (this.#inTurn) return;
    this.#inTurn = true;
    this.#activity();
    this.#text = "";
    this.#wordsPending = false;
    this.#discardPendingEndOfTurn();
    this.#options.post({ type: "user-started" });
  }

  #stop(): void {
    if (!this.#inTurn || this.#vadSpeaking) return;
    this.#inTurn = false;
    this.#cancelWatchdog?.();
    this.#cancelWatchdog = null;
    this.#text = "";
    this.#discardPendingEndOfTurn();
    this.#options.clearAnalyzer();
    const text = this.#finals.length > 0 ? this.#options.join(this.#finals) : null;
    this.#finals = [];
    this.#options.post({ type: "user-stopped", text });
  }

  #acknowledge(): void {
    this.#acknowledged = true;
    this.#maybeStop();
  }

  #maybeStop(): void {
    if (!this.#turnComplete) return;
    // Acknowledged, the turn ends with or without words: one with none (a cough) as an empty turn.
    if (this.#acknowledged) {
      this.#cancelTimeout?.();
      this.#cancelTimeout = null;
      this.#stop();
    } else if (this.#text && this.#cancelTimeout === null) {
      this.#stop();
    }
  }

  #discardPendingEndOfTurn(): void {
    this.#turnComplete = false;
    this.#acknowledged = false;
    this.#timeoutExpired = false;
    this.#vadStopped = false;
    this.#cancelTimeout?.();
    this.#cancelTimeout = null;
    this.#cancelAckCap?.();
    this.#cancelAckCap = null;
  }

  #armTimeout(ms: number): void {
    this.#cancelTimeout?.();
    this.#cancelTimeout = this.#options.clock.setTimer(ms, () => {
      this.#cancelTimeout = null;
      this.#timeoutExpired = true;
      this.#maybeStop();
    });
  }

  /**
   * A VAD edge, a transcript or a turn's start: the watchdog waits its 5 s afresh. One that fires
   * while the VAD hears speech does nothing; the VAD's stop starts it again.
   */
  #activity(): void {
    if (!this.#inTurn) return;
    this.#cancelWatchdog?.();
    this.#cancelWatchdog = this.#options.clock.setTimer(STOP_TIMEOUT_MS, () => {
      this.#cancelWatchdog = null;
      this.#stop();
    });
  }
}

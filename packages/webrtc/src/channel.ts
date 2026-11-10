// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/transport-smallwebrtc/src/connection.ts@ce8f8bc
//
// The data channel the client opens: app messages both ways, the client's pings, and the
// signalling envelope, which small-webrtc's client sends for its tracks and reads for peerLeft.
import { isPlainObject, logger } from "@eidolon/config";
import type { RTCDataChannel } from "werift";

export const SIGNALLING_TYPE = "signalling";
/** Messages kept while the channel isn't open yet. */
export const MAX_MESSAGE_QUEUE_SIZE = 50;
/** How long after the peer connects the channel may take to open before sends stop queueing. */
export const DATA_CHANNEL_TIMEOUT_MS = 10_000;

export class Channel {
  readonly #onMessage: (message: unknown) => void;
  #channel: RTCDataChannel | null = null;
  #queue: string[] = [];
  #queueing = true;
  #openTimeout: ReturnType<typeof setTimeout> | null = null;
  #lastPing: number | null = null;

  /** `onMessage` gets each app message: neither a ping nor the signalling envelope. */
  constructor(onMessage: (message: unknown) => void) {
    this.#onMessage = onMessage;
  }

  /** When the client last pinged (performance.now()), or null before its first ping. */
  get lastPing(): number | null {
    return this.#lastPing;
  }

  attach(channel: RTCDataChannel): void {
    this.#channel = channel;
    // A channel the client created may already be open when it arrives, and no "open" follows.
    if (channel.readyState === "open") this.#flush();
    channel.stateChanged.subscribe((state) => {
      if (state !== "open") return;
      logger.debug("Data channel is open!");
      this.#flush();
    });
    channel.onMessage.subscribe((data) => this.#received(data));
  }

  /** JSON, at once while the channel is open, else queued until it opens. */
  send(message: unknown): void {
    const text = JSON.stringify(message);
    if (this.#channel?.readyState === "open") {
      this.#channel.send(text);
    } else if (this.#queueing) {
      if (this.#queue.length < MAX_MESSAGE_QUEUE_SIZE) {
        logger.debug("Data channel not ready, queuing message");
        this.#queue.push(text);
      } else {
        logger.warning(
          `Message queue is full (${MAX_MESSAGE_QUEUE_SIZE} messages). Discarding message.`,
        );
      }
    } else {
      // The client may never open a data channel.
      logger.trace("Data channel unavailable and queueing disabled. Discarding message.");
    }
  }

  /**
   * The peer connected: a channel still closed after the timeout drops what waits, and queues no
   * more.
   */
  peerConnected(): void {
    if (this.#openTimeout !== null) return;
    this.#openTimeout = setTimeout(() => {
      if (this.#channel?.readyState === "open") return;
      logger.warning(
        `Data channel not established within ${DATA_CHANNEL_TIMEOUT_MS / 1000}s after ` +
          "connection. Clearing message queue and disabling future queueing.",
      );
      this.#queue.length = 0;
      this.#queueing = false;
    }, DATA_CHANNEL_TIMEOUT_MS);
  }

  close(): void {
    if (this.#openTimeout !== null) clearTimeout(this.#openTimeout);
    this.#queue.length = 0;
  }

  #flush(): void {
    if (this.#openTimeout !== null) clearTimeout(this.#openTimeout);
    if (this.#channel === null) return;
    logger.debug("Data channel is open, flushing queued messages");
    for (const text of this.#queue.splice(0)) this.#channel.send(text);
  }

  #received(data: string | Uint8Array): void {
    // The client's liveness: small-webrtc pings every second.
    if (typeof data === "string" && data.startsWith("ping")) {
      this.#lastPing = performance.now();
      return;
    }
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch (error) {
      logger.error(`Error parsing JSON message ${text}, ${error}`);
      return;
    }
    if (isPlainObject(message) && message.type === SIGNALLING_TYPE && message.message) {
      // trackStatus: the client muting a track, which a call reads no differently.
      logger.debug(`Signalling message received: ${JSON.stringify(message.message)}`);
      return;
    }
    this.#onMessage(message);
  }
}

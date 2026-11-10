// What the streaming speech clients share: the utterance's event queue, the text a segment sends,
// where a socket goes, and a socket that queues what is sent before it opens.
import { errorText, logger } from "@eidolon/config";
import { modelInfo } from "../../catalog.ts";
import { stripMarkup } from "../../markup.ts";
import { Meter } from "../../meter.ts";
import { textUnits } from "../../pricing.ts";
import type { Selection } from "../../resolve.ts";
import { spokenLanguage } from "../../stt/index.ts";
import { connectWs, type WsConnection, type WsData } from "../../ws.ts";
import type { UtteranceAudio } from "./index.ts";

export type KeyedSelection = Selection & { readonly apiKey: string };

/** An utterance's audio events, pushed as they come and read once. */
export class AudioQueue implements AsyncIterable<UtteranceAudio> {
  #items: UtteranceAudio[] = [];
  #wake: (() => void) | null = null;
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  push(item: UtteranceAudio): void {
    if (this.#closed) return;
    this.#items.push(item);
    this.#wake?.();
  }

  /** Pushes the last event, `end` or `error`. */
  finish(item: UtteranceAudio): void {
    this.push(item);
    this.close();
  }

  /** Ends once what is queued has been read. */
  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  /** Ends at once. */
  drop(): void {
    this.#items = [];
    this.close();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<UtteranceAudio> {
    for (;;) {
      const next = this.#items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = null;
    }
  }
}

/** A segment's text as the voice model gets it, and the meter that counts it. */
export class SpokenText {
  readonly #meter: Meter;
  readonly #markup;

  constructor(selection: Selection) {
    this.#meter = new Meter(selection);
    this.#markup = modelInfo(selection.provider.id, "tts", selection.model)?.markup;
  }

  /** Cues stripped unless the model reads them, and metered; null when nothing is left to say. */
  take(text: string): string | null {
    const spoken = stripMarkup(text, this.#markup);
    if (spoken.trim() === "") return null;
    this.#meter.add(textUnits(spoken));
    return spoken;
  }

  flush(): void {
    this.#meter.flush();
  }
}

/**
 * The language she speaks, a regional code as its base language, as pipedog sent it to Cartesia
 * and Soniox.
 */
export function speechLanguage(): string | null {
  const language = spokenLanguage();
  return language?.includes("-") ? (language.split("-")[0] as string).toLowerCase() : language;
}

/** `url`, pipedog's for the provider, under an account's own API base when it has one. */
export function socketUrl(selection: Selection, url: string): string {
  if (selection.account.baseSource !== "account" || selection.baseUrl === undefined) return url;
  const { pathname, search } = new URL(url);
  return `${selection.baseUrl.replace(/^http/, "ws").replace(/\/+$/, "")}${pathname}${search}`;
}

/** `text` with `secret` taken out, for an error a provider echoed it in. */
export function scrubbed(text: string, secret: string): string {
  return secret === "" ? text : text.replaceAll(secret, "[key]");
}

/** Waits for `promise`, or `ms`, whichever comes first. */
export async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

export interface SocketLinkOptions {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  /** For error texts. */
  readonly provider: string;
  readonly onMessage: (data: WsData) => void;
  /** Once, when the socket is gone: null when this side closed it, else why. */
  readonly onEnd: (error: string | null) => void;
  /** The error text for a failed handshake. */
  readonly refused: (detail: string) => string;
  readonly keepalive?: { readonly everyMs: number; readonly message: () => WsData };
}

/** A socket that holds what is sent until it opens, in order. */
export class SocketLink {
  readonly #options: SocketLinkOptions;
  #socket: WsConnection | null = null;
  #outbox: WsData[] = [];
  #state: "connecting" | "open" | "ended" = "connecting";
  #closing = false;
  #keepalive: ReturnType<typeof setInterval> | undefined;
  readonly #ended = Promise.withResolvers<void>();

  constructor(options: SocketLinkOptions) {
    this.#options = options;
    connectWs(options.url, options.headers, options.signal).then(
      (socket) => this.#opened(socket),
      (error) =>
        this.#end(
          this.#closing || options.signal.aborted ? null : options.refused(errorText(error)),
        ),
    );
  }

  get alive(): boolean {
    return this.#state !== "ended";
  }

  get open(): boolean {
    return this.#state === "open";
  }

  get ended(): Promise<void> {
    return this.#ended.promise;
  }

  send(data: WsData): void {
    if (this.#state === "open") this.#socket?.send(data);
    else if (this.#state === "connecting") this.#outbox.push(data);
  }

  async close(): Promise<void> {
    this.#closing = true;
    if (this.#socket === null) {
      this.#end(null);
      return;
    }
    await this.#socket.close();
  }

  #opened(socket: WsConnection): void {
    if (this.#state === "ended") {
      void socket.close();
      return;
    }
    this.#socket = socket;
    this.#state = "open";
    for (const data of this.#outbox) socket.send(data);
    this.#outbox = [];
    const { keepalive } = this.#options;
    if (keepalive !== undefined) {
      this.#keepalive = setInterval(() => socket.send(keepalive.message()), keepalive.everyMs);
    }
    void this.#read(socket);
  }

  async #read(socket: WsConnection): Promise<void> {
    for await (const data of socket.messages) {
      try {
        this.#options.onMessage(data);
      } catch (error) {
        logger.warning(
          `${this.#options.provider} sent a message it can't read: ${errorText(error)}`,
        );
      }
    }
    const reason = socket.closeReason === "" ? "" : ` ${socket.closeReason}`;
    this.#end(
      this.#closing || this.#options.signal.aborted
        ? null
        : `${this.#options.provider} closed the connection (${socket.closeCode}${reason})`,
    );
  }

  #end(error: string | null): void {
    if (this.#state === "ended") return;
    this.#state = "ended";
    this.#outbox = [];
    clearInterval(this.#keepalive);
    this.#ended.resolve();
    this.#options.onEnd(error);
  }
}

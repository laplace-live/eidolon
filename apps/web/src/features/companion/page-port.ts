// The desktop companion's page's end of the port main pairs it with the main window by.
import { type ToApp, type ToCompanion, toCompanion } from "./protocol";

/** The part of a MessagePort the two ends use; tests give their own. */
export interface PortLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  addEventListener(type: "close", listener: () => void): void;
}

/** The companion page's end: one port at a time, every message read through toCompanion. */
export class PagePort {
  readonly #handlers: {
    message(message: ToCompanion): void;
    linked(on: boolean): void;
  };
  #port: PortLike | null = null;

  constructor(handlers: { message(message: ToCompanion): void; linked(on: boolean): void }) {
    this.#handlers = handlers;
  }

  /** Closes the port before it; `linked(true)`. */
  connect(port: PortLike): void {
    const before = this.#port;
    this.#port = port;
    before?.close();
    port.onmessage = (event) => {
      if (this.#port !== port) return;
      const message = toCompanion(event.data);
      if (message !== null) this.#handlers.message(message);
    };
    // Electron adds `close` to a renderer's MessagePort, for an end that went.
    port.addEventListener("close", () => {
      if (this.#port !== port) return;
      this.#port = null;
      this.#handlers.linked(false);
    });
    this.#handlers.linked(true);
  }

  /** False with no port. */
  send(message: ToApp): boolean {
    if (this.#port === null) return false;
    this.#port.postMessage(message);
    return true;
  }

  close(): void {
    const port = this.#port;
    if (port === null) return;
    this.#port = null;
    port.close();
    this.#handlers.linked(false);
  }

  get linked(): boolean {
    return this.#port !== null;
  }
}

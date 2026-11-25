import type { TransportState } from "@laplace.live/eidolon-sdk";

/** What hanging up needs of a call's client. */
export interface Ending {
  readonly state: TransportState;
  on(event: "transportStateChanged", handler: (state: TransportState) => void): () => void;
  enableMic(enable: boolean): void;
  disconnect(): Promise<void>;
}

/** The longest a call hung up as it connects waits for its connection before it lets go anyway. */
export const LINGER_MS = 10_000;

export interface HangingUp {
  /** It waits for its connection first, muted. */
  readonly lingers: boolean;
  /** Settles once the client has disconnected, never rejecting. */
  readonly done: Promise<void>;
}

/**
 * Disconnects `client`. The server hears a call end only over the call's connection, so a client
 * closed while its offer is out leaves the call the server answered up until the server's transport
 * gives up, about 30 s, with the chat in a call nobody can hang up. One still connecting is muted
 * and disconnects once its connection comes up or fails, or after LINGER_MS.
 */
export function hangUpClient(client: Ending, lingerMs = LINGER_MS): HangingUp {
  const disconnect = () => client.disconnect().catch(() => undefined);
  if (client.state !== "connecting") return { lingers: false, done: disconnect() };
  client.enableMic(false);
  const done = new Promise<void>((resolve) => {
    const go = () => {
      off();
      clearTimeout(timer);
      void disconnect().then(resolve);
    };
    const timer = setTimeout(go, lingerMs);
    const off = client.on("transportStateChanged", (state) => {
      if (state !== "connecting") go();
    });
  });
  return { lingers: true, done };
}

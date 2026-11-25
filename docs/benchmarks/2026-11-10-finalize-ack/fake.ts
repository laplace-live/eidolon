// Soniox and Deepgram played on 127.0.0.1 for `measure.ts --fake`. Each finalize is answered after
// a delay scripted by what the audio since the previous one held, so the run's numbers can be
// checked against the script.
import {
  type Listening,
  messageOf,
  serveWs,
} from "../../../packages/providers/test/ws-server.ts";

export type Dialect = "soniox" | "deepgram";
export type Heard = "speech" | "cough" | "silence";

export interface Scripted {
  readonly dialect: Dialect;
  /** What the audio since the previous finalize sounded like to the fake. */
  readonly heard: Heard;
  /** ms before its answer; null for never. */
  readonly delayMs: number | null;
}

const RATE = 16000;
// A 20 ms frame louder than this counts as sound: room tone is about 60, speech and coughs thousands.
const LOUD_RMS = 500;
const SPEECH_MS = 350;
const COUGH_MS = 40;
/** After measure.ts stops waiting, but before its next finalize. */
export const LATE_MS = 5_200;
/** What a finalize after speech is answered with. */
export const FAKE_WORDS = "你好";

/** The delay `dialect` answers the k-th finalize of what it heard after; null never answers. */
export function scriptedDelay(dialect: Dialect, heard: Heard, k: number): number | null {
  if (heard === "silence" && k === 2) return dialect === "soniox" ? null : LATE_MS;
  const [base, step] = { speech: [240, 30], cough: [110, 20], silence: [70, 10] }[heard];
  return base + step * (k % 5) + (dialect === "deepgram" ? 40 : 0);
}

/** What a fake answers a client through. */
interface Socket {
  send(data: string): void;
  close(code: number): void;
}

interface Peer {
  readonly dialect: Dialect;
  configured: boolean;
  loudMs: number;
  interimSent: boolean;
  readonly counts: Record<Heard, number>;
}

function dialectOf(path: string): Dialect | null {
  return path === "/transcribe-websocket" ? "soniox" : path === "/v1/listen" ? "deepgram" : null;
}

export class FakeRecognizers {
  readonly scripted: Scripted[] = [];
  /** Protocol errors the fake saw, which fail the check. */
  readonly problems: string[] = [];
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #server: Listening | null = null;

  /** The fakes, listening on a free port. */
  static async start(): Promise<FakeRecognizers> {
    const fakes = new FakeRecognizers();
    fakes.#server = await serveWs({
      handshake: ({ url, headers }) => {
        if (dialectOf(url.pathname) === null) return new Response("not found", { status: 404 });
        if (!headers.get("authorization")) return new Response("no key", { status: 401 });
        return undefined;
      },
      open: (ws, { url }) => {
        const dialect = dialectOf(url.pathname) as Dialect;
        const peer: Peer = {
          dialect,
          configured: dialect === "deepgram",
          loudMs: 0,
          interimSent: false,
          counts: { speech: 0, cough: 0, silence: 0 },
        };
        ws.on("message", (data, isBinary) => {
          const message = messageOf(data, isBinary);
          if (typeof message === "string") fakes.#text(ws, peer, message);
          else fakes.#audio(ws, peer, message);
        });
      },
    });
    return fakes;
  }

  /** The HTTP origin, as an account's API base names it. */
  get base(): string {
    return `http://127.0.0.1:${this.#server?.port}`;
  }

  stop(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    void this.#server?.stop();
  }

  #audio(ws: Socket, peer: Peer, data: Uint8Array): void {
    if (!peer.configured) this.problems.push("Soniox audio came before its config");
    // A copy: the Buffer's offset may not be even.
    const pcm = new Int16Array(new Uint8Array(data).buffer);
    let squares = 0;
    for (const v of pcm) squares += v * v;
    if (Math.sqrt(squares / pcm.length) > LOUD_RMS) peer.loudMs += (pcm.length / RATE) * 1000;
    if (peer.loudMs >= SPEECH_MS && !peer.interimSent) {
      peer.interimSent = true;
      ws.send(
        JSON.stringify(
          peer.dialect === "soniox"
            ? { tokens: [{ text: "你", is_final: false }] }
            : {
                type: "Results",
                is_final: false,
                channel: { alternatives: [{ transcript: "你" }] },
              },
        ),
      );
    }
  }

  #text(ws: Socket, peer: Peer, text: string): void {
    if (!peer.configured) {
      const config = JSON.parse(text) as { model?: unknown; sample_rate?: unknown };
      if (typeof config.model !== "string" || config.sample_rate !== 16000) {
        this.problems.push(`Soniox config: ${text}`);
      }
      peer.configured = true;
      return;
    }
    const finalize = peer.dialect === "soniox" ? '{"type": "finalize"}' : '{"type": "Finalize"}';
    if (text === '{"type": "CloseStream"}' && peer.dialect === "deepgram") {
      ws.close(1000);
      return;
    }
    if (text !== finalize) {
      this.problems.push(`${peer.dialect} got ${text}`);
      return;
    }
    const heard: Heard =
      peer.loudMs >= SPEECH_MS ? "speech" : peer.loudMs >= COUGH_MS ? "cough" : "silence";
    const delayMs = scriptedDelay(peer.dialect, heard, peer.counts[heard]++);
    this.scripted.push({ dialect: peer.dialect, heard, delayMs });
    peer.loudMs = 0;
    peer.interimSent = false;
    if (delayMs === null) return;
    const words = heard === "speech" ? FAKE_WORDS : "";
    const answer =
      peer.dialect === "soniox"
        ? {
            tokens: [
              ...(words ? [{ text: words, is_final: true }] : []),
              { text: "<fin>", is_final: true },
            ],
          }
        : {
            type: "Results",
            is_final: true,
            from_finalize: true,
            channel: { alternatives: [{ transcript: words }] },
          };
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      ws.send(JSON.stringify(answer));
    }, delayMs);
    this.#timers.add(timer);
  }
}

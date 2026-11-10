// An OpenAI-compatible chat completions API, played by Bun.serve: every request body is kept, and
// each request is answered by the next scripted reply as server-sent events, text deltas or a
// round of tool calls, with the usage OpenRouter reports.
// https://platform.openai.com/docs/api-reference/chat/streaming
import type { Server } from "bun";

export interface MindToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface MindReply {
  /** Text deltas, streamed in order. */
  readonly deltas?: readonly string[];
  readonly toolCalls?: readonly MindToolCall[];
  /** Answered with this HTTP status and error body instead. */
  readonly error?: { readonly status: number; readonly message: string };
  /** Before the first delta. */
  readonly firstDeltaMs?: number;
  /** Between deltas. */
  readonly deltaMs?: number;
}

export interface MindRequest {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
}

const MODEL = "twin/mind-1";

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  const body = {
    id: "gen-twin",
    object: "chat.completion.chunk",
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(body)}\n\n`;
}

const USAGE = `data: ${JSON.stringify({
  id: "gen-twin",
  object: "chat.completion.chunk",
  model: MODEL,
  choices: [],
  usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.0001 },
})}\n\n`;

export class FakeMind {
  readonly #server: Server<undefined>;
  readonly requests: MindRequest[] = [];
  readonly #replies: MindReply[];

  constructor(replies: readonly MindReply[] = []) {
    this.#replies = [...replies];
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.#answer(request),
    });
  }

  /** The API base an account names: requests go to `<base>/chat/completions`. */
  get base(): string {
    return `http://127.0.0.1:${this.#server.port}/api/v1`;
  }

  /** Replies the next requests get. */
  script(...replies: MindReply[]): void {
    this.#replies.push(...replies);
  }

  stop(): void {
    this.#server.stop(true);
  }

  async #answer(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    const body = (await request.json()) as Record<string, unknown>;
    this.requests.push({ path, headers, body });
    const reply = this.#replies.shift() ?? { deltas: ["好的。"] };
    if (reply.error !== undefined) {
      return Response.json(
        { error: { message: reply.error.message } },
        {
          status: reply.error.status,
        },
      );
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (text: string) => controller.enqueue(encoder.encode(text));
        try {
          await Bun.sleep(reply.firstDeltaMs ?? 20);
          for (const [i, delta] of (reply.deltas ?? []).entries()) {
            if (i > 0 && reply.deltaMs) await Bun.sleep(reply.deltaMs);
            send(chunk(i === 0 ? { role: "assistant", content: delta } : { content: delta }));
          }
          const calls = reply.toolCalls ?? [];
          for (const [index, call] of calls.entries()) {
            send(
              chunk({
                tool_calls: [
                  {
                    index,
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                  },
                ],
              }),
            );
          }
          send(chunk({}, calls.length > 0 ? "tool_calls" : "stop"));
          send(USAGE);
          send("data: [DONE]\n\n");
          controller.close();
        } catch {
          // The client hung up: an interrupted reply.
        }
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }
}

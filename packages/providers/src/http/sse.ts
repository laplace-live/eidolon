// Server-sent events off a fetch body: OpenAI-compatible chat streams and Anthropic's Messages
// stream. Comment lines (OpenRouter's `: OPENROUTER PROCESSING` keep-alives) are skipped.

export interface SseEvent {
  readonly event: string | null;
  readonly data: string;
}

/** Each event as it completes; cancelling the iteration cancels the body. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | null = null;
  let data: string[] = [];
  let done = false;
  try {
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (done) buffer += "\n\n";
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (line === "") {
          if (data.length > 0) yield { event, data: data.join("\n") };
          event = null;
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const name = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (name === "data") data.push(value);
        else if (name === "event") event = value;
      }
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

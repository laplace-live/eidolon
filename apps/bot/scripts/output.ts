// The local app's output, for the scripts that boot it and wait for the link it prints.

/** What boot.ts prints once the app listens; its group is the link that signs a browser in. */
export const READY_LINE = /^Eidolon is ready: (\S+)$/m;

/** A child's output as it arrives. */
export class Output {
  text = "";

  constructor(stream: ReadableStream<Uint8Array>) {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) this.text += decoder.decode(chunk, { stream: true });
    })();
  }

  /** The first group of `pattern` once it shows; throws when `exited` settles or time runs out. */
  async waitFor(pattern: RegExp, exited: Promise<unknown>, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let over = false;
    void exited.then(() => {
      over = true;
    });
    for (;;) {
      const match = pattern.exec(this.text);
      if (match) return match[1] ?? match[0];
      if (over || Date.now() > deadline) throw new Error(`no ${pattern} in the output`);
      await Bun.sleep(100);
    }
  }

  tail(lines = 20): string {
    return this.text.trimEnd().split("\n").slice(-lines).join("\n");
  }
}

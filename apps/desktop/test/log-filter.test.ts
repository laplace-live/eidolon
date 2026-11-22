import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { filterLines, holdsLinkCode } from "../src/main/log-filter.ts";

const CODE = `1793000000.${"a".repeat(43)}`;
const READY = `Eidolon is ready: http://127.0.0.1:7860/#${CODE}`;
const ALREADY = `Eidolon is already running: http://127.0.0.1:7860/#${CODE}`;

/** Feeds `chunks` through filterLines: what the reader saw, and what was logged. */
async function run(chunks: string[]): Promise<{ read: string[]; logged: string[] }> {
  const stream = new PassThrough();
  const read: string[] = [];
  const logged: string[] = [];
  const done = filterLines(
    stream,
    (line) => read.push(line),
    (line) => logged.push(line),
  );
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  await done;
  return { read, logged };
}

describe("the backend's output", () => {
  test("drops both link lines from the log, after the reader has seen them", async () => {
    const { read, logged } = await run([
      "[local] booting\n",
      `${READY}\n`,
      `${ALREADY}\n`,
      "listening\n",
    ]);
    expect(read).toEqual(["[local] booting", READY, ALREADY, "listening"]);
    expect(logged).toEqual(["[local] booting", "listening"]);
  });

  test("drops either line whatever its link looks like, a link code anywhere, and nothing else", () => {
    expect(holdsLinkCode("Eidolon is ready: http://localhost:7860/")).toBe(true);
    expect(holdsLinkCode("Eidolon is already running: http://localhost:7860/")).toBe(true);
    expect(holdsLinkCode(`see http://localhost:7860/#${CODE} here`)).toBe(true);
    expect(holdsLinkCode("port 7860 is taken by another program")).toBe(false);
    expect(holdsLinkCode(`#1793000000.${"a".repeat(42)}`)).toBe(false);
  });

  test("joins a line split across chunks, a link line included, and ends one without a newline", async () => {
    const { read, logged } = await run([
      READY.slice(0, 20),
      `${READY.slice(20)}\r\nerror: one`,
      " two\r\nlast words",
    ]);
    expect(read).toEqual([READY, "error: one two", "last words"]);
    expect(logged).toEqual(["error: one two", "last words"]);
  });

  test("a stream that never comes is no output", async () => {
    await expect(
      filterLines(
        null,
        () => {},
        () => {},
      ),
    ).resolves.toBeUndefined();
  });
});

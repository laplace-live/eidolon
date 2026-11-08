// Transcription's free check: every real .soniox.json with tokens re-renders to its transcript
// byte for byte, the sliced ones included, from the payload alone; the real transcripts are the
// golden. The skip rule must find each from its audio. Each test skips when its data is absent,
// unless EIDOLON_REQUIRE_PARITY=1.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isPlainObject, sortedPy } from "@eidolon/config";
import { transcribe } from "../src/index.ts";

const SOURCES = join(process.env.EIDOLON_REAL_HOME ?? "", "sources/milky-green");
const STREAMS = join(SOURCES, "streams");
const VODS = join(SOURCES, "vods");
const REQUIRED = process.env.EIDOLON_REQUIRE_PARITY === "1";
const SUFFIX = ".soniox.json";

function firstDifference(a: string, b: string): number {
  const left = a.split("\n");
  const right = b.split("\n");
  const i = left.findIndex((line, n) => line !== right[n]);
  return (i === -1 ? Math.min(left.length, right.length) : i) + 1;
}

test.skipIf(!existsSync(STREAMS) && !REQUIRED)(
  "every real .soniox.json with tokens re-renders to its transcript byte for byte",
  () => {
    expect(existsSync(STREAMS), `no transcripts at ${STREAMS}`).toBe(true);
    const names = sortedPy(readdirSync(STREAMS).filter((name) => name.endsWith(SUFFIX)));
    let checked = 0;
    let sliced = 0;
    let tokenless = 0;
    // Names and line numbers only: the transcripts are private.
    const mismatched: string[] = [];
    for (const name of names) {
      const payload: unknown = JSON.parse(readFileSync(join(STREAMS, name), "utf8"));
      const transcript = isPlainObject(payload) ? payload.transcript : null;
      const tokens = isPlainObject(transcript) ? transcript.tokens : null;
      if (!Array.isArray(tokens) || tokens.length === 0) {
        tokenless++;
        continue;
      }
      checked++;
      if (transcribe.isSlicedPayload(payload)) sliced++;
      const streamId = name.slice(0, -SUFFIX.length);
      const md = join(STREAMS, `${streamId}.md`);
      if (!existsSync(md)) {
        mismatched.push(`${streamId}.md is missing`);
        continue;
      }
      const record = payload as Record<string, unknown>;
      const hints = record.language_hints;
      const rendered = transcribe.renderPayload(payload, {
        streamDate: streamId.slice(0, 10),
        streamId,
        sourceFile: String(record.audio_filename),
        language: Array.isArray(hints) && typeof hints[0] === "string" ? hints[0] : null,
      });
      const expected = readFileSync(md, "utf8");
      if (rendered !== expected) {
        mismatched.push(`${streamId}.md differs from line ${firstDifference(rendered, expected)}`);
      }
    }
    console.info(
      `transcribe parity: ${checked} payloads re-rendered (${sliced} sliced), ${tokenless} without tokens`,
    );
    expect(checked).toBeGreaterThan(0);
    expect(mismatched).toEqual([]);
  },
  1_800_000,
);

test.skipIf(!existsSync(VODS) && !REQUIRED)(
  "the skip rule finds every real transcript from its audio's upload date",
  () => {
    expect(existsSync(VODS), `no audio at ${VODS}`).toBe(true);
    const found = new Set<string>();
    const pending: string[] = [];
    for (const audio of transcribe.listAudioFiles(VODS)) {
      const status = transcribe.audioStatus(audio, STREAMS);
      if (status.state === "done") found.add(status.mdPath as string);
      else pending.push(`${status.state}: ${audio.split("/").at(-1)}`);
    }
    const transcripts = readdirSync(STREAMS).filter((name) => name.endsWith(".md"));
    console.info(
      `transcribe skip rule: ${found.size} done; ${pending.join(", ") || "none pending"}`,
    );
    expect(transcripts.filter((name) => !found.has(join(STREAMS, name)))).toEqual([]);
  },
  120_000,
);

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateImageMain, outPath } from "../src/index.ts";
import { blockNetwork, captureIo, FIX, golden, placehold, setEnv, substitute } from "./helpers.ts";

blockNetwork();

interface Case {
  argv: string[];
  hour: number;
  minute: number;
  response: string;
  env: Record<string, string> | null;
  friends_dir: string | null;
  code: number;
  stdout: string;
  stderr: string;
  requests: { url: string; auth: string; body: string }[];
  files: Record<string, string>;
}

const REFS = join(FIX, "selfie-references");
const goldens = await golden<Case[]>("generate_image.json");

const b64 = (text: string) => Buffer.from(text).toString("base64");
// What the Python oracle's fake transport answered.
const RESPONSES: Record<string, [number, unknown]> = {
  one: [200, { data: [{ b64_json: b64("P".repeat(1536)) }], usage: { cost: 0.04 } }],
  three: [
    200,
    {
      data: [
        { b64_json: b64("a".repeat(2560)), media_type: "image/png" },
        { b64_json: b64("b".repeat(10)), media_type: "image/jpeg" },
        { b64_json: b64("c".repeat(3584)), media_type: "image/webp" },
      ],
      usage: { cost: 0 },
    },
  ],
  webp_byok: [
    200,
    {
      data: [{ b64_json: b64("w".repeat(100)), media_type: "image/webp" }],
      usage: { cost: 0, cost_details: { upstream_inference_cost: 0.0123 } },
    },
  ],
  credits: [402, { error: { message: "Insufficient credits", code: 402 } }],
  empty: [200, { data: [] }],
  nousage: [200, { data: [{ b64_json: b64("x"), media_type: "image/gif" }] }],
};

let work = "";
let restoreEnv = () => {};
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "cli-genimg-"));
  restoreEnv = setEnv({ OPENROUTER_API_KEY: undefined, SELFIE_REFERENCE_IMAGES: undefined });
});
afterEach(() => {
  restoreEnv();
  rmSync(work, { recursive: true, force: true });
});

function filesUnder(dir: string, paths: Record<string, string>): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    if (!existsSync(current)) return;
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[placehold(path, paths)] = readFileSync(path).toString("base64");
    }
  };
  walk(dir);
  return Object.fromEntries(Object.entries(files).sort());
}

/** Python swapped in a missing friends/ directory; here, a root holding only the outfits. */
function rootWithoutFriends(): string {
  const root = join(work, "refs-without-friends");
  mkdirSync(join(root, "outfits"), { recursive: true });
  for (const name of ["day.png", "night.png"]) {
    copyFileSync(join(REFS, "outfits", name), join(root, "outfits", name));
  }
  return root;
}

describe("laplace-generate-image matches the Python CLI", () => {
  for (const c of goldens) {
    test(c.argv.join(" ").slice(0, 120), async () => {
      const out = join(work, "out");
      const paths = { "<REFS>": REFS, "<OUT>": out, "<FIX>": FIX };
      const env = c.env ?? { OPENROUTER_API_KEY: "sk-test" };
      for (const [key, value] of Object.entries(env)) process.env[key] = substitute(value, paths);
      const root = c.friends_dir === null ? REFS : rootWithoutFriends();
      const requests: Case["requests"] = [];
      const io = captureIo();
      const code = await generateImageMain(
        c.argv.map((arg) => substitute(arg, paths)),
        {
          ...io.io,
          clock: () => ({ hour: c.hour, minute: c.minute }),
          referencesRoot: root,
          fetch: (async (url: string, init: RequestInit) => {
            requests.push({
              url,
              auth: (init.headers as Record<string, string>).Authorization as string,
              body: placehold(String(init.body).replaceAll(root, REFS), paths),
            });
            const [status, body] = RESPONSES[c.response] as [number, unknown];
            return new Response(JSON.stringify(body), { status });
          }) as unknown as typeof fetch,
        },
      );
      expect({
        code,
        stdout: placehold(io.stdout(), paths),
        stderr: placehold(io.stderr(), paths),
        requests,
        files: filesUnder(out, paths),
      }).toEqual({
        code: c.code,
        stdout: c.stdout,
        stderr: c.stderr,
        requests: c.requests,
        files: Object.fromEntries(Object.entries(c.files).sort()),
      });
    });
  }
});

describe("outPath", () => {
  const png = { data: new Uint8Array(), mediaType: "image/png" };
  const webp = { data: new Uint8Array(), mediaType: "image/webp" };
  test("takes the suffix the API returned, numbering only multiples", () => {
    expect(outPath("data/generated/image.png", 0, 1, webp)).toBe("data/generated/image.webp");
    expect(outPath("out", 0, 1, png)).toBe("out.png");
    expect(outPath("out.tar.gz", 0, 1, png)).toBe("out.tar.png");
    expect(outPath("data/generated/image.png", 2, 3, png)).toBe("data/generated/image-3.png");
    expect(outPath(".hidden", 0, 1, png)).toBe(".hidden.png");
  });
});

test("the built-in prompt reads the persona clock where Python does", async () => {
  process.env.OPENROUTER_API_KEY = "sk-test";
  const reads: string[] = [];
  const io = captureIo();
  await generateImageMain(["-o", join(work, "x.png")], {
    ...io.io,
    referencesRoot: REFS,
    clock: () => {
      reads.push("clock");
      return { hour: 23, minute: 59 };
    },
    fetch: (async () =>
      new Response(JSON.stringify(RESPONSES.one?.[1]), { status: 200 })) as unknown as typeof fetch,
  });
  expect(reads).toEqual(["clock", "clock"]);
  expect(io.stdout()).toContain("Time: it is late night, about 23:59 local time.");
});

// /api/local/personas: creating and switching personas, and each one's files. Every write lands in
// the user's copy in the data home, and the templates' bytes are pinned across this whole file.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  activePersona,
  dataHome,
  personaHomeDir,
  personaTemplateDir,
  readPersonaIdentity,
  sourceFolder,
  templatesDir,
} from "@eidolon/config";
import { referenceSources } from "@eidolon/imagegen";
import { selfieReferenceCount } from "../../src/local/personas.ts";
import { MAX_UPLOAD_BYTES } from "../../src/local/routes/personas.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";
import { type Booted, bootFixture, cleanUpBoot, fakeModules, raw } from "./harness.ts";

function hashTree(root: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const name of readdirSync(root, { recursive: true }) as string[]) {
    const path = join(root, name);
    if (statSync(path).isFile()) {
      hashes.set(name, createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
  }
  return hashes;
}

let templates: Map<string, string>;
beforeAll(() => {
  templates = hashTree(templatesDir());
});
afterAll(() => {
  expect(hashTree(templatesDir())).toEqual(templates);
});

let booted: Booted;
let logs: CapturedLogs;
let calls = 0;
const saved = new Map<string, string | undefined>();

beforeEach(async () => {
  logs = captureLogs();
  calls = 0;
  const fakes = fakeModules();
  const runtime = fakes.modules.runtime;
  booted = await bootFixture({
    fakes: {
      ...fakes,
      modules: {
        ...fakes.modules,
        runtime: {
          ...runtime,
          createSignallingServer: (options) => ({
            ...runtime.createSignallingServer(options),
            get activeSessions() {
              return calls;
            },
          }),
        },
      },
    },
  });
});

afterEach(async () => {
  await booted.stop();
  logs.restore();
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  cleanUpBoot();
});

const VOICE = "0123456789abcdef0123456789abcdef";
const MILKY = "milky-green";

function api(
  method: string,
  path: string,
  body?: unknown,
  type = "application/json",
): Promise<Response> {
  const encoded =
    body === undefined || body instanceof Uint8Array || body instanceof ReadableStream
      ? (body as BodyInit | undefined)
      : JSON.stringify(body);
  return fetch(`${booted.base}/api/local${path}`, {
    method,
    headers: { Cookie: booted.cookie, Origin: booted.origin, "Content-Type": type },
    body: encoded,
  });
}

async function call(method: string, path: string, body?: unknown, type?: string) {
  const response = await api(method, path, body, type);
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: an image.
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

function write(rel: string, text: string | Uint8Array): string {
  const path = join(dataHome(), rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

const NEW_PERSONA = {
  id: "aria",
  name: "阿莉亚",
  shortName: "莉亚",
  fans: "星星",
  summary: "Aria, a Mandarin-speaking streamer who sings late at night",
  timezone: "Asia/Tokyo",
  voiceId: VOICE,
};

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const WEBP = Uint8Array.from([
  ...new TextEncoder().encode("RIFF"),
  4,
  0,
  0,
  0,
  ...new TextEncoder().encode("WEBPVP8 "),
]);

describe("listing and creating", () => {
  test("lists the demo persona from her template", async () => {
    const { status, body } = await call("GET", "/personas");
    expect([status, body]).toEqual([
      200,
      {
        active: MILKY,
        personas: [{ id: MILKY, name: "明前奶绿", shortName: "奶绿", template: true, own: false }],
      },
    ]);
  });

  test("creates persona.yaml with her identity and voice, and a starter prompt", async () => {
    const created = await call("POST", "/personas", NEW_PERSONA);
    expect([created.status, created.body]).toEqual([
      201,
      { id: "aria", name: "阿莉亚", shortName: "莉亚", template: false, own: true },
    ]);
    const yaml = Bun.YAML.parse(readFileSync(join(personaHomeDir("aria"), "persona.yaml"), "utf8"));
    expect(yaml).toEqual({
      identity: {
        name: "阿莉亚",
        shortName: "莉亚",
        fans: "星星",
        summary: NEW_PERSONA.summary,
        timezone: "Asia/Tokyo",
      },
      voice: { voiceId: VOICE },
    });
    const prompt = readFileSync(join(personaHomeDir("aria"), "prompt.md"), "utf8");
    expect(prompt).toContain("你是 **阿莉亚**");
    expect(prompt).toContain("星星");
    expect(prompt).toContain("## Delivery cues / 表演提示");
    expect(prompt).toContain("## Behavioural rules / 行为准则");
    expect(readPersonaIdentity("aria")).toMatchObject({ name: "阿莉亚", fans: "星星" });
    const listed = await call("GET", "/personas");
    expect(listed.body.personas.map((p: { id: string }) => p.id)).toEqual(["aria", MILKY]);
  });

  test("a field left blank is left out, so its default applies", async () => {
    const created = await call("POST", "/personas", {
      ...NEW_PERSONA,
      shortName: "",
      fans: "",
      summary: "",
    });
    expect(created.status).toBe(201);
    const yaml = Bun.YAML.parse(readFileSync(join(personaHomeDir("aria"), "persona.yaml"), "utf8"));
    expect(Object.keys((yaml as { identity: object }).identity)).toEqual(["name", "timezone"]);
    expect(readPersonaIdentity("aria")).toMatchObject({ shortName: "阿莉亚", fans: "观众" });
    expect(readFileSync(join(personaHomeDir("aria"), "prompt.md"), "utf8")).toContain("观众");
  });

  test("refuses a bad slug, a route word, a taken id, no name, voice or known zone", async () => {
    for (const [change, status, code] of [
      [{ id: "Aria" }, 400, "invalid-persona-id"],
      [{ id: "../x" }, 400, "invalid-persona-id"],
      [{ id: "-aria" }, 400, "invalid-persona-id"],
      [{ id: "a b" }, 400, "invalid-persona-id"],
      [{ id: "active" }, 400, "invalid-persona-id"],
      [{ id: "prompt" }, 400, "invalid-persona-id"],
      [{ id: MILKY }, 409, "persona-exists"],
      [{ name: "" }, 400, "bad-request"],
      [{ name: "a\nb" }, 400, "bad-request"],
      [{ voiceId: undefined }, 400, "bad-request"],
      [{ voiceId: "not-a-voice" }, 400, "bad-request"],
      [{ timezone: "Mars/Olympus" }, 400, "bad-request"],
    ] as const) {
      const refused = await call("POST", "/personas", { ...NEW_PERSONA, ...change });
      expect([JSON.stringify(change), refused.status, refused.body.error.code]).toEqual([
        JSON.stringify(change),
        status,
        code,
      ]);
    }
    expect(existsSync(personaHomeDir("aria"))).toBe(false);
  });
});

describe("switching", () => {
  test("writes settings.yaml and installs the settings again", async () => {
    await call("POST", "/personas", NEW_PERSONA);
    const switched = await call("PUT", "/personas/active", { id: "aria" });
    expect([switched.status, switched.body.active]).toEqual([200, "aria"]);
    expect(activePersona().id).toBe("aria");
    expect(activePersona().identity.name).toBe("阿莉亚");
    expect(Bun.YAML.parse(readFileSync(join(dataHome(), "settings.yaml"), "utf8"))).toEqual({
      persona: "aria",
    });
  });

  test("is refused during a call, for an unknown id, and when the environment picks", async () => {
    await call("POST", "/personas", NEW_PERSONA);
    calls = 1;
    const busy = await call("PUT", "/personas/active", { id: "aria" });
    expect([busy.status, busy.body.error.code]).toEqual([409, "call-active"]);
    calls = 0;
    const unknown = await call("PUT", "/personas/active", { id: "nobody" });
    expect([unknown.status, unknown.body.error.code]).toEqual([404, "unknown-persona"]);
    saved.set("EIDOLON_PERSONA", process.env.EIDOLON_PERSONA);
    process.env.EIDOLON_PERSONA = MILKY;
    const pinned = await call("PUT", "/personas/active", { id: "aria" });
    expect([pinned.status, pinned.body.error.code]).toEqual([409, "conflict"]);
    expect(existsSync(join(dataHome(), "settings.yaml"))).toBe(false);
  });
});

describe("prompt, glossary and identity", () => {
  test("the prompt reads from the template and writes the user's copy", async () => {
    const template = readFileSync(join(personaTemplateDir(MILKY), "prompt.md"), "utf8");
    const read = await call("GET", `/personas/${MILKY}/prompt`);
    expect(read.body).toEqual({ text: template, source: "template" });
    const saved = await call("PUT", `/personas/${MILKY}/prompt`, { text: "# 新的人设\n" });
    expect(saved.body).toEqual({ text: "# 新的人设\n", source: "own" });
    expect(readFileSync(join(personaHomeDir(MILKY), "prompt.md"), "utf8")).toBe("# 新的人设\n");
  });

  test("the prompt follows her prompt setting, but only inside her folder", async () => {
    await call("PUT", "/settings", {
      scope: "persona",
      persona: MILKY,
      values: { prompt: "drafts/prompt-v2.md" },
    });
    const saved = await call("PUT", `/personas/${MILKY}/prompt`, { text: "v2" });
    expect(saved.body).toEqual({ text: "v2", source: "own" });
    expect(readFileSync(join(personaHomeDir(MILKY), "drafts", "prompt-v2.md"), "utf8")).toBe("v2");
    // A hand-edited setting that leaves her folder is neither read nor written.
    write(`personas/${MILKY}/persona.yaml`, "prompt: /etc/hosts\n");
    for (const [method, body] of [
      ["GET", undefined],
      ["PUT", { text: "x" }],
    ] as const) {
      const refused = await call(method, `/personas/${MILKY}/prompt`, body);
      expect([refused.status, refused.body.error.code]).toEqual([409, "invalid-path"]);
    }
  });

  test("a glossary that isn't TOML isn't saved; Soniox's objections come back", async () => {
    const read = await call("GET", `/personas/${MILKY}/glossary`);
    expect([read.body.source, read.body.errors]).toEqual(["template", []]);
    const broken = await call("PUT", `/personas/${MILKY}/glossary`, { text: "terms = [1,\n" });
    expect([broken.status, broken.body.error.code]).toEqual([400, "invalid-toml"]);
    expect(broken.body.error.message).toBe("line 1, column 12: Unterminated array; expected ']'");
    // The place in the TOML, counted in characters, never this server's own source position.
    for (const [text, message] of [
      ["a = 1\n\n  b = = 2\n", "line 3, column 7: Expected a value but found '='"],
      ['"名字" = "奶绿"\n"别名" = = "x"\n', "line 2, column 8: Expected a value but found '='"],
    ] as const) {
      const refused = await call("PUT", `/personas/${MILKY}/glossary`, { text });
      expect([refused.status, refused.body.error.message]).toEqual([400, message]);
    }
    expect(existsSync(join(personaHomeDir(MILKY), "glossary.toml"))).toBe(false);
    const shaped = await call("PUT", `/personas/${MILKY}/glossary`, { text: 'terms = "x"\n' });
    expect(shaped.status).toBe(200);
    expect(shaped.body.source).toBe("own");
    expect(shaped.body.errors).toEqual([
      "`terms` must be an array of strings, as Soniox's StructuredContext requires.",
    ]);
  });

  test("identity round trips; a blank field falls back; the rest of persona.yaml stays", async () => {
    const read = await call("GET", `/personas/${MILKY}/identity`);
    expect(read.body).toMatchObject({
      name: "明前奶绿",
      shortName: "奶绿",
      fans: "奶糖花",
      timezone: "Asia/Shanghai",
    });
    const saved = await call("PUT", `/personas/${MILKY}/identity`, {
      ...read.body,
      shortName: "绿",
      fans: "",
    });
    expect(saved.body).toEqual({ ...read.body, shortName: "绿", fans: "" });
    const own = Bun.YAML.parse(
      readFileSync(join(personaHomeDir(MILKY), "persona.yaml"), "utf8"),
    ) as Record<string, any>;
    expect(own.identity.viewerLine).toBe("今天来花店的{fans}叫「{viewer}」（B站UID:{uid}）。");
    expect(own.identity.localViewerLine).toBe("今天来花店的{fans}叫「{viewer}」。");
    expect("fans" in own.identity).toBe(false);
    expect(own.knowledge.facts.subject).toBe("明前奶[绿黑]");
    // She is active, so the next call reads the new identity.
    expect(activePersona().identity).toMatchObject({ shortName: "绿", fans: "观众" });
    const zone = await call("PUT", `/personas/${MILKY}/identity`, {
      ...read.body,
      timezone: "Nope/Zone",
    });
    expect(zone.status).toBe(400);
  });
});

describe("references and the avatar", () => {
  const upload = (path: string, bytes: Uint8Array | ReadableStream, type = "image/png") =>
    call("POST", `/personas/${MILKY}/references/${path}`, bytes, type);

  test("lists the template's outfits; the user's image of the same name hides it", async () => {
    const before = await call("GET", `/personas/${MILKY}/references`);
    expect(before.body).toEqual({
      outfits: [
        {
          name: "day.png",
          source: "template",
          size: statSync(join(personaTemplateDir(MILKY), "references/outfits/day.png")).size,
        },
        {
          name: "night.png",
          source: "template",
          size: statSync(join(personaTemplateDir(MILKY), "references/outfits/night.png")).size,
        },
      ],
      friends: [],
      avatar: null,
    });
    expect((await upload("outfits/day.png", PNG)).status).toBe(200);
    const after = await call("GET", `/personas/${MILKY}/references`);
    expect(after.body.outfits[0]).toEqual({ name: "day.png", source: "own", size: PNG.length });
  });

  test("takes PNG, JPEG and WebP by their bytes, renaming the extension to match", async () => {
    for (const [name, bytes, saved] of [
      ["summer.png", JPEG, "summer.jpg"],
      ["winter.jpeg", JPEG, "winter.jpeg"],
      ["rain.jpg", WEBP, "rain.webp"],
      ["小明.webp", PNG, "小明.png"],
    ] as const) {
      const answer = await upload(`friends/${encodeURIComponent(name)}`, bytes);
      expect([name, answer.status, answer.body]).toEqual([
        name,
        200,
        { name: saved, source: "own", size: bytes.length },
      ]);
      expect(existsSync(join(personaHomeDir(MILKY), "references", "friends", saved))).toBe(true);
    }
  });

  test("refuses SVG and HTML whatever the name, and past 20 MiB, leaving nothing", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    for (const bytes of [svg, html]) {
      const refused = await upload("outfits/evil.png", bytes);
      expect([refused.status, refused.body.error.code]).toEqual([415, "unsupported-media-type"]);
    }
    const svgName = await upload("outfits/evil.svg", svg, "image/svg+xml");
    expect([svgName.status, svgName.body.error.code]).toEqual([400, "invalid-file-name"]);

    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1024 * 1024);
    big.set(PNG);
    const declared = await upload("outfits/big.png", big);
    expect([declared.status, declared.body.error.code]).toEqual([413, "payload-too-large"]);
    // Chunked, so only counting the bytes as they stream can stop it.
    const streamed = await upload(
      "outfits/big.png",
      new ReadableStream({
        start(controller) {
          for (let sent = 0; sent < MAX_UPLOAD_BYTES + 1024 * 1024; sent += 1024 * 1024) {
            controller.enqueue(
              sent === 0 ? big.subarray(0, 1024 * 1024) : new Uint8Array(1024 * 1024),
            );
          }
          controller.close();
        },
      }),
    );
    expect([streamed.status, streamed.body.error.code]).toEqual([413, "payload-too-large"]);
    expect(existsSync(join(personaHomeDir(MILKY), "references"))).toBe(false);
  });

  test("a template image stays; the user's goes, and the template's shows again", async () => {
    const template = await call("DELETE", `/personas/${MILKY}/references/outfits/day.png`);
    expect([template.status, template.body.error.code]).toEqual([409, "template-file"]);
    await upload("outfits/day.png", PNG);
    expect((await call("DELETE", `/personas/${MILKY}/references/outfits/day.png`)).status).toBe(
      200,
    );
    const listed = await call("GET", `/personas/${MILKY}/references`);
    expect(listed.body.outfits[0].source).toBe("template");
    const missing = await call("DELETE", `/personas/${MILKY}/references/outfits/nope.png`);
    expect([missing.status, missing.body.error.code]).toEqual([404, "not-found"]);
    expect((await call("DELETE", `/personas/${MILKY}/references/hats/day.png`)).status).toBe(400);
  });

  test("a preview is typed by its bytes, sandboxed, and never cached", async () => {
    const response = await api("GET", `/personas/${MILKY}/references/outfits/day.png`);
    expect(response.status).toBe(200);
    expect(
      Object.fromEntries(
        ["content-type", "x-content-type-options", "content-security-policy", "cache-control"].map(
          (name) => [name, response.headers.get(name)],
        ),
      ),
    ).toEqual({
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "no-store",
    });
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      readFileSync(join(personaTemplateDir(MILKY), "references/outfits/day.png")),
    );
    // Planted by hand under an image's name: never served as what it says it is.
    write(`personas/${MILKY}/references/outfits/fake.png`, "<svg/>");
    const fake = await call("GET", `/personas/${MILKY}/references/outfits/fake.png`);
    expect(fake.status).toBe(415);
  });

  test("the avatar: one file, replaced by type, served, and deleted", async () => {
    expect((await call("GET", `/personas/${MILKY}/avatar`)).status).toBe(404);
    const png = await call("PUT", `/personas/${MILKY}/avatar`, PNG);
    expect(png.body).toEqual({ name: "avatar.png", source: "own", size: PNG.length });
    const jpeg = await call("PUT", `/personas/${MILKY}/avatar`, JPEG, "image/jpeg");
    expect(jpeg.body.name).toBe("avatar.jpg");
    // At the root of her folder, beside persona.yaml, and the only one.
    expect(readdirSync(personaHomeDir(MILKY))).toEqual(["avatar.jpg"]);
    const served = await api("GET", `/personas/${MILKY}/avatar?v=2`);
    expect([served.status, served.headers.get("content-type")]).toEqual([200, "image/jpeg"]);
    const listed = await call("GET", `/personas/${MILKY}/references`);
    expect(listed.body.avatar).toEqual({ name: "avatar.jpg", source: "own", size: JPEG.length });
    expect((await call("DELETE", `/personas/${MILKY}/avatar`)).status).toBe(200);
    expect((await call("GET", `/personas/${MILKY}/avatar`)).status).toBe(404);
    expect(
      (await call("PUT", `/personas/${MILKY}/avatar`, new TextEncoder().encode("<svg/>"))).status,
    ).toBe(415);
  });

  test("an avatar alone turns on no selfies: the selfie tool finds no outfit", async () => {
    await call("POST", "/personas", NEW_PERSONA);
    await call("PUT", "/personas/active", { id: "aria" });
    expect((await call("PUT", "/personas/aria/avatar", PNG)).status).toBe(200);
    expect(activePersona().id).toBe("aria");
    expect(referenceSources()).toEqual([]);
    // What GET status reports.
    expect(selfieReferenceCount()).toBe(0);
  });
});

describe("facts and the index", () => {
  const facts = () => sourceFolder(MILKY, "facts");

  test("lists her fact files: which her patterns pick, which changed since the ingest", async () => {
    await call("PUT", `/personas/${MILKY}/facts/${encodeURIComponent("明前奶绿设定集.txt")}`, {
      text: "2024-01-01 明前奶绿喜欢猫\n",
    });
    const notes = await call("PUT", `/personas/${MILKY}/facts/notes.txt`, { text: "草稿\n" });
    expect(notes.body).toMatchObject({ name: "notes.txt", matched: false, changed: false });
    let listed = await call("GET", `/personas/${MILKY}/facts`);
    expect(listed.body.patterns).toEqual(["*设定集.txt", "*事件集.txt"]);
    expect(listed.body.files.map((f: any) => [f.name, f.matched, f.changed])).toEqual([
      ["notes.txt", false, false],
      ["明前奶绿设定集.txt", true, true],
    ]);
    expect(listed.body.removed).toEqual([]);

    const stat = statSync(join(facts(), "明前奶绿设定集.txt"));
    write(
      `personas/${MILKY}/index/persona_facts.meta.json`,
      JSON.stringify({
        embedModel: "google/gemini-embedding-2-preview",
        embedDim: 3072,
        rows: 1,
        builtAt: "2026-11-01T00:00:00.000Z",
        sources: [
          { name: "明前奶绿设定集.txt", size: stat.size, mtime: stat.mtime.toISOString() },
          { name: "旧事件集.txt", size: 10, mtime: "2026-01-01T00:00:00.000Z" },
        ],
        patterns: ["*设定集.txt", "*事件集.txt"],
      }),
    );
    listed = await call("GET", `/personas/${MILKY}/facts`);
    expect(listed.body.files.find((f: any) => f.name === "明前奶绿设定集.txt").changed).toBe(false);
    expect(listed.body.removed).toEqual(["旧事件集.txt"]);
  });

  test("reads, writes and deletes one .txt file, inside her fact folder only", async () => {
    expect((await call("GET", `/personas/${MILKY}/facts/a.txt`)).status).toBe(404);
    const saved = await call("PUT", `/personas/${MILKY}/facts/a.txt`, { text: "一\n二\n" });
    expect(saved.body).toMatchObject({ name: "a.txt", size: "一\n二\n".length + 4 });
    expect((await call("GET", `/personas/${MILKY}/facts/a.txt`)).body).toEqual({
      text: "一\n二\n",
    });
    expect((await call("DELETE", `/personas/${MILKY}/facts/a.txt`)).status).toBe(200);
    expect(existsSync(join(facts(), "a.txt"))).toBe(false);
    for (const name of ["a.md", ".hidden.txt", "a%2Fb.txt", "a%00.txt", "a%5Cb.txt"]) {
      const refused = await call("PUT", `/personas/${MILKY}/facts/${name}`, { text: "x" });
      expect([name, refused.status]).toEqual([name, 400]);
    }
  });

  test("the index comes from its build records, for any persona", async () => {
    await call("POST", "/personas", NEW_PERSONA);
    mkdirSync(join(personaHomeDir("aria"), "index", "persona_facts.lance"), { recursive: true });
    write(
      "personas/aria/index/persona_facts.meta.json",
      JSON.stringify({
        embedModel: "other/model",
        embedDim: 1024,
        rows: 5,
        builtAt: "2026-11-03T00:00:00.000Z",
      }),
    );
    const index = await call("GET", "/personas/aria/index");
    expect(index.body).toEqual({
      tables: [
        {
          table: "stream_chunks",
          built: false,
          rows: null,
          builtAt: null,
          model: null,
          dim: null,
          stale: false,
        },
        {
          table: "persona_facts",
          built: true,
          rows: 5,
          builtAt: "2026-11-03T00:00:00.000Z",
          model: "other/model",
          dim: 1024,
          stale: true,
        },
      ],
      catalogBuiltAt: null,
    });
    expect((await call("GET", "/personas/nobody/index")).status).toBe(404);
  });
});

describe("names that try to leave their folder", () => {
  test("never read or change a file outside, by any spelling", async () => {
    const sentinels = [
      write("secret.txt", "SENTINEL-HOME"),
      write(`sources/${MILKY}/secret.txt`, "SENTINEL-SOURCES"),
      write(`personas/${MILKY}/references/secret.png`, PNG),
    ];
    const before = sentinels.map((path) => readFileSync(path));
    const spellings = [
      "..%2F..%2Fsecret.txt",
      "%2e%2e%2f%2e%2e%2fsecret.txt",
      "..%5C..%5Csecret.txt",
      "%2Fetc%2Fpasswd",
      "secret.txt%00.png",
      "..",
      "..%2Fsecret.png",
    ];
    const paths = [
      ...spellings.map((s) => `/api/local/personas/${MILKY}/facts/${s}`),
      ...spellings.map((s) => `/api/local/personas/${MILKY}/references/outfits/${s}`),
      ...spellings.map((s) => `/api/local/personas/${s}/prompt`),
      ...spellings.map((s) => `/api/local/personas/${s}/glossary`),
      ...spellings.map((s) => `/api/local/personas/${s}/identity`),
      `/api/local/personas/${MILKY}/facts/../../../secret.txt`,
      `/api/local/personas/${MILKY}/references/../secret.png`,
    ];
    const head = (method: string, path: string, length: number) =>
      [
        `${method} ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${booted.port}`,
        `Cookie: ${booted.cookie}`,
        `Origin: ${booted.origin}`,
        "Content-Type: application/json",
        `Content-Length: ${length}`,
      ].join("\n");
    const body = '{"text":"OVERWRITTEN"}';
    for (const path of paths) {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const response = await raw(
          booted.port,
          head(method, path, method === "PUT" ? body.length : 0),
          method === "PUT" ? body : "",
        );
        expect([method, path, response.status < 500, response.status === 200]).toEqual([
          method,
          path,
          true,
          false,
        ]);
        expect(response.body).not.toContain("SENTINEL");
      }
    }
    expect(sentinels.map((path) => readFileSync(path))).toEqual(before);
  });
});

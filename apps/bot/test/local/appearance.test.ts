// /api/local/personas/:id/models: her character models, imported into her folder in the data home
// once PSD2Live's runtime has loaded them, set active only through PUT settings, and served only to
// the app's pages. The templates' bytes are pinned across this whole file.
import "../../../../packages/config/test/isolated-guard.ts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataHome, envOptional, personaHomeDir, templatesDir } from "@eidolon/config";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { type CharacterModel, MAX_MODEL_BYTES } from "../../src/local/api.ts";
import { modelSlug } from "../../src/local/appearance.ts";
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

const MILKY = "milky-green";
const RIG = readFileSync(join(import.meta.dirname, "fixtures/psd2live/tml.p2lrt"));
const SHA256 = "59c68b11c223d31828261d3420e015c091ce29dc29e23072e71b93c6f283ed81";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const NOD = "modifier:m34:6d6f74696f6e";
const MIB = 1024 * 1024;

function api(method: string, path: string, body?: unknown, type = "application/json") {
  const encoded =
    body === undefined || body instanceof Uint8Array || body instanceof ReadableStream
      ? (body as BodyInit | undefined)
      : JSON.stringify(body);
  // Node's fetch sends a stream only as a half-duplex request.
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: { ...booted.session, "Content-Type": type },
    body: encoded,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  };
  return fetch(`${booted.base}/api/local${path}`, init);
}

async function call(method: string, path: string, body?: unknown, type?: string) {
  const response = await api(method, path, body, type);
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: a model's bytes.
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

function upload(filename: string | null, bytes: Uint8Array | ReadableStream = RIG) {
  const query = filename === null ? "" : `?filename=${encodeURIComponent(filename)}`;
  return call("POST", `/personas/${MILKY}/models${query}`, bytes, "application/octet-stream");
}

const folderOf = (model: string) => join(personaHomeDir(MILKY), "models", model);
const manifestOf = (model: string) =>
  JSON.parse(readFileSync(join(folderOf(model), "model.json"), "utf8"));
const personaYaml = () => join(personaHomeDir(MILKY), "persona.yaml");

function setAppearance(model: unknown) {
  return call("PUT", "/settings", {
    scope: "persona",
    persona: MILKY,
    values: { "appearance.model": model },
  });
}

/** The test rig with its META chunk renamed, which the runtime skips: a rig with no generator. */
function withoutMeta(bytes: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(bytes);
  const view = new DataView(copy.buffer);
  const table = view.getUint32(20, true);
  for (let index = 0; index < view.getUint32(16, true); index++) {
    const entry = table + index * 40;
    if (Buffer.from(copy.subarray(entry, entry + 4)).toString("latin1") === "META") {
      copy.set(Buffer.from("XXXX", "latin1"), entry);
    }
  }
  return copy;
}

describe("model ids", () => {
  test("are slugs of the file's name, `model` when it makes none, then -2, -3…", () => {
    const none = new Set<string>();
    expect(modelSlug("Tml.P2LRT", none)).toBe("tml");
    expect(modelSlug("My Model v1.2.p2lrt", none)).toBe("my-model-v1-2");
    expect(modelSlug("__a (1).p2lrt", none)).toBe("a-1");
    expect(modelSlug("奶绿.p2lrt", none)).toBe("model");
    expect(modelSlug(null, none)).toBe("model");
    expect(modelSlug("tml.p2lrt", new Set(["tml", "tml-2"]))).toBe("tml-3");
    const long = modelSlug(`${"a".repeat(80)}.p2lrt`, new Set(["a".repeat(64)]));
    expect(long).toBe(`${"a".repeat(62)}-2`);
    for (const id of ["tml", "my-model-v1-2", "a-1", "model", long]) {
      expect(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)).toBe(true);
    }
  });
});

describe("importing", () => {
  test("keeps the file and what the runtime read in her folder, under an id of its own", async () => {
    const first = await upload("Tml.p2lrt");
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      id: "tml",
      name: "Tml",
      kind: "psd2live",
      size: RIG.length,
      sha256: SHA256,
      framing: { call: null, companion: null },
      moods: {},
      gestures: {},
      outfits: [],
      outfit: null,
    });
    expect(first.body.updatedAt).toBe(first.body.importedAt);
    expect(first.body.inventory).toMatchObject({ generator: "psd2live 3.8.4", textures: 6 });
    expect(readdirSync(folderOf("tml")).sort()).toEqual(["model.json", "model.p2lrt"]);
    expect(readFileSync(join(folderOf("tml"), "model.p2lrt"))).toEqual(RIG);
    const { id: _id, ...fields } = first.body as CharacterModel;
    expect(manifestOf("tml")).toEqual({ format: 1, file: "model.p2lrt", ...fields });

    expect((await upload("tml.p2lrt")).body).toMatchObject({ id: "tml-2", name: "tml" });
    expect((await upload("奶绿 (新).p2lrt")).body).toMatchObject({
      id: "model",
      name: "奶绿 (新)",
    });
    expect((await upload(null)).body).toMatchObject({ id: "model-2", name: "model-2" });
    // Importing never makes one hers to show.
    const listed = await call("GET", `/personas/${MILKY}/models`);
    expect([
      listed.body.active,
      listed.body.models.map((model: CharacterModel) => model.id),
    ]).toEqual([null, ["model", "model-2", "tml", "tml-2"]]);
    expect(existsSync(personaYaml())).toBe(false);
  });

  test("refuses what isn't a .p2lrt, an empty file, and what the runtime refuses, keeping nothing", async () => {
    const png = await upload("a.p2lrt", PNG);
    expect([png.status, png.body.error.code]).toEqual([415, "unsupported-media-type"]);
    const empty = await upload("a.p2lrt", new Uint8Array(0));
    expect([empty.status, empty.body.error.code]).toEqual([400, "bad-request"]);
    const cut = await upload("a.p2lrt", RIG.subarray(0, RIG.length - 1));
    expect([cut.status, cut.body.error]).toEqual([
      400,
      { code: "invalid-model", message: "Chunk META lies outside the file" },
    ]);
    expect(existsSync(join(personaHomeDir(MILKY), "models"))).toBe(false);
  });

  test("past 200 MiB, declared or counted as it streams, is 413 and keeps nothing", async () => {
    const declared = await raw(
      booted.port,
      [
        `POST /api/local/personas/${MILKY}/models?filename=big.p2lrt HTTP/1.1`,
        `Host: 127.0.0.1:${booted.port}`,
        `Cookie: ${booted.cookie}`,
        `X-Eidolon-Proof: ${booted.proof}`,
        `Origin: ${booted.origin}`,
        "Content-Type: application/octet-stream",
        `Content-Length: ${MAX_MODEL_BYTES + 1}`,
      ].join("\n"),
    );
    expect([declared.status, JSON.parse(declared.body).error.code]).toEqual([
      413,
      "payload-too-large",
    ]);
    // Chunked and endless: a server that waited for the end would never answer.
    const zeros = new Uint8Array(MIB);
    const streamed = await upload(
      "big.p2lrt",
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(zeros);
        },
      }),
    );
    expect([streamed.status, streamed.body.error.code]).toEqual([413, "payload-too-large"]);
    expect(existsSync(join(personaHomeDir(MILKY), "models"))).toBe(false);
  }, 60_000);

  test("waits while a call is on, as a new file for a model does", async () => {
    expect((await upload("tml.p2lrt")).status).toBe(201);
    calls = 1;
    const busy = await upload("other.p2lrt");
    expect([busy.status, busy.body.error.code]).toEqual([409, "call-active"]);
    const replace = await call(
      "PUT",
      `/personas/${MILKY}/models/tml/file`,
      RIG,
      "application/octet-stream",
    );
    expect([replace.status, replace.body.error.code]).toEqual([409, "call-active"]);
    calls = 0;
    expect(readdirSync(join(personaHomeDir(MILKY), "models"))).toEqual(["tml"]);
  });

  test("only for a persona that exists", async () => {
    const unknown = await call("GET", "/personas/nobody/models");
    expect([unknown.status, unknown.body.error.code]).toEqual([404, "unknown-persona"]);
    const bad = await call("GET", "/personas/Bad%20Id/models");
    expect([bad.status, bad.body.error.code]).toEqual([400, "invalid-persona-id"]);
  });
});

describe("the active model", () => {
  test("is her appearance.model, only ever one of her models", async () => {
    await upload("tml.p2lrt");
    for (const bad of ["../../etc", "nope", "Tml", "tml/../tml"]) {
      const refused = await setAppearance(bad);
      expect([bad, refused.status, refused.body.error.code]).toEqual([bad, 400, "invalid-setting"]);
      expect(JSON.stringify(refused.body)).not.toContain(bad);
    }
    expect(existsSync(personaYaml())).toBe(false);

    const set = await setAppearance("tml");
    expect([set.status, set.body.restartRequired]).toEqual([200, false]);
    expect(parseYaml(readFileSync(personaYaml(), "utf8")).appearance).toEqual({ model: "tml" });
    expect(envOptional("APPEARANCE_MODEL")).toBe("tml");
    const { sha256, updatedAt } = manifestOf("tml");
    const active = { id: "tml", name: "tml", kind: "psd2live", sha256, updatedAt };
    expect((await call("GET", `/personas/${MILKY}/models`)).body.active).toBe("tml");
    const personas = (await call("GET", "/personas")).body.personas;
    expect(personas.find((p: { id: string }) => p.id === MILKY).appearance).toEqual({
      model: active,
    });
    expect((await call("GET", "/status")).body.persona.appearance).toEqual({ model: active });

    expect((await setAppearance(null)).status).toBe(200);
    expect(parseYaml(readFileSync(personaYaml(), "utf8")).appearance).toBeUndefined();
    expect((await call("GET", "/status")).body.persona.appearance).toEqual({ model: null });
  });

  test("a setting written by hand that names no model of hers shows none", async () => {
    mkdirSync(personaHomeDir(MILKY), { recursive: true });
    writeFileSync(personaYaml(), "appearance:\n  model: ../../etc\n");
    const listed = await call("GET", `/personas/${MILKY}/models`);
    expect([listed.status, listed.body]).toEqual([200, { active: null, models: [] }]);
    const personas = (await call("GET", "/personas")).body.personas;
    expect(personas[0].appearance).toEqual({ model: null });
  });
});

describe("editing", () => {
  const OUTFIT = {
    id: "plain",
    name: "Plain",
    poses: [],
    parameters: [{ id: "ParamCheek", value: 1 }],
    hiddenParts: [] as string[],
  };

  test("PATCH replaces each field it sends, checked against the model's file", async () => {
    const imported = (await upload("tml.p2lrt")).body as CharacterModel;
    const part = imported.inventory.parts[0]?.id as string;
    const patch = {
      name: "  奶绿的模型  ",
      framing: { call: { x: 640, y: 120, width: 760, height: 900 }, companion: null },
      moods: { happy: ["smile"], lazy: ["sleepy", "smile"], thinking: [] },
      gestures: { nod: NOD },
      outfits: [{ ...OUTFIT, hiddenParts: [part] }],
      outfit: "plain",
    };
    const patched = await call("PATCH", `/personas/${MILKY}/models/tml`, patch);
    expect(patched.status).toBe(200);
    expect(patched.body).toEqual({
      ...imported,
      ...patch,
      name: "奶绿的模型",
      updatedAt: patched.body.updatedAt,
    });
    expect(patched.body.updatedAt >= imported.updatedAt).toBe(true);
    expect(manifestOf("tml")).toMatchObject({ format: 1, name: "奶绿的模型", outfit: "plain" });

    const before = readFileSync(join(folderOf("tml"), "model.json"));
    for (const refused of [
      { color: "red" },
      { name: "" },
      { name: "a\nb" },
      { name: "a".repeat(65) },
      { framing: { call: { x: 0, y: 0, width: 0, height: 10 }, companion: null } },
      { framing: { call: null } },
      { moods: { happy: ["grin"] } },
      { moods: { happy: ["smile", "sad", "angry"] } },
      { moods: { happy: ["smile", "smile"] } },
      { moods: { Happy: ["smile"] } },
      { gestures: { nod: "Nod" } },
      { outfits: [{ ...OUTFIT, parameters: [{ id: "ParamCheek", value: 2 }] }] },
      { outfits: [{ ...OUTFIT, parameters: [{ id: "ParamNope", value: 0 }] }] },
      { outfits: [{ ...OUTFIT, hiddenParts: ["nope"] }] },
      { outfits: [{ ...OUTFIT, poses: [{ group: 0, entry: 0 }] }] },
      { outfits: [OUTFIT, OUTFIT] },
      { outfits: Array.from({ length: 33 }, (_, i) => ({ ...OUTFIT, id: `o${i}` })) },
      { outfit: "nope" },
      [],
    ]) {
      const answer = await call("PATCH", `/personas/${MILKY}/models/tml`, refused);
      expect([refused, answer.status, answer.body.error?.code]).toEqual([
        refused,
        400,
        "bad-request",
      ]);
    }
    expect(readFileSync(join(folderOf("tml"), "model.json"))).toEqual(before);

    // Outfits without the one she wears take it off her; nothing sent changes nothing.
    const bare = await call("PATCH", `/personas/${MILKY}/models/tml`, { outfits: [] });
    expect([bare.body.outfits, bare.body.outfit]).toEqual([[], null]);
    expect((await call("PATCH", `/personas/${MILKY}/models/tml`, {})).body).toEqual(bare.body);
    const missing = await call("PATCH", `/personas/${MILKY}/models/nope`, { name: "x" });
    expect([missing.status, missing.body.error.code]).toEqual([404, "unknown-model"]);
  });

  test("PUT file puts a new rig in place, keeping the settings that still name what it holds", async () => {
    const imported = (await upload("tml.p2lrt")).body as CharacterModel;
    const part = imported.inventory.parts[0]?.id as string;
    const framing = { call: { x: 1, y: 2, width: 3, height: 4 }, companion: null };
    // Settings a file once held: written by hand, as a model's earlier export would have left them.
    const manifest = manifestOf("tml");
    writeFileSync(
      join(folderOf("tml"), "model.json"),
      JSON.stringify({
        ...manifest,
        framing,
        moods: { happy: ["smile", "grin"], wry: ["smirk"], thinking: [] },
        gestures: { nod: NOD, wave: "modifier:m99:gone" },
        outfits: [
          {
            id: "party",
            name: "Party",
            poses: [{ group: 0, entry: 1 }],
            parameters: [
              { id: "ParamCheek", value: 5 },
              { id: "ParamGone", value: 1 },
            ],
            hiddenParts: [part, "gone"],
          },
        ],
        outfit: "party",
      }),
    );

    const other = withoutMeta(RIG);
    const replaced = await call(
      "PUT",
      `/personas/${MILKY}/models/tml/file`,
      other,
      "application/octet-stream",
    );
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({
      id: "tml",
      name: "tml",
      size: other.length,
      sha256: createHash("sha256").update(other).digest("hex"),
      importedAt: imported.importedAt,
      framing,
      moods: { happy: ["smile"], thinking: [] },
      gestures: { nod: NOD },
      outfits: [
        {
          id: "party",
          name: "Party",
          poses: [],
          parameters: [{ id: "ParamCheek", value: 1 }],
          hiddenParts: [part],
        },
      ],
      outfit: "party",
    });
    expect(replaced.body.inventory.generator).toBeNull();
    expect(readFileSync(join(folderOf("tml"), "model.p2lrt"))).toEqual(Buffer.from(other));
    const { id: _id, ...fields } = replaced.body as CharacterModel;
    expect(manifestOf("tml")).toEqual({ format: 1, file: "model.p2lrt", ...fields });

    const png = await call("PUT", `/personas/${MILKY}/models/tml/file`, PNG, "image/png");
    expect([png.status, png.body.error.code]).toEqual([415, "unsupported-media-type"]);
    const missing = await call(
      "PUT",
      `/personas/${MILKY}/models/nope/file`,
      RIG,
      "application/octet-stream",
    );
    expect([missing.status, missing.body.error.code]).toEqual([404, "unknown-model"]);
  });

  test("DELETE removes the model, and her appearance.model with it when it named it", async () => {
    await upload("tml.p2lrt");
    await upload("tml.p2lrt");
    expect((await setAppearance("tml")).status).toBe(200);

    expect((await call("DELETE", `/personas/${MILKY}/models/tml-2`)).body).toEqual({ ok: true });
    expect(existsSync(folderOf("tml-2"))).toBe(false);
    expect(parseYaml(readFileSync(personaYaml(), "utf8")).appearance).toEqual({ model: "tml" });

    expect((await call("DELETE", `/personas/${MILKY}/models/tml`)).status).toBe(200);
    expect(existsSync(folderOf("tml"))).toBe(false);
    expect(parseYaml(readFileSync(personaYaml(), "utf8")).appearance).toBeUndefined();
    expect(envOptional("APPEARANCE_MODEL")).toBeUndefined();
    const again = await call("DELETE", `/personas/${MILKY}/models/tml`);
    expect([again.status, again.body.error.code]).toEqual([404, "unknown-model"]);
  });

  test("DELETE leaves the environment's appearance.model, which isn't hers, alone", async () => {
    await upload("tml.p2lrt");
    saved.set("APPEARANCE_MODEL", process.env.APPEARANCE_MODEL);
    process.env.APPEARANCE_MODEL = "tml";
    expect((await call("GET", `/personas/${MILKY}/models`)).body.active).toBe("tml");
    expect((await call("DELETE", `/personas/${MILKY}/models/tml`)).status).toBe(200);
    expect(existsSync(personaYaml())).toBe(false);
    expect((await call("GET", `/personas/${MILKY}/models`)).body.active).toBeNull();
  });
});

describe("the file", () => {
  test("is served under its sha256 to the app's pages alone, and kept for good", async () => {
    await upload("tml.p2lrt");
    const path = `/personas/${MILKY}/models/tml/file`;
    const response = await api("GET", `${path}?sha256=${SHA256}`);
    expect(response.status).toBe(200);
    expect(
      Object.fromEntries(
        ["content-type", "x-content-type-options", "cache-control", "content-length"].map(
          (name) => [name, response.headers.get(name)],
        ),
      ),
    ).toEqual({
      "content-type": "application/octet-stream",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=31536000, immutable",
      "content-length": String(RIG.length),
    });
    expect(Buffer.from(await response.arrayBuffer())).toEqual(RIG);

    // The cookie alone reads pictures, never a model.
    const cookie = await fetch(`${booted.base}/api/local${path}?sha256=${SHA256}`, {
      headers: { Cookie: booted.cookie },
    });
    expect([cookie.status, ((await cookie.json()) as any).error.code]).toEqual([
      401,
      "proof-missing",
    ]);
    const unnamed = await call("GET", path);
    expect([unnamed.status, unnamed.body.error.code]).toEqual([400, "bad-request"]);
    const other = await call("GET", `${path}?sha256=${"0".repeat(64)}`);
    expect([other.status, other.body.error.code, other.headers.get("cache-control")]).toEqual([
      404,
      "not-found",
      "no-store",
    ]);
    const missing = await call("GET", `/personas/${MILKY}/models/nope/file?sha256=${SHA256}`);
    expect([missing.status, missing.body.error.code]).toEqual([404, "unknown-model"]);
  });
});

describe("model ids that try to leave their folder", () => {
  test("never read or change a file outside, by any spelling", async () => {
    await upload("tml.p2lrt");
    const write = (rel: string, text: string) => {
      const path = join(dataHome(), rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
      return path;
    };
    const sentinels = [
      write("secret.txt", "SENTINEL-HOME"),
      write(`personas/${MILKY}/secret.txt`, "SENTINEL-PERSONA"),
      write(`personas/${MILKY}/model.json`, '{"name":"SENTINEL-MANIFEST"}'),
    ];
    const before = sentinels.map((path) => readFileSync(path));
    const spellings = [
      "..%2F..%2Fsecret.txt",
      "%2e%2e%2f%2e%2e",
      "..%5C..%5Csecret.txt",
      "%2Fetc%2Fpasswd",
      "tml%00",
      "..",
      "%2e%2e",
      "TML",
      "tml%2F..%2F..",
    ];
    const paths = [
      ...spellings.map((s) => `/api/local/personas/${MILKY}/models/${s}`),
      ...spellings.map((s) => `/api/local/personas/${MILKY}/models/${s}/file?sha256=${SHA256}`),
      ...spellings.map((s) => `/api/local/personas/${s}/models`),
      `/api/local/personas/${MILKY}/models/../../secret.txt`,
    ];
    const body = '{"name":"OVERWRITTEN"}';
    for (const path of paths) {
      for (const method of ["GET", "PUT", "PATCH", "DELETE", "POST"]) {
        const response = await raw(
          booted.port,
          [
            `${method} ${path} HTTP/1.1`,
            `Host: 127.0.0.1:${booted.port}`,
            `Cookie: ${booted.cookie}`,
            `X-Eidolon-Proof: ${booted.proof}`,
            `Origin: ${booted.origin}`,
            "Content-Type: application/json",
            `Content-Length: ${body.length}`,
          ].join("\n"),
          body,
        );
        expect([method, path, response.status < 500, response.status < 300]).toEqual([
          method,
          path,
          true,
          false,
        ]);
        expect(response.body).not.toContain("SENTINEL");
      }
    }
    expect(sentinels.map((path) => readFileSync(path))).toEqual(before);
    expect(readdirSync(join(personaHomeDir(MILKY), "models"))).toEqual(["tml"]);
  });

  test("never by an id written into model.json: the folder's name is the id", async () => {
    await upload("tml.p2lrt");
    const other = withoutMeta(RIG);
    await upload("other.p2lrt", other);
    const sentinel = join(dataHome(), "keep.txt");
    writeFileSync(sentinel, "SENTINEL");
    const claim = (id: string) =>
      writeFileSync(
        join(folderOf("tml"), "model.json"),
        JSON.stringify({ ...manifestOf("tml"), id, extra: true }),
      );

    claim("other");
    const listed = (await call("GET", `/personas/${MILKY}/models`)).body.models;
    expect(listed.map((model: CharacterModel) => model.id)).toEqual(["other", "tml"]);
    expect(listed[1]).not.toHaveProperty("extra");
    const file = await api("GET", `/personas/${MILKY}/models/tml/file?sha256=${SHA256}`);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(RIG);
    const renamed = await call("PATCH", `/personas/${MILKY}/models/tml`, { name: "Renamed" });
    expect([renamed.body.id, manifestOf("tml").name, manifestOf("other").name]).toEqual([
      "tml",
      "Renamed",
      "other",
    ]);
    const manifest = manifestOf("tml");
    expect(["id" in manifest, "extra" in manifest]).toEqual([false, false]);

    claim("../../..");
    expect((await call("DELETE", `/personas/${MILKY}/models/tml`)).body).toEqual({ ok: true });
    expect(readdirSync(join(personaHomeDir(MILKY), "models"))).toEqual(["other"]);
    expect(readFileSync(sentinel, "utf8")).toBe("SENTINEL");
  });
});

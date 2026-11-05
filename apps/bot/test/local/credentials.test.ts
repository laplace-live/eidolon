// /api/local/credentials: keys are written 0600 from the first byte, and no key, name or malformed
// body ever comes back in a response or a log line.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataHome, envOptional } from "@eidolon/config";
import { type CapturedLogs, captureLogs } from "../fakes.ts";
import { type Booted, bootFixture, cleanUpBoot } from "./harness.ts";

let booted: Booted;
let logs: CapturedLogs;
const touched: string[] = [];

beforeEach(async () => {
  logs = captureLogs();
  booted = await bootFixture();
});

afterEach(async () => {
  await booted.stop();
  logs.restore();
  for (const name of touched.splice(0)) delete process.env[name];
  cleanUpBoot();
});

function setEnv(name: string, value: string): void {
  touched.push(name);
  process.env[name] = value;
}

const file = () => join(dataHome(), "credentials.json");

function api(method: string, path: string, body?: unknown, raw?: string): Promise<Response> {
  return fetch(`${booted.base}/api/local${path}`, {
    method,
    headers: { Cookie: booted.cookie, Origin: booted.origin, "Content-Type": "application/json" },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

/** Status and body text, with the body checked for every secret. */
async function answer(response: Response, secrets: readonly string[]) {
  const text = await response.text();
  for (const secret of secrets) expect(text).not.toContain(secret);
  return { status: response.status, body: JSON.parse(text) };
}

function expectNoLogOf(secrets: readonly string[]): void {
  const lines = [...logs.lines(), ...logs.access].join("\n");
  for (const secret of secrets) expect(lines).not.toContain(secret);
}

describe("GET credentials", () => {
  test("names every key with where it comes from, and never a value", async () => {
    writeFileSync(file(), JSON.stringify({ SONIOX_API_KEY: "sk-soniox-saved" }), { mode: 0o600 });
    setEnv("OPENROUTER_API_KEY", "sk-or-from-env");
    const { status, body } = await answer(await api("GET", "/credentials"), [
      "sk-soniox-saved",
      "sk-or-from-env",
    ]);
    expect(status).toBe(200);
    expect(body.SONIOX_API_KEY).toEqual({ set: true, source: "credentials" });
    expect(body.OPENROUTER_API_KEY).toEqual({ set: true, source: "env" });
    expect(body.FISH_API_KEY).toEqual({ set: false, source: null });
    expect(Object.keys(body)).toContain("CF_WAF_BYPASS_TOKEN");
  });
});

describe("PUT credentials", () => {
  test("creates credentials.json 0600 from its first byte, merges, and null removes", async () => {
    const opened = spyOn(fs, "openSync");
    let first: Awaited<ReturnType<typeof answer>>;
    try {
      first = await answer(
        await api("PUT", "/credentials", { SONIOX_API_KEY: " sk-one ", FISH_API_KEY: "sk-two" }),
        ["sk-one", "sk-two"],
      );
      const secret = opened.mock.calls.filter((call) => String(call[0]).includes("credentials"));
      expect(secret.map((call) => [call[1], call[2]])).toEqual([["wx", 0o600]]);
    } finally {
      opened.mockRestore();
    }
    expect(first.status).toBe(200);
    expect(first.body.SONIOX_API_KEY).toEqual({ set: true, source: "credentials" });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
      SONIOX_API_KEY: "sk-one",
      FISH_API_KEY: "sk-two",
    });

    const removed = await answer(await api("PUT", "/credentials", { FISH_API_KEY: null }), [
      "sk-one",
    ]);
    expect(removed.body.FISH_API_KEY).toEqual({ set: false, source: null });
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ SONIOX_API_KEY: "sk-one" });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expectNoLogOf(["sk-one", "sk-two"]);
  });

  test("installs the settings again, so the next call reads the new key", async () => {
    expect(envOptional("SONIOX_API_KEY")).toBeUndefined();
    await api("PUT", "/credentials", { SONIOX_API_KEY: "sk-next-call" });
    expect(envOptional("SONIOX_API_KEY")).toBe("sk-next-call");
  });

  test("flags a key an environment variable overrides", async () => {
    setEnv("SONIOX_API_KEY", "sk-env-wins");
    const { body } = await answer(
      await api("PUT", "/credentials", { SONIOX_API_KEY: "sk-file-loses" }),
      ["sk-env-wins", "sk-file-loses"],
    );
    expect(body.SONIOX_API_KEY).toEqual({ set: true, source: "env" });
  });

  test("refuses unknown names and values that aren't one line, echoing neither", async () => {
    for (const [update, code] of [
      [{ NOT_A_KEY: "sk-wrong-field" }, "unknown-credential"],
      [{ SONIOX_API_KEY: "sk-line\nsk-break" }, "bad-request"],
      [{ SONIOX_API_KEY: "   " }, "bad-request"],
      [{ SONIOX_API_KEY: 42 }, "bad-request"],
    ] as const) {
      const { status, body } = await answer(await api("PUT", "/credentials", update), [
        "sk-wrong-field",
        "NOT_A_KEY",
        "sk-line",
        "sk-break",
      ]);
      expect([status, body.error.code]).toEqual([400, code]);
    }
    expect(fs.existsSync(file())).toBe(false);
  });

  test("a body that isn't JSON is bad-json, echoing none of it", async () => {
    const { status, body } = await answer(
      await api("PUT", "/credentials", undefined, '{"SONIOX_API_KEY": sk-unquoted-leak}'),
      ["sk-unquoted-leak"],
    );
    expect([status, body.error.code]).toEqual([400, "bad-json"]);
    expectNoLogOf(["sk-unquoted-leak"]);
  });

  test("a credentials.json that isn't JSON stays untouched and unechoed", async () => {
    const broken = '{"SONIOX_API_KEY": sk-file-leak}';
    writeFileSync(file(), broken, { mode: 0o600 });
    const put = await answer(await api("PUT", "/credentials", { FISH_API_KEY: "sk-new" }), [
      "sk-file-leak",
    ]);
    expect([put.status, put.body.error.code]).toEqual([409, "conflict"]);
    expect(readFileSync(file(), "utf8")).toBe(broken);
    const listed = await answer(await api("GET", "/credentials"), ["sk-file-leak"]);
    expect(listed.body.SONIOX_API_KEY).toEqual({ set: false, source: null });
    // The settings page reports what the files hold; this file's parser message quotes the key.
    const settings = await answer(await api("GET", "/settings"), ["sk-file-leak"]);
    expect(settings.status).toBe(200);
    expectNoLogOf(["sk-file-leak"]);
    expect(logs.lines()).toContain(
      `WARNING ${file()} is not valid JSON; saving keys waits until it is`,
    );
  });

  test("keeps what else the file holds", async () => {
    writeFileSync(file(), JSON.stringify({ CUSTOM_THING: "kept", SONIOX_API_KEY: "a" }), {
      mode: 0o600,
    });
    await api("PUT", "/credentials", { FISH_API_KEY: "b" });
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
      SONIOX_API_KEY: "a",
      FISH_API_KEY: "b",
      CUSTOM_THING: "kept",
    });
  });

  test("a group-readable file is rewritten private", async () => {
    writeFileSync(file(), JSON.stringify({ SONIOX_API_KEY: "a" }), { mode: 0o644 });
    await api("PUT", "/credentials", { FISH_API_KEY: "b" });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });
});

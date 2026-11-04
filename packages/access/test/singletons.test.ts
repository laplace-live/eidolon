// The only test file that touches the process-wide defaults: bun test shares modules across files,
// so every other file injects its quota, resolver and settings.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ANONYMOUS,
  admitOffer,
  anonOfferQuota,
  audioQualitySettings,
  preflightOffer,
  resolveBearerCaller,
  resolveUserContext,
  sessionBitrateFor,
  userContextResolver,
} from "../src/index.ts";
import { EnvPatch, LogCapture } from "./helpers.ts";

const env = new EnvPatch();
let logs: LogCapture;
beforeEach(() => {
  logs = new LogCapture();
  // Without a base URL the default resolver never reaches the network.
  env.set("WORKERS_BASE_URL", undefined);
});
afterEach(() => {
  logs.restore();
  env.restore();
});

describe("env is read after import", () => {
  test("nothing reads the env at module top level", () => {
    const index = join(import.meta.dir, "../src/index.ts");
    const script = `
      const access = await import(${JSON.stringify(index)});
      Object.assign(process.env, {
        EIDOLON_ANON_RATE_LIMIT_PER_HOUR: "7",
        EIDOLON_ANON_RATE_LIMIT_WINDOW_SEC: "120",
        EIDOLON_OPUS_BITRATE_MEDIUM_BPS: "128000",
        PIPECAT_ALLOWED_ORIGINS: "https://a.example",
        EIDOLON_REAL_IP_HEADER: "x-real-ip",
      });
      const quota = access.anonOfferQuota();
      const audio = access.audioQualitySettings();
      const first = {
        quota: [quota.maxPerWindow, quota.windowSeconds],
        audio: audio.defaultBitrateBps,
        origins: access.corsPolicyFromEnv().allowOrigins,
        ip: access.resolveClientIp(new Headers({ "x-real-ip": "192.0.2.1" }), "10.0.0.1"),
      };
      process.env.EIDOLON_ANON_RATE_LIMIT_PER_HOUR = "9";
      process.env.EIDOLON_OPUS_BITRATE_MEDIUM_BPS = "64000";
      const memoized = access.anonOfferQuota() === quota && access.audioQualitySettings() === audio;
      console.log("@@" + JSON.stringify({ first, memoized }));
    `;
    const run = Bun.spawnSync({
      cmd: [process.execPath, "--no-env-file", "-e", script],
      env: {},
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = run.stdout.toString();
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const line = stdout.split("\n").find((l) => l.startsWith("@@"));
    expect(JSON.parse(line?.slice(2) ?? "null")).toEqual({
      first: {
        quota: [7, 120],
        audio: 128000,
        origins: ["https://a.example"],
        ip: "192.0.2.1",
      },
      memoized: true,
    });
  });
});

describe("process-wide defaults", () => {
  test("admitOffer and preflightOffer share the anonymous offer quota", async () => {
    const quota = anonOfferQuota();
    expect(anonOfferQuota()).toBe(quota);
    const clientIp = "198.51.100.200";
    const admitted = await admitOffer({ bodyText: "{}", clientIp });
    expect(admitted).toMatchObject({
      allowed: true,
      quota: { remaining: quota.maxPerWindow - 1 },
      opusBitrateBps: audioQualitySettings().defaultBitrateBps,
    });
    const peeked = await preflightOffer({ bodyText: "{}", clientIp });
    expect(await peeked.json()).toEqual({
      ok: true,
      anonymous: true,
      remaining: quota.maxPerWindow - 1,
    });
  });

  test("a token the default resolver cannot validate takes the anonymous path", async () => {
    const quota = anonOfferQuota();
    const clientIp = "198.51.100.201";
    const admitted = await admitOffer({
      bodyText: '{"requestData":{"loginSyncToken":"tok"}}',
      clientIp,
    });
    expect(admitted).toMatchObject({ allowed: true, user: ANONYMOUS, token: "tok" });
    expect(quota.peek(clientIp).remaining).toBe(quota.maxPerWindow - 1);
    expect(logs.lines()).toContain(
      "WARNING|[user-context] WORKERS_BASE_URL not set; cannot validate token; treating viewer " +
        "as anonymous",
    );
  });

  test("resolveUserContext goes through one shared resolver", async () => {
    expect(userContextResolver()).toBe(userContextResolver());
    expect(await resolveUserContext(null)).toBe(ANONYMOUS);
    expect(await resolveUserContext("  ")).toBe(ANONYMOUS);
    expect(await resolveUserContext("tok")).toBe(ANONYMOUS);
    expect(logs.lines()).toEqual([
      "INFO|[user-context] No loginSyncToken; viewer is anonymous",
      "INFO|[user-context] No loginSyncToken; viewer is anonymous",
      "WARNING|[user-context] WORKERS_BASE_URL not set; cannot validate token; treating viewer " +
        "as anonymous",
    ]);
  });

  test("resolveBearerCaller defaults to the shared resolver", async () => {
    expect(await resolveBearerCaller("Bearer tok")).toBeNull();
    expect(logs.lines()).toHaveLength(1);
  });

  test("sessionBitrateFor defaults to the process settings", () => {
    expect(audioQualitySettings()).toBe(audioQualitySettings());
    expect(sessionBitrateFor(undefined)).toBe(audioQualitySettings().defaultBitrateBps);
    expect(sessionBitrateFor("lowest")).toBe(audioQualitySettings().presetsBps.lowest);
  });
});

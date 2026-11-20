// Every provider the catalog offers for a call's hearing, voice or realtime role opens a client
// through the dispatcher a call uses; one without would fail only once a call starts.
import "../../config/test/isolated-guard.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataHome, installSettings, resetSettings } from "@eidolon/config";
import { afterAll, beforeAll, test } from "vitest";
import { defaultModel, providerById, providersFor, type RoleId, roleById } from "../src/catalog.ts";
import { openRealtime } from "../src/realtime/index.ts";
import { openSpeech } from "../src/speech/stream/index.ts";
import { openStt } from "../src/stt/index.ts";
import { setEnv } from "./speech/fake.ts";
import { captureLogs, FakeServer } from "./stt/fake.ts";

const OPEN = {
  hearing: () => openStt(new AbortController().signal),
  voice: async () => openSpeech(),
  realtime: () =>
    openRealtime({
      instructions: "",
      tools: [],
      voice: "probe",
      transcription: null,
      signal: new AbortController().signal,
    }),
} satisfies Partial<Record<RoleId, () => Promise<{ close(): Promise<void> }>>>;

const CASES = (Object.keys(OPEN) as (keyof typeof OPEN)[]).flatMap((roleId) =>
  providersFor(roleById(roleId).category).map((provider) => [roleId, provider.id] as const),
);

const credentials = join(dataHome(), "credentials.json");
let server: FakeServer;
let logs: ReturnType<typeof captureLogs>;

beforeAll(async () => {
  logs = captureLogs();
  server = await FakeServer.start();
  // Every account's API base is this server, so no client reaches its provider's own host.
  const accounts = Object.fromEntries(
    [...new Set(CASES.map(([, id]) => id))].map((id) => [
      `${id}-probe`,
      {
        provider: id,
        apiKey: "probe-key",
        baseUrl: server.base,
        options: Object.fromEntries(
          (providerById(id)?.fields ?? []).map((field) => [field.key, "probe"]),
        ),
      },
    ]),
  );
  mkdirSync(dataHome(), { recursive: true });
  writeFileSync(credentials, JSON.stringify({ accounts }), { mode: 0o600 });
  installSettings();
});

afterAll(async () => {
  rmSync(credentials, { force: true });
  resetSettings();
  await server.stop();
  logs.restore();
});

test.each(CASES)("the %s role opens a client for %s", async (roleId, providerId) => {
  const role = roleById(roleId);
  const restore = setEnv({
    [role.providerEnv]: `${providerId}-probe`,
    [role.modelEnv]: defaultModel(role, providerId) ?? "probe",
  });
  try {
    const client = await OPEN[roleId]();
    await client.close();
  } finally {
    restore();
  }
});

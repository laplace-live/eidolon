// The --use-system-ca proof's own parts, which run only on a CI runner, here on plain Node with
// NODE_EXTRA_CA_CERTS standing in for the OS trust store the proof writes there.
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Certs, type Host, makeCerts, run, startHost } from "../scripts/system-ca.ts";

let dir = "";
let certs: Certs;
let host: Host;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "eidolon-system-ca-"));
  certs = makeCerts(dir);
  host = await startHost(certs);
});

afterAll(async () => {
  await host?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** `path` under the host's base, fetched by a Node child: its answer, or 2 when it got none. */
function fetchFrom(path: string, env: NodeJS.ProcessEnv, init: RequestInit = {}) {
  const url = JSON.stringify(`${host.base}${path}`);
  const script = `fetch(${url}, ${JSON.stringify(init)}).then(
    async (r) => { process.stdout.write(await r.text()); process.exit(r.ok ? 0 : 1); },
    (e) => { console.error(String(e?.cause ?? e)); process.exit(2); },
  );`;
  return run(process.execPath, ["-e", script], { env, ms: 30_000 });
}

describe("the throwaway CA's https host", () => {
  test("is refused by a client that doesn't hold the CA, and records the handshake", async () => {
    const from = host.seen.length;
    const { code } = await fetchFrom("/models", process.env);
    expect(code).toBe(2);
    const seen = host.seen.slice(from);
    expect(seen.some((entry) => entry.startsWith("refused"))).toBe(true);
    expect(seen).not.toContain("GET /api/v1/models");
  });

  test("lists one model and embeds, as OpenRouter would, for a client that holds the CA", async () => {
    const env = { ...process.env, NODE_EXTRA_CA_CERTS: certs.caPem };
    const listed = await fetchFrom("/models", env);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.output)).toMatchObject({ data: [{ id: expect.any(String) }] });
    const embedded = await fetchFrom("/embeddings", env, {
      method: "POST",
      body: JSON.stringify({ input: ["one", "two"], dimensions: 3 }),
    });
    const { data } = JSON.parse(embedded.output) as { data: { embedding: number[] }[] };
    expect(data.map((item) => item.embedding)).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
  });

  test("serves a certificate for 127.0.0.1 from a CA its SHA-1 names, as both trust stores do", () => {
    const ca = new X509Certificate(readFileSync(certs.caPem));
    const served = new X509Certificate(certs.cert);
    expect(ca.ca).toBe(true);
    expect(served.ca).toBe(false);
    expect(served.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(served.verify(ca.publicKey)).toBe(true);
    expect(certs.thumbprint).toBe(ca.fingerprint.replaceAll(":", ""));
    expect(new X509Certificate(readFileSync(certs.caDer)).fingerprint).toBe(ca.fingerprint);
  });
});

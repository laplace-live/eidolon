import "../../../packages/config/test/isolated-guard.ts";
import { rmSync } from "node:fs";
import { dataHome } from "@eidolon/config";
import { SubspaceStore } from "@eidolon/subspace";
import { afterEach, describe, expect, test } from "vitest";
import { pairMain } from "../src/pair.ts";
import { subspaceMain } from "../src/subspace.ts";
import { captureIo } from "./helpers.ts";

afterEach(() => {
  rmSync(dataHome(), { recursive: true, force: true });
});

describe("laplace-pair and laplace-subspace", () => {
  test("--help shows CLI usage", async () => {
    const pairHelp = captureIo();
    expect(await pairMain(["--help"], pairHelp.io)).toBe(0);
    expect(pairHelp.stdout()).toContain("usage: laplace-pair");
    expect(pairHelp.stdout()).toContain("--relay");

    const subHelp = captureIo();
    expect(await subspaceMain(["--help"], subHelp.io)).toBe(0);
    expect(subHelp.stdout()).toContain("usage: laplace-subspace");
    expect(subHelp.stdout()).toContain("revoke");
  });

  test("pair validates --port range", async () => {
    const io = captureIo();
    expect(await pairMain(["--port", "70000"], io.io)).toBe(2);
    expect(io.stderr()).toContain("must be between 0 and 65535");
  });

  test("subspace status, grants, and revoke read/modify subspace store cleanly", async () => {
    const store = new SubspaceStore(dataHome());
    store.addGrant({
      id: "grant_cli_1",
      clientName: "CLI Test Phone",
      tokenSha256: "a".repeat(64),
      mode: "direct",
      createdAt: 1_760_000_000_000,
      lastSeenAt: null,
    });

    const statusIo = captureIo();
    expect(await subspaceMain(["status", "--json"], statusIo.io)).toBe(0);
    const status = JSON.parse(statusIo.stdout()) as {
      running: boolean;
      share: { grants: readonly { id: string }[] };
    };
    expect(status.running).toBe(false);
    expect(status.share.grants.map((g) => g.id)).toEqual(["grant_cli_1"]);

    const grantsIo = captureIo();
    expect(await subspaceMain(["grants", "--json"], grantsIo.io)).toBe(0);
    const grants = JSON.parse(grantsIo.stdout()) as { id: string; clientName: string }[];
    expect(grants).toHaveLength(1);
    expect(grants[0]?.clientName).toBe("CLI Test Phone");

    const revokeIo = captureIo();
    expect(await subspaceMain(["revoke", "grant_cli_1", "--json"], revokeIo.io)).toBe(0);
    expect(JSON.parse(revokeIo.stdout())).toEqual({ revoked: "grant_cli_1" });
    expect(store.readGrants()).toEqual([]);

    const missingRevoke = captureIo();
    expect(await subspaceMain(["revoke", "nonexistent"], missingRevoke.io)).toBe(1);
    expect(missingRevoke.stderr()).toContain("Unknown grant id");
  });
});

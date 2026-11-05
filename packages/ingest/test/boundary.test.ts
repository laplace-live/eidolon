// docker.yml skips the bot image build for packages/ingest changes, which holds only while nothing
// the image loads imports @eidolon/ingest. Biome's noRestrictedImports is what enforces that.
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PROJECT_ROOT } from "@eidolon/config";

test("Biome refuses @eidolon/ingest everywhere the bot image loads code, and only there", async () => {
  const refused: Record<string, boolean> = {
    "apps/bot/src/x.ts": true,
    "packages/context/src/x.ts": true,
    "packages/runtime/src/x.ts": true,
    "packages/tools/src/x.ts": true,
    "packages/retrieval/test/x.ts": true,
    "apps/cli/src/x.ts": false,
    "packages/ingest/src/x.ts": false,
    "packages/ingest/test/x.ts": false,
  };
  const dir = mkdtempSync(join(tmpdir(), "ingest-boundary-"));
  try {
    copyFileSync(join(PROJECT_ROOT, "biome.json"), join(dir, "biome.json"));
    const linted = await Promise.all(
      Object.keys(refused).map(async (file) => {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), 'import "@eidolon/ingest";\n');
        const lint = Bun.spawn([join(PROJECT_ROOT, "node_modules/.bin/biome"), "lint", file], {
          cwd: dir,
          stdout: "ignore",
          stderr: "ignore",
        });
        return [file, (await lint.exited) !== 0] as const;
      }),
    );
    expect(Object.fromEntries(linted)).toEqual(refused);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

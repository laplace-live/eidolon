// Production never has the assistant, and docker.yml skips the bot image build for
// packages/assistant changes: both hold only while nothing the image loads imports
// @eidolon/assistant. Biome's noRestrictedImports is what enforces that.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PROJECT_ROOT, spawnProcess } from "@eidolon/config";
import { expect, test } from "vitest";

test("Biome refuses @eidolon/assistant everywhere the bot image loads code, and only there", async () => {
  const refused: Record<string, boolean> = {
    "apps/bot/src/x.ts": true,
    "packages/engine/src/x.ts": true,
    "packages/runtime/src/x.ts": true,
    "packages/tools/src/x.ts": true,
    "packages/retrieval/test/x.ts": true,
    "apps/bot/src/local/x.ts": false,
    "apps/cli/src/x.ts": false,
    "packages/assistant/src/x.ts": false,
    "packages/assistant/test/x.ts": false,
  };
  const dir = mkdtempSync(join(tmpdir(), "assistant-boundary-"));
  try {
    copyFileSync(join(PROJECT_ROOT, "biome.json"), join(dir, "biome.json"));
    const linted = await Promise.all(
      Object.keys(refused).map(async (file) => {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), 'import "@eidolon/assistant";\n');
        const lint = spawnProcess([join(PROJECT_ROOT, "node_modules/.bin/biome"), "lint", file], {
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

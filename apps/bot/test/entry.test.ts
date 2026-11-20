// main.ts is never imported by tests (it boots the bot), so its import order is checked from source.
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");
/**
 * A static import's or re-export's specifier, or a dynamic import's, in source order;
 * `import type` evaluates nothing.
 */
const IMPORT =
  /^(?:import|export)\s+(?!type\s)(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/gm;

async function importsOf(file: string): Promise<string[]> {
  const source = await readFile(join(SRC, file), "utf8");
  return [...source.matchAll(IMPORT)].map((match) => (match[1] ?? match[2]) as string);
}

describe("entry point", () => {
  test("main.ts imports load-env.ts before anything else is evaluated", async () => {
    expect((await importsOf("main.ts"))[0]).toBe("./load-env.ts");
  });

  test("load-env.ts evaluates nothing but @eidolon/config before applying .env", async () => {
    expect(await importsOf("load-env.ts")).toEqual(["@eidolon/config"]);
  });

  test("no apps/bot module reads process.env itself", async () => {
    const files = readdirSync(SRC).filter((name) => name.endsWith(".ts"));
    expect(files).toContain("main.ts");
    for (const file of files) {
      expect(`${file}: ${(await readFile(join(SRC, file), "utf8")).includes("process.env")}`).toBe(
        `${file}: false`,
      );
    }
  });
});

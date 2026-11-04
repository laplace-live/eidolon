// main.ts is never imported by tests (it boots the bot), so its import order is checked from source.
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const transpiler = new Bun.Transpiler({ loader: "ts" });

async function importsOf(file: string): Promise<string[]> {
  return transpiler.scanImports(await Bun.file(join(SRC, file)).text()).map(({ path }) => path);
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
      expect(`${file}: ${(await Bun.file(join(SRC, file)).text()).includes("process.env")}`).toBe(
        `${file}: false`,
      );
    }
  });
});

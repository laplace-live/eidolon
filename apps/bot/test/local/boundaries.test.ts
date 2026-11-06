// What keeps the local app out of production: main.ts reaches none of it, nothing outside
// apps/bot/src/local names it, apps/bot gains no dependency, and the SPA's leaves import nothing.
import "../../../../packages/config/test/isolated-guard.ts";
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  ERROR_CODES,
  JOB_COMMANDS,
  LOCAL_ROUTES,
  type LocalApi,
  type LocalRoute,
} from "../../src/local/api.ts";
import { localRouteModules } from "../../src/local/extension.ts";
import type { LocalApp } from "../../src/local/router.ts";
import { sessionRoutes } from "../../src/local/session.ts";
import { LocalToken } from "../../src/local/token.ts";

const ROOT = resolve(import.meta.dir, "../../../..");
const BOT_SRC = join(ROOT, "apps", "bot", "src");
const LOCAL_SRC = join(BOT_SRC, "local");
const transpiler = new Bun.Transpiler({ loader: "ts" });

interface Workspace {
  readonly dir: string;
  readonly exports: Readonly<Record<string, string>>;
}

function workspaces(): Map<string, Workspace> {
  const found = new Map<string, Workspace>();
  for (const group of ["apps", "packages"]) {
    for (const name of readdirSync(join(ROOT, group))) {
      const manifest = join(ROOT, group, name, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
        name: string;
        exports?: Record<string, string>;
      };
      found.set(pkg.name, { dir: join(ROOT, group, name), exports: pkg.exports ?? {} });
    }
  }
  return found;
}

function scan(file: string): string[] {
  return transpiler
    .scanImports(readFileSync(file, "utf8"))
    .filter(({ kind }) => kind !== "import-rule" && kind !== "url-token")
    .map(({ path }) => path);
}

/** Every workspace file main.ts loads, and every specifier it meets on the way. */
function importGraph(entry: string): { files: Set<string>; specifiers: Set<string> } {
  const packages = workspaces();
  const files = new Set<string>();
  const specifiers = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of scan(file)) {
      specifiers.add(specifier);
      let target: string | null = null;
      if (specifier.startsWith(".")) {
        target = resolve(dirname(file), specifier);
      } else {
        const parts = specifier.split("/");
        const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
        const workspace = packages.get(name);
        const sub = `.${specifier.slice(name.length)}` || ".";
        const entryPath = workspace?.exports[sub === "." ? "." : sub];
        if (workspace && entryPath) target = join(workspace.dir, entryPath);
      }
      if (target !== null && existsSync(target) && statSync(target).isFile()) queue.push(target);
    }
  }
  return { files, specifiers };
}

function sources(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(dir, name));
}

describe("production never loads the local app", () => {
  test("main.ts reaches nothing under local/, @eidolon/ingest, @eidolon/cli or apps/web", () => {
    const { files, specifiers } = importGraph(join(BOT_SRC, "main.ts"));
    const reached = [...files].map((file) => relative(ROOT, file));
    expect(reached).toContain("apps/bot/src/server.ts");
    expect(reached).toContain("packages/runtime/src/index.ts");
    expect(reached).toContain("packages/memory/src/admin.ts");
    const forbidden = reached.filter(
      (file) =>
        file.startsWith("apps/bot/src/local/") ||
        file.startsWith("apps/web/") ||
        file.startsWith("apps/cli/") ||
        file.startsWith("packages/ingest/"),
    );
    expect(forbidden).toEqual([]);
    expect(
      [...specifiers].filter(
        (s) => /^@eidolon\/(ingest|cli)(\/|$)/.test(s) || s.includes("/local"),
      ),
    ).toEqual([]);
  });

  test("no file outside local/ names it", () => {
    for (const file of sources(BOT_SRC).filter((f) => !f.startsWith(`${LOCAL_SRC}/`))) {
      const text = readFileSync(file, "utf8");
      expect([relative(ROOT, file), text.includes("./local")]).toEqual([
        relative(ROOT, file),
        false,
      ]);
      const named = scan(file).filter((specifier) => /(^|\/)local(\/|$)/.test(specifier));
      expect([relative(ROOT, file), named]).toEqual([relative(ROOT, file), []]);
    }
  });

  test("apps/bot's external dependencies are unchanged", () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "apps", "bot", "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
    };
    const external = Object.entries(manifest.dependencies).filter(
      ([, version]) => !version.startsWith("workspace:"),
    );
    expect(Object.fromEntries(external)).toEqual({
      "@modelcontextprotocol/sdk": "1.32.1",
      zod: "4.6.7",
    });
  });
});

describe("the local entries", () => {
  test("load .env first, as main.ts does", () => {
    for (const entry of ["main.ts", "server.ts"]) {
      expect([entry, scan(join(LOCAL_SRC, entry))[0]]).toEqual([entry, "../load-env.ts"]);
    }
  });

  test("read no env themselves: settings go through @eidolon/config", () => {
    for (const file of sources(LOCAL_SRC)) {
      const text = readFileSync(file, "utf8");
      expect([relative(ROOT, file), text.includes("process.env")]).toEqual([
        relative(ROOT, file),
        false,
      ]);
    }
  });

  test("hash no key: only token.ts digests, to compare its random secret in constant time", () => {
    const hashing = sources(LOCAL_SRC)
      .filter((file) => /\b(createHash|CryptoHasher)\b/.test(readFileSync(file, "utf8")))
      .map((file) => relative(LOCAL_SRC, file));
    expect(hashing).toEqual(["token.ts"]);
  });
});

describe("the SPA's leaves", () => {
  test("import nothing, so the browser build sees no Bun or Node", () => {
    for (const leaf of [
      "apps/bot/src/local/api.ts",
      "packages/ingest/src/progress.ts",
      "apps/cli/src/job.ts",
    ]) {
      const text = readFileSync(join(ROOT, leaf), "utf8");
      expect([leaf, scan(join(ROOT, leaf)), /^\s*import\s/m.test(text)]).toEqual([leaf, [], false]);
    }
  });
});

describe("the route table", () => {
  test("is exactly api.ts's LOCAL_ROUTES, each once", () => {
    const app: LocalApp = {
      port: () => 7860,
      activeCalls: () => 0,
      restart: () => {},
      onStop: () => {},
      memoryAdmin: () => null,
    };
    const registered = [
      ...sessionRoutes(app, new LocalToken("s".repeat(43))),
      ...localRouteModules(app),
    ].map((spec) => spec.route);
    expect(registered.toSorted()).toEqual([...LOCAL_ROUTES].toSorted());
    expect(new Set(registered).size).toBe(registered.length);
  });

  test("LOCAL_ROUTES lists every endpoint LocalApi types", () => {
    type Unlisted = Exclude<keyof LocalApi, LocalRoute>;
    const complete: [Unlisted] extends [never] ? true : Unlisted = true;
    expect(complete).toBe(true);
  });

  test("codes are unique", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(new Set(JOB_COMMANDS).size).toBe(JOB_COMMANDS.length);
    expect(new Set(LOCAL_ROUTES).size).toBe(LOCAL_ROUTES.length);
  });
});

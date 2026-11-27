// Ensures apps/relay/Dockerfile and .github/workflows/relay.yml stay in sync with every workspace
// manifest (--frozen-lockfile) and transitive @eidolon/* workspace dependency of @eidolon/relay.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");

interface WorkspaceManifest {
  readonly dir: string;
  readonly manifestPath: string;
  readonly dependencies: Readonly<Record<string, string>>;
}

function readWorkspaces(): Map<string, WorkspaceManifest> {
  const found = new Map<string, WorkspaceManifest>();
  for (const group of ["apps", "packages"] as const) {
    const groupDir = join(ROOT, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relDir = `${group}/${entry.name}`;
      const relManifest = `${relDir}/package.json`;
      const absManifest = join(ROOT, relManifest);
      if (!existsSync(absManifest)) continue;
      const parsed = JSON.parse(readFileSync(absManifest, "utf8")) as {
        readonly name: string;
        readonly dependencies?: Readonly<Record<string, string>>;
      };
      found.set(parsed.name, {
        dir: relDir,
        manifestPath: relManifest,
        dependencies: parsed.dependencies ?? {},
      });
    }
  }
  return found;
}

function workflowPathList(
  yml: string,
  event: "push" | "pull_request",
  key: "paths" | "paths-ignore",
): string[] {
  let inOn = false;
  let inEvent = false;
  let inKey = false;
  const items: string[] = [];
  for (const line of yml.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\S/.test(line) && !line.startsWith("#")) {
      inOn = line === "on:";
      inEvent = false;
      inKey = false;
      continue;
    }
    if (!inOn) continue;
    if (/^  [a-z_]+:/.test(line)) {
      inEvent = line.trim() === `${event}:`;
      inKey = false;
      continue;
    }
    if (!inEvent) continue;
    if (/^    [a-z-]+:/.test(line)) {
      inKey = line.trim() === `${key}:`;
      continue;
    }
    if (!inKey) continue;
    const item = /^      - ["']?([^"'\n#]+?)["']?(?:\s+#.*)?$/.exec(line);
    if (item?.[1]) items.push(item[1]);
  }
  return items;
}

describe("apps/relay Docker image and CI workflow", () => {
  test("copies every workspace manifest needed by pnpm --frozen-lockfile and runtime dependencies", () => {
    const workspaces = readWorkspaces();
    const dockerfile = readFileSync(join(ROOT, "apps/relay/Dockerfile"), "utf8");
    const dockerignore = readFileSync(join(ROOT, "apps/relay/Dockerfile.dockerignore"), "utf8");
    const relayYml = readFileSync(join(ROOT, ".github/workflows/relay.yml"), "utf8");
    const dockerYml = readFileSync(join(ROOT, ".github/workflows/docker.yml"), "utf8");
    const tsYml = readFileSync(join(ROOT, ".github/workflows/ts.yml"), "utf8");

    for (const ws of workspaces.values()) {
      expect(dockerfile).toContain(`COPY ${ws.manifestPath} ${dirname(ws.manifestPath)}/`);
      if (ws.dir !== "apps/relay" && ws.dir.startsWith("apps/")) {
        expect(dockerignore).toContain(`!${ws.manifestPath}`);
      }
    }

    const reached = new Set<string>();
    const queue = ["@eidolon/relay"];
    while (queue.length > 0) {
      const name = queue.pop()!;
      const ws = workspaces.get(name);
      expect(ws, `Missing workspace manifest for ${name}`).toBeDefined();
      for (const [dep, version] of Object.entries(ws!.dependencies)) {
        if (!version.startsWith("workspace:") || reached.has(dep)) continue;
        reached.add(dep);
        queue.push(dep);
      }
    }

    const relayPushPaths = workflowPathList(relayYml, "push", "paths");
    const relayPrPaths = workflowPathList(relayYml, "pull_request", "paths");
    for (const dep of reached) {
      const ws = workspaces.get(dep)!;
      expect(dockerfile).toContain(`COPY ${ws.dir} ./${ws.dir}`);
      expect(relayPushPaths).toContain(`${ws.dir}/**`);
      expect(relayPrPaths).toContain(`${ws.dir}/**`);
    }

    expect(relayYml).toContain("ghcr.io/laplace-live/eidolon-relay");
    expect(relayYml).toContain("*.dockerfile=apps/relay/Dockerfile");

    const dockerPushIgnored = workflowPathList(dockerYml, "push", "paths-ignore");
    const dockerPrIgnored = workflowPathList(dockerYml, "pull_request", "paths-ignore");
    for (const ignored of [
      "apps/relay/**",
      "packages/subspace/**",
      ".github/workflows/relay.yml",
    ]) {
      expect(dockerPushIgnored).toContain(ignored);
      expect(dockerPrIgnored).toContain(ignored);
    }

    const tsPushPaths = workflowPathList(tsYml, "push", "paths");
    const tsPrPaths = workflowPathList(tsYml, "pull_request", "paths");
    for (const watchedByTs of [".github/workflows/docker.yml", ".github/workflows/relay.yml"]) {
      expect(tsPushPaths).toContain(watchedByTs);
      expect(tsPrPaths).toContain(watchedByTs);
    }
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AGENTS_BUDGET, README_BUDGET, verifyDocs } from "./verify-docs.ts";

const ROOT = join(import.meta.dirname, "..");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function writeFixture(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "eidolon-verify-docs-"));
  tempDirs.push(root);
  writeFixture(
    root,
    "package.json",
    JSON.stringify({
      name: "fixture",
      scripts: { test: "vitest run", "doc-check": "node scripts/verify-docs.ts" },
    }),
  );
  writeFixture(
    root,
    "apps/desktop/package.json",
    JSON.stringify({ name: "fixture-desktop", devDependencies: { electron: "45.4.1" } }),
  );
  writeFixture(root, "README.md", "# Fixture\n\n<!-- Electron 45 floors -->\n\n- macOS 13+\n");
  writeFixture(root, "docs/guide.md", "# Guide\n\n## Details\n\nAll good.\n");
  writeFixture(
    root,
    "AGENTS.md",
    [
      "# AGENTS.md",
      "",
      "## Index",
      "",
      "- guide → [guide.md](docs/guide.md#details)",
      "- desktop: `apps/desktop`, `pnpm test`, `pnpm doc-check`",
      "",
    ].join("\n"),
  );
  writeFixture(
    root,
    ".changeset/good-fix.md",
    '---\n"fixture-desktop": patch\n---\n\nfix: Handle empty input safely\n',
  );
  return root;
}

describe("verifyDocs", () => {
  test("passes on the repository itself", () => {
    const result = verifyDocs(ROOT);
    expect(result.failures).toEqual([]);
    expect(result.agentsBytes).toBeLessThanOrEqual(AGENTS_BUDGET);
    expect(result.readmeBytes).toBeLessThanOrEqual(README_BUDGET);
  });

  test("passes on a minimal valid fixture", () => {
    const root = makeFixtureRepo();
    const result = verifyDocs(root);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("ignores links inside longer fenced code blocks containing inner fences", () => {
    const root = makeFixtureRepo();
    writeFixture(
      root,
      "docs/guide.md",
      [
        "# Guide",
        "",
        "## Details",
        "",
        "````markdown",
        "```bash",
        "echo hi",
        "```",
        "See [missing](docs/nope.md) inside the outer fence.",
        "````",
        "",
      ].join("\n"),
    );
    expect(verifyDocs(root).failures).toEqual([]);
  });

  test("flags AGENTS.md over budget with its fattest sections", () => {
    const root = makeFixtureRepo();
    writeFixture(
      root,
      "AGENTS.md",
      `# AGENTS.md\n\n## Index\n\n- [guide.md](docs/guide.md) apps/desktop test doc-check\n\n## Bloated\n\n${"x".repeat(AGENTS_BUDGET)}\n`,
    );
    const { failures } = verifyDocs(root);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("AGENTS.md is");
    expect(failures[0]).toContain("Bloated");
  });

  test("flags README.md over budget", () => {
    const root = makeFixtureRepo();
    writeFixture(
      root,
      "README.md",
      `# Fixture\n\n<!-- Electron 45 floors -->\n\n${"y".repeat(README_BUDGET)}\n`,
    );
    const { failures } = verifyDocs(root);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("README.md is");
  });

  test("flags broken file links and heading anchors", () => {
    const root = makeFixtureRepo();
    writeFixture(
      root,
      "docs/guide.md",
      "# Guide\n\n## Details\n\n[missing](docs/nope.md) [bad anchor](#missing-heading)\n",
    );
    const { failures } = verifyDocs(root);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain("link target does not exist");
    expect(failures[1]).toContain("no such heading");
  });

  test("flags orphan docs (even when named in prose), overlapping script names, and overlapping package names", () => {
    const root = makeFixtureRepo();
    writeFixture(root, "docs/orphan.md", "# Orphan\n");
    writeFixture(
      root,
      "AGENTS.md",
      [
        "# AGENTS.md",
        "",
        "## Index",
        "",
        "- guide → [guide.md](docs/guide.md#details)",
        "- mentions docs/orphan.md without linking it",
        "- desktop: `apps/desktop`, `pnpm test`, `pnpm doc-check`",
        "- substring neighbor: `packages/secrets`",
        "",
      ].join("\n"),
    );
    writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "fixture",
        scripts: {
          test: "vitest run",
          "doc-check": "node scripts/verify-docs.ts",
          check: "echo 1",
        },
      }),
    );
    writeFixture(root, "packages/secret/package.json", JSON.stringify({ name: "@fixture/secret" }));
    const { failures } = verifyDocs(root);
    expect(failures).toEqual([
      'docs/orphan.md is not linked from AGENTS.md — add a "Where to look" entry',
      'root script "check" is undocumented in AGENTS.md or docs/',
      "workspace package packages/secret (@fixture/secret) is undocumented in AGENTS.md or docs/",
    ]);
  });

  test("flags invalid changeset summaries including disallowed prefixes", () => {
    const root = makeFixtureRepo();
    writeFixture(
      root,
      ".changeset/disallowed.md",
      '---\n"a": patch\n---\n\ndocs: Explain the CLI\n',
    );
    writeFixture(root, ".changeset/lower.md", '---\n"a": patch\n---\n\nfix: lowercase start\n');
    writeFixture(root, ".changeset/multi.md", '---\n"a": patch\n---\n\nfeat: One\nSecond line\n');
    writeFixture(root, ".changeset/no-prefix.md", '---\n"a": patch\n---\n\nMissing prefix\n');
    const { failures } = verifyDocs(root);
    expect(failures).toHaveLength(4);
    expect(failures[0]).toContain("needs a kind prefix");
    expect(failures[1]).toContain("starts lowercase");
    expect(failures[2]).toContain("summary is 2 lines");
    expect(failures[3]).toContain("needs a kind prefix");
  });

  test("flags Electron floor mismatch in README.md", () => {
    const root = makeFixtureRepo();
    writeFixture(
      root,
      "apps/desktop/package.json",
      JSON.stringify({ name: "fixture-desktop", devDependencies: { electron: "46.0.0" } }),
    );
    const { failures } = verifyDocs(root);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("Electron 45's system requirements");
    expect(failures[0]).toContain("Electron 46");
  });
});

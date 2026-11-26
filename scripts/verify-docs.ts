#!/usr/bin/env node
// Keeps AGENTS.md, README.md, docs/, and .changeset/ honest: budget creep, broken links or
// heading anchors, orphan docs, undocumented scripts or workspace packages, changesets that stopped
// reading as release notes, and README system requirements outliving an Electron major bump.
// CI runs this directly with Node 24 (no install), so it imports only node:* and scripts/changelog.ts.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { classify } from "./changelog.ts";

/**
 * Byte ceiling for AGENTS.md. A smoke alarm, not a quota: AGENTS.md is a router (rules + the
 * "Where to look" list), so a growing project adds entries — not prose. If this fires, move prose
 * into docs/ rather than raising the number.
 */
export const AGENTS_BUDGET = 15_000;

/** Byte ceiling for the root README.md. Deep guides belong in docs/. */
export const README_BUDGET = 1_000;

/** Soft ceiling on a changeset summary. The documented rule is ~80; this warns on prose. */
export const SUMMARY_WARN_CHARS = 100;

const ALLOWED_CHANGESET_PREFIX = /^(?:feat|fix|perf|chore)(?:\([^)]*\))?!?:[ \t]+/;

export interface VerifyDocsResult {
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
  readonly agentsBytes: number;
  readonly readmeBytes: number;
  readonly docCount: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Removes fenced code blocks per CommonMark fence char/length rules so literal examples never count as headings. */
function stripFencedCode(markdown: string): string {
  const out: string[] = [];
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;
  for (const line of markdown.split("\n")) {
    if (fenceChar === null) {
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (open?.[1]) {
        const mark = open[1];
        const rest = open[2] ?? "";
        if (mark[0] === "`" && rest.includes("`")) {
          out.push(line);
        } else {
          fenceChar = mark[0] as "`" | "~";
          fenceLen = mark.length;
        }
        continue;
      }
      out.push(line);
    } else {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close?.[1]?.[0] === fenceChar && close[1].length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
    }
  }
  return out.join("\n");
}

/** Removes fenced code blocks and inline code spans so literal snippets never count as links. */
function stripCode(markdown: string): string {
  return stripFencedCode(markdown).replace(/`[^`\n]+`/g, "");
}

/** GitHub-style heading anchor slug generator scoped to a single markdown file. */
function collectAnchors(markdown: string): Set<string> {
  const counts = new Map<string, number>();
  const anchors = new Set<string>();
  const stripped = stripFencedCode(markdown);
  for (const match of stripped.matchAll(/^#{1,6} (.+)$/gm)) {
    const base = (match[1] ?? "")
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff\- ]/g, "")
      .trim()
      .replace(/ /g, "-");
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return anchors;
}

function trackedWorkspaceManifests(root: string): string[] {
  if (existsSync(join(root, ".git"))) {
    return execFileSync(
      "git",
      ["ls-files", ":(glob)apps/*/package.json", ":(glob)packages/*/package.json"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
  }
  const manifests: string[] = [];
  for (const group of ["apps", "packages"]) {
    const dir = join(root, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = `${group}/${entry.name}/package.json`;
      if (existsSync(join(root, manifest))) manifests.push(manifest);
    }
  }
  return manifests.sort();
}

/** Verifies docs, budgets, links, script/package coverage, changesets, and Electron floor markers. */
export function verifyDocs(root: string): VerifyDocsResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const fail = (msg: string) => failures.push(msg);
  const warn = (msg: string) => warnings.push(msg);
  const read = (rel: string) => readFileSync(join(root, rel), "utf8");

  const docsDir = join(root, "docs");
  const docsEntries = existsSync(docsDir)
    ? readdirSync(docsDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => `docs/${f}`)
    : [];
  const docFiles = ["AGENTS.md", "README.md", ...docsEntries];
  const agentCorpus = ["AGENTS.md", ...docsEntries].map(read).join("\n");

  // 1. Size budgets. Report the fattest sections of AGENTS.md so overflow points to what to extract.
  const agentsMd = read("AGENTS.md");
  const agentsBytes = Buffer.byteLength(agentsMd);
  if (agentsBytes > AGENTS_BUDGET) {
    const sections: { heading: string; bytes: number }[] = [];
    for (const line of agentsMd.split("\n")) {
      const heading = /^#{2,3} (.+)/.exec(line);
      if (heading?.[1]) sections.push({ heading: heading[1], bytes: 0 });
      const current = sections[sections.length - 1];
      if (current) current.bytes += Buffer.byteLength(line) + 1;
    }
    const fattest = sections
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 3)
      .map((s) => `${String(s.bytes).padStart(6)} B  ${s.heading}`)
      .join("\n     ");
    fail(
      `AGENTS.md is ${agentsBytes} B, over the ${AGENTS_BUDGET} B budget. Move prose into ` +
        `docs/ and leave a "Where to look" entry behind. Fattest sections:\n     ${fattest}`,
    );
  }

  const readmeMd = read("README.md");
  const readmeBytes = Buffer.byteLength(readmeMd);
  if (readmeBytes > README_BUDGET) {
    fail(
      `README.md is ${readmeBytes} B, over the ${README_BUDGET} B budget. Move detail into docs/.`,
    );
  }

  // 2. Relative links and intra-file heading anchors resolve.
  const anchorCache = new Map<string, Set<string>>();
  const anchorsFor = (absPath: string, body: string) => {
    let anchors = anchorCache.get(absPath);
    if (!anchors) {
      anchors = collectAnchors(body);
      anchorCache.set(absPath, anchors);
    }
    return anchors;
  };
  const linkedFromAgents = new Set<string>();

  for (const file of docFiles) {
    const body = read(file);
    const cleaned = stripCode(body);
    for (const [, target] of cleaned.matchAll(
      /\]\((?!https?:|mailto:)([^)\s]+)(?:\s+"[^"]*")?\)/g,
    )) {
      if (!target) continue;
      if (target.startsWith("#")) {
        const anchor = target.slice(1);
        const abs = resolve(root, file);
        if (!anchorsFor(abs, body).has(anchor)) {
          fail(`${file}: no such heading → #${anchor}`);
        }
        continue;
      }
      const [pathPart = "", anchor] = target.split("#", 2);
      const abs = resolve(root, dirname(file), pathPart);
      if (file === "AGENTS.md") linkedFromAgents.add(relative(root, abs).replace(/\\/g, "/"));
      let targetBody: string;
      try {
        targetBody = readFileSync(abs, "utf8");
      } catch {
        let isDir = false;
        try {
          isDir = statSync(abs).isDirectory();
        } catch {
          isDir = false;
        }
        if (!isDir) fail(`${file}: link target does not exist → ${target}`);
        continue;
      }
      if (!anchor) continue;
      if (!anchorsFor(abs, targetBody).has(anchor)) {
        fail(`${file}: no such heading → ${relative(root, abs)}#${anchor}`);
      }
    }
  }

  // 3. Every docs/*.md page is linked from AGENTS.md.
  for (const doc of docsEntries) {
    if (!linkedFromAgents.has(doc)) {
      fail(`${doc} is not linked from AGENTS.md — add a "Where to look" entry`);
    }
  }

  // 4. Every root script is documented by exact token in AGENTS.md or docs/.
  const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
  for (const name of Object.keys(pkg.scripts ?? {})) {
    if (!new RegExp(`(?<![\\w:-])${escapeRegExp(name)}(?![\\w:-])`).test(agentCorpus)) {
      fail(`root script "${name}" is undocumented in AGENTS.md or docs/`);
    }
  }

  // 5. Every tracked workspace package is documented by boundary-aware path or name in AGENTS.md or docs/.
  for (const manifest of trackedWorkspaceManifests(root)) {
    const dir = dirname(manifest);
    const { name } = JSON.parse(read(manifest)) as { name: string };
    const matchesDir = new RegExp(`(?<![\\w./-])${escapeRegExp(dir)}(?![\\w.-])`).test(agentCorpus);
    const matchesName = new RegExp(`(?<![\\w@/-])${escapeRegExp(name)}(?![\\w-])`).test(
      agentCorpus,
    );
    if (!matchesDir && !matchesName) {
      fail(`workspace package ${dir} (${name}) is undocumented in AGENTS.md or docs/`);
    }
  }

  // 6. Changesets still read as single-sentence release notes with one of the four documented prefixes.
  const changesetDir = join(root, ".changeset");
  if (existsSync(changesetDir)) {
    for (const name of readdirSync(changesetDir)
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .sort()) {
      const rel = `.changeset/${name}`;
      const parts = read(rel).split(/^---[ \t]*$/m);
      if (parts.length < 3) {
        fail(`${rel}: no changeset frontmatter`);
        continue;
      }
      const lines = parts
        .slice(2)
        .join("---")
        .split("\n")
        .filter((l) => l.trim());
      if (lines.length === 0) {
        fail(`${rel}: empty summary`);
        continue;
      }
      if (lines.length > 1) {
        fail(
          `${rel}: summary is ${lines.length} lines — it must be one plain sentence naming the ` +
            "change (docs/releasing.md#changesets)",
        );
        continue;
      }
      const summary = lines[0] ?? "";
      const { text } = classify(summary);
      if (!ALLOWED_CHANGESET_PREFIX.test(summary)) {
        fail(
          `${rel}: summary needs a kind prefix (feat:/fix:/perf:/chore:) — see docs/releasing.md#changesets`,
        );
      }
      if (/^[a-z]/.test(text)) {
        fail(
          `${rel}: summary starts lowercase ("${text.split(" ")[0]} …") — capitalize it after the prefix, or backtick an identifier`,
        );
      }
      if (summary.length > SUMMARY_WARN_CHARS) {
        warn(`${rel}: summary is ${summary.length} chars — aim for one sentence under ~80`);
      }
    }
  }

  // 7. README.md system requirements marker matches apps/desktop's pinned Electron major.
  const desktopManifestPath = join(root, "apps/desktop/package.json");
  if (existsSync(desktopManifestPath)) {
    const desktopPkg = JSON.parse(read("apps/desktop/package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const electronRange =
      desktopPkg.devDependencies?.electron ?? desktopPkg.dependencies?.electron ?? "";
    const pinned = /^\D*(\d+)\./.exec(electronRange)?.[1];
    const checked = /<!-- Electron (\d+) floors/.exec(readmeMd)?.[1];
    if (!pinned || !checked) {
      fail(
        "gate 7 found no Electron major in apps/desktop/package.json or README.md — check the marker format",
      );
    } else if (pinned !== checked) {
      fail(
        `README.md lists Electron ${checked}'s system requirements, but apps/desktop pins Electron ${pinned} — ` +
          "re-derive them (docs/desktop.md#bumping-electron), then update README.md's marker",
      );
    }
  }

  return {
    failures,
    warnings,
    agentsBytes,
    readmeBytes,
    docCount: docFiles.length,
  };
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "..");
  const result = verifyDocs(root);
  if (result.warnings.length > 0) {
    console.warn(`doc-check: ${result.warnings.length} warning(s)\n`);
    for (const w of result.warnings) console.warn(`  ! ${w}`);
    console.warn("");
  }
  if (result.failures.length > 0) {
    console.error(`doc-check: ${result.failures.length} problem(s)\n`);
    for (const f of result.failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(
    `doc-check: ok (AGENTS.md ${result.agentsBytes}/${AGENTS_BUDGET} B, README.md ${result.readmeBytes}/${README_BUDGET} B, ${result.docCount} files)`,
  );
}

// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/src/core/skills.ts@ac78a60 and packages/coding-agent/src/utils/frontmatter.ts@ac78a60
//
// The Agent Skills a task may load (agentskills.io): the owner's, in the data home's skills folder,
// and the task folder's own, in its .agents/skills. The worker's prompt lists each one's name and
// description; the skill tool reads the rest.
import type { Dirent } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isPlainObject } from "@eidolon/config";
import { estimateTokens } from "@eidolon/engine";
import { fold } from "./policy.ts";
import { formatSize, sliceHead } from "./tools/truncate.ts";

export const SKILL_FILE = "SKILL.md";

// agentskills.io's limits on a skill's name and description, and on a scan: a SKILL.md at most
// 4 folders below where it starts, and 2,000 folders.
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_DEPTH = 4;
const MAX_FOLDERS = 2000;
// OpenClaw's caps: 256 KB for a SKILL.md, and for a prompt's catalog 150 skills and 18,000
// characters, which is 4,500 tokens of English in the engine's estimate; it counts each CJK
// character a token.
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_LISTED = 150;
const MAX_CATALOG_TOKENS = 4500;

export type SkillSource = "owner" | "folder";

export interface Skill {
  readonly name: string;
  /** One line, whitespace collapsed, at most 1,024 characters. */
  readonly description: string;
  readonly source: SkillSource;
  /** Its folder, as its realpath. */
  readonly dir: string;
}

export interface SkillProblem {
  readonly path: string;
  readonly message: string;
  /** Left out, rather than listed with a fault. */
  readonly skipped: boolean;
}

export interface SkillCatalog {
  /** The ones the worker's prompt lists, in its order: the owner's by name, then the folder's. */
  readonly skills: readonly Skill[];
  /** Found, but past 150 skills or 4,500 tokens. */
  readonly unlisted: number;
  readonly problems: readonly SkillProblem[];
}

export function skillsDir(dataHome: string): string {
  return join(dataHome, "skills");
}

/** Whether `path` is `root` or lies under it, matching names as the disk does. */
export function isInside(path: string, root: string): boolean {
  const rel = relative(fold(root), fold(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unreadable(path: string, error: unknown): SkillProblem {
  return { path, message: `can't be read: ${errorText(error)}`, skipped: true };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validateName(name: string): string[] {
  const errors: string[] = [];
  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    errors.push("name must not start or end with a hyphen");
  }
  if (name.includes("--")) errors.push("name must not contain consecutive hyphens");
  return errors;
}

interface Frontmatter {
  readonly fields: Readonly<Record<string, unknown>>;
  /** Why the YAML didn't parse, when its single-line fields were read instead. */
  readonly yamlError: string | null;
}

/** The fields between a leading `---` and the next, after a byte order mark goes; none without. */
function parseFrontmatter(content: string): Frontmatter {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const end = normalized.startsWith("---") ? normalized.indexOf("\n---", 3) : -1;
  if (end === -1) return { fields: {}, yamlError: null };
  const yaml = normalized.slice(4, end);
  try {
    const parsed: unknown = Bun.YAML.parse(yaml);
    return { fields: isPlainObject(parsed) ? parsed : {}, yamlError: null };
  } catch (error) {
    return { fields: lineFields(yaml), yamlError: errorText(error) };
  }
}

const LINE_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "description",
  "disable-model-invocation",
]);

/**
 * OpenClaw's fallback for frontmatter other clients accept and YAML doesn't, such as an unquoted
 * colon in a description: each top-level `key: value` line, quotes taken off. A value on the lines
 * below, as a block scalar's, is no value here.
 */
function lineFields(yaml: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const line of yaml.split("\n")) {
    const match = /^([\w-]+):\s*(.*)$/.exec(line);
    const key = match?.[1];
    const raw = match?.[2]?.trim() ?? "";
    if (key === undefined || !LINE_FIELDS.has(key) || raw === "" || /^[|>][1-9+-]*$/.test(raw)) {
      continue;
    }
    const quote = raw[0];
    const value =
      raw.length > 1 && (quote === '"' || quote === "'") && raw.at(-1) === quote
        ? raw.slice(1, -1)
        : raw;
    fields[key] = key === "disable-model-invocation" ? value === "true" : value;
  }
  return fields;
}

interface Found {
  readonly skill: Skill;
  /** Its SKILL.md, as the scan reached it. */
  readonly path: string;
  /** disable-model-invocation: only an explicit invocation would load it, and a task has none. */
  readonly disabled: boolean;
}

/**
 * The skill whose folder is `dir`, `real` on disk, from its SKILL.md; null when it is left out,
 * with why in `problems`. Its fields but name, description and disable-model-invocation are
 * ignored: allowed-tools pre-approves nothing.
 */
async function readSkill(
  dir: string,
  real: string,
  source: SkillSource,
  problems: SkillProblem[],
): Promise<Found | null> {
  const path = join(dir, SKILL_FILE);
  const note = (message: string, skipped = false) => problems.push({ path, message, skipped });
  let text: string;
  try {
    const file = await realpath(path);
    if (!isInside(file, real)) {
      note("leads outside its skill's folder", true);
      return null;
    }
    // Stat first: opening a FIFO waits for a writer.
    const stats = await stat(file);
    if (!stats.isFile()) {
      note("isn't a file", true);
      return null;
    }
    if (stats.size > MAX_SKILL_BYTES) {
      note(`is ${formatSize(stats.size)}, over the 256KB a SKILL.md may be`, true);
      return null;
    }
    const handle = await open(file, "r");
    try {
      text = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
  } catch (error) {
    problems.push(unreadable(path, error));
    return null;
  }
  const { fields, yamlError } = parseFrontmatter(text);
  const description = typeof fields.description === "string" ? oneLine(fields.description) : "";
  if (description === "") {
    note(
      yamlError === null
        ? "description is required"
        : `its frontmatter doesn't parse (${yamlError})`,
      true,
    );
    return null;
  }
  if (yamlError !== null) {
    note(
      `its frontmatter doesn't parse (${yamlError}): its name and description were read line by line`,
    );
  }
  const name = (typeof fields.name === "string" ? oneLine(fields.name) : "") || basename(dir);
  for (const error of validateName(name)) note(error);
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    note(
      `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length}): the catalog cuts it`,
    );
  }
  return {
    skill: { name, description: sliceHead(description, MAX_DESCRIPTION_LENGTH), source, dir: real },
    path,
    disabled: fields["disable-model-invocation"] === true,
  };
}

interface Scan {
  readonly found: Found[];
  readonly problems: SkillProblem[];
  /** The folders scanned, by realpath, so one reached twice through links is scanned once. */
  readonly visited: Set<string>;
}

/**
 * The skills in `root` and below, as pi walks for them: a folder holding a SKILL.md is a skill and
 * isn't walked further; otherwise its folders are, but for dot-folders and node_modules. Links are
 * followed, though for a folder's skills, `within` is that folder's realpath and nothing leading
 * outside it is read.
 */
async function scan(
  root: string,
  source: SkillSource,
  within: string | null,
  state: Scan,
): Promise<void> {
  let folders = 0;
  /** False once the scan has stopped at MAX_FOLDERS. */
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    let real: string;
    try {
      real = await realpath(dir);
    } catch (error) {
      // A source not made has no skills.
      if (depth > 0 || !isMissing(error)) state.problems.push(unreadable(dir, error));
      return true;
    }
    // First, so a folder's link to an owner's skill, listed already, is no problem.
    if (state.visited.has(fold(real))) return true;
    if (within !== null && !isInside(real, within)) {
      state.problems.push({ path: dir, message: "leads outside the task's folder", skipped: true });
      return true;
    }
    if (folders === MAX_FOLDERS) {
      state.problems.push({
        path: root,
        message: `stopped scanning after ${MAX_FOLDERS} folders`,
        skipped: true,
      });
      return false;
    }
    folders++;
    state.visited.add(fold(real));
    let entries: Dirent[];
    try {
      entries = await readdir(real, { withFileTypes: true });
    } catch (error) {
      if (depth > 0 || !isMissing(error)) state.problems.push(unreadable(dir, error));
      return true;
    }
    if (
      entries.some(
        (entry) => entry.name === SKILL_FILE && (entry.isFile() || entry.isSymbolicLink()),
      )
    ) {
      const found = await readSkill(dir, real, source, state.problems);
      if (found !== null) state.found.push(found);
      return true;
    }
    if (depth === MAX_DEPTH) return true;
    for (const entry of entries.sort((a, b) => byName(a.name, b.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          if (!(await stat(path)).isDirectory()) continue;
        } catch (error) {
          state.problems.push(unreadable(path, error));
          continue;
        }
      } else if (!entry.isDirectory()) {
        continue;
      }
      if (!(await walk(path, depth + 1))) return false;
    }
    return true;
  };
  await walk(root, 0);
}

/**
 * The skills a task in `folder` may load, from `<dataHome>/skills` and the folder's
 * .agents/skills, each scanned 4 folders deep and 2,000 folders at most. A name found twice goes
 * to the owner's skill, else to the first found. Never throws: a source, folder or file it can't
 * read is a problem, and is left out.
 */
export async function loadSkills(options: {
  readonly dataHome: string;
  readonly folder?: string;
}): Promise<SkillCatalog> {
  const state: Scan = { found: [], problems: [], visited: new Set() };
  await scan(skillsDir(options.dataHome), "owner", null, state);
  if (options.folder !== undefined) {
    const folder = resolve(options.folder);
    const root = join(folder, ".agents", "skills");
    let within: string | null = null;
    try {
      within = await realpath(folder);
    } catch (error) {
      if (!isMissing(error)) state.problems.push(unreadable(root, error));
    }
    if (within !== null) await scan(root, "folder", within, state);
  }
  const named = new Map<string, Found>();
  for (const found of state.found) {
    const winner = named.get(found.skill.name);
    if (winner === undefined) {
      named.set(found.skill.name, found);
      continue;
    }
    const whose = winner.skill.source === found.skill.source ? "" : "the owner's ";
    state.problems.push({
      path: found.path,
      message: `shadowed by ${whose}${winner.path}`,
      skipped: true,
    });
  }
  const offered = [...named.values()]
    .filter((found) => !found.disabled)
    .map((found) => found.skill)
    .sort((a, b) => byName(a.name, b.name));
  const ordered = [
    ...offered.filter((skill) => skill.source === "owner"),
    ...offered.filter((skill) => skill.source === "folder"),
  ];
  const skills: Skill[] = [];
  let tokens = 0;
  for (const skill of ordered) {
    const cost = estimateTokens(skillEntry(skill));
    if (skills.length === MAX_LISTED || tokens + cost > MAX_CATALOG_TOKENS) break;
    skills.push(skill);
    tokens += cost;
  }
  return { skills, unlisted: ordered.length - skills.length, problems: state.problems };
}

/** pi's escapeXml, but quotes stay, as text outside an attribute may keep them. */
function escapeText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** How the worker's prompt lists `skill`: escaped, so its text can't close the list or add to it. */
export function skillEntry(skill: Skill): string {
  const name = escapeText(skill.name).replaceAll('"', "&quot;");
  return `<skill name="${name}" from="${skill.source}">${escapeText(skill.description)}</skill>`;
}

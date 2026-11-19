// The skill tool: a listed skill's SKILL.md, or another file or folder in its folder, read as read
// reads them. It is the one tool that reads in the data home, and only inside a listed skill's
// folder, never a dot-file there.
import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { estimateTokens, type TaskToolContext, type TaskToolResult } from "@eidolon/engine";
import { fold, isMissing } from "../policy.ts";
import {
  isInside,
  type RequestedSkill,
  SKILL_FILE,
  type Skill,
  type SkillCatalog,
  type SkillProblem,
} from "../skills.ts";
import type { AssistantTool, PathGuard } from "../types.ts";
import { resolveToCwd } from "./path.ts";
import { createReadTool } from "./read.ts";
import {
  errorResult,
  failure,
  integerArgument,
  invalidArguments,
  stringArgument,
} from "./results.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./truncate.ts";

// As agentskills.io advises, a skill's bundled files are listed for the worker, not read to it.
const LISTED_FILES = 50;
const LISTED_DEPTH = 3;

/**
 * The skill tool for `skills`, those the worker's prompt lists or carries whole; a task with none
 * has no skill tool.
 * A folder skill's files also pass `guard`, the task's own.
 */
export function createSkillTool(skills: readonly Skill[], guard: PathGuard): AssistantTool {
  const named = new Map(skills.map((skill) => [skill.name, skill]));
  return {
    schema: {
      name: "skill",
      description: `Load a skill listed in <skills> or <requested_skills>: its SKILL.md, or with path, another file in its folder, or the list of a folder in it. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit to read on.`,
      properties: {
        name: {
          type: "string",
          enum: skills.map((skill) => skill.name),
          description: "The skill's name, as <skills> or <requested_skills> gives it",
        },
        path: {
          type: "string",
          description:
            "A file or folder in the skill's folder, relative to it, such as references/forms.md (default: SKILL.md)",
        },
        offset: { type: "integer", description: "Line number to start reading from (1-indexed)" },
        limit: { type: "integer", description: "Maximum number of lines to read" },
      },
      required: ["name"],
    },
    snippet: "Load a skill's instructions, or a file in its folder",
    // The <skills> section says when to load one.
    guidelines: [],
    replay: "safe",
    async execute(args, context) {
      const problems: string[] = [];
      const name = stringArgument(args, "name", problems);
      const path =
        args.path === undefined || args.path === null || args.path === ""
          ? SKILL_FILE
          : stringArgument(args, "path", problems);
      const offset = integerArgument(args, "offset", problems);
      const limit = integerArgument(args, "limit", problems, 0);
      if (problems.length > 0) return invalidArguments("skill", problems, args);
      const skill = named.get(name);
      if (skill === undefined) return errorResult(`No skill is named ${name}.`);
      return load(skill, guard, { path, offset, limit }, context);
    },
  };
}

/**
 * Where `path`, against `skill`'s folder, lies on disk: one of the skill's own files or folders,
 * never a dot-file or dot-folder, where a key or a git remote's token would be. A folder skill's
 * must pass `guard`, the task's, too, whose PathRefused is thrown as it is.
 */
async function locate(skill: Skill, guard: PathGuard, path: string): Promise<string> {
  const outside = () => new Error(`${path} is outside the skill ${skill.name}'s folder`);
  const hidden = () => new Error(`${path} is hidden: skill doesn't read dot-files or dot-folders`);
  const wanted = resolveToCwd(path, skill.dir);
  const inside = isInside(wanted, skill.dir);
  if (inside && isHidden(wanted, skill.dir)) throw hidden();
  let target: string;
  try {
    target = await realpath(wanted);
  } catch (error) {
    if (!isMissing(error)) throw error;
    throw inside ? new Error(`${path} isn't in the skill ${skill.name}'s folder`) : outside();
  }
  if (!isInside(target, skill.dir)) throw outside();
  if (isHidden(target, skill.dir)) throw hidden();
  if (skill.source === "folder") await guard.resolve(target, "read");
  return target;
}

function isHidden(path: string, dir: string): boolean {
  return relative(fold(dir), fold(path))
    .split(sep)
    .some((part) => part.startsWith("."));
}

async function load(
  skill: Skill,
  guard: PathGuard,
  args: { readonly path: string; readonly offset?: number; readonly limit?: number },
  context: TaskToolContext,
): Promise<TaskToolResult> {
  let target: string;
  try {
    target = await locate(skill, guard, args.path);
    if ((await stat(target)).isDirectory()) {
      const where = relative(skill.dir, target);
      return {
        content: fileList(where === "" ? "its folder" : where, await filesIn(target, skill)),
      };
    }
  } catch (error) {
    // Text alone, never `refused`: a skill's files are nothing to ask the owner for.
    return failure(error);
  }
  const located = target;
  // The file located, under the worker's own name for it.
  const read = await createReadTool({ folder: skill.dir, resolve: async () => located }).execute(
    args,
    context,
  );
  if (
    read.isError ||
    fold(resolveToCwd(args.path, skill.dir)) !== fold(join(skill.dir, SKILL_FILE))
  ) {
    return read;
  }
  const whose = skill.source === "folder" ? "from the task's folder" : "the owner's";
  const files = (await filesIn(skill.dir, skill)).filter((file) => file !== SKILL_FILE);
  return {
    ...read,
    content: [
      `Skill ${skill.name} (${whose}), in ${skill.dir}. Paths in it are relative to that folder; read its files with skill and their path.`,
      read.content,
      ...(files.length > 0 ? [fileList("its folder", files)] : []),
    ].join("\n\n"),
  };
}

export interface TaskSkills {
  /** What skill may load: the catalog's, then the named ones it doesn't list. */
  readonly loadable: readonly Skill[];
  /**
   * The named skills whose SKILL.md reads, each with it as skill answers for it, or, past the room
   * a task's context leaves them, with a note to load it.
   */
  readonly requested: readonly RequestedSkill[];
  /** The named skills whose SKILL.md doesn't read now, and why. */
  readonly unreadable: readonly SkillProblem[];
}

/** What the prompt carries for a named skill its SKILL.md didn't fit beside. */
export const SKILL_LEFT_TO_LOAD =
  "Its SKILL.md didn't fit here: load it with skill before you do anything else.";

/**
 * A run's skills from `catalog`: what its skill tool loads, and what its prompt carries for each
 * named skill, its SKILL.md as skill answers for it, cut as skill cuts a file. Together they fill
 * at most a quarter of `contextTokens`, the task's context; a skill past that is named with
 * SKILL_LEFT_TO_LOAD.
 */
export async function taskSkills(
  catalog: SkillCatalog,
  guard: PathGuard,
  contextTokens: number,
): Promise<TaskSkills> {
  const listed = new Set(catalog.skills.map((skill) => skill.name));
  const context: TaskToolContext = { signal: new AbortController().signal, onUpdate: () => {} };
  const requested: RequestedSkill[] = [];
  const unreadable: SkillProblem[] = [];
  let room = contextTokens / 4;
  for (const skill of catalog.requested) {
    const { content, isError } = await load(skill, guard, { path: SKILL_FILE }, context);
    if (isError) {
      unreadable.push({ path: join(skill.dir, SKILL_FILE), message: content, skipped: true });
      continue;
    }
    const cost = estimateTokens(content);
    if (cost > room) {
      requested.push({ skill, text: SKILL_LEFT_TO_LOAD });
      continue;
    }
    room -= cost;
    requested.push({ skill, text: content });
  }
  return {
    loadable: [
      ...catalog.skills,
      ...requested.map(({ skill }) => skill).filter((skill) => !listed.has(skill.name)),
    ],
    requested,
    unreadable,
  };
}

function fileList(where: string, files: readonly string[]): string {
  if (files.length === 0) return `Files in ${where}: none`;
  const more = files.length > LISTED_FILES ? `, …and ${files.length - LISTED_FILES} more` : "";
  return `Files in ${where}: ${files.slice(0, LISTED_FILES).join(", ")}${more}`;
}

/**
 * The files in `folder` and LISTED_DEPTH folders below it, by their path in `skill`'s folder,
 * leaving out dot-entries, node_modules and links, which may lead out of the skill.
 */
async function filesIn(folder: string, skill: Skill): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isFile()) files.push(relative(skill.dir, path));
      else if (entry.isDirectory() && depth < LISTED_DEPTH) await walk(path, depth + 1);
    }
  };
  await walk(folder, 0);
  return files;
}

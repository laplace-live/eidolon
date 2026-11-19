// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/test/skills.test.ts@ac78a60
//
// pi's loader cases, on skills written to temporary folders rather than pi's fixtures; the two
// sources, the line fallback, the limits, links, clashes and the catalog's budget are this
// package's own.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { estimateTokens } from "@eidolon/engine";
import {
  loadSkills,
  type SkillProblem,
  scanSkills,
  skillEntry,
  skillNames,
  skillSwitchesPath,
  skillsDir,
} from "../src/skills.ts";
import { removeTempFolders, tempFolder } from "./tool-folder.ts";

afterEach(removeTempFolders);

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A SKILL.md in `dir` with `frontmatter` between its --- lines; its path. */
function writeSkill(dir: string, frontmatter: string, body = "# Instructions\n"): string {
  const path = join(dir, "SKILL.md");
  write(path, `---\n${frontmatter}\n---\n\n${body}`);
  return path;
}

/** A data home, with the owner's skills folder, and a task folder, none of them made yet. */
async function places(): Promise<{
  home: string;
  owner: string;
  shared: string;
  folder: string;
  root: string;
}> {
  const root = await tempFolder();
  const home = join(root, "home", ".laplace", "eidolon");
  return {
    home,
    owner: skillsDir(home),
    shared: join(root, "home", ".agents", "skills"),
    folder: join(root, "home", "proj"),
    root,
  };
}

function messages(problems: readonly SkillProblem[]): string[] {
  return problems.map((problem) => problem.message);
}

describe("loadSkills", () => {
  test("should load a valid skill", async () => {
    const { home, owner } = await places();
    const dir = join(owner, "valid-skill");
    writeSkill(dir, "name: valid-skill\ndescription: A valid skill for testing purposes.");
    expect(await loadSkills({ dataHome: home })).toEqual({
      skills: [
        {
          name: "valid-skill",
          description: "A valid skill for testing purposes.",
          source: "owner",
          dir,
        },
      ],
      requested: [],
      missing: [],
      off: [],
      unlisted: [],
      problems: [],
    });
  });

  test("should allow names that don't match parent directory", async () => {
    const { home, owner } = await places();
    writeSkill(
      join(owner, "name-mismatch"),
      "name: different-name\ndescription: A skill with a name that doesn't match the directory.",
    );
    const { skills, problems } = await loadSkills({ dataHome: home });
    expect(skills.map((skill) => skill.name)).toEqual(["different-name"]);
    expect(problems).toEqual([]);
  });

  test("should use parent directory name when name not in frontmatter", async () => {
    const { home, owner } = await places();
    writeSkill(join(owner, "valid-skill"), "description: A valid skill for testing purposes.");
    const { skills, problems } = await loadSkills({ dataHome: home });
    expect(skills.map((skill) => skill.name)).toEqual(["valid-skill"]);
    expect(problems).toEqual([]);
  });

  test("should warn when name contains invalid characters", async () => {
    const { home, owner } = await places();
    const path = writeSkill(
      join(owner, "invalid-name-chars"),
      "name: Invalid_Name\ndescription: A skill with invalid characters in the name.",
    );
    const { skills, problems } = await loadSkills({ dataHome: home });
    expect(skills.map((skill) => skill.name)).toEqual(["Invalid_Name"]);
    expect(problems).toEqual([
      {
        path,
        message: "name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)",
        skipped: false,
      },
    ]);
  });

  test("should warn when name exceeds 64 characters", async () => {
    const { home, owner } = await places();
    const name =
      "this-is-a-very-long-skill-name-that-exceeds-the-sixty-four-character-limit-set-by-the-standard";
    writeSkill(
      join(owner, "long-name"),
      `name: ${name}\ndescription: A skill with a name that exceeds 64 characters.`,
    );
    const { skills, problems } = await loadSkills({ dataHome: home });
    expect(skills.map((skill) => skill.name)).toEqual([name]);
    expect(messages(problems)).toEqual([`name exceeds 64 characters (${name.length})`]);
  });

  test("should warn when name contains consecutive hyphens", async () => {
    const { home, owner } = await places();
    writeSkill(
      join(owner, "consecutive-hyphens"),
      "name: bad--name\ndescription: A skill with consecutive hyphens in the name.",
    );
    const { skills, problems } = await loadSkills({ dataHome: home });
    expect(skills.map((skill) => skill.name)).toEqual(["bad--name"]);
    expect(messages(problems)).toEqual(["name must not contain consecutive hyphens"]);
  });

  test("should warn and skip skill when description is missing, or the frontmatter with it", async () => {
    const { home, owner } = await places();
    const missing = writeSkill(join(owner, "missing-description"), "name: missing-description");
    const bare = join(owner, "no-frontmatter", "SKILL.md");
    write(bare, "# No Frontmatter\n\nThis skill has no YAML frontmatter at all.\n");
    expect(await loadSkills({ dataHome: home })).toEqual({
      skills: [],
      requested: [],
      missing: [],
      off: [],
      unlisted: [],
      problems: [
        { path: missing, message: "description is required", skipped: true },
        { path: bare, message: "description is required", skipped: true },
      ],
    });
  });

  test("should warn and skip skill when YAML frontmatter is invalid and its description isn't on one line", async () => {
    const { home, owner } = await places();
    const path = writeSkill(
      join(owner, "invalid-yaml"),
      "name: invalid-yaml\ndescription: >\n  Folded over\n  two lines.\nbad: [unclosed bracket",
    );
    expect(await loadSkills({ dataHome: home })).toEqual({
      skills: [],
      requested: [],
      missing: [],
      off: [],
      unlisted: [],
      problems: [
        {
          path,
          message: "its frontmatter doesn't parse (YAML Parse error: Unexpected token)",
          skipped: true,
        },
      ],
    });
  });

  test("a description with an unquoted colon still loads, read line by line", async () => {
    const { home, owner } = await places();
    const paths = [
      writeSkill(
        join(owner, "manual-only"),
        "name: manual-only\ndescription: Use when: asked by name\ndisable-model-invocation: true",
      ),
      writeSkill(
        join(owner, "pdf-tools"),
        "name: pdf-tools\ndescription: Use when: the user asks about 'PDFs'\nlicense: MIT",
      ),
      writeSkill(
        join(owner, "quoted"),
        "name: 'quoted'\ndescription: \"Use when: quoted\"\nmetadata: {unclosed",
      ),
    ];
    const { skills, problems } = await loadSkills({ dataHome: home });
    expect(skills.map(({ name, description }) => [name, description])).toEqual([
      ["pdf-tools", "Use when: the user asks about 'PDFs'"],
      ["quoted", "Use when: quoted"],
    ]);
    expect(problems).toEqual(
      paths.map((path) => ({
        path,
        message:
          "its frontmatter doesn't parse (YAML Parse error: Unexpected token): its name and description were read line by line",
        skipped: false,
      })),
    );
  });

  test("should ignore unknown frontmatter fields", async () => {
    const { home, owner } = await places();
    writeSkill(
      join(owner, "unknown-field"),
      "name: unknown-field\ndescription: A skill with an unknown frontmatter field.\nauthor: someone\nversion: 1.0",
    );
    const { skills, problems } = await loadSkills({ dataHome: home });
    expect(skills.map((skill) => skill.name)).toEqual(["unknown-field"]);
    expect(problems).toEqual([]);
  });

  test("multiline descriptions from YAML are collapsed to one line", async () => {
    const { home, owner } = await places();
    writeSkill(
      join(owner, "multiline-description"),
      "name: multiline-description\ndescription: |\n  This is a multiline description.\n  It spans multiple lines.\n\n  And should be normalized.",
    );
    const { skills, problems } = await loadSkills({ dataHome: home });
    expect(skills.map((skill) => skill.description)).toEqual([
      "This is a multiline description. It spans multiple lines. And should be normalized.",
    ]);
    expect(problems).toEqual([]);
  });

  test("a byte order mark and CRLF line ends still parse", async () => {
    const { home, owner } = await places();
    write(
      join(owner, "windows", "SKILL.md"),
      "\uFEFF---\r\nname: windows\r\ndescription: Saved on Windows.\r\n---\r\n# Body\r\n",
    );
    const { skills, problems } = await loadSkills({ dataHome: home });
    expect(skills.map(({ name, description }) => [name, description])).toEqual([
      ["windows", "Saved on Windows."],
    ]);
    expect(problems).toEqual([]);
  });

  test("a description over 1,024 characters is cut, with a problem", async () => {
    const { home, owner } = await places();
    const path = writeSkill(join(owner, "wordy"), `name: wordy\ndescription: ${"a".repeat(1100)}`);
    const { skills, problems } = await loadSkills({ dataHome: home });
    expect(skills.map((skill) => skill.description)).toEqual(["a".repeat(1024)]);
    expect(problems).toEqual([
      {
        path,
        message: "description exceeds 1024 characters (1100): the catalog cuts it",
        skipped: false,
      },
    ]);
  });

  test("a skill that opts out of model use is never listed, and allowed-tools pre-approves nothing", async () => {
    const { home, owner } = await places();
    writeSkill(
      join(owner, "disable-model-invocation"),
      "name: disable-model-invocation\ndescription: A skill that cannot be invoked by the model.\ndisable-model-invocation: true",
    );
    const dir = join(owner, "cleanup");
    writeSkill(
      dir,
      'name: cleanup\ndescription: Clean the build folder.\nallowed-tools: "Bash(rm:*) Read"',
    );
    expect(await loadSkills({ dataHome: home })).toEqual({
      skills: [{ name: "cleanup", description: "Clean the build folder.", source: "owner", dir }],
      requested: [],
      missing: [],
      off: [],
      unlisted: [],
      problems: [],
    });
  });

  test("finds skills in grouped folders and stops at a SKILL.md, 4 folders deep at most", async () => {
    const { home, owner } = await places();
    writeSkill(
      join(owner, "nested", "child-skill"),
      "name: child-skill\ndescription: A nested skill in a subdirectory.",
    );
    writeSkill(join(owner, "root-skill-preferred"), "description: Root skill should win.");
    writeSkill(
      join(owner, "root-skill-preferred", "nested-child"),
      "description: Nested skill should be ignored.",
    );
    writeSkill(join(owner, "a", "b", "c", "four-deep"), "description: Four folders down.");
    writeSkill(join(owner, "a", "b", "c", "d", "five-deep"), "description: Five folders down.");
    const { skills, problems } = await loadSkills({ dataHome: home });
    expect(skills.map(({ name, description }) => [name, description])).toEqual([
      ["child-skill", "A nested skill in a subdirectory."],
      ["four-deep", "Four folders down."],
      ["root-skill-preferred", "Root skill should win."],
    ]);
    expect(problems).toEqual([]);
  });

  test("skips hidden folders, node_modules and lone .md files", async () => {
    const { home, owner } = await places();
    writeSkill(join(owner, ".hidden", "secret"), "description: In a dot-folder.");
    writeSkill(join(owner, "tools", "node_modules", "pkg"), "description: A dependency's.");
    write(join(owner, "README.md"), "---\nname: readme\ndescription: A lone file.\n---\n");
    write(join(owner, "tools", "notes.md"), "---\nname: notes\ndescription: Another.\n---\n");
    writeSkill(join(owner, "tools", "visible"), "description: The only skill here.");
    const { skills, problems } = await loadSkills({ dataHome: home });
    expect(skills.map((skill) => skill.name)).toEqual(["visible"]);
    expect(problems).toEqual([]);
  });

  test("no folders, no skills and no problems", async () => {
    const { home, folder } = await places();
    const empty = { skills: [], requested: [], missing: [], off: [], unlisted: [], problems: [] };
    expect(await loadSkills({ dataHome: home })).toEqual(empty);
    expect(await loadSkills({ dataHome: home, folder })).toEqual(empty);
    mkdirSync(folder, { recursive: true });
    write(join(folder, ".agents", "AGENTS.md"), "no skills folder in here");
    expect(await loadSkills({ dataHome: home, folder })).toEqual(empty);
  });

  test("a SKILL.md over 256 KB is skipped", async () => {
    const { home, owner } = await places();
    const path = join(owner, "huge", "SKILL.md");
    write(path, `---\nname: huge\ndescription: Too big.\n---\n${"x".repeat(256 * 1024)}`);
    writeSkill(join(owner, "small"), "description: Fits.");
    const { skills, problems } = await loadSkills({ dataHome: home });
    expect(skills.map((skill) => skill.name)).toEqual(["small"]);
    expect(problems).toEqual([
      { path, message: "is 256.0KB, over the 256KB a SKILL.md may be", skipped: true },
    ]);
  });

  test("a SKILL.md that is a FIFO, or links to one, is never opened", async () => {
    const { home, owner } = await places();
    mkdirSync(join(owner, "pipe"), { recursive: true });
    mkdirSync(join(owner, "linked"), { recursive: true });
    expect(Bun.spawnSync(["mkfifo", join(owner, "pipe", "SKILL.md")]).exitCode).toBe(0);
    symlinkSync("../pipe/SKILL.md", join(owner, "linked", "SKILL.md"));
    mkdirSync(join(owner, "inside"), { recursive: true });
    expect(Bun.spawnSync(["mkfifo", join(owner, "inside", "fifo")]).exitCode).toBe(0);
    symlinkSync("fifo", join(owner, "inside", "SKILL.md"));
    expect(await loadSkills({ dataHome: home })).toEqual({
      skills: [],
      requested: [],
      missing: [],
      off: [],
      unlisted: [],
      problems: [
        { path: join(owner, "inside", "SKILL.md"), message: "isn't a file", skipped: true },
        {
          path: join(owner, "linked", "SKILL.md"),
          message: "leads outside its skill's folder",
          skipped: true,
        },
      ],
    });
  }, 5000);

  test("stops scanning a source after 2,000 folders", async () => {
    const { home, owner, folder } = await places();
    for (let i = 0; i < 2000; i++)
      mkdirSync(join(owner, `d${String(i).padStart(4, "0")}`), { recursive: true });
    writeSkill(join(owner, "zz-last"), "description: Past the folders scanned.");
    writeSkill(join(folder, ".agents", "skills", "own"), "description: The other source's.");
    expect(await loadSkills({ dataHome: home, folder })).toEqual({
      skills: [
        {
          name: "own",
          description: "The other source's.",
          source: "folder",
          dir: join(folder, ".agents", "skills", "own"),
        },
      ],
      requested: [],
      missing: [],
      off: [],
      unlisted: [],
      problems: [{ path: owner, message: "stopped scanning after 2000 folders", skipped: true }],
    });
  });

  test("the owner's skill wins a name clash, and the folder's is noted as shadowed", async () => {
    const { home, owner, folder } = await places();
    const ownerPath = writeSkill(
      join(owner, "house-style"),
      "name: house-style\ndescription: The owner's house style for web pages.",
    );
    const planted = writeSkill(
      join(folder, ".agents", "skills", "house-style"),
      "name: house-style\ndescription: A planted house style.",
    );
    writeSkill(
      join(folder, ".agents", "skills", "release-notes"),
      "name: release-notes\ndescription: Release notes for this repo.",
    );
    const { skills, problems } = await loadSkills({ dataHome: home, folder });
    expect(skills.map(({ name, description, source }) => [name, description, source])).toEqual([
      ["house-style", "The owner's house style for web pages.", "owner"],
      ["release-notes", "Release notes for this repo.", "folder"],
    ]);
    expect(problems).toEqual([
      { path: planted, message: `shadowed by the owner's ${ownerPath}`, skipped: true },
    ]);
  });

  test("should detect name collisions within a source and keep the first skill found", async () => {
    const { home, owner } = await places();
    const first = writeSkill(
      join(owner, "first", "calendar"),
      "name: calendar\ndescription: First.",
    );
    const second = writeSkill(
      join(owner, "second", "calendar"),
      "name: calendar\ndescription: Second.",
    );
    const { skills, problems } = await loadSkills({ dataHome: home });
    expect(skills.map((skill) => skill.description)).toEqual(["First."]);
    expect(problems).toEqual([{ path: second, message: `shadowed by ${first}`, skipped: true }]);
  });

  test("a skill reached twice through links is listed once, and a link back up is walked once", async () => {
    const { home, owner, folder } = await places();
    const dir = join(owner, "real");
    writeSkill(dir, "name: real\ndescription: Reached twice.");
    symlinkSync("real", join(owner, "alias"));
    mkdirSync(join(owner, "group"), { recursive: true });
    symlinkSync("..", join(owner, "group", "up"));
    // The owner's skill, linked into the task's folder too.
    mkdirSync(join(folder, ".agents", "skills"), { recursive: true });
    symlinkSync(dir, join(folder, ".agents", "skills", "real"));
    expect(await loadSkills({ dataHome: home, folder })).toEqual({
      skills: [{ name: "real", description: "Reached twice.", source: "owner", dir }],
      requested: [],
      missing: [],
      off: [],
      unlisted: [],
      problems: [],
    });
  });

  test("a folder skill whose folder leads outside the task's is skipped; an owner's linked skill folder is followed", async () => {
    const { home, owner, folder, root } = await places();
    const outside = join(root, "home", ".ssh");
    writeSkill(outside, "name: keys\ndescription: Planted beside the keys.");
    write(join(outside, "id_ed25519"), "PRIVATE-KEY");
    mkdirSync(join(folder, ".agents", "skills"), { recursive: true });
    // As a cloned repository stores a link.
    symlinkSync("../../../.ssh", join(folder, ".agents", "skills", "keys"));
    const linkedTarget = join(root, "dotfiles", "skills", "house-style");
    writeSkill(linkedTarget, "name: house-style\ndescription: Kept in the owner's dotfiles.");
    mkdirSync(owner, { recursive: true });
    symlinkSync(linkedTarget, join(owner, "house-style"));
    expect(await loadSkills({ dataHome: home, folder })).toEqual({
      skills: [
        {
          name: "house-style",
          description: "Kept in the owner's dotfiles.",
          source: "owner",
          dir: linkedTarget,
        },
      ],
      requested: [],
      missing: [],
      off: [],
      unlisted: [],
      problems: [
        {
          path: join(folder, ".agents", "skills", "keys"),
          message: "leads outside the task's folder",
          skipped: true,
        },
      ],
    });
    const linkedRoot = join(root, "home", "other");
    mkdirSync(join(linkedRoot, ".agents"), { recursive: true });
    symlinkSync(join(root, "dotfiles", "skills"), join(linkedRoot, ".agents", "skills"));
    expect(
      (await loadSkills({ dataHome: join(root, "nowhere"), folder: linkedRoot })).problems,
    ).toEqual([
      {
        path: join(linkedRoot, ".agents", "skills"),
        message: "leads outside the task's folder",
        skipped: true,
      },
    ]);
  });

  test("a SKILL.md linked out of its folder is skipped", async () => {
    const { home, owner } = await places();
    write(
      join(owner, "notes.md"),
      "---\nname: linked\ndescription: Lives outside the skill.\n---\n",
    );
    mkdirSync(join(owner, "linked"), { recursive: true });
    symlinkSync("../notes.md", join(owner, "linked", "SKILL.md"));
    expect(await loadSkills({ dataHome: home })).toEqual({
      skills: [],
      requested: [],
      missing: [],
      off: [],
      unlisted: [],
      problems: [
        {
          path: join(owner, "linked", "SKILL.md"),
          message: "leads outside its skill's folder",
          skipped: true,
        },
      ],
    });
  });

  test("a link loop in a source is a problem, never a throw", async () => {
    const { home, owner } = await places();
    writeSkill(join(owner, "ok"), "description: Still loads.");
    symlinkSync("loop-b", join(owner, "loop-a"));
    symlinkSync("loop-a", join(owner, "loop-b"));
    const { skills, problems } = await loadSkills({ dataHome: home });
    expect(skills.map((skill) => skill.name)).toEqual(["ok"]);
    expect(problems.map((problem) => [problem.path, problem.skipped])).toEqual([
      [join(owner, "loop-a"), true],
      [join(owner, "loop-b"), true],
    ]);
    for (const problem of problems) expect(problem.message).toStartWith("can't be read: ELOOP");
  });

  test("an unreadable source is a problem, and the other source still loads", async () => {
    const { home, owner, folder } = await places();
    writeSkill(join(owner, "locked"), "description: Behind a folder no one may list.");
    writeSkill(join(folder, ".agents", "skills", "open"), "description: The folder's.");
    chmodSync(owner, 0o000);
    try {
      const { skills, problems } = await loadSkills({ dataHome: home, folder });
      expect(skills.map((skill) => [skill.name, skill.source])).toEqual([["open", "folder"]]);
      expect(problems.map((problem) => [problem.path, problem.skipped])).toEqual([[owner, true]]);
      expect(problems[0]?.message).toStartWith("can't be read: EACCES");
    } finally {
      chmodSync(owner, 0o755);
    }
  });

  test("past 150 skills, the owner's are listed first, each source by name, and the rest counted", async () => {
    const { home, owner, folder } = await places();
    // Written out of order, so the order listed is the names'.
    for (let i = 144; i >= 0; i--) {
      const name = `owner-${String(i).padStart(3, "0")}`;
      writeSkill(join(owner, name), `description: Skill ${i}.`);
    }
    for (let i = 9; i >= 0; i--) {
      writeSkill(join(folder, ".agents", "skills", `a-folder-${i}`), `description: Folder ${i}.`);
    }
    const { skills, unlisted, problems } = await loadSkills({ dataHome: home, folder });
    expect(skills).toHaveLength(150);
    expect(unlisted).toHaveLength(5);
    expect(problems).toEqual([]);
    expect(skills.slice(0, 145).every((skill) => skill.source === "owner")).toBe(true);
    expect(skills.slice(0, 3).map((skill) => skill.name)).toEqual([
      "owner-000",
      "owner-001",
      "owner-002",
    ]);
    expect(skills.slice(145).map((skill) => skill.name)).toEqual([
      "a-folder-0",
      "a-folder-1",
      "a-folder-2",
      "a-folder-3",
      "a-folder-4",
    ]);
  });

  test("a Chinese catalog stops at the token budget", async () => {
    const { home, owner } = await places();
    const description = "写网页时用这个技能，按主人的习惯排版、配色和命名".repeat(8);
    for (let i = 0; i < 40; i++) {
      writeSkill(join(owner, `zh-${String(i).padStart(2, "0")}`), `description: ${description}`);
    }
    const { skills, unlisted } = await loadSkills({ dataHome: home });
    const entry = skillEntry({ name: "zh-00", description, source: "owner", dir: owner });
    // 233 characters an entry: 18,000 characters would list all 40.
    expect(40 * entry.length).toBeLessThan(18_000);
    expect(estimateTokens(entry)).toBe(203);
    expect(skills.map((skill) => skill.name)).toEqual(
      Array.from({ length: 22 }, (_, i) => `zh-${String(i).padStart(2, "0")}`),
    );
    expect(unlisted).toHaveLength(18);
  });
});

describe("the shared folder, the owner's switches and the skills she names", () => {
  test("the shared folder's skills come after the owner's and before the task folder's, and the owner's wins a name clash", async () => {
    const { home, owner, shared, folder } = await places();
    const ownerPath = writeSkill(
      join(owner, "house-style"),
      "name: house-style\ndescription: The owner's own house style.",
    );
    const sharedPath = writeSkill(
      join(shared, "house-style"),
      "name: house-style\ndescription: The house style other agents use.",
    );
    writeSkill(join(shared, "ship"), "name: ship\ndescription: Ship a change.");
    const planted = writeSkill(
      join(folder, ".agents", "skills", "ship"),
      "name: ship\ndescription: A planted ship.",
    );
    writeSkill(join(folder, ".agents", "skills", "audit"), "name: audit\ndescription: Audit it.");
    const { skills, problems } = await loadSkills({ dataHome: home, shared, folder });
    expect(skills.map(({ name, source }) => [name, source])).toEqual([
      ["house-style", "owner"],
      ["ship", "shared"],
      ["audit", "folder"],
    ]);
    expect(problems).toEqual([
      { path: sharedPath, message: `shadowed by the owner's ${ownerPath}`, skipped: true },
      {
        path: planted,
        message: `shadowed by the shared folder's ${join(shared, "ship", "SKILL.md")}`,
        skipped: true,
      },
    ]);
    // Trusted as the owner's own: only a task folder's skill is marked untrusted.
    expect(skills.map(skillEntry)).toEqual([
      `<skill name="house-style" from="owner">The owner's own house style.</skill>`,
      `<skill name="ship" from="owner">Ship a change.</skill>`,
      `<skill name="audit" from="folder">Audit it.</skill>`,
    ]);
  });

  test("a shared folder that doesn't exist has no skills and no problems", async () => {
    const { home, owner, shared } = await places();
    writeSkill(join(owner, "notes"), "name: notes\ndescription: Notes.");
    const { skills, problems } = await loadSkills({ dataHome: home, shared });
    expect(skills.map((skill) => skill.name)).toEqual(["notes"]);
    expect(problems).toEqual([]);
  });

  test("a name switched off in skills.json is off wherever it is found, and she can't name it", async () => {
    const { home, owner, shared, folder } = await places();
    writeSkill(join(owner, "notes"), "name: notes\ndescription: Notes.");
    writeSkill(join(shared, "ship"), "name: ship\ndescription: Ship a change.");
    writeSkill(join(folder, ".agents", "skills", "ship"), "name: ship\ndescription: Planted.");
    write(skillSwitchesPath(home), JSON.stringify({ disabled: ["ship"] }));
    const scan = await scanSkills({ dataHome: home, shared, folder });
    expect([...scan.disabled]).toEqual(["ship"]);
    expect(scan.switchesProblem).toBeNull();
    const catalog = await loadSkills({ dataHome: home, shared, folder, requested: ["ship"] });
    expect(catalog.skills.map((skill) => skill.name)).toEqual(["notes"]);
    expect(catalog.requested).toEqual([]);
    expect(catalog.missing).toEqual(["ship"]);
    expect(catalog.off).toEqual(["ship"]);
    expect(skillNames(scan)).toEqual(["notes"]);
  });

  test("a skills.json that doesn't read switches nothing off, and says why", async () => {
    const { home, owner } = await places();
    writeSkill(join(owner, "notes"), "name: notes\ndescription: Notes.");
    for (const [text, problem] of [
      ["{disabled: [notes]", "isn't JSON"],
      ['{"disabled": "notes"}', "isn't {disabled: [the names of skills switched off]}"],
      ['["notes"]', "isn't {disabled: [the names of skills switched off]}"],
    ] as const) {
      write(skillSwitchesPath(home), text);
      const scan = await scanSkills({ dataHome: home });
      expect([scan.switchesProblem, [...scan.disabled]]).toEqual([problem, []]);
      expect(skillNames(scan)).toEqual(["notes"]);
    }
    write(skillSwitchesPath(home), "{}");
    expect((await scanSkills({ dataHome: home })).switchesProblem).toBeNull();
  });

  test("she names the owner's and the shared folder's skills, one that opts out of model use included, never a task folder's", async () => {
    const { home, owner, shared, folder } = await places();
    const notes = join(owner, "notes");
    writeSkill(notes, "name: notes\ndescription: Notes.");
    const deploy = join(shared, "deploy");
    writeSkill(
      deploy,
      "name: deploy\ndescription: Deploy the site.\ndisable-model-invocation: true",
    );
    writeSkill(join(shared, "Bad Name"), "name: Bad Name\ndescription: Not a name she can give.");
    writeSkill(join(folder, ".agents", "skills", "audit"), "name: audit\ndescription: Audit it.");
    const scan = await scanSkills({ dataHome: home, shared, folder });
    expect(skillNames(scan)).toEqual(["deploy", "notes"]);
    const catalog = await loadSkills({
      dataHome: home,
      shared,
      folder,
      requested: ["deploy", "notes", "deploy", "audit", "nope"],
    });
    expect(catalog.requested).toEqual([
      { name: "deploy", description: "Deploy the site.", source: "shared", dir: deploy },
      { name: "notes", description: "Notes.", source: "owner", dir: notes },
    ]);
    expect(catalog.missing).toEqual(["audit", "nope"]);
    expect(catalog.off).toEqual([]);
    // Named or not, a skill that opts out of model use is never in the catalog.
    expect(catalog.skills.map((skill) => skill.name)).toEqual(["notes", "Bad Name", "audit"]);
  });
});

describe("skillEntry", () => {
  test("should escape XML special characters, but a description's quotes", () => {
    expect(
      skillEntry({
        name: 'a"b<c>&',
        description: 'A skill with <special> & "characters" and the owner\'s words.',
        source: "folder",
        dir: "/tmp/skill",
      }),
    ).toBe(
      '<skill name="a&quot;b&lt;c&gt;&amp;" from="folder">A skill with &lt;special&gt; &amp; "characters" and the owner\'s words.</skill>',
    );
  });
});

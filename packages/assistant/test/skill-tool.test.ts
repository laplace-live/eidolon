// The skill tool, on skills loadSkills finds in temporary folders and under the policy a task runs
// with: what it reads and lists, and what it refuses without ever asking the owner.
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FolderPolicy } from "../src/policy.ts";
import { loadSkills, type Skill, skillsDir } from "../src/skills.ts";
import { createReadTool } from "../src/tools/read.ts";
import { createSkillTool, SKILL_LEFT_TO_LOAD, taskSkills } from "../src/tools/skill.ts";
import { createWriteTool } from "../src/tools/write.ts";
import { folderGuard, removeTempFolders, tempFolder, toolContext } from "./tool-folder.ts";

afterEach(removeTempFolders);

const HOUSE_STYLE =
  "---\nname: house-style\ndescription: The owner's house style for web pages. Use when making any HTML page.\n---\n\n" +
  "Every page starts with the comment `<!-- house-style -->` and sets `font-family: Georgia`.\n";

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * An owner's skill, house-style, in a data home under a stand-in home, beside its credentials, and
 * a folder skill, release-notes, in the task's folder, with the policy that task runs under.
 */
async function fixture() {
  const root = await tempFolder();
  const home = join(root, "home");
  const dataHome = join(home, ".laplace", "eidolon");
  const folder = join(home, "proj");
  const ownerDir = join(skillsDir(dataHome), "house-style");
  write(join(ownerDir, "SKILL.md"), HOUSE_STYLE);
  write(join(ownerDir, "assets", "logo.svg"), "<svg/>");
  write(join(ownerDir, "references", "colors.md"), "# Colors\n\nInk #222 on paper #fffdf7.\n");
  write(join(ownerDir, "scripts", "build.sh"), "#!/bin/sh\necho built\n");
  write(join(ownerDir, ".env"), "NOTION_TOKEN=ntn-SECRET");
  write(
    join(ownerDir, ".git", "config"),
    '[remote "origin"]\n\turl = https://x:ghp_SECRET@github.com/o/r\n',
  );
  write(join(ownerDir, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  write(join(dataHome, "credentials.json"), '{"OPENROUTER_API_KEY": "sk-or-SECRET"}');
  write(join(home, ".ssh", "id_ed25519"), "PRIVATE-KEY-SECRET");
  symlinkSync(join(home, ".ssh", "id_ed25519"), join(ownerDir, "references", "key"));
  const folderDir = join(folder, ".agents", "skills", "release-notes");
  write(
    join(folderDir, "SKILL.md"),
    "---\nname: release-notes\ndescription: Release notes for this repo.\n---\n\nList each change once.\n",
  );
  write(join(folderDir, "template.md"), "## {version}\n");
  const policy = new FolderPolicy({
    folder,
    grants: [],
    home,
    dataHome,
    appRoot: join(home, "Git", "laplace-eidolon"),
  });
  const catalog = await loadSkills({ dataHome, folder });
  expect(catalog.problems).toEqual([]);
  const skills: readonly Skill[] = catalog.skills;
  return { dataHome, folder, ownerDir, folderDir, policy, skills };
}

describe("skill tool", () => {
  test("loads a skill's SKILL.md, naming its folder and listing its files", async () => {
    const { ownerDir, folderDir, policy, skills } = await fixture();
    const skill = createSkillTool(skills, policy);
    const loaded = {
      content:
        `Skill house-style (the owner's), in ${ownerDir}. Paths in it are relative to that folder; read its files with skill and their path.\n\n` +
        `${HOUSE_STYLE}\n\nFiles in its folder: assets/logo.svg, references/colors.md, scripts/build.sh`,
      files: { read: [join(ownerDir, "SKILL.md")] },
    };
    expect(await skill.execute({ name: "house-style" }, toolContext())).toEqual(loaded);
    expect(await skill.execute({ name: "house-style", path: "" }, toolContext())).toEqual(loaded);
    expect(await skill.execute({ name: "house-style", path: "./SKILL.md" }, toolContext())).toEqual(
      loaded,
    );
    expect(await skill.execute({ name: "release-notes" }, toolContext())).toEqual({
      content:
        `Skill release-notes (from the task's folder), in ${folderDir}. Paths in it are relative to that folder; read its files with skill and their path.\n\n` +
        "---\nname: release-notes\ndescription: Release notes for this repo.\n---\n\nList each change once.\n" +
        "\n\nFiles in its folder: template.md",
      files: { read: [join(folderDir, "SKILL.md")] },
    });
  });

  test("loads a built-in skill from the app, which the file tools may not read", async () => {
    const { dataHome, folder, policy } = await fixture();
    // The policy's app root, where the built-in skills ship.
    const dir = join(dirname(dataHome), "..", "Git", "laplace-eidolon", "skills", "update");
    const text = "---\nname: update\ndescription: Update a persona.\n---\n\nRun discover.\n";
    write(join(dir, "SKILL.md"), text);
    const catalog = await loadSkills({ dataHome, builtin: dirname(dir), folder });
    const update = catalog.skills.find((skill) => skill.name === "update");
    expect(update?.source).toBe("builtin");
    const skill = createSkillTool(catalog.skills, policy);
    const real = update?.dir ?? "";
    expect(await skill.execute({ name: "update" }, toolContext())).toEqual({
      content:
        `Skill update (built into Eidolon), in ${real}. Paths in it are relative to that folder; read its files with skill and their path.\n\n` +
        `${text}`,
      files: { read: [join(real, "SKILL.md")] },
    });
    const read = await createReadTool(policy).execute(
      { path: join(real, "SKILL.md") },
      toolContext(),
    );
    expect(read.isError).toBe(true);
  });

  test("reads a file of the skill by its path, relative or absolute", async () => {
    const { ownerDir, policy, skills } = await fixture();
    const skill = createSkillTool(skills, policy);
    const colors = join(ownerDir, "references", "colors.md");
    for (const path of ["references/colors.md", colors]) {
      expect(await skill.execute({ name: "house-style", path }, toolContext())).toEqual({
        content: "# Colors\n\nInk #222 on paper #fffdf7.\n",
        files: { read: [colors] },
      });
    }
    expect(
      await skill.execute(
        { name: "house-style", path: "references/colors.md", offset: 3, limit: 1 },
        toolContext(),
      ),
    ).toEqual({
      content: "Ink #222 on paper #fffdf7.\n\n[1 more lines in file. Use offset=4 to continue.]",
      files: { read: [colors] },
    });
  });

  test("a folder in the skill lists its files, 3 folders deep and 50 at most", async () => {
    const { ownerDir, policy, skills } = await fixture();
    const skill = createSkillTool(skills, policy);
    const list = async (path: string) =>
      (await skill.execute({ name: "house-style", path }, toolContext())).content;
    expect(await list("references")).toBe("Files in references: references/colors.md");
    expect(await list(".")).toBe(
      "Files in its folder: SKILL.md, assets/logo.svg, references/colors.md, scripts/build.sh",
    );
    mkdirSync(join(ownerDir, "empty"));
    expect(await list("empty/")).toBe("Files in empty: none");
    write(join(ownerDir, "deep", "a", "b", "c", "three.md"), "");
    write(join(ownerDir, "deep", "a", "b", "c", "d", "four.md"), "");
    expect(await list("deep")).toBe("Files in deep: deep/a/b/c/three.md");
    for (let i = 0; i < 60; i++)
      write(join(ownerDir, "many", `f${String(i).padStart(2, "0")}`), "");
    const shown = Array.from({ length: 50 }, (_, i) => `many/f${String(i).padStart(2, "0")}`);
    expect(await list("many")).toBe(`Files in many: ${shown.join(", ")}, …and 10 more`);
  });

  test("a path out of the skill's folder is an error, never an approval", async () => {
    const { dataHome, policy, skills } = await fixture();
    const skill = createSkillTool(skills, policy);
    for (const path of [
      "../../credentials.json",
      join(dataHome, "credentials.json"),
      "../release-notes/SKILL.md",
      "/etc/hosts",
    ]) {
      expect(await skill.execute({ name: "house-style", path }, toolContext())).toEqual({
        content: `${path} is outside the skill house-style's folder`,
        isError: true,
      });
    }
  });

  test("a file linked out of the skill's folder is refused", async () => {
    const { policy, skills } = await fixture();
    expect(
      await createSkillTool(skills, policy).execute(
        { name: "house-style", path: "references/key" },
        toolContext(),
      ),
    ).toEqual({
      content: "references/key is outside the skill house-style's folder",
      isError: true,
    });
  });

  test("a dot-file or dot-folder in a skill's folder is refused, and never listed", async () => {
    const { ownerDir, policy, skills } = await fixture();
    symlinkSync(".env", join(ownerDir, "notes.md"));
    symlinkSync(".git", join(ownerDir, "repo"));
    const skill = createSkillTool(skills, policy);
    for (const path of [
      ".env",
      ".git/config",
      "references/../.env",
      join(ownerDir, ".env"),
      ".nothing-here",
      "notes.md",
      "repo/config",
    ]) {
      expect(await skill.execute({ name: "house-style", path }, toolContext())).toEqual({
        content: `${path} is hidden: skill doesn't read dot-files or dot-folders`,
        isError: true,
      });
    }
    const listing = (await skill.execute({ name: "house-style", path: "." }, toolContext()))
      .content;
    expect(listing).not.toMatch(/\.env|\.git|notes\.md|repo/);
  });

  test("a folder skill's file the task's policy denies is refused; the owner's skills never ask it", async () => {
    const { folder, folderDir, skills } = await fixture();
    write(join(folderDir, "vendor", "notes.md"), "vendored");
    const guard = folderGuard(folder, [join(folderDir, "vendor")]);
    const skill = createSkillTool(skills, guard);
    expect(
      await skill.execute({ name: "release-notes", path: "vendor/notes.md" }, toolContext()),
    ).toEqual({
      content: `No task may read ${join(folderDir, "vendor", "notes.md")}`,
      isError: true,
    });
    expect(
      await skill.execute({ name: "release-notes", path: "template.md" }, toolContext()),
    ).toEqual({ content: "## {version}\n", files: { read: [join(folderDir, "template.md")] } });
    expect(guard.resolved).toContain(join(folderDir, "template.md"));
    const asked = guard.resolved.length;
    expect((await skill.execute({ name: "house-style" }, toolContext())).isError).toBeUndefined();
    expect(guard.resolved).toHaveLength(asked);
  });

  test("reads an owner's skill though the file tools may neither read nor write the data home's skills", async () => {
    const { dataHome, ownerDir, policy, skills } = await fixture();
    const path = join(ownerDir, "SKILL.md");
    expect(await createReadTool(policy).execute({ path }, toolContext())).toEqual({
      content: `No task may read ${path}, whatever access it is given.`,
      isError: true,
    });
    for (const planted of [path, join(skillsDir(dataHome), "new", "SKILL.md")]) {
      expect(
        await createWriteTool(policy).execute(
          { path: planted, content: "---\ndescription: Planted.\n---\n" },
          toolContext(),
        ),
      ).toEqual({
        content: `No task may write ${planted}, whatever access it is given.`,
        isError: true,
      });
    }
    const loaded = await createSkillTool(skills, policy).execute(
      { name: "house-style" },
      toolContext(),
    );
    expect(loaded.isError).toBeUndefined();
    expect(loaded.content).toContain("Every page starts with the comment `<!-- house-style -->`");
  });

  test("a long SKILL.md is cut as read cuts it, and offset reads on", async () => {
    const { ownerDir, policy, skills } = await fixture();
    const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
    write(
      join(ownerDir, "SKILL.md"),
      `---\nname: house-style\ndescription: Long.\n---\n${lines.join("\n")}`,
    );
    const skill = createSkillTool(skills, policy);
    const header = `Skill house-style (the owner's), in ${ownerDir}. Paths in it are relative to that folder; read its files with skill and their path.\n\n`;
    const files =
      "\n\nFiles in its folder: assets/logo.svg, references/colors.md, scripts/build.sh";
    const first = await skill.execute({ name: "house-style" }, toolContext());
    expect(first.content).toStartWith(`${header}---\nname: house-style\n`);
    expect(first.content).toEndWith(
      `Line 1996\n\n[Showing lines 1-2000 of 2504. Use offset=2001 to continue.]${files}`,
    );
    expect(first.details).toMatchObject({ truncation: { truncated: true, truncatedBy: "lines" } });
    const next = await skill.execute({ name: "house-style", offset: 2001 }, toolContext());
    expect(next.content).toStartWith(`${header}Line 1997\n`);
    expect(next.content).toEndWith(`Line 2500${files}`);
  });

  test("its name is an enum of the listed skills, and a missing file says so", async () => {
    const { policy, skills } = await fixture();
    const skill = createSkillTool(skills, policy);
    expect(skill.schema).toEqual({
      name: "skill",
      description:
        "Load a skill listed in <skills> or <requested_skills>: its SKILL.md, or with path, another file in its folder, or the list of a folder in it. Output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit to read on.",
      properties: {
        name: {
          type: "string",
          enum: ["house-style", "release-notes"],
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
    });
    expect([skill.snippet, skill.guidelines, skill.replay, skill.executionMode]).toEqual([
      "Load a skill's instructions, or a file in its folder",
      [],
      "safe",
      undefined,
    ]);
    expect(await skill.execute({ name: "nope" }, toolContext())).toEqual({
      content: "No skill is named nope.",
      isError: true,
    });
    expect((await skill.execute({ name: 7 }, toolContext())).content).toStartWith(
      'Validation failed for tool "skill":\n  - name: expected string, got integer',
    );
    expect(
      await skill.execute({ name: "house-style", path: "references/forms.md" }, toolContext()),
    ).toEqual({
      content: "references/forms.md isn't in the skill house-style's folder",
      isError: true,
    });
  });
});

describe("taskSkills", () => {
  test("a skill she named is carried whole, as skill reads it, and loads although no catalog lists it", async () => {
    const { dataHome, folder, ownerDir, policy } = await fixture();
    const deployDir = join(skillsDir(dataHome), "deploy");
    write(
      join(deployDir, "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy the site.\ndisable-model-invocation: true\n---\n\nRun the deploy script.\n",
    );
    const catalog = await loadSkills({ dataHome, folder, requested: ["deploy", "house-style"] });
    expect(catalog.skills.map((skill) => skill.name)).toEqual(["house-style", "release-notes"]);
    const { loadable, requested, unreadable } = await taskSkills(catalog, policy, 128_000);
    expect(loadable.map((skill) => skill.name)).toEqual(["house-style", "release-notes", "deploy"]);
    expect(unreadable).toEqual([]);
    const tool = createSkillTool(loadable, policy);
    expect(requested.map(({ skill, text }) => [skill.name, text])).toEqual([
      ["deploy", (await tool.execute({ name: "deploy" }, toolContext())).content],
      ["house-style", (await tool.execute({ name: "house-style" }, toolContext())).content],
    ]);
    expect(requested[0]?.text).toStartWith(
      `Skill deploy (the owner's), in ${deployDir}. Paths in it are relative to that folder;`,
    );
    expect(requested[1]?.text).toContain(`${ownerDir}`);
  });

  test("a long SKILL.md is carried cut where skill cuts it, saying where to read on; past a quarter of the context, a skill is named to load", async () => {
    const { dataHome, folder, policy } = await fixture();
    const rules = Array.from({ length: 2105 }, (_, i) => `- Rule ${i + 1}.`).join("\n");
    write(
      join(skillsDir(dataHome), "long-rules", "SKILL.md"),
      `---\nname: long-rules\ndescription: Many rules.\ndisable-model-invocation: true\n---\n${rules}\n`,
    );
    const catalog = await loadSkills({
      dataHome,
      folder,
      requested: ["long-rules", "house-style"],
    });
    const roomy = await taskSkills(catalog, policy, 128_000);
    const [long, house] = roomy.requested;
    expect(long?.text.includes("- Rule 1995.")).toBe(true);
    expect(long?.text.includes("- Rule 2105.")).toBe(false);
    expect(
      long?.text.endsWith("\n\n[Showing lines 1-2000 of 2111. Use offset=2001 to continue.]"),
    ).toBe(true);
    expect(house?.text).toContain("font-family: Georgia");
    // Cut, the long one is about 6,500 tokens: past a quarter of 20,000, so it is named to load.
    const tight = await taskSkills(catalog, policy, 20_000);
    expect(tight.requested.map(({ skill, text }) => [skill.name, text.slice(0, 40)])).toEqual([
      ["long-rules", SKILL_LEFT_TO_LOAD.slice(0, 40)],
      ["house-style", house?.text.slice(0, 40)],
    ]);
    // Named to load, it loads, though no catalog lists a skill that opts out of model use.
    expect(tight.loadable.map((skill) => skill.name)).toEqual([
      "house-style",
      "release-notes",
      "long-rules",
    ]);
    // With contextTokens at 0 (unlimited), requested skills use the 32,000-token inline budget.
    const unlimited = await taskSkills(catalog, policy, 0);
    expect(
      unlimited.requested.map(({ skill, text }) => [skill.name, text.includes("- Rule 1995.")]),
    ).toEqual([
      ["long-rules", true],
      ["house-style", false],
    ]);
    expect(unlimited.requested[1]?.text).toContain("font-family: Georgia");
  });

  test("a named skill whose SKILL.md is gone since the scan is unreadable, and nothing else changes", async () => {
    const { dataHome, folder, ownerDir, policy } = await fixture();
    const catalog = await loadSkills({ dataHome, folder, requested: ["house-style"] });
    renameSync(join(ownerDir, "SKILL.md"), join(ownerDir, "SKILL.md.old"));
    const { loadable, requested, unreadable } = await taskSkills(catalog, policy, 128_000);
    expect(loadable.map((skill) => skill.name)).toEqual(["house-style", "release-notes"]);
    expect(requested).toEqual([]);
    expect(unreadable).toEqual([
      {
        path: join(ownerDir, "SKILL.md"),
        message: "SKILL.md isn't in the skill house-style's folder",
        skipped: true,
      },
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import type { SkillView } from "@/lib/api";
import { isSkillName, visibleSkills } from "./skills";

const skill = (name: string, changes: Partial<SkillView> = {}): SkillView => ({
  name,
  description: `How to ${name}.`,
  source: "eidolon",
  folder: `~/.laplace/eidolon/skills/${name}`,
  enabled: true,
  problems: [],
  ...changes,
});

const SKILLS = [
  skill("house-style", { description: "Our house style for every web page." }),
  skill("ship", { source: "shared", folder: "~/.agents/skills/ship" }),
  skill("deploy", { source: "shared", folder: "~/.agents/skills/deploy", enabled: false }),
  skill("persona-update", { source: "builtin", folder: "~/eidolon/skills/persona-update" }),
];

const names = (skills: readonly SkillView[]) => skills.map((each) => each.name);

describe("visibleSkills", () => {
  test("a source keeps its own, and off keeps those switched off from any", () => {
    expect(names(visibleSkills(SKILLS, "all", ""))).toEqual([
      "house-style",
      "ship",
      "deploy",
      "persona-update",
    ]);
    expect(names(visibleSkills(SKILLS, "eidolon", ""))).toEqual(["house-style"]);
    expect(names(visibleSkills(SKILLS, "shared", ""))).toEqual(["ship", "deploy"]);
    expect(names(visibleSkills(SKILLS, "builtin", ""))).toEqual(["persona-update"]);
    expect(names(visibleSkills(SKILLS, "off", ""))).toEqual(["deploy"]);
  });

  test("each word of the search is in its name, description or folder, case aside", () => {
    expect(names(visibleSkills(SKILLS, "all", "  WEB  page "))).toEqual(["house-style"]);
    expect(names(visibleSkills(SKILLS, "all", ".agents"))).toEqual(["ship", "deploy"]);
    expect(names(visibleSkills(SKILLS, "shared", "ship deploy"))).toEqual([]);
    expect(names(visibleSkills(SKILLS, "eidolon", "ship"))).toEqual([]);
  });
});

describe("isSkillName", () => {
  test("lowercase letters and digits that single hyphens join, 64 at most", () => {
    for (const name of ["ship", "house-style", "a1-b2-c3", "x".repeat(64)]) {
      expect(isSkillName(name)).toBe(true);
    }
    for (const name of ["", "Ship", "house style", "-ship", "ship-", "ship--it", "x".repeat(65)]) {
      expect(isSkillName(name)).toBe(false);
    }
  });
});

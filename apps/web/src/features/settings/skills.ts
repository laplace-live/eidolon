// The owner's skills: which of them Settings' Skills card shows, which she can be asked for by name,
// and the names a new skill may take.
import { queryOptions } from "@tanstack/react-query";
import { call, type SkillsResponse, type SkillView } from "@/lib/api";

export const skillsQuery = queryOptions({
  queryKey: ["assistant", "skills"],
  queryFn: ({ signal }) => call("GET /api/local/skills", { signal }),
  // Skill folders change outside the app.
  refetchOnWindowFocus: true,
});

export const SKILL_FILTERS = ["all", "eidolon", "shared", "off"] as const;
export type SkillFilter = (typeof SKILL_FILTERS)[number];

/**
 * The skills `filter` keeps, a source's or those switched off, whose name, description or folder
 * holds each word of `search`, case aside.
 */
export function visibleSkills(
  skills: readonly SkillView[],
  filter: SkillFilter,
  search: string,
): SkillView[] {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  return skills.filter((skill) => {
    if (filter === "off" ? skill.enabled : filter !== "all" && skill.source !== filter) {
      return false;
    }
    const text = `${skill.name}\n${skill.description}\n${skill.folder}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function nameableSkills({ skills }: SkillsResponse): SkillView[] {
  return skills.filter((skill) => skill.nameable === true);
}

/** agentskills.io's names: runs of lowercase letters and digits, single hyphens, 64 at most. */
export function isSkillName(name: string): boolean {
  return /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

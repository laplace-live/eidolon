// The owner's skills, for Settings and for her start_task: what the data home's skills folder and
// the folder the owner's agents share hold, and the owner's switches, which this process alone
// writes, to the data home's skills.json.
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  byName,
  catalogOf,
  type FoundSkill,
  MAX_DESCRIPTION_LENGTH,
  MAX_SKILL_BYTES,
  oneLine,
  replaceJsonFile,
  SKILL_FILE,
  type SkillScan,
  scanSkills,
  skillNames,
  skillSwitchesPath,
  skillsDir,
  validateName,
} from "@eidolon/assistant";
import { sharedSkillsDir } from "@eidolon/config";
import type { SkillCreate, SkillOrigin, SkillsResponse, SkillView } from "../api.ts";
import { homed } from "./places.ts";

const ORIGINS = { owner: "eidolon", shared: "shared" } as const satisfies Record<
  "owner" | "shared",
  SkillOrigin
>;

type SkillCreateResult = SkillsResponse | "exists" | { readonly invalid: string };

export class OwnerSkills {
  readonly #dataHome: string;
  readonly #home = homedir();
  /** Her names for start_task as the latest scan found them. */
  #names: readonly string[] = [];
  /** Scans started, and the latest whose names stand: an older scan ending later changes none. */
  #started = 0;
  #applied = 0;
  #background: Promise<unknown> | null = null;
  #writes: Promise<unknown> = Promise.resolve();

  constructor(dataHome: string) {
    this.#dataHome = dataHome;
  }

  /**
   * Her names as the latest scan found them, for a turn that can't wait: each call starts another
   * scan for the next turn, unless one is running.
   */
  names(): readonly string[] {
    this.#background ??= this.#scan().finally(() => {
      this.#background = null;
    });
    return this.#names;
  }

  /** The owner's skills as their folders hold them now. */
  async view(): Promise<SkillsResponse> {
    return this.#view(await this.#scan());
  }

  /** Switches the skills named `name` on or off; null when the owner has none by that name. */
  change(name: string, enabled: boolean): Promise<SkillsResponse | null> {
    return this.#serial(async () => {
      const scan = await this.#scan();
      if (!scan.winners.has(name)) return null;
      // A skills.json that doesn't read switched nothing off, and is written anew.
      const disabled = new Set(scan.disabled);
      if (enabled) disabled.delete(name);
      else disabled.add(name);
      await mkdir(this.#dataHome, { recursive: true });
      await replaceJsonFile(skillSwitchesPath(this.#dataHome), { disabled: [...disabled].sort() });
      return this.#view(await this.#scan());
    });
  }

  /** Writes a new skill into the data home's skills folder, unless one by that name is there. */
  create(input: SkillCreate): Promise<SkillCreateResult> {
    return this.#serial(async () => {
      const name = input.name.trim();
      const description = oneLine(input.description);
      const instructions = input.instructions.trim();
      const naming = validateName(name);
      if (name === "" || naming.length > 0) {
        return {
          invalid: name === "" ? "A skill needs a name" : `Its ${naming.join(", and its ")}`,
        };
      }
      if (description === "") return { invalid: "A skill needs a description" };
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        return { invalid: `A description is ${MAX_DESCRIPTION_LENGTH} characters at most` };
      }
      if (instructions === "") return { invalid: "A skill needs instructions" };
      // A JSON string is a YAML one, quoted, whatever the description holds.
      const text = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${instructions}\n`;
      if (Buffer.byteLength(text) > MAX_SKILL_BYTES) {
        return { invalid: "A SKILL.md is 256 KB at most, and tasks skip a larger one" };
      }
      const root = skillsDir(this.#dataHome);
      await mkdir(root, { recursive: true });
      try {
        await mkdir(join(root, name));
      } catch (error) {
        if ((error as { code?: unknown }).code === "EEXIST") return "exists";
        throw error;
      }
      await writeFile(join(root, name, SKILL_FILE), text, { flag: "wx" });
      return this.#view(await this.#scan());
    });
  }

  #scan(): Promise<SkillScan> {
    const turn = ++this.#started;
    return scanSkills({ dataHome: this.#dataHome, shared: sharedSkillsDir() }).then((scan) => {
      if (turn > this.#applied) {
        this.#applied = turn;
        this.#names = skillNames(scan);
      }
      return scan;
    });
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#writes.then(work);
    this.#writes = next.catch(() => {});
    return next;
  }

  async #view(scan: SkillScan): Promise<SkillsResponse> {
    const home = this.#home;
    const roots = { owner: skillsDir(this.#dataHome), shared: sharedSkillsDir() };
    // So a link on the way to a skill shows where its files are, and the roots' own links don't.
    const real = {
      owner: await realpath(roots.owner).catch(() => roots.owner),
      shared: await realpath(roots.shared).catch(() => roots.shared),
    };
    const unlisted = new Set(catalogOf(scan).unlisted);
    const found = new Set(scan.found.map((each) => each.path));
    const notes = new Map<string, string[]>();
    const skipped: { path: string; message: string }[] = [];
    for (const { path, message, skipped: left } of scan.problems) {
      // A found skill left out was shadowed, which `winners` says.
      if (!found.has(path)) skipped.push({ path: homed(path, home), message });
      else if (!left) notes.set(path, [...(notes.get(path) ?? []), message]);
    }
    const view = (each: FoundSkill): SkillView => {
      const { skill } = each;
      const source = skill.source === "shared" ? "shared" : "owner";
      const folder = dirname(each.path);
      const winner = scan.winners.get(skill.name);
      return {
        name: skill.name,
        description: skill.description,
        source: ORIGINS[source],
        folder: homed(folder, home),
        ...(join(real[source], relative(roots[source], folder)) === skill.dir
          ? {}
          : { linksTo: homed(skill.dir, home) }),
        enabled: !scan.disabled.has(skill.name),
        ...(each.explicit ? { onlyWhenNamed: true as const } : {}),
        ...(unlisted.has(skill) ? { unlisted: true as const } : {}),
        ...(winner === undefined || winner === each
          ? {}
          : { shadowedBy: homed(dirname(winner.path), home) }),
        problems: notes.get(each.path) ?? [],
      };
    };
    return {
      sources: [
        { id: ORIGINS.owner, path: homed(roots.owner, home) },
        { id: ORIGINS.shared, path: homed(roots.shared, home) },
      ],
      // Stable: a skill and one it shadows keep the scan's order.
      skills: scan.found.map(view).sort((a, b) => byName(a.name, b.name)),
      skipped,
      errors:
        scan.switchesProblem === null
          ? []
          : [
              `skills.json ${scan.switchesProblem}, so every skill is on until it's fixed or a switch is changed, which writes it anew`,
            ],
    };
  }
}

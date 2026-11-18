// The commands the owner allowed for good from tasks' cards: what each allows, the file they live
// in, and that answers given at once never lose one another's.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AllowedCommands } from "../../src/local/tasks/commands.ts";
import { placeOf } from "../../src/local/tasks/places.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";

let root = "";
let path = "";
let clock = 0;
let logs: CapturedLogs;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eidolon-commands-"));
  path = join(root, "tasks", "allowed-commands.json");
  clock = 1_700_000_000_000;
  logs = captureLogs();
});

afterEach(() => {
  logs.restore();
  rmSync(root, { recursive: true, force: true });
});

function store(): AllowedCommands {
  return new AllowedCommands(path, () => clock++);
}

describe("allowed commands", () => {
  test("allow exactly the command, in exactly the folder: no other command, folder or subfolder", async () => {
    const allowed = store();
    await allowed.add("/work/site", "npm test", "task-1");
    expect(await allowed.allows("/work/site", "npm test")).toBe(true);
    for (const [folder, command] of [
      ["/work/site", "npm test -- --watch"],
      ["/work/site", "npm  test"],
      ["/work/site", " npm test"],
      ["/work/site/sub", "npm test"],
      ["/work", "npm test"],
      ["/work/other", "npm test"],
    ]) {
      expect([folder, command, await allowed.allows(folder as string, command as string)]).toEqual([
        folder,
        command,
        false,
      ]);
    }
    // The folders are realpaths, which give a case-insensitive volume's own case: on a
    // case-sensitive one, /Volumes/Code/App and /Volumes/Code/app are two folders.
    expect(await allowed.allows("/WORK/Site", "npm test")).toBe(false);
    expect(await allowed.allows("/work/site", "NPM TEST")).toBe(false);
  });

  test("a folder named in another case keeps its grant where the volume ignores case, through its realpath", async () => {
    mkdirSync(join(root, "Site"));
    const allowed = store();
    await allowed.add(await placeOf(join(root, "Site")), "npm test", "task-1");
    // A case-sensitive volume has no such folder, and the realpath keeps the case asked for.
    const ignoresCase = existsSync(join(root, "site"));
    expect(await allowed.allows(await placeOf(join(root, "site")), "npm test")).toBe(ignoresCase);
  });

  test("are listed newest first, each once, with the task whose card added it", async () => {
    const allowed = store();
    await allowed.add("/a", "make", "task-1");
    await allowed.add("/a", "make", "task-2");
    await allowed.add("/b", "make", "task-2");
    const listed = await allowed.list();
    expect(
      listed.map(({ folder, command, task, addedAt }) => [folder, command, task, addedAt]),
    ).toEqual([
      ["/b", "make", "task-2", 1_700_000_000_001],
      ["/a", "make", "task-1", 1_700_000_000_000],
    ]);
    for (const { id } of listed) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    // A second store on the file, as at the next start, reads the same.
    expect(await store().list()).toEqual(listed);
  });

  test("one taken back asks again; an id none has takes nothing", async () => {
    const allowed = store();
    await allowed.add("/a", "make", "task-1");
    await allowed.add("/a", "make test", "task-1");
    const [newest, oldest] = await allowed.list();
    expect(await allowed.remove(Bun.randomUUIDv7())).toBe(false);
    expect(await allowed.remove(newest?.id as string)).toBe(true);
    expect(await allowed.remove(newest?.id as string)).toBe(false);
    expect(await allowed.list()).toEqual([oldest]);
    expect(await allowed.allows("/a", "make test")).toBe(false);
    expect(await store().allows("/a", "make test")).toBe(false);
  });

  test("live in one file, 0600, in a 0700 folder, replaced whole with no temp file left", async () => {
    const allowed = store();
    // So the modes the code asks for show: a umask of 077 makes every file 0600 whatever it asks.
    const umask = process.umask(0o022);
    try {
      await allowed.add("/a", "make", "task-1");
      await allowed.add("/a", "ls", "task-1");
    } finally {
      process.umask(umask);
    }
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "tasks")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(root, "tasks"))).toEqual(["allowed-commands.json"]);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.v).toBe(1);
    expect(saved.commands.map((each: { command: string }) => each.command)).toEqual(["make", "ls"]);
  });

  test("a file that isn't one reads as none, so every command asks, and the next one allowed replaces it", async () => {
    for (const text of ["{", '{"v":2,"commands":[]}', '{"v":1,"commands":"make"}']) {
      await store().add("/seed", "seed", "task-0");
      writeFileSync(path, text);
      const fresh = store();
      expect([text, await fresh.allows("/seed", "seed")]).toEqual([text, false]);
      await fresh.add("/a", "make", "task-1");
      expect((await store().list()).map((each) => each.command)).toEqual(["make"]);
      rmSync(path);
    }
    expect(logs.lines().filter((line) => line.startsWith("WARNING"))).toHaveLength(3);
    // Entries that aren't whole are dropped, the rest kept.
    writeFileSync(
      path,
      JSON.stringify({
        v: 1,
        commands: [
          { id: "x", folder: "/a", command: "make", addedAt: 1, task: "t" },
          { id: "y", folder: "/a", command: 7, addedAt: 1, task: "t" },
        ],
      }),
    );
    expect((await store().list()).map((each) => each.id)).toEqual(["x"]);
  });

  test("writes go one at a time: answers given at once and a removal all land", async () => {
    const allowed = store();
    await allowed.add("/a", "keep", "task-0");
    await allowed.add("/a", "drop", "task-0");
    const drop = (await allowed.list()).find((each) => each.command === "drop");
    await Promise.all([
      allowed.add("/a", "one", "task-1"),
      allowed.add("/b", "two", "task-2"),
      allowed.remove(drop?.id as string),
      allowed.add("/c", "three", "task-3"),
    ]);
    const kept = (await store().list()).map((each) => each.command).sort();
    expect(kept).toEqual(["keep", "one", "three", "two"]);
  });
});

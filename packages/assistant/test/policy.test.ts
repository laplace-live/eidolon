import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderPolicy, type FolderPolicyOptions, GrantRefused } from "../src/policy.ts";

const root = mkdtempSync(join(tmpdir(), "grants-"));
// macOS's temp folder lies under a symlink (/var is /private/var), as /tmp does.
const rootOnDisk = realpathSync(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** `path`, under the temp folder, as it lies on disk. */
function onDisk(path: string): string {
  return path.replace(root, rootOnDisk);
}

let cases = 0;

/** A home with the task's folder in it, and a folder outside every grant. */
function layout() {
  const base = join(root, `case-${cases++}`);
  const home = join(base, "home");
  const folder = join(home, "projects", "app");
  const outside = join(base, "outside");
  mkdirSync(folder, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "");
  const options: FolderPolicyOptions = {
    folder,
    grants: [],
    home,
    dataHome: join(home, ".laplace", "eidolon"),
    appRoot: join(home, "Git", "laplace-eidolon"),
  };
  return { base, home, folder, outside, options };
}

describe("FolderPolicy", () => {
  test("the folder is read-write, and a path resolves to where it lies on disk", async () => {
    const { folder, options } = layout();
    writeFileSync(join(folder, "index.html"), "");
    const policy = new FolderPolicy(options);
    expect(policy.folder).toBe(folder);
    for (const access of ["read", "write"] as const) {
      expect(await policy.resolve("index.html", access)).toBe(onDisk(join(folder, "index.html")));
    }
    expect(await policy.resolve(join(folder, "src", "main.ts"), "write")).toBe(
      onDisk(join(folder, "src", "main.ts")),
    );
    expect(await policy.resolve("src/../index.html", "read")).toBe(
      onDisk(join(folder, "index.html")),
    );
  });

  test("a folder not made yet is checked through its deepest existing ancestor", async () => {
    const { home, options } = layout();
    const folder = join(home, "projects", "todo", "web");
    const policy = new FolderPolicy({ ...options, folder });
    expect(await policy.resolve("css/app.css", "write")).toBe(
      onDisk(join(folder, "css", "app.css")),
    );
    await expect(policy.resolve("../notes.txt", "write")).rejects.toMatchObject({
      why: "outside",
      path: onDisk(join(home, "projects", "todo", "notes.txt")),
    });
  });

  test("`..` can't climb out of the grants", async () => {
    const { folder, outside, options } = layout();
    const policy = new FolderPolicy(options);
    const secret = onDisk(join(outside, "secret.txt"));
    await expect(policy.resolve("../../../outside/secret.txt", "read")).rejects.toMatchObject({
      name: "PathRefused",
      path: secret,
      access: "read",
      why: "outside",
      message: `${secret} is outside the folders this task may read`,
    });
    await expect(policy.resolve(`${folder}/../app-2/index.html`, "write")).rejects.toMatchObject({
      why: "outside",
    });
  });

  test("a symlink out of the grants is followed and refused; one into them is followed", async () => {
    const { folder, outside, options } = layout();
    symlinkSync(outside, join(folder, "link"));
    writeFileSync(join(folder, "index.html"), "");
    symlinkSync(join(folder, "index.html"), join(outside, "back"));
    const policy = new FolderPolicy(options);
    await expect(policy.resolve("link/secret.txt", "read")).rejects.toMatchObject({
      why: "outside",
      path: onDisk(join(outside, "secret.txt")),
    });
    await expect(policy.resolve("link/new.txt", "write")).rejects.toMatchObject({
      why: "outside",
      path: onDisk(join(outside, "new.txt")),
    });
    expect(await policy.resolve(join(outside, "back"), "write")).toBe(
      onDisk(join(folder, "index.html")),
    );
  });

  test("a dangling symlink is followed to where a write through it would land", async () => {
    const { folder, outside, options } = layout();
    symlinkSync(join(outside, "agent.plist"), join(folder, "notes.md"));
    symlinkSync("../../../outside/relative.txt", join(folder, "relative.md"));
    symlinkSync(join(folder, "later.txt"), join(folder, "alias.txt"));
    const policy = new FolderPolicy(options);
    await expect(policy.resolve("notes.md", "write")).rejects.toMatchObject({
      why: "outside",
      path: onDisk(join(outside, "agent.plist")),
    });
    await expect(policy.resolve("relative.md", "write")).rejects.toMatchObject({
      why: "outside",
      path: onDisk(join(outside, "relative.txt")),
    });
    expect(await policy.resolve("alias.txt", "write")).toBe(onDisk(join(folder, "later.txt")));
  });

  test("a folder is the same under any name for it, as /tmp is /private/tmp", async () => {
    const { base, folder, options } = layout();
    const alias = join(base, "alias");
    symlinkSync(folder, alias);
    const file = onDisk(join(folder, "a.txt"));
    for (const named of [alias, onDisk(folder)]) {
      const policy = new FolderPolicy({ ...options, folder: named });
      expect(await policy.resolve(join(folder, "a.txt"), "write")).toBe(file);
      expect(await policy.resolve(join(alias, "a.txt"), "write")).toBe(file);
      expect(await policy.resolve(file, "write")).toBe(file);
    }
  });

  test("the deny list holds inside a grant, however the path reaches it", async () => {
    const { home, folder, options } = layout();
    const { dataHome, appRoot } = options;
    for (const dir of [join(home, ".config", "gh"), join(home, ".ssh"), dataHome, appRoot]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(home, ".ssh", "id_ed25519"), "");
    symlinkSync(join(home, ".ssh"), join(folder, "keys"));
    const policy = new FolderPolicy({
      ...options,
      grants: [
        { path: join(home, ".config"), access: "read-write" },
        { path: join(home, ".laplace"), access: "read-write" },
        { path: join(home, "Git"), access: "read-write" },
      ],
    });
    const denied: [string, "read" | "write"][] = [
      [join(home, ".config", "gh", "hosts.yml"), "read"],
      [dataHome, "read"],
      [join(dataHome, "credentials.json"), "read"],
      [join(dataHome, "tasks", "next", "task.json"), "write"],
      [join(appRoot, ".env"), "read"],
      [join(appRoot, "packages", "new.ts"), "write"],
      ["keys/id_ed25519", "read"],
    ];
    for (const [path, access] of denied) {
      await expect(policy.resolve(path, access)).rejects.toMatchObject({ why: "denied", access });
    }
    for (const path of [
      join(home, ".config", "app.toml"),
      join(home, ".laplace", "notes.md"),
      join(home, "Git", "other", "main.ts"),
    ]) {
      expect(await policy.resolve(path, "write")).toBe(onDisk(path));
    }
  });

  test("each of the owner's credential places is denied even when granted outright", async () => {
    const { home, options } = layout();
    for (const name of [".ssh", ".gnupg", ".aws", ".config/gh", ".netrc", ".git-credentials"]) {
      const place = join(home, name);
      const policy = new FolderPolicy({
        ...options,
        grants: [{ path: place, access: "read-write" }],
      });
      await expect(policy.resolve(place, "read")).rejects.toMatchObject({
        why: "denied",
        message: `No task may read ${onDisk(place)}`,
      });
    }
  });

  test("/, home and any folder holding home are refused as grants", () => {
    const { base, home, options } = layout();
    symlinkSync(home, join(base, "home-link"));
    for (const path of [
      "/",
      home,
      `${home}/`,
      "~",
      base,
      join(home, "projects", ".."),
      join(base, "home-link"),
    ]) {
      expect(() => new FolderPolicy({ ...options, grants: [{ path, access: "read" }] })).toThrow(
        GrantRefused,
      );
    }
    for (const folder of [home, "~", "/"]) {
      expect(() => new FolderPolicy({ ...options, folder })).toThrow(GrantRefused);
    }
    expect(() => new FolderPolicy({ ...options, grants: [{ path: "/", access: "read" }] })).toThrow(
      "No task may be granted /: it is or holds the home folder",
    );
    const policy = new FolderPolicy({
      ...options,
      grants: [{ path: join(home, "Git"), access: "read-write" }],
    });
    expect(policy.folder).toBe(options.folder);
  });

  test("a read-only grant can be read but not written", async () => {
    const { base, options } = layout();
    const shared = join(base, "shared");
    mkdirSync(shared);
    writeFileSync(join(shared, "data.csv"), "");
    const policy = new FolderPolicy({ ...options, grants: [{ path: shared, access: "read" }] });
    expect(await policy.resolve(join(shared, "data.csv"), "read")).toBe(
      onDisk(join(shared, "data.csv")),
    );
    for (const name of ["data.csv", "new.csv"]) {
      await expect(policy.resolve(join(shared, name), "write")).rejects.toMatchObject({
        why: "outside",
        access: "write",
        message: `${onDisk(join(shared, name))} is outside the folders this task may write`,
      });
    }
  });

  test("~ is the policy's home", async () => {
    const { home, folder, options } = layout();
    const policy = new FolderPolicy({ ...options, folder: "~/projects/app" });
    expect(policy.folder).toBe(folder);
    for (const path of ["~/projects/app/notes.md", "@~/projects/app/notes.md"]) {
      expect(await policy.resolve(path, "write")).toBe(onDisk(join(folder, "notes.md")));
    }
    await expect(policy.resolve("~/notes.md", "read")).rejects.toMatchObject({
      why: "outside",
      path: onDisk(join(home, "notes.md")),
    });
  });

  test("a read finds the name as macOS spelled it; a write takes the name as given", async () => {
    const { folder, options } = layout();
    const stored = "Screenshot 2026-11-16 at 10.00.00\u202fAM.png";
    const typed = "Screenshot 2026-11-16 at 10.00.00 AM.png";
    writeFileSync(join(folder, stored), "");
    const policy = new FolderPolicy(options);
    expect(await policy.resolve(typed, "read")).toBe(onDisk(join(folder, stored)));
    expect(await policy.resolve(typed, "write")).toBe(onDisk(join(folder, typed)));
  });

  test.if(process.platform === "darwin")(
    "on macOS a denied folder not made yet is denied in any letter case",
    async () => {
      const { home, options } = layout();
      mkdirSync(join(home, ".config"));
      const policy = new FolderPolicy({
        ...options,
        grants: [{ path: join(home, ".config"), access: "read-write" }],
      });
      await expect(
        policy.resolve(join(home, ".config", "GH", "hosts.yml"), "write"),
      ).rejects.toMatchObject({ why: "denied" });
    },
  );
});

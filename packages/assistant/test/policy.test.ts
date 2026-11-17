import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  test("a dangling link's `..` past a missing folder leads nowhere, as the kernel has it", async () => {
    const { home, folder, options } = layout();
    const repo = join(home, "Git", "evil");
    mkdirSync(repo, { recursive: true });
    // Read as text, ~ and / ; the kernel stops at the missing folder.
    symlinkSync("nope/../../..", join(repo, "docs"));
    symlinkSync("/nonexistent-eidolon-grant/..", join(repo, "site"));
    for (const name of ["docs", "site"]) {
      const linked = join(repo, name);
      const asFolder = new FolderPolicy({ ...options, folder: linked });
      await expect(asFolder.resolve(linked, "write")).rejects.toMatchObject({ code: "ENOENT" });
      const granted = new FolderPolicy({
        ...options,
        grants: [{ path: linked, access: "read-write" }],
      });
      for (const policy of [asFolder, granted]) {
        for (const [path, access] of [
          [join(home, "Library", "LaunchAgents", "x.plist"), "write"],
          [join(home, ".zshrc"), "write"],
          ["/etc/hosts", "read"],
        ] as const) {
          await expect(policy.resolve(path, access)).rejects.toMatchObject({ why: "outside" });
        }
      }
      // A grant that leads nowhere grants nothing, and takes nothing from the others.
      expect(await granted.resolve("index.html", "write")).toBe(onDisk(join(folder, "index.html")));
    }
  });

  test("a grant that comes to lead home once its missing folder is made grants nothing", async () => {
    const { home, options } = layout();
    const repo = join(home, "Git", "evil");
    const site = join(repo, "site");
    mkdirSync(site, { recursive: true });
    // Nowhere until site/.build or out is made, then home.
    symlinkSync("site/.build/../../../..", join(repo, "docs"));
    symlinkSync("out/../../..", join(repo, "notes"));
    const zshrc = join(home, ".zshrc");
    for (const [folder, grant, made] of [
      [site, "docs", join(site, ".build")],
      [join(repo, "out"), "notes", join(repo, "out")],
    ] as const) {
      const policy = new FolderPolicy({
        ...options,
        folder,
        grants: [{ path: join(repo, grant), access: "read-write" }],
      });
      // As laplace-task makes the folder, or the write tool a folder in it.
      mkdirSync(await policy.resolve(made, "write"));
      for (const path of [zshrc, join(home, "Library", "LaunchAgents", "x.plist")]) {
        await expect(policy.resolve(path, "write")).rejects.toMatchObject({ why: "outside" });
      }
      expect(await policy.resolve("index.html", "write")).toBe(onDisk(join(folder, "index.html")));
    }
  });

  test("a link whose target leads back to itself is refused, not followed forever", async () => {
    const { base, folder, options } = layout();
    symlinkSync("x/../README.md", join(folder, "README.md"));
    const loop = join(base, "proj");
    symlinkSync("y/../proj", loop);
    const policy = new FolderPolicy(options);
    const settled = (work: Promise<unknown>) =>
      Promise.race([work.then(String, String), Bun.sleep(2000).then(() => "still resolving")]);
    for (const access of ["read", "write"] as const) {
      expect(await settled(policy.resolve("README.md", access))).toStartWith("Error: ENOENT");
    }
    const looped = new FolderPolicy({ ...options, folder: loop });
    expect(await settled(looped.resolve(loop, "write"))).toStartWith("Error: ENOENT");
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

  test("nothing in a .git folder may be written, where git would run what it says", async () => {
    const { folder, options } = layout();
    mkdirSync(join(folder, ".git", "hooks"), { recursive: true });
    writeFileSync(join(folder, ".git", "config"), "[core]\n");
    symlinkSync(join(folder, ".git", "config"), join(folder, "settings.ini"));
    const policy = new FolderPolicy(options);
    for (const path of [
      ".git/config",
      ".git/hooks/pre-commit",
      ".git/info/attributes",
      ".git",
      "settings.ini",
      "vendor/lib/.git/config",
    ]) {
      await expect(policy.resolve(path, "write")).rejects.toMatchObject({
        why: "denied",
        access: "write",
      });
    }
    expect(await policy.resolve(".git/config", "read")).toBe(
      onDisk(join(folder, ".git", "config")),
    );
    for (const path of [".gitignore", ".github/workflows/ci.yml", "notes.git/a.txt"]) {
      expect(await policy.resolve(path, "write")).toBe(onDisk(join(folder, path)));
    }
  });

  test("nor in a folder git takes for a repository's own whatever its name, nor one a write would make", async () => {
    const { folder, options } = layout();
    const make = (path: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "");
    };
    // A bare repository, and the bare-repository-plus-worktrees layout with a worktree's own.
    for (const repo of ["site.git", "proj/.bare"]) {
      for (const piece of ["HEAD", "objects/info/packs", "refs/heads/.keep", "hooks/.keep"]) {
        make(join(folder, repo, piece));
      }
    }
    make(join(folder, "proj", ".bare", "worktrees", "main", "HEAD"));
    make(join(folder, "proj", ".bare", "worktrees", "main", "commondir"));
    const policy = new FolderPolicy(options);
    const refused = async (path: string) =>
      expect(policy.resolve(path, "write")).rejects.toMatchObject({
        why: "denied",
        access: "write",
      });
    for (const path of [
      "site.git/config",
      "site.git/hooks/post-receive",
      "proj/.bare/config",
      "proj/.bare/hooks/pre-commit",
      "proj/.bare/worktrees/main/config.worktree",
    ]) {
      await refused(path);
    }
    // Planted a piece at a time, as the write tool alone could: the last piece is refused.
    for (const pieces of [
      ["HEAD", "objects/info/packs", "refs/heads/main"],
      ["objects/info/packs", "refs/heads/main", "HEAD"],
      ["HEAD", "refs/heads/main", "objects/info/packs"],
      ["HEAD", "commondir"],
      ["commondir", "HEAD"],
    ]) {
      const planted = join(folder, "src", pieces.join("+").replaceAll("/", "_"));
      for (const piece of pieces.slice(0, -1)) make(join(planted, piece));
      await refused(join(planted, pieces.at(-1) as string));
    }
    // Reading is fine, and a HEAD, an objects or a refs alone is only a name.
    expect(await policy.resolve("site.git/config", "read")).toBe(
      onDisk(join(folder, "site.git", "config")),
    );
    for (const path of ["notes/HEAD", "assets/objects/a.png", "docs/refs/api.md"]) {
      expect(await policy.resolve(path, "write")).toBe(onDisk(join(folder, path)));
    }
  });

  test.if(process.platform === "darwin")(
    "on macOS a .git folder is .git in any letter case",
    async () => {
      const { options } = layout();
      const policy = new FolderPolicy(options);
      await expect(policy.resolve("sub/.GIT/config", "write")).rejects.toMatchObject({
        why: "denied",
      });
    },
  );

  test("the .env the app reads is denied, and from a worktree the main checkout it comes from", async () => {
    const { home, options } = layout();
    const main = join(home, "Git", "laplace-eidolon");
    const worktree = join(home, "orca", "workspaces", "laplace-eidolon", "feat");
    for (const dir of [join(main, "packages"), worktree, join(home, "Git", "other")]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(main, ".env"), "OPENROUTER_API_KEY=sk-or-secret\n");
    writeFileSync(join(home, "Git", ".env"), "TOKEN=secret\n");
    const grants = [{ path: join(home, "Git"), access: "read-write" } as const];
    // A worktree with no .env of its own reads its main checkout's.
    const fromWorktree = new FolderPolicy({
      ...options,
      grants,
      appRoot: worktree,
      dotenv: join(main, ".env"),
    });
    for (const [path, access] of [
      [join(main, ".env"), "read"],
      [join(main, "packages", "app.ts"), "write"],
    ] as const) {
      await expect(fromWorktree.resolve(path, access)).rejects.toMatchObject({ why: "denied" });
    }
    // One found above the checkout is denied alone.
    const fromAbove = new FolderPolicy({ ...options, grants, dotenv: join(home, "Git", ".env") });
    await expect(fromAbove.resolve(join(home, "Git", ".env"), "read")).rejects.toMatchObject({
      why: "denied",
    });
    for (const policy of [fromWorktree, fromAbove]) {
      expect(await policy.resolve(join(home, "Git", "other", "a.ts"), "write")).toBe(
        onDisk(join(home, "Git", "other", "a.ts")),
      );
    }
  });

  test("from a worktree, a main checkout's .env linked out of it is denied where it leads", async () => {
    const { home, options } = layout();
    const main = join(home, "Git", "laplace-eidolon");
    const worktree = join(home, "orca", "workspaces", "laplace-eidolon", "feat");
    for (const dir of [main, worktree, join(home, "Git", "secrets")]) {
      mkdirSync(dir, { recursive: true });
    }
    const keys = join(home, "Git", "secrets", "eidolon.env");
    writeFileSync(keys, "OPENROUTER_API_KEY=sk-or-secret\n");
    symlinkSync("../secrets/eidolon.env", join(main, ".env"));
    const policy = new FolderPolicy({
      ...options,
      grants: [{ path: join(home, "Git"), access: "read-write" }],
      appRoot: worktree,
      dotenv: join(main, ".env"),
    });
    for (const path of [join(main, ".env"), keys]) {
      await expect(policy.resolve(path, "read")).rejects.toMatchObject({ why: "denied" });
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

  test("home and any folder holding it are denied, never outside: no grant could open them", async () => {
    const { base, home, options } = layout();
    symlinkSync(home, join(base, "home-link"));
    const policy = new FolderPolicy({
      ...options,
      grants: [{ path: join(home, "Git"), access: "read-write" }],
    });
    for (const path of [
      "/",
      home,
      "~",
      base,
      join(home, "projects", ".."),
      join(base, "home-link"),
    ]) {
      for (const access of ["read", "write"] as const) {
        await expect(policy.resolve(path, access)).rejects.toMatchObject({ why: "denied", access });
      }
    }
    // A file right in home can be granted alone, so it is only outside.
    await expect(policy.resolve(join(home, "notes.txt"), "read")).rejects.toMatchObject({
      why: "outside",
    });
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

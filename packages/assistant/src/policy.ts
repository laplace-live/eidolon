// What a task may touch: its folder and the folders granted it, and never this app, its data or the
// owner's keys. Every decision is made on where a path lies on disk, so `..` and symlinks, dangling
// ones included, can't lead a task outside.
import { realpathSync } from "node:fs";
import { readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathExists, resolveReadPath, resolveToCwd } from "./tools/path.ts";
import { type PathGuard, PathRefused } from "./types.ts";

export interface FolderGrant {
  /** Absolute, or under ~. */
  readonly path: string;
  readonly access: "read" | "read-write";
}

export interface FolderPolicyOptions {
  /** The task's own folder, granted read-write. */
  readonly folder: string;
  readonly grants: readonly FolderGrant[];
  readonly home: string;
  readonly dataHome: string;
  /** EIDOLON_APP_ROOT, or the checkout. */
  readonly appRoot: string;
}

/** A grant of the home folder, or of a folder holding it: no task gets the whole home. */
export class GrantRefused extends Error {
  override name = "GrantRefused";
  readonly path: string;

  constructor(path: string) {
    super(`No task may be granted ${path}: it is or holds the home folder`);
    this.path = path;
  }
}

/** Under home, the owner's keys and credentials. */
const SECRETS = [".ssh", ".gnupg", ".aws", join(".config", "gh"), ".netrc", ".git-credentials"];

// APFS and NTFS match names in any case, so a denied folder not made yet has every spelling.
const fold =
  process.platform === "darwin" || process.platform === "win32"
    ? (path: string) => path.toLowerCase()
    : (path: string) => path;

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** `path` with a leading ~ meaning `home`; path.ts's ~ is the OS user's. */
function withHome(path: string, home: string): string {
  const bare = path.startsWith("@") ? path.slice(1) : path;
  return bare === "~" || bare.startsWith("~/") ? join(home, bare.slice(1)) : path;
}

/**
 * Where `path` leads on disk: its realpath, else its parent's plus its name, with a dangling
 * symlink followed to where a write through it would land.
 */
async function onDisk(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const parent = dirname(path);
  if (parent === path) return path;
  const here = join(await onDisk(parent), basename(path));
  let target: string;
  try {
    target = await readlink(here);
  } catch {
    return here;
  }
  return onDisk(resolve(dirname(here), target));
}

export class FolderPolicy implements PathGuard {
  readonly folder: string;
  readonly #home: string;
  readonly #grants: readonly FolderGrant[];
  readonly #denied: readonly string[];

  /** Throws GrantRefused for a grant, the folder included, that is or holds the home folder. */
  constructor(options: FolderPolicyOptions) {
    const home = resolve(options.home);
    const absolute = (path: string) => resolve(withHome(path, home));
    this.#home = home;
    this.folder = absolute(options.folder);
    this.#grants = [
      { path: this.folder, access: "read-write" },
      ...options.grants.map((grant) => ({ path: absolute(grant.path), access: grant.access })),
    ];
    // A folder not made yet holds nothing, home least of all.
    const real = (path: string) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    };
    for (const grant of this.#grants) {
      if (isInside(real(home), real(grant.path))) throw new GrantRefused(grant.path);
    }
    this.#denied = [
      resolve(options.dataHome),
      resolve(options.appRoot),
      ...SECRETS.map((name) => join(home, name)),
    ];
  }

  /**
   * Where `path`, against the folder and with ~ expanded, lies on disk, once `access` to it is
   * allowed; for a read of a name that isn't there, the spelling macOS may have given it.
   */
  async resolve(path: string, access: "read" | "write"): Promise<string> {
    const wanted = resolveToCwd(withHome(path, this.#home), this.folder);
    const found = await this.#allow(wanted, access);
    if (access === "write" || (await pathExists(found))) return found;
    const spelled = await resolveReadPath(wanted, this.folder);
    return spelled === wanted ? found : this.#allow(spelled, access);
  }

  async #allow(path: string, access: "read" | "write"): Promise<string> {
    const [target, denied, grants] = await Promise.all([
      onDisk(path),
      Promise.all(this.#denied.map(onDisk)),
      Promise.all(
        this.#grants.map(async (grant) => ({ ...grant, path: await onDisk(grant.path) })),
      ),
    ]);
    if (denied.some((place) => isInside(fold(target), fold(place)))) {
      throw new PathRefused(target, access, "denied");
    }
    const granted = grants.some(
      (grant) =>
        (access === "read" || grant.access === "read-write") && isInside(target, grant.path),
    );
    if (!granted) throw new PathRefused(target, access, "outside");
    return target;
  }
}

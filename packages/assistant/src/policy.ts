// What a task may touch: its folder and the folders granted it, and never this app, its data or the
// owner's keys, nor a repository's git directory to write. Every decision is made on where a path
// lies on disk, so `..` and symlinks, dangling ones included, can't lead a task outside.
import { realpathSync } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
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
  /**
   * The .env the app reads (findDotenv's), with the owner's keys. A linked worktree's is its main
   * checkout's, and that checkout is denied with it, unless the worktree lies inside it.
   */
  readonly dotenv?: string | null;
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
export const fold =
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

/** `path`'s realpath; a folder not made yet holds nothing, home least of all. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Why `path`, an absolute folder, can't be granted: it is or holds `home` on disk. Else null. */
export function grantRefusal(path: string, home: string): GrantRefused | null {
  return isInside(real(resolve(home)), real(path)) ? new GrantRefused(path) : null;
}

/**
 * Where `path` leads on disk: its realpath, else its parent's plus its name, with a dangling
 * symlink followed to where a write through it would land. Throws ENOENT where the kernel would.
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
  return onDisk(await linkTarget(dirname(here), target));
}

/**
 * A link's `target`, read from `folder`, the link's own: each `..` is taken on disk, as the kernel
 * takes it, so one after a missing folder or a file throws rather than collapsing as text would.
 */
async function linkTarget(folder: string, target: string): Promise<string> {
  let at = isAbsolute(target) ? parse(target).root : folder;
  for (const part of target.split(sep)) {
    if (part === "" || part === ".") continue;
    // realpath's own `..` is the kernel's, unlike path.resolve's.
    at = part === ".." ? await realpath(`${at}${sep}..`) : join(at, part);
  }
  return at;
}

/**
 * Whether `target`, once written, lies in a folder git takes for a git directory whatever its name
 * (is_git_directory in git's setup.c): a HEAD beside objects and refs, or beside a commondir saying
 * where they are. What the write would make there counts, so a task can't plant one.
 */
async function inGitDirectory(target: string): Promise<boolean> {
  for (let folder = dirname(target); ; folder = dirname(folder)) {
    const made = fold(relative(folder, target).split(sep)[0] as string);
    const has = async (name: string) =>
      made === fold(name) ||
      (await lstat(join(folder, name)).then(
        () => true,
        () => false,
      ));
    if (
      (await has("HEAD")) &&
      ((await has("commondir")) || ((await has("objects")) && (await has("refs"))))
    ) {
      return true;
    }
    if (dirname(folder) === folder) return false;
  }
}

export class FolderPolicy implements PathGuard {
  readonly folder: string;
  readonly #home: string;
  readonly #realHome: string;
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
    this.#realHome = real(home);
    for (const grant of this.#grants) {
      const refused = grantRefusal(grant.path, home);
      if (refused !== null) throw refused;
    }
    const appRoot = resolve(options.appRoot);
    const dotenv = options.dotenv ? resolve(options.dotenv) : null;
    // The .env is denied where it leads, and its folder with it when that doesn't hold the app root,
    // as a linked worktree's main checkout doesn't; one found above the checkout is denied alone.
    const dotenvPlaces =
      dotenv === null
        ? []
        : isInside(real(appRoot), real(dirname(dotenv)))
          ? [dotenv]
          : [dotenv, dirname(dotenv)];
    this.#denied = [
      resolve(options.dataHome),
      appRoot,
      ...dotenvPlaces,
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
        // A grant that leads nowhere grants nothing, nor one leading home: a link past a missing
        // folder can, once the task makes that folder.
        this.#grants.map((grant) =>
          onDisk(grant.path).then(
            (place) => (isInside(this.#realHome, place) ? null : { ...grant, path: place }),
            () => null,
          ),
        ),
      ),
    ]);
    if (denied.some((place) => isInside(fold(target), fold(place)))) {
      throw new PathRefused(target, access, "denied");
    }
    // git runs what a repository's own config and hooks say (core.fsmonitor on `git status`), and
    // shows no change to them.
    if (
      access === "write" &&
      (target.split(sep).some((part) => fold(part) === ".git") || (await inGitDirectory(target)))
    ) {
      throw new PathRefused(target, access, "denied");
    }
    const granted = grants.some(
      (grant) =>
        grant !== null &&
        (access === "read" || grant.access === "read-write") &&
        isInside(target, grant.path),
    );
    if (!granted) {
      // No grant may hold home, so there is nothing to ask the owner for.
      throw new PathRefused(
        target,
        access,
        isInside(this.#realHome, target) ? "denied" : "outside",
      );
    }
    return target;
  }
}

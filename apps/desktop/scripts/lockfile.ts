// bun.lock, read for npm: the versions a dependency tree resolves to there, as the `overrides` that
// pin an npm install to them, and what an install's `npm ls --all --json` shows that differs.
import { readFileSync } from "node:fs";

export interface LockMeta {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalPeers?: readonly string[];
  readonly os?: string | readonly string[];
  readonly cpu?: string | readonly string[];
}

export interface BunLock {
  /** By key: the names of the packages an entry nests under, then its own, joined by `/`. */
  readonly packages: Readonly<Record<string, readonly unknown[]>>;
}

export interface Locked {
  /** Its key, as names. */
  readonly path: readonly string[];
  readonly name: string;
  readonly version: string;
  readonly meta: LockMeta;
}

export interface Platform {
  readonly os: string;
  readonly cpu: string;
}

/** bun.lock's text: JSON with trailing commas. */
export function parseBunLock(text: string): BunLock {
  let json = "";
  let copied = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === ",") {
      let next = i + 1;
      while (/\s/.test(text[next] ?? "")) next++;
      if (text[next] === "}" || text[next] === "]") {
        json += text.slice(copied, i);
        copied = i + 1;
      }
    }
  }
  return JSON.parse(json + text.slice(copied)) as BunLock;
}

export function readBunLock(file: string): BunLock {
  return parseBunLock(readFileSync(file, "utf8"));
}

function entry(lock: BunLock, path: readonly string[]): Locked | null {
  const found = lock.packages[path.join("/")];
  if (found === undefined) return null;
  const id = found[0] as string;
  const at = id.lastIndexOf("@");
  return {
    path,
    name: id.slice(0, at),
    version: id.slice(at + 1),
    meta: (found[2] ?? {}) as LockMeta,
  };
}

/** The entry `name` resolves to from the one at `from`, as Node looks up the folders above. */
export function resolveFrom(lock: BunLock, from: readonly string[], name: string): Locked | null {
  for (let depth = from.length; depth >= 0; depth--) {
    const found = entry(lock, [...from.slice(0, depth), name]);
    if (found !== null) return found;
  }
  return null;
}

/** npm's os and cpu rule: a listed value, or none of the `!` ones. */
export function supports(field: string | readonly string[] | undefined, value: string): boolean {
  if (field === undefined) return true;
  const list = typeof field === "string" ? [field] : field;
  const negated = list.filter((item) => item.startsWith("!"));
  if (negated.includes(`!${value}`)) return false;
  return list.includes(value) || negated.length === list.length;
}

function installs(meta: LockMeta, platform: Platform | undefined): boolean {
  return (
    platform === undefined || (supports(meta.os, platform.os) && supports(meta.cpu, platform.cpu))
  );
}

/**
 * Every entry the `roots` reach in bun.lock, by key: dependencies, the peers npm installs and,
 * given a platform, the optional dependencies that support it, else all of them. Throws when a
 * root's entry isn't at the version given.
 */
export function lockedTree(
  lock: BunLock,
  roots: Readonly<Record<string, string>>,
  platform?: Platform,
): Map<string, Locked> {
  const tree = new Map<string, Locked>();
  const queue: Locked[] = [];
  for (const [name, version] of Object.entries(roots)) {
    const root = entry(lock, [name]);
    if (root?.version !== version) {
      throw new Error(
        `bun.lock has ${name} at ${root?.version ?? "no version"}, not ${version}: run bun install`,
      );
    }
    queue.push(root);
  }
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const key = next.path.join("/");
    if (tree.has(key) || !installs(next.meta, platform)) continue;
    tree.set(key, next);
    const { dependencies = {}, optionalDependencies = {}, peerDependencies = {} } = next.meta;
    const optionalPeers = next.meta.optionalPeers ?? [];
    const names = [
      ...Object.keys(dependencies),
      ...Object.keys(optionalDependencies),
      ...Object.keys(peerDependencies).filter((name) => !optionalPeers.includes(name)),
    ];
    for (const name of names) {
      const found = resolveFrom(lock, next.path, name);
      if (found === null) throw new Error(`bun.lock resolves no ${name} for ${key}`);
      queue.push(found);
    }
  }
  return tree;
}

export type Overrides = { [name: string]: string | Overrides };

/**
 * npm `overrides` that pin each package to its version in `tree`, nested where bun.lock nests a
 * second version: `{"tsyringe": {".": <its version>, "tslib": <its own tslib's>}}`.
 */
export function pinOverrides(tree: Iterable<Locked>): Overrides {
  const overrides: Overrides = {};
  // A package's own pin comes before its nested ones, which turn it into `{".": version, ...}`.
  const shallowFirst = [...tree].sort(
    (a, b) => a.path.length - b.path.length || a.path.join("/").localeCompare(b.path.join("/")),
  );
  for (const { path, version } of shallowFirst) {
    let level = overrides;
    for (const name of path.slice(0, -1)) {
      const at = level[name];
      const nested: Overrides = typeof at === "object" ? at : at === undefined ? {} : { ".": at };
      level[name] = nested;
      level = nested;
    }
    level[path.at(-1) as string] = version;
  }
  return overrides;
}

/**
 * What `npm ls --all --json` prints of a package: no version for an optional one the platform
 * skips, and `missing` for one npm couldn't find.
 */
export interface LsNode {
  readonly version?: string;
  readonly missing?: boolean;
  readonly problems?: readonly string[];
  readonly dependencies?: Readonly<Record<string, LsNode>>;
}

function installed(node: LsNode): node is LsNode & { version: string } {
  return node.version !== undefined && node.missing !== true;
}

/**
 * Where an install of `roots`, its manifest's dependencies and optional dependencies, differs from
 * bun.lock, as `npm ls` describes it: a version npm resolved otherwise, a package missing on either
 * side, and npm's own problems. Empty when they agree. The roots come from the manifest because
 * npm skips an optional package it fails to fetch, exits 0, and lists it as one the platform skips.
 */
export function lockDrift(
  ls: LsNode,
  lock: BunLock,
  roots: Readonly<Record<string, string>>,
  platform: Platform,
): string[] {
  const drift = [...(ls.problems ?? [])];
  let expected: Map<string, Locked>;
  try {
    expected = lockedTree(lock, roots, platform);
  } catch (error) {
    return [...drift, (error as Error).message];
  }
  const found = new Set<string>();
  // Every place npm shows a package, deduped ones included; `above` stops a cycle.
  const walk = (node: LsNode, from: readonly string[], trail: string, above: Set<string>) => {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      if (!installed(child)) continue;
      const at = `${trail}${name}`;
      const locked = resolveFrom(lock, from, name);
      if (locked === null) {
        drift.push(`${at}@${child.version}: not in bun.lock`);
        continue;
      }
      if (locked.version !== child.version) {
        drift.push(`${at}: npm installed ${child.version}, bun.lock has ${locked.version}`);
      }
      const key = locked.path.join("/");
      found.add(key);
      if (!above.has(key)) walk(child, locked.path, `${at} > `, new Set([...above, key]));
    }
  };
  walk(ls, [], "", new Set());
  for (const [key, locked] of expected) {
    if (!found.has(key)) drift.push(`${locked.name}@${locked.version} (${key}): not installed`);
  }
  for (const key of found) {
    if (!expected.has(key)) drift.push(`${key}: installed, but not in bun.lock's tree for it`);
  }
  return drift;
}

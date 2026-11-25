// pnpm-lock.yaml, read for npm: the versions a dependency tree resolves to there, as the
// `overrides` that pin an npm install to them, and what an install's `npm ls --all --json` shows
// that differs.
import { readFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";

export interface LockMeta {
  readonly os?: string | readonly string[];
  readonly cpu?: string | readonly string[];
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
}

interface Snapshot {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

interface Importer {
  readonly dependencies?: Readonly<Record<string, { readonly version: string }>>;
  readonly devDependencies?: Readonly<Record<string, { readonly version: string }>>;
  readonly optionalDependencies?: Readonly<Record<string, { readonly version: string }>>;
}

export interface PnpmLock {
  /** Each workspace project's own dependencies, by its folder. */
  readonly importers: Readonly<Record<string, Importer>>;
  /** By `name@version`: its platforms and its peers. */
  readonly packages: Readonly<Record<string, LockMeta>>;
  /** By `name@version`, then the peers it resolved in parentheses: what it depends on. */
  readonly snapshots: Readonly<Record<string, Snapshot | null>>;
}

export interface Locked {
  readonly name: string;
  readonly version: string;
  readonly meta: LockMeta;
  /** What it depends on, by name, at the versions the lockfile resolves: optional peers aside. */
  readonly dependencies: Readonly<Record<string, string>>;
}

export interface Platform {
  readonly os: string;
  readonly cpu: string;
}

/** pnpm-lock.yaml's text: the workspace's document, after the package manager's own. */
export function parsePnpmLock(text: string): PnpmLock {
  const documents = parseAllDocuments(text);
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error("pnpm-lock.yaml holds no document");
  }
  const lock = (documents.at(-1) as (typeof documents)[number]).toJS() as Partial<PnpmLock>;
  return {
    importers: lock.importers ?? {},
    packages: lock.packages ?? {},
    snapshots: lock.snapshots ?? {},
  };
}

export function readPnpmLock(file: string): PnpmLock {
  return parsePnpmLock(readFileSync(file, "utf8"));
}

/** A key or a resolved version without the peers in parentheses after it. */
function withoutPeers(id: string): string {
  const at = id.indexOf("(");
  return at === -1 ? id : id.slice(0, at);
}

/** `name@version`'s two halves, a scope's `@` aside. */
function splitId(id: string): [name: string, version: string] {
  const at = id.indexOf("@", 1);
  return [id.slice(0, at), id.slice(at + 1)];
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
 * What `name@version` depends on in every snapshot of it, whichever peers each resolved: its
 * dependencies, optional dependencies and the peers npm installs, the optional ones aside.
 */
function dependenciesOf(lock: PnpmLock, id: string, meta: LockMeta): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [key, snapshot] of Object.entries(lock.snapshots)) {
    if (withoutPeers(key) !== id) continue;
    const listed = { ...snapshot?.dependencies, ...snapshot?.optionalDependencies };
    for (const [name, version] of Object.entries(listed)) {
      if (meta.peerDependenciesMeta?.[name]?.optional === true) continue;
      found[name] ??= withoutPeers(version);
    }
  }
  return found;
}

/**
 * Every package the `roots` reach in pnpm-lock.yaml, by `name@version`: dependencies, the peers
 * npm installs and, given a platform, the optional dependencies that support it, else all of them.
 * Throws when a root isn't locked at the version given.
 */
export function lockedTree(
  lock: PnpmLock,
  roots: Readonly<Record<string, string>>,
  platform?: Platform,
): Map<string, Locked> {
  const tree = new Map<string, Locked>();
  const queue = Object.entries(roots);
  for (const [name, version] of queue) {
    if (lock.packages[`${name}@${version}`] === undefined) {
      const locked = Object.keys(lock.packages)
        .map(splitId)
        .filter(([other]) => other === name)
        .map(([, other]) => other);
      throw new Error(
        `pnpm-lock.yaml has ${name} at ${locked.join(", ") || "no version"}, not ${version}: ` +
          "run pnpm install",
      );
    }
  }
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const [name, version] = next;
    const id = `${name}@${version}`;
    const meta = lock.packages[id];
    if (meta === undefined) throw new Error(`pnpm-lock.yaml has no ${id}`);
    if (tree.has(id) || !installs(meta, platform)) continue;
    const dependencies = dependenciesOf(lock, id, meta);
    tree.set(id, { name, version, meta, dependencies });
    queue.push(...Object.entries(dependencies));
  }
  return tree;
}

export type Overrides = { [name: string]: string | Overrides };

/**
 * npm `overrides` that pin each package to its version in `tree`. A package locked at more than one
 * version gets the one most of its dependents take, and each dependent locked to another gets that
 * one nested under it: `{"tsyringe": {".": <its version>, "tslib": <its own tslib's>}}`.
 */
export function pinOverrides(tree: Iterable<Locked>): Overrides {
  const nodes = [...tree].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  const dependents = new Map<string, Map<string, number>>();
  for (const node of nodes) {
    const versions = dependents.get(node.name) ?? new Map<string, number>();
    dependents.set(node.name, versions.set(node.version, versions.get(node.version) ?? 0));
  }
  for (const node of nodes) {
    for (const [name, version] of Object.entries(node.dependencies)) {
      const versions = dependents.get(name);
      versions?.set(version, (versions.get(version) ?? 0) + 1);
    }
  }
  const overrides: Overrides = {};
  for (const [name, versions] of [...dependents].sort(([a], [b]) => a.localeCompare(b))) {
    const [[version]] = [...versions].sort(
      ([a, countA], [b, countB]) =>
        countB - countA || b.localeCompare(a, undefined, { numeric: true }),
    ) as [[string, number]];
    overrides[name] = version;
  }
  for (const node of nodes) {
    for (const [name, version] of Object.entries(node.dependencies)) {
      const pinned = overrides[name];
      if ((typeof pinned === "object" ? pinned["."] : pinned) === version) continue;
      const at = overrides[node.name];
      const nested: Overrides = typeof at === "object" ? at : { ".": node.version };
      nested[name] = version;
      overrides[node.name] = nested;
    }
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
 * pnpm-lock.yaml, as `npm ls` describes it: a version npm resolved otherwise, a package missing on
 * either side, and npm's own problems. Empty when they agree. The roots come from the manifest
 * because npm skips an optional package it fails to fetch, exits 0, and lists it as one the
 * platform skips.
 */
export function lockDrift(
  ls: LsNode,
  lock: PnpmLock,
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
  // Every place npm shows a package, deduped ones included, against what its dependent's entry
  // locks; `above` stops a cycle.
  const walk = (
    node: LsNode,
    locks: Readonly<Record<string, string>>,
    trail: string,
    above: Set<string>,
  ) => {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      if (!installed(child)) continue;
      const at = `${trail}${name}`;
      const version = locks[name];
      if (version === undefined) {
        drift.push(`${at}@${child.version}: not in pnpm-lock.yaml`);
        continue;
      }
      if (version !== child.version) {
        drift.push(`${at}: npm installed ${child.version}, pnpm-lock.yaml has ${version}`);
      }
      const id = `${name}@${version}`;
      found.add(id);
      const locked = expected.get(id);
      if (locked !== undefined && !above.has(id)) {
        walk(child, locked.dependencies, `${at} > `, new Set([...above, id]));
      }
    }
  };
  walk(ls, roots, "", new Set());
  for (const id of expected.keys()) {
    if (!found.has(id)) drift.push(`${id}: not installed`);
  }
  for (const id of found) {
    if (!expected.has(id)) drift.push(`${id}: installed, but not in pnpm-lock.yaml's tree for it`);
  }
  return drift;
}

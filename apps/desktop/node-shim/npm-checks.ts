// Copyright (c) Robert Kowalski and Isaac Z. Schlueter ("Authors")
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from npm-install-checks lib/dev-engines.js and lib/current-env.js@8.0.0
//
// The devEngines check npm makes before any command: this computer as npm sees it, and each engine
// of a project's devEngines none of whose choices it matches.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { release } from "node:os";
import { SHIM_BIN } from "./npm-exec.ts";

export interface Semver {
  validRange(range: string, loose?: boolean): string | null;
  satisfies(version: string, range: string): boolean;
}

export interface EngineInfo {
  readonly name?: string | null;
  readonly version?: string;
}

export type CurrentEnv = Readonly<Record<string, EngineInfo | undefined>>;

export interface DevEngineFailure {
  readonly engine: string;
  readonly errors: string[];
  readonly current: EngineInfo;
  readonly required: unknown;
  readonly onFail: string;
}

let loadedSemver: Semver | undefined;
/** npm's semver, which the pnpm here carries for node-gyp. */
export function semver(): Semver {
  loadedSemver ??= createRequire(SHIM_BIN)(
    "../node_modules/pnpm/dist/node_modules/semver",
  ) as Semver;
  return loadedSemver;
}

/** The libc family npm-install-checks reads on Linux, null where it can't tell, else none. */
function libc(): "musl" | "glibc" | null | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const ldd = readFileSync("/usr/bin/ldd", "utf8");
    if (ldd.includes("musl")) return "musl";
    return ldd.includes("GNU C Library") ? "glibc" : null;
  } catch {}
  const procReport = process.report as NodeJS.ProcessReport & { excludeNetwork?: boolean };
  const excluded = procReport.excludeNetwork;
  procReport.excludeNetwork = true;
  const report = procReport.getReport() as unknown as {
    header?: { glibcVersionRuntime?: string };
    sharedObjects?: unknown;
  };
  procReport.excludeNetwork = excluded;
  if (report.header?.glibcVersionRuntime) return "glibc";
  const musl = (file: string) => file.includes("libc.musl-") || file.includes("ld-musl-");
  return Array.isArray(report.sharedObjects) && report.sharedObjects.some(musl) ? "musl" : null;
}

/** This computer as npm `npmVersion` checks a project's devEngines against it. */
export function currentEnv(npmVersion: string): CurrentEnv {
  return {
    cpu: { name: process.arch },
    libc: { name: libc() },
    os: { name: process.platform, version: release() },
    packageManager: { name: "npm", version: npmVersion },
    runtime: { name: "node", version: process.version },
  };
}

/**
 * npm-install-checks' mismatch between one `wanted` dependency of a devEngines `engine` and its
 * `current` one, or its throw where `wanted` is malformed.
 */
function devEngineMismatch(
  wanted: unknown,
  current: EngineInfo,
  engine: string,
): string | undefined {
  if (typeof wanted !== "object" || wanted === null || Array.isArray(wanted)) {
    throw new Error(`Invalid non-object value for "${engine}"`);
  }
  const entry = wanted as Record<string, unknown>;
  const properties = Object.keys(entry);
  const unknown = properties.find((key) => !["name", "version", "onFail"].includes(key));
  if (unknown !== undefined) throw new Error(`Invalid property "${unknown}" for "${engine}"`);
  if (!properties.includes("name")) throw new Error(`Missing "name" property for "${engine}"`);
  if (typeof entry.name !== "string") {
    throw new Error(`Invalid non-string value for "name" within "${engine}"`);
  }
  if (typeof current.name !== "string" || current.name === "") {
    throw new Error(`Unable to determine "name" for "${engine}"`);
  }
  if (properties.includes("onFail")) {
    if (typeof entry.onFail !== "string") {
      throw new Error(`Invalid non-string value for "onFail" within "${engine}"`);
    }
    if (!["ignore", "warn", "error", "download"].includes(entry.onFail)) {
      throw new Error(`Invalid onFail value "${entry.onFail}" for "${engine}"`);
    }
  }
  if (entry.name !== current.name) {
    return `Invalid name "${entry.name}" does not match "${current.name}" for "${engine}"`;
  }
  if (!properties.includes("version")) return undefined;
  if (typeof entry.version !== "string") {
    throw new Error(`Invalid non-string value for "version" within "${engine}"`);
  }
  if (typeof current.version !== "string" || current.version === "") {
    throw new Error(`Unable to determine "version" for "${engine}" "${entry.name}"`);
  }
  const { version } = current;
  if (semver().validRange(entry.version)) {
    if (semver().satisfies(version, entry.version)) return undefined;
    return `Invalid semver version "${entry.version}" does not match "${version}" for "${engine}"`;
  }
  if (entry.version === version) return undefined;
  return `Invalid version "${entry.version}" does not match "${version}" for "${engine}"`;
}

/**
 * Each engine of the devEngines `wanted` none of whose choices `current` matches, as
 * npm-install-checks' checkDevEngines finds them, with its errors, its `current` and `required`
 * values and the onFail of its last choice; its throw where `wanted` is malformed.
 */
export function devEngineFailures(wanted: unknown, current: CurrentEnv): DevEngineFailure[] {
  if (typeof wanted !== "object" || wanted === null || Array.isArray(wanted)) {
    throw new Error('Invalid non-object value for "devEngines"');
  }
  const failures: DevEngineFailure[] = [];
  for (const [engine, authored] of Object.entries(wanted)) {
    if (!["packageManager", "runtime", "cpu", "libc", "os"].includes(engine)) {
      throw new Error(`Invalid property "devEngines.${engine}"`);
    }
    // Any one of several will do.
    const dependencies: unknown[] = [authored].flat();
    const now = current[engine] ?? {};
    const errors = dependencies
      .map((dependency) => devEngineMismatch(dependency, now, engine))
      .filter((error): error is string => error !== undefined);
    if (dependencies.length === 0 || errors.length < dependencies.length) continue;
    const last = dependencies.at(-1) as { onFail?: string };
    const onFail = last.onFail || "error";
    const failure = { engine, errors, current: now, required: authored };
    failures.push({ ...failure, onFail: onFail === "download" ? "error" : onFail });
  }
  return failures;
}

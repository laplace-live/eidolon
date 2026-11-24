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

let loadedSemver;
/** npm's semver, which the pnpm here carries for node-gyp. */
function semver() {
  loadedSemver ??= createRequire(import.meta.url)("../node_modules/pnpm/dist/node_modules/semver");
  return loadedSemver;
}

/** The libc family npm-install-checks reads on Linux, null where it can't tell, else none. */
function libc() {
  if (process.platform !== "linux") return undefined;
  try {
    const ldd = readFileSync("/usr/bin/ldd", "utf8");
    if (ldd.includes("musl")) return "musl";
    return ldd.includes("GNU C Library") ? "glibc" : null;
  } catch {}
  const excluded = process.report.excludeNetwork;
  process.report.excludeNetwork = true;
  const report = process.report.getReport();
  process.report.excludeNetwork = excluded;
  if (report.header?.glibcVersionRuntime) return "glibc";
  const musl = (file) => file.includes("libc.musl-") || file.includes("ld-musl-");
  return Array.isArray(report.sharedObjects) && report.sharedObjects.some(musl) ? "musl" : null;
}

/** This computer as npm `npmVersion` checks a project's devEngines against it. */
export function currentEnv(npmVersion) {
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
function devEngineMismatch(wanted, current, engine) {
  if (typeof wanted !== "object" || wanted === null || Array.isArray(wanted)) {
    throw new Error(`Invalid non-object value for "${engine}"`);
  }
  const properties = Object.keys(wanted);
  const unknown = properties.find((key) => !["name", "version", "onFail"].includes(key));
  if (unknown !== undefined) throw new Error(`Invalid property "${unknown}" for "${engine}"`);
  if (!properties.includes("name")) throw new Error(`Missing "name" property for "${engine}"`);
  if (typeof wanted.name !== "string") {
    throw new Error(`Invalid non-string value for "name" within "${engine}"`);
  }
  if (typeof current.name !== "string" || current.name === "") {
    throw new Error(`Unable to determine "name" for "${engine}"`);
  }
  if (properties.includes("onFail")) {
    if (typeof wanted.onFail !== "string") {
      throw new Error(`Invalid non-string value for "onFail" within "${engine}"`);
    }
    if (!["ignore", "warn", "error", "download"].includes(wanted.onFail)) {
      throw new Error(`Invalid onFail value "${wanted.onFail}" for "${engine}"`);
    }
  }
  if (wanted.name !== current.name) {
    return `Invalid name "${wanted.name}" does not match "${current.name}" for "${engine}"`;
  }
  if (!properties.includes("version")) return undefined;
  if (typeof wanted.version !== "string") {
    throw new Error(`Invalid non-string value for "version" within "${engine}"`);
  }
  if (typeof current.version !== "string" || current.version === "") {
    throw new Error(`Unable to determine "version" for "${engine}" "${wanted.name}"`);
  }
  const { version } = current;
  if (semver().validRange(wanted.version)) {
    if (semver().satisfies(version, wanted.version)) return undefined;
    return `Invalid semver version "${wanted.version}" does not match "${version}" for "${engine}"`;
  }
  if (wanted.version === version) return undefined;
  return `Invalid version "${wanted.version}" does not match "${version}" for "${engine}"`;
}

/**
 * Each engine of the devEngines `wanted` none of whose choices `current` matches, as
 * npm-install-checks' checkDevEngines finds them, with its errors, its `current` and `required`
 * values and the onFail of its last choice; its throw where `wanted` is malformed.
 */
export function devEngineFailures(wanted, current) {
  if (typeof wanted !== "object" || wanted === null || Array.isArray(wanted)) {
    throw new Error('Invalid non-object value for "devEngines"');
  }
  const failures = [];
  for (const [engine, authored] of Object.entries(wanted)) {
    if (!["packageManager", "runtime", "cpu", "libc", "os"].includes(engine)) {
      throw new Error(`Invalid property "devEngines.${engine}"`);
    }
    // Any one of several will do.
    const dependencies = [authored].flat();
    const now = current[engine] ?? {};
    const errors = dependencies
      .map((dependency) => devEngineMismatch(dependency, now, engine))
      .filter((error) => error !== undefined);
    if (dependencies.length === 0 || errors.length < dependencies.length) continue;
    const onFail = dependencies.at(-1).onFail || "error";
    const failure = { engine, errors, current: now, required: authored };
    failures.push({ ...failure, onFail: onFail === "download" ? "error" : onFail });
  }
  return failures;
}

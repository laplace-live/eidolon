// `node apps/desktop/scripts/signed-check.ts`: the checks on a signed release in apps/desktop/.out,
// which desktop.yml runs after its signed package step. On macOS: the app's signature, Gatekeeper's
// verdict, the stapled ticket, the hardened runtime and a secure timestamp on each of the payload's
// natives, and the designated requirement of the app and every helper. On Windows: the NSIS setup
// installed for this user, a timestamped Authenticode signature on every PE file of the install,
// the setup and the uninstaller included, each the org's where the release signs it and Microsoft's
// elsewhere, then the uninstall. A PASS or FAIL line per check, and exit 1 when one failed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, win32 } from "node:path";
import { VC_RUNTIME_DLLS } from "../../eidolon/src/launcher.ts";
import { PUBLISHER_NAMES } from "../electron-builder.release.ts";
import { shimPnpmExe } from "./node-shim.ts";
import { readPe } from "./pe.ts";
import { DESKTOP, installedBinary, installer, runsFolder, sleep } from "./smoke/kit.ts";
import { namesUninstaller, silentUninstall, UNINSTALLER, uninstallEntries } from "./smoke/nsis.ts";
import { jsonList, powershellCommand } from "./smoke/packaged.ts";
import { MICROSOFT_SIGNERS, stageDir, TARGETS, UNSIGNED_PE_FILE } from "./stage-backend.ts";

/** One check's verdict, printed as the smokes print theirs. */
export interface Check {
  readonly name: string;
  readonly pass: boolean;
  /** What decided it. */
  readonly detail: string;
}

/** A tool's exit status and everything it printed, stdout then stderr. */
export interface ToolRun {
  readonly status: number | null;
  readonly output: string;
}

const REQUIREMENT_FILE = "resources/designated-requirement.mac";
/** The CodeDirectory flag codesign prints as `runtime`. */
const HARDENED_RUNTIME = 0x10000;
// The NSIS setup alone took 58 s on windows-latest.
const INSTALL_MS = 180_000;
const UNINSTALL_MS = 120_000;

/** What `codesign -dvvv` says of a file's signature. */
export interface CodeSignature {
  /** False for "code object is not signed at all". */
  readonly signed: boolean;
  /** The CodeDirectory's flags. */
  readonly flags: number;
  /**
   * The date of the secure timestamp Apple's server gave the signature; null without one, as for an
   * ad-hoc signature, or one with only the signer's own `Signed Time`.
   */
  readonly timestamp: string | null;
  /** The certificate chain, the signer's first; none for an ad-hoc signature. */
  readonly authorities: readonly string[];
  readonly team: string | null;
}

export function codeSignature(output: string): CodeSignature {
  const field = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(output)?.[1]?.trim();
  const directory = /^CodeDirectory .*\bflags=0x([0-9a-f]+)/m.exec(output);
  const team = field("TeamIdentifier");
  return {
    signed: directory !== null,
    flags: directory === null ? 0 : Number.parseInt(directory[1] as string, 16),
    timestamp: field("Timestamp") ?? null,
    authorities: [...output.matchAll(/^Authority=(.*)$/gm)].map((match) =>
      (match[1] as string).trim(),
    ),
    team: team === undefined || team === "not set" ? null : team,
  };
}

/** The first of `output`'s lines that isn't empty: a tool's verdict, when it failed early. */
function firstLine(output: string): string {
  return output.split(/\r?\n/).find((line) => line.trim() !== "") ?? "no output";
}

/** A payload native: signed, with the hardened runtime and a secure timestamp. */
export function nativeCheck(label: string, run: ToolRun): Check {
  const signature = codeSignature(run.output);
  const missing = [
    ...(run.status === 0 && signature.signed ? [] : ["no signature"]),
    ...((signature.flags & HARDENED_RUNTIME) === 0 ? ["no hardened runtime"] : []),
    ...(signature.timestamp === null ? ["no secure timestamp"] : []),
  ];
  const described = signature.signed
    ? `flags 0x${signature.flags.toString(16)}, ${signature.authorities[0] ?? "ad hoc"}` +
      (signature.timestamp === null ? "" : `, Timestamp=${signature.timestamp}`)
    : firstLine(run.output);
  return {
    name: `${label} has the hardened runtime and a secure timestamp`,
    pass: missing.length === 0,
    detail: missing.length === 0 ? described : `${missing.join(", ")}: ${described}`,
  };
}

/**
 * The explicit designated requirement in `codesign -d -r-`'s or `csreq -t`'s output; null for an
 * ad-hoc signature's implicit one, which codesign prints commented out.
 */
export function designatedRequirement(output: string): string | null {
  return (
    output
      .split(/\r?\n/)
      .find((line) => line.startsWith("designated => "))
      ?.trim() ?? null
  );
}

/** A bundle whose designated requirement is the requirement file's, as csreq compiles it. */
export function requirementCheck(label: string, run: ToolRun, expected: string): Check {
  const actual = designatedRequirement(run.output);
  const pass = run.status === 0 && actual === expected;
  return {
    name: `${label}'s designated requirement is ${REQUIREMENT_FILE}'s`,
    pass,
    detail: pass ? "" : (actual ?? `none explicit: ${firstLine(run.output)}`),
  };
}

/**
 * codesign's deep, strict verification of the app, which exits 1 on a broken signature and 3 on an
 * unmet designated requirement, printing its verdict after the nested code's progress lines.
 */
export function verifyCheck(run: ToolRun): Check {
  const verdict = run.output
    .split(/\r?\n/)
    .filter((line) => line !== "" && !/^--(prepared|validated):/.test(line));
  return {
    name: "codesign --verify --deep --strict passes on the app",
    pass: run.status === 0,
    detail: verdict.join("; "),
  };
}

/**
 * Gatekeeper's verdict on the app, which exits 3 when it rejects one: accepted, and as notarized,
 * which a system that doesn't require notarization leaves out of an accepted Developer ID's source.
 */
export function gatekeeperCheck(run: ToolRun): Check {
  const lines = run.output.split(/\r?\n/).filter((line) => line !== "");
  return {
    name: "Gatekeeper accepts the app as notarized (spctl --assess)",
    pass: run.status === 0 && lines.includes("source=Notarized Developer ID"),
    detail: lines.join("; "),
  };
}

/** The app's notarization ticket stapled to it, which stapler validates or exits 65. */
export function stapleCheck(run: ToolRun): Check {
  return {
    name: "the app's notarization ticket is stapled (stapler validate)",
    pass: run.status === 0,
    detail: run.output.trim().split(/\r?\n/).at(-1) ?? "",
  };
}

/** What the script's PowerShell pipeline emits for each file, through ConvertTo-Json. */
export interface Authenticode {
  readonly Path: string;
  /** Get-AuthenticodeSignature's status by name: Valid, NotSigned, HashMismatch, NotTrusted… */
  readonly Status: string;
  readonly StatusMessage: string | null;
  /** The common name of the signer's certificate. */
  readonly Signer: string | null;
  readonly TimeStamper: string | null;
}

const SIMPLE_NAME = "[System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName";

/** The pipeline that reads the signature of each path listed, one a line, in the file `list`. */
export function authenticodeScript(list: string): string {
  return [
    `Get-Content -LiteralPath '${list.replace(/'/g, "''")}' -Encoding UTF8 | Where-Object { $_ } | ForEach-Object {`,
    "  $signature = Get-AuthenticodeSignature -LiteralPath $_",
    "  [pscustomobject]@{",
    // A line Get-Content read carries note properties, which ConvertTo-Json would write out too.
    "    Path = [string]$_",
    "    Status = [string]$signature.Status",
    "    StatusMessage = [string]$signature.StatusMessage",
    `    Signer = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.GetNameInfo(${SIMPLE_NAME}, $false) })`,
    `    TimeStamper = $(if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.GetNameInfo(${SIMPLE_NAME}, $false) })`,
    "  }",
    "}",
  ].join("\n");
}

export function parseAuthenticode(stdout: string): Authenticode[] {
  return jsonList<Authenticode>(stdout);
}

/**
 * Each of `files` Valid and timestamped, and signed by one of `publishers` where the release signs
 * it, which is every .exe and each name the stage listed unsigned; by Microsoft elsewhere, the
 * signature it came with. A file inside `root` is named by its path from there.
 */
export function signatureChecks(
  files: readonly string[],
  signatures: readonly Authenticode[],
  options: { root: string; listed: readonly string[]; publishers: readonly string[] },
): Check[] {
  const listed = new Set(options.listed.map((name) => name.toLowerCase()));
  const byPath = new Map(signatures.map((entry) => [entry.Path.toLowerCase(), entry]));
  return files.map((file) => {
    const name = win32.basename(file).toLowerCase();
    const org = name.endsWith(".exe") || listed.has(name);
    const fromRoot = win32.relative(options.root, file);
    const label =
      fromRoot.startsWith("..") || win32.isAbsolute(fromRoot) ? win32.basename(file) : fromRoot;
    const check = org ? `${label} is signed by the org` : `${label} keeps Microsoft's signature`;
    const entry = byPath.get(file.toLowerCase());
    if (entry === undefined) {
      return {
        name: check,
        pass: false,
        detail: "Get-AuthenticodeSignature reported nothing for it",
      };
    }
    const signers = org ? options.publishers : MICROSOFT_SIGNERS;
    const pass =
      entry.Status === "Valid" &&
      signers.includes(entry.Signer ?? "") &&
      entry.TimeStamper !== null;
    const stamped =
      entry.TimeStamper === null ? ", not timestamped" : `, timestamped by ${entry.TimeStamper}`;
    const why = entry.Status === "Valid" ? "" : `: ${entry.StatusMessage ?? ""}`;
    return {
      name: check,
      pass,
      detail: `${entry.Status}, ${entry.Signer ?? "no signer"}${stamped}${why}`,
    };
  });
}

/**
 * What the Windows checks must find in the install by name, so none passes on nothing: the app, its
 * uninstaller, each listed file, and the files that keep Microsoft's signature (onnxruntime's, the
 * VC++ runtime and Electron's d3dcompiler_47.dll).
 */
export function requiredInInstall(listed: readonly string[]): string[] {
  return [
    ...new Set([
      "LAPLACE Eidolon.exe",
      UNINSTALLER,
      "pnpm.exe",
      "d3dcompiler_47.dll",
      ...TARGETS["win32-x64"].onnxruntime,
      ...VC_RUNTIME_DLLS,
      ...listed,
    ]),
  ];
}

export function presenceCheck(files: readonly string[], required: readonly string[]): Check {
  const found = new Set(files.map((file) => win32.basename(file).toLowerCase()));
  const missing = required.filter((name) => !found.has(name.toLowerCase()));
  return {
    name: "the install holds the app, its uninstaller, each listed file and Microsoft's",
    pass: missing.length === 0,
    detail: missing.length === 0 ? `${files.length} PE files` : `missing: ${missing.join(", ")}`,
  };
}

function run(command: string, args: readonly string[]): ToolRun {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Every file under `dir`, links aside. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function checkMac(record: (check: Check) => void): void {
  const app = join(DESKTOP, ".out", "mac-arm64", "LAPLACE Eidolon.app");
  if (!existsSync(app)) throw new Error(`No ${app}: package the release first`);
  record(verifyCheck(run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app])));
  record(gatekeeperCheck(run("spctl", ["--assess", "--type", "execute", "--verbose=4", app])));
  record(stapleCheck(run("xcrun", ["stapler", "validate", app])));
  const payload = join(app, "Contents", "Resources", "eidolon");
  const pnpmExe = join(shimPnpmExe(payload, { os: "darwin", cpu: "arm64" }), "pnpm");
  const natives = existsSync(payload)
    ? filesUnder(payload).filter((file) => /\.(node|dylib)$/.test(file) || file === pnpmExe)
    : [];
  record({
    name: "the payload holds natives to check",
    pass: natives.length > 0,
    detail: `${natives.length} Mach-O files`,
  });
  for (const native of natives) {
    record(nativeCheck(relative(payload, native), run("codesign", ["-dvvv", native])));
  }
  const compiled = run("csreq", ["-r", join(DESKTOP, REQUIREMENT_FILE), "-t"]);
  const expected = designatedRequirement(compiled.output);
  if (expected === null) {
    throw new Error(`csreq compiled no requirement from ${REQUIREMENT_FILE}: ${compiled.output}`);
  }
  const frameworks = join(app, "Contents", "Frameworks");
  const helpers = readdirSync(frameworks)
    .filter((name) => /\.(app|framework)$/.test(name))
    .sort();
  record(requirementCheck("LAPLACE Eidolon.app", run("codesign", ["-d", "-r-", app]), expected));
  for (const helper of helpers) {
    record(
      requirementCheck(helper, run("codesign", ["-d", "-r-", join(frameworks, helper)]), expected),
    );
  }
}

/** Every file's Authenticode signature, read in one PowerShell run. */
function authenticode(files: readonly string[]): Authenticode[] {
  const scratch = mkdtempSync(join(runsFolder(), "eidolon-signed-check-"));
  try {
    const list = join(scratch, "files.txt");
    writeFileSync(list, files.join("\n"), "utf8");
    const [command, args] = powershellCommand(authenticodeScript(list));
    const result = spawnSync(command, args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Get-AuthenticodeSignature exited ${result.status}: ${result.stderr}`);
    }
    return parseAuthenticode(result.stdout);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function uninstall(folder: string): Promise<Check> {
  const name = "the uninstaller removes the app silently";
  const silent = silentUninstall(await uninstallEntries(), folder);
  if (silent === null) {
    return { name, pass: false, detail: `no uninstall entry names ${join(folder, UNINSTALLER)}` };
  }
  const ran = spawnSync(silent.command, [...silent.args], {
    timeout: UNINSTALL_MS,
    windowsHide: true,
  });
  // The uninstaller returns at once, and removes the app from a copy of itself in %TEMP%.
  const deadline = Date.now() + UNINSTALL_MS;
  while (existsSync(folder) && Date.now() < deadline) await sleep(500);
  return {
    name,
    pass: ran.status === 0 && !existsSync(folder),
    detail: `exit ${ran.status ?? ran.signal}; ${folder} ${existsSync(folder) ? "remains" : "is gone"}`,
  };
}

/** Refuses to overwrite and uninstall an install already in `folder`, whatever executable name it holds. */
export function ensureNoWindowsInstall(
  folder: string,
  exists: (path: string) => boolean = existsSync,
): void {
  if (exists(folder)) {
    throw new Error(
      `LAPLACE Eidolon is already installed for this user in ${folder}. signed-check installs the release ` +
        "there and uninstalls it after, so it runs only where none is, such as a CI runner",
    );
  }
}

async function checkWindows(record: (check: Check) => void): Promise<void> {
  const setup = installer("win32");
  const binary = installedBinary();
  const folder = dirname(binary);
  ensureNoWindowsInstall(folder);
  const listed: string[] = JSON.parse(
    readFileSync(join(stageDir("win32-x64"), UNSIGNED_PE_FILE), "utf8"),
  );
  const started = Date.now();
  const installed = spawnSync(setup, ["/S"], { timeout: INSTALL_MS, windowsHide: true });
  const entry = (await uninstallEntries()).find((candidate) => namesUninstaller(candidate, folder));
  record({
    name: "the setup installs the app silently, for this user",
    pass: installed.status === 0 && existsSync(binary) && entry !== undefined,
    detail:
      `exit ${installed.status ?? installed.signal} after ${((Date.now() - started) / 1000).toFixed(1)} s; ` +
      `${binary} ${existsSync(binary) ? "is there" : "is missing"}; ` +
      `uninstall entry: ${entry?.UninstallString ?? "none names its uninstaller"}`,
  });
  if (!existsSync(folder)) return;
  try {
    const files = [setup, ...filesUnder(folder).filter((file) => readPe(file) !== null)];
    record(presenceCheck(files, requiredInInstall(listed)));
    const checks = signatureChecks(files, authenticode(files), {
      root: folder,
      listed,
      publishers: PUBLISHER_NAMES,
    });
    for (const check of checks) record(check);
  } finally {
    record(await uninstall(folder));
  }
}

if (import.meta.main) {
  let failed = 0;
  let count = 0;
  const record = (check: Check): void => {
    count++;
    if (!check.pass) failed++;
    console.log(
      `${check.pass ? "PASS" : "FAIL"} ${check.name}${check.detail === "" ? "" : ` — ${check.detail}`}`,
    );
  };
  if (process.platform === "darwin") checkMac(record);
  else if (process.platform === "win32") await checkWindows(record);
  else throw new Error(`signed-check checks macOS and Windows releases, not ${process.platform}`);
  console.log(
    failed === 0
      ? `signed-check: all ${count} checks passed`
      : `signed-check: ${failed} of ${count} checks failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

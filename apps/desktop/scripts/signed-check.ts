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
import { readMachoExecuteUuid, STOCK_LLD_UUID_PREFIX } from "./macho.ts";
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

export const ALLOWED_MAC_TEAMS: readonly string[] = ["B5483RCL5H", "9H3CCD4YMM"];
const APP_BUNDLE_ID = "live.laplace.eidolon";
const COMM_ENTITLEMENT = "com.apple.developer.usernotifications.communication";
const EMAIL_IN_TEXT = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/** The app's notarization ticket stapled to it, which stapler validates or exits 65. */
export function stapleCheck(run: ToolRun): Check {
  return {
    name: "the app's notarization ticket is stapled (stapler validate)",
    pass: run.status === 0,
    detail: run.output.trim().split(/\r?\n/).at(-1) ?? "",
  };
}

function isAllowedOrgDevId(name: string | undefined, team: string | null | undefined): boolean {
  return (
    typeof team === "string" &&
    ALLOWED_MAC_TEAMS.includes(team) &&
    name !== undefined &&
    PUBLISHER_NAMES.some((org) => name === `Developer ID Application: ${org} (${team})`)
  );
}

/** Verifies macOS Developer ID signing identity belongs strictly to an allowed org without personal info. */
export function macSignerCheck(run: ToolRun): Check {
  const sig = codeSignature(run.output);
  const leaf = sig.authorities[0] ?? "";
  const orgAllowed = isAllowedOrgDevId(leaf, sig.team);
  const noEmail = sig.authorities.every((auth) => !auth.includes("@"));
  const pass = run.status === 0 && sig.signed && orgAllowed && noEmail;
  return {
    name: "macOS signer is an allowed organization Developer ID without personal identifiers",
    pass,
    detail: sig.signed ? `${leaf || "no leaf"}, team=${sig.team ?? "none"}` : firstLine(run.output),
  };
}

function parseRfc2253Fields(subjectLine: string): Map<string, string> {
  const fields = new Map<string, string>();
  const body = subjectLine.replace(/^subject=\s*/i, "");
  const parts: string[] = [];
  let current = "";
  let escaped = false;
  let inQuotes = false;
  for (const ch of body) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === "," || ch === "+")) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current.trim());
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (!fields.has(key)) fields.set(key, val);
  }
  return fields;
}

function decodeXmlEntities(text: string): string {
  return text.replace(
    /&(lt|gt|amp|quot|apos|#(\d+)|#x([0-9a-fA-F]+));/g,
    (full, name: string, dec?: string, hex?: string) => {
      if (dec !== undefined) return String.fromCodePoint(Number.parseInt(dec, 10));
      if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
      switch (name) {
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "amp":
          return "&";
        case "quot":
          return '"';
        case "apos":
          return "'";
        default:
          return full;
      }
    },
  );
}

const XML_WS = /\s+/y;
const XML_OPEN = /<([a-zA-Z0-9_-]+)(?:\s[^>]*?)?(\/?)>/y;
const XML_KEY_OPEN = /<key(?:\s[^>]*?)?(\/?)>/y;
const XML_PLIST_OPEN = /<plist\b[^>]*>/y;

/** Parses Apple's XML1 plist output (supports `<date>` and `<data>`, unlike `plutil -convert json`). */
export function parseAppleXmlPlist(xml: string): unknown {
  let pos = 0;

  const matchAt = (re: RegExp): RegExpExecArray | null => {
    re.lastIndex = pos;
    return re.exec(xml);
  };

  const skipTrivia = () => {
    while (pos < xml.length) {
      const ws = matchAt(XML_WS);
      if (ws !== null) {
        pos += ws[0].length;
        continue;
      }
      if (xml.startsWith("<!--", pos)) {
        const end = xml.indexOf("-->", pos + 4);
        if (end < 0) throw new Error("unterminated XML comment in plist");
        pos = end + 3;
        continue;
      }
      if (xml.startsWith("<?", pos)) {
        const end = xml.indexOf("?>", pos + 2);
        if (end < 0) throw new Error("unterminated XML processing instruction in plist");
        pos = end + 2;
        continue;
      }
      if (xml.startsWith("<!", pos)) {
        const end = xml.indexOf(">", pos + 2);
        if (end < 0) throw new Error("unterminated XML declaration in plist");
        pos = end + 1;
        continue;
      }
      break;
    }
  };

  const readScalarText = (tag: string): string => {
    const close = `</${tag}>`;
    const end = xml.indexOf(close, pos);
    if (end < 0) throw new Error(`missing ${close} in plist`);
    const raw = xml.slice(pos, end);
    pos = end + close.length;
    return raw;
  };

  const readValue = (): unknown => {
    skipTrivia();
    const open = matchAt(XML_OPEN);
    if (open === null) {
      throw new Error(`unexpected plist token near ${xml.slice(pos, pos + 40)}`);
    }
    const tag = open[1] as string;
    const selfClosing = open[2] === "/";
    pos += open[0].length;

    if (selfClosing) {
      if (tag === "true") return true;
      if (tag === "false") return false;
      if (tag === "dict") return {};
      if (tag === "array") return [];
      if (tag === "string" || tag === "data" || tag === "date") return "";
      throw new Error(`unsupported empty plist element <${tag}/>`);
    }

    if (tag === "dict") {
      const dict: Record<string, unknown> = {};
      while (true) {
        skipTrivia();
        if (xml.startsWith("</dict>", pos)) {
          pos += 7;
          return dict;
        }
        const keyOpen = matchAt(XML_KEY_OPEN);
        if (keyOpen === null) {
          throw new Error(`expected <key> inside <dict> near ${xml.slice(pos, pos + 40)}`);
        }
        pos += keyOpen[0].length;
        const keyName = keyOpen[1] === "/" ? "" : decodeXmlEntities(readScalarText("key"));
        const value = readValue();
        Object.defineProperty(dict, keyName, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }

    if (tag === "array") {
      const items: unknown[] = [];
      while (true) {
        skipTrivia();
        if (xml.startsWith("</array>", pos)) {
          pos += 8;
          return items;
        }
        items.push(readValue());
      }
    }

    const raw = readScalarText(tag);
    if (tag === "string") return decodeXmlEntities(raw);
    if (tag === "date") return decodeXmlEntities(raw).trim();
    if (tag === "data") return raw.replace(/\s+/g, "");
    if (tag === "integer") return Number.parseInt(raw.trim(), 10);
    if (tag === "real") return Number.parseFloat(raw.trim());
    throw new Error(`unsupported plist element <${tag}>`);
  };

  skipTrivia();
  const plistOpen = matchAt(XML_PLIST_OPEN);
  if (plistOpen === null) throw new Error("expected <plist> root element");
  pos += plistOpen[0].length;
  const root = readValue();
  skipTrivia();
  if (!xml.startsWith("</plist>", pos)) {
    throw new Error(`expected </plist> near ${xml.slice(pos, pos + 40)}`);
  }
  return root;
}

/** Anti-doxxing and entitlement checks on a decoded macOS `.provisionprofile` plist and X.509 cert subjects. */
export function provisioningProfileChecks(
  profile: unknown,
  certSubjects: readonly ToolRun[],
): Check[] {
  const record =
    profile !== null && typeof profile === "object"
      ? (profile as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const teams = Array.isArray(record.TeamIdentifier)
    ? record.TeamIdentifier.filter((value): value is string => typeof value === "string")
    : [];
  const teamName = typeof record.TeamName === "string" ? record.TeamName : "";
  const teamPass =
    teams.length > 0 &&
    teams.every((team) => ALLOWED_MAC_TEAMS.includes(team)) &&
    PUBLISHER_NAMES.includes(teamName);

  const devices = Array.isArray(record.ProvisionedDevices) ? record.ProvisionedDevices : [];
  const profileWithoutCerts = JSON.stringify({
    ...record,
    DeveloperCertificates: undefined,
    "DER-Encoded-Profile": undefined,
  });
  const leakedEmail = EMAIL_IN_TEXT.exec(profileWithoutCerts)?.[0] ?? null;
  const privacyPass = devices.length === 0 && leakedEmail === null;

  const certs = Array.isArray(record.DeveloperCertificates) ? record.DeveloperCertificates : [];
  const badCerts: string[] = [];
  if (certs.length === 0) {
    badCerts.push("no DeveloperCertificates");
  } else if (certSubjects.length !== certs.length) {
    badCerts.push(
      `decoded ${certSubjects.length} certificate subjects for ${certs.length} certificates`,
    );
  } else {
    for (const [index, cert] of certSubjects.entries()) {
      if (cert.status !== 0) {
        badCerts.push(`cert[${index}] exit ${cert.status ?? "null"}`);
        continue;
      }
      if (cert.output.includes("@")) {
        badCerts.push(`cert[${index}] exposes an email address`);
        continue;
      }
      const subjectLine =
        cert.output
          .split(/\r?\n/)
          .find((line) => /^subject=/i.test(line))
          ?.trim() ?? cert.output.trim();
      const fields = parseRfc2253Fields(subjectLine);
      if (fields.has("emailAddress")) {
        badCerts.push(`cert[${index}] exposes emailAddress`);
        continue;
      }
      const ou = fields.get("OU");
      const o = fields.get("O");
      const cn = fields.get("CN");
      const cnAllowed = isAllowedOrgDevId(cn, ou);
      const oAllowed = o === undefined || PUBLISHER_NAMES.includes(o);
      if (!cnAllowed || !oAllowed) {
        badCerts.push(`cert[${index}] unexpected subject (${subjectLine})`);
      }
    }
  }

  const entitlements =
    record.Entitlements !== null && typeof record.Entitlements === "object"
      ? (record.Entitlements as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const appId = entitlements["com.apple.application-identifier"];
  const hasAppId =
    typeof appId === "string" &&
    teams.some((team) => ALLOWED_MAC_TEAMS.includes(team) && appId === `${team}.${APP_BUNDLE_ID}`);
  const hasComm = entitlements[COMM_ENTITLEMENT] === true;

  return [
    {
      name: "embedded.provisionprofile belongs to an allowed organization team",
      pass: teamPass,
      detail: `TeamName=${teamName || "none"}, TeamIdentifier=[${teams.join(", ")}]`,
    },
    {
      name: "embedded.provisionprofile has no provisioned device UDIDs or email addresses",
      pass: privacyPass,
      detail: privacyPass
        ? "no ProvisionedDevices, no email"
        : `devices=${devices.length}, email=${leakedEmail ?? "none"}`,
    },
    {
      name: "embedded.provisionprofile holds only organization Developer ID certificates",
      pass: badCerts.length === 0,
      detail: badCerts.length === 0 ? `${certs.length} org certificate(s)` : badCerts.join("; "),
    },
    {
      name: "embedded.provisionprofile grants communication notifications for live.laplace.eidolon",
      pass: hasAppId && hasComm,
      detail: `application-identifier=${typeof appId === "string" ? appId : "none"}, communication=${String(entitlements[COMM_ENTITLEMENT])}`,
    },
  ];
}

function asPlistRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPlistRecord(plistPath: string): Record<string, unknown> | null {
  try {
    return asPlistRecord(parseAppleXmlPlist(readFileSync(plistPath, "utf8")));
  } catch {
    return null;
  }
}

function collectBundleExecutableUuids(
  app: string,
  helpers: readonly string[],
): {
  readonly mainPlist: Record<string, unknown> | null;
  readonly uuids: ReadonlyMap<string, string | null>;
} {
  const mainPlist = readPlistRecord(join(app, "Contents", "Info.plist"));
  const uuids = new Map<string, string | null>();
  const addBundle = (relBundle: string, plistObj: Record<string, unknown> | null): void => {
    const exe =
      typeof plistObj?.CFBundleExecutable === "string" ? plistObj.CFBundleExecutable : null;
    const relExe = exe
      ? join(relBundle, "Contents", "MacOS", exe)
      : join(relBundle, "Contents", "MacOS");
    const absExe = join(app, relExe);
    uuids.set(relExe, exe && existsSync(absExe) ? readMachoExecuteUuid(absExe) : null);
  };
  addBundle("", mainPlist);
  for (const helper of helpers) {
    if (!helper.endsWith(".app")) continue;
    const relBundle = join("Contents", "Frameworks", helper);
    addBundle(relBundle, readPlistRecord(join(app, relBundle, "Contents", "Info.plist")));
  }
  return { mainPlist, uuids };
}

/** Verifies macOS Local Network privacy metadata and unique non-stock Mach-O executable LC_UUIDs. */
export function macBundleLocalNetworkChecks(
  infoPlist: unknown,
  uuids: ReadonlyMap<string, string | null>,
): Check[] {
  const record = asPlistRecord(infoPlist) ?? {};
  const desc = record.NSLocalNetworkUsageDescription;
  const hasDesc = typeof desc === "string" && desc.trim() !== "";

  const problems: string[] = [];
  if (uuids.size < 2) {
    problems.push(`expected app and helper executables, got ${uuids.size}`);
  }
  const seen = new Map<string, string>();
  for (const [exePath, uuid] of uuids) {
    if (uuid === null) {
      problems.push(`${exePath}: missing LC_UUID`);
      continue;
    }
    const lower = uuid.toLowerCase();
    if (lower.startsWith(STOCK_LLD_UUID_PREFIX)) {
      problems.push(`${exePath}: stock lld UUID (${uuid})`);
    }
    const prev = seen.get(lower);
    if (prev !== undefined) {
      problems.push(`${exePath}: duplicates ${prev} (${uuid})`);
    } else {
      seen.set(lower, exePath);
    }
  }

  return [
    {
      name: "Info.plist carries NSLocalNetworkUsageDescription",
      pass: hasDesc,
      detail: hasDesc ? desc : "missing NSLocalNetworkUsageDescription in Contents/Info.plist",
    },
    {
      name: "app and helper executables carry unique non-stock Mach-O LC_UUIDs",
      pass: problems.length === 0,
      detail: problems.length === 0 ? `${uuids.size} unique UUIDs` : problems.join("; "),
    },
  ];
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
 * uninstaller, `pnpm.exe`, each listed file, and the files that keep Microsoft's signature
 * (onnxruntime's, the VC++ runtime and Electron's d3dcompiler_47.dll).
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
  const { status, stdout, stderr } = runRaw(command, args);
  return { status, output: `${stdout}${stderr}` };
}

/** Every file under `dir`, links aside. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** A macOS app bundle's payload Mach-O binaries: non-empty, with every required path present. */
export function payloadNativesCheck(
  natives: readonly string[],
  required: readonly string[],
): Check {
  const missing = required.filter((file) => !natives.includes(file));
  return {
    name: "the payload holds natives to check",
    pass: natives.length > 0 && missing.length === 0,
    detail:
      missing.length > 0 ? `missing: ${missing.join(", ")}` : `${natives.length} Mach-O files`,
  };
}

function runRaw(
  command: string,
  args: readonly string[],
  input?: string | Uint8Array,
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(command, args, {
    ...(input !== undefined ? { input } : {}),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function checkProvisioningProfile(app: string, record: (check: Check) => void): void {
  const profilePath = join(app, "Contents", "embedded.provisionprofile");
  const expectProfile = process.env.EIDOLON_EXPECT_PROVISIONING_PROFILE === "1";
  if (!existsSync(profilePath)) {
    if (expectProfile) {
      record({
        name: "embedded.provisionprofile is present when provisioned signing was enabled",
        pass: false,
        detail: `missing: ${profilePath}`,
      });
    }
    return;
  }
  const cms = runRaw("security", ["cms", "-D", "-i", profilePath]);
  if (cms.status !== 0) {
    record({
      name: "embedded.provisionprofile decodes cleanly",
      pass: false,
      detail: `security cms exited ${cms.status ?? "null"}: ${firstLine(`${cms.stdout}\n${cms.stderr}`)}`,
    });
    return;
  }
  const xmlRun = runRaw("plutil", ["-convert", "xml1", "-o", "-", "-"], cms.stdout);
  if (xmlRun.status !== 0) {
    record({
      name: "embedded.provisionprofile converts to XML plist",
      pass: false,
      detail: `plutil exited ${xmlRun.status ?? "null"}: ${firstLine(`${xmlRun.stdout}\n${xmlRun.stderr}`)}`,
    });
    return;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseAppleXmlPlist(xmlRun.stdout) as Record<string, unknown>;
  } catch (error) {
    record({
      name: "embedded.provisionprofile parses as plist XML",
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const certs = Array.isArray(parsed.DeveloperCertificates)
    ? parsed.DeveloperCertificates.filter((value): value is string => typeof value === "string")
    : [];
  const subjects = certs.map((b64) => {
    const out = runRaw(
      "openssl",
      ["x509", "-inform", "der", "-noout", "-subject", "-email", "-nameopt", "RFC2253"],
      Buffer.from(b64, "base64"),
    );
    return { status: out.status, output: `${out.stdout}${out.stderr}` };
  });
  for (const check of provisioningProfileChecks(parsed, subjects)) record(check);
}

function checkMac(record: (check: Check) => void): void {
  const app = join(DESKTOP, ".out", "mac-arm64", "LAPLACE Eidolon.app");
  if (!existsSync(app)) throw new Error(`No ${app}: package the release first`);
  record(verifyCheck(run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app])));
  record(macSignerCheck(run("codesign", ["-dvvv", app])));
  record(gatekeeperCheck(run("spctl", ["--assess", "--type", "execute", "--verbose=4", app])));
  record(stapleCheck(run("xcrun", ["stapler", "validate", app])));
  const macNotify = join(app, "Contents", "Resources", "native", "mac_notify.node");
  if (existsSync(macNotify)) {
    record(nativeCheck("native/mac_notify.node", run("codesign", ["-dvvv", macNotify])));
  } else {
    record({
      name: "native/mac_notify.node ships in Contents/Resources/native",
      pass: false,
      detail: `missing: ${macNotify}`,
    });
  }
  checkProvisioningProfile(app, record);
  const payload = join(app, "Contents", "Resources", "eidolon");
  const pnpmExe = join(shimPnpmExe(payload, { os: "darwin", cpu: "arm64" }), "pnpm");
  const natives = existsSync(payload)
    ? filesUnder(payload).filter((file) => /\.(node|dylib)$/.test(file) || file === pnpmExe)
    : [];
  record(
    payloadNativesCheck(
      natives.map((file) => relative(payload, file)),
      [relative(payload, pnpmExe)],
    ),
  );
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
  const { mainPlist, uuids } = collectBundleExecutableUuids(app, helpers);
  for (const check of macBundleLocalNetworkChecks(mainPlist, uuids)) record(check);
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

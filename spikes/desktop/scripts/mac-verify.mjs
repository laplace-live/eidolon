// The signed and notarized macOS build's checks, M1 to M5, into <evidence>/mac-signature.json. Exits 1
// when one fails.
// usage: node scripts/mac-verify.mjs [--app .out/mac-arm64/Eidolon.app] [--dmg <path>]
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { SPIKE, writeEvidence } from "./lib.mjs";

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}
const APP = resolve(option("app", join(SPIKE, ".out/mac-arm64/Eidolon.app")));
const OUT = join(APP, "..", "..");
const DMG = resolve(option("dmg", join(OUT, readdirSync(OUT).find((f) => f.endsWith(".dmg")) ?? "missing.dmg")));
const PAYLOAD = join(APP, "Contents/Resources/eidolon");

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}
const short = (text) => text.split(APP).join("<app>").split(OUT).join("<out>");
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}
/** codesign's description of one file's signature. */
function describe(path) {
  const { code, out } = run("codesign", ["-dvvv", path]);
  const field = (name) => out.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1] ?? null;
  return {
    code,
    identifier: field("Identifier"),
    flags: out.match(/flags=(0x[0-9a-f]+\([^)]*\))/)?.[1] ?? null,
    authority: [...out.matchAll(/^Authority=(.*)$/gm)].map((m) => m[1]),
    timestamp: field("Timestamp"),
    team: field("TeamIdentifier"),
    runtime: /flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/.test(out),
  };
}
const normalizedRequirement = (text) =>
  text
    .replace(/\/\*.*?\*\//g, "")
    .replace(/"/g, "")
    .replace(/^.*designated\s*=>\s*/s, "")
    .replace(/\s+/g, " ")
    .trim();

const checks = {};
const result = { app: short(APP), dmg: short(DMG), checks };

// M1
const verify = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", APP]);
checks.M1 = { status: verify.code === 0 ? "pass" : "fail", command: "codesign --verify --deep --strict --verbose=2", output: short(verify.out) };

// M2
const assess = run("spctl", ["--assess", "--type", "execute", "-vv", APP]);
checks.M2 = {
  status: assess.code === 0 && /source=Notarized Developer ID/.test(assess.out) ? "pass" : "fail",
  command: "spctl --assess --type execute -vv",
  output: short(assess.out),
};

// M3
const stapleApp = run("xcrun", ["stapler", "validate", APP]);
const stapleDmg = run("xcrun", ["stapler", "validate", DMG]);
const dmgSignature = run("codesign", ["-dvvv", DMG]);
const dmgAssess = run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", DMG]);
checks.M3 = {
  status: stapleApp.code === 0 && stapleDmg.code === 0 ? "pass" : "fail",
  app: { code: stapleApp.code, output: short(stapleApp.out) },
  dmg: { code: stapleDmg.code, output: short(stapleDmg.out) },
  dmgSignature: short(dmgSignature.out).split("\n").filter((l) => /^(Authority|TeamIdentifier|Timestamp|Signature|code object)/.test(l) || /not signed/.test(l)),
  dmgGatekeeper: { code: dmgAssess.code, output: short(dmgAssess.out) },
};

// M4
const natives = walk(PAYLOAD).filter((f) => /\.(node|dylib)$/.test(f));
const described = natives.map((f) => ({ file: relative(PAYLOAD, f), ...describe(f) }));
checks.M4 = {
  status:
    natives.length > 0 &&
    described.every((d) => d.code === 0 && d.runtime && d.timestamp !== null && d.authority[0]?.startsWith("Developer ID Application:"))
      ? "pass"
      : "fail",
  files: described.map((d) => ({ file: d.file, runtime: d.runtime, flags: d.flags, timestamp: d.timestamp, authority: d.authority[0] ?? null, team: d.team })),
};

// M5
const expected = normalizedRequirement(readFileSync(join(SPIKE, "resources/requirements.mac.txt"), "utf8"));
const requirementOf = (path) => {
  const { code, out } = run("codesign", ["-d", "-r-", path]);
  return { code, text: out.match(/designated => .*/)?.[0] ?? short(out), normalized: normalizedRequirement(out) };
};
const appRequirement = requirementOf(APP);
const helpers = readdirSync(join(APP, "Contents/Frameworks"))
  .filter((name) => name.endsWith(".app") || name.endsWith(".framework"))
  .map((name) => {
    const path = join(APP, "Contents/Frameworks", name);
    const check = run("codesign", ["--verify", "--strict", "--verbose=2", path]);
    const requirement = requirementOf(path);
    return { name, verify: check.code === 0 ? "valid" : short(check.out), requirement: requirement.text, matches: requirement.normalized === expected };
  });
checks.M5 = {
  status: appRequirement.normalized === expected && helpers.length > 0 && helpers.every((h) => h.verify === "valid") ? "pass" : "fail",
  designated: appRequirement.text,
  expected,
  helpers,
};

const main = describe(APP);
result.signer = { identifier: main.identifier, authority: main.authority, team: main.team, timestamp: main.timestamp, flags: main.flags };
result.entitlements = short(run("codesign", ["-d", "--entitlements", "-", "--xml", APP]).out).slice(0, 2000);
writeEvidence("mac-signature.json", result);
console.log(JSON.stringify(result, null, 1));
for (const [id, { status }] of Object.entries(checks)) console.log(`${id}: ${status}`);
process.exit(Object.values(checks).every((c) => c.status === "pass") ? 0 : 1);

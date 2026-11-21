// The Windows steps around the NSIS installer, each writing <evidence>/windows-<label>-<step>.json and
// exiting 1 when its check fails:
//   install <setup or its folder> --label <l>   W1: a silent per-user install, where it went, and the
//                                               Start-menu shortcut's AppUserModelID
//   uninstall --label <l> --run <run name>      W7: a silent uninstall leaves the run's data home as it was
//   signatures <win-unpacked> --setup <folder>  S1: Authenticode on the build's PE files
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { powershellJson, RUNS, SPIKE, sleep, writeEvidence } from "./lib.mjs";

const [command, positional] = process.argv.slice(2);
function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}
const LABEL = option("label", "app");
const PUBLISHERS = ["Sparanoid, Inc.", "LAPLACE Live LLC"];
const APP_USER_MODEL_ID = "live.laplace.eidolon";
const INSTALL_DIR = join(process.env.LOCALAPPDATA ?? "", "Programs", "eidolon");
const EXE = join(INSTALL_DIR, "Eidolon.exe");
const UNINSTALLER = join(INSTALL_DIR, "Uninstall Eidolon.exe");
const START_MENU_LINK = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Eidolon.lnk");
const quote = (path) => `'${String(path).replace(/'/g, "''")}'`;

/** The NSIS setup in electron-builder's output folder `dir`, or `dir` itself when it is the file. */
function setupIn(dir) {
  const path = resolve(dir);
  if (!statSync(path).isDirectory()) return path;
  const found = readdirSync(path).filter((f) => /^Eidolon Setup .*\.exe$/.test(f) && !f.includes("__uninstaller"));
  if (found.length !== 1) throw new Error(`expected one setup in ${path}, found ${JSON.stringify(found)}`);
  return join(path, found[0]);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/**
 * Records the check and exits 1 only when `done` is false: the install or uninstall didn't happen.
 * A check that fails otherwise leaves the next steps running; report.mjs fails the job for it.
 */
function finish(step, pass, evidence, done = true) {
  const file = writeEvidence(`windows-${LABEL}-${step}.json`, { label: LABEL, step, status: pass ? "pass" : "fail", ...evidence });
  console.log(JSON.stringify({ status: pass ? "pass" : "fail", ...evidence }, null, 1));
  console.log(`${step} (${LABEL}): ${pass ? "pass" : "fail"}; evidence in ${file}`);
  process.exit(done ? 0 : 1);
}

/** Authenticode status, signer and timestamper of each path. */
function signatures(paths) {
  if (paths.length === 0) return [];
  mkdirSync(RUNS, { recursive: true });
  const list = join(RUNS, `signature-paths-${process.pid}.txt`);
  writeFileSync(list, paths.join("\n"), "utf8");
  return powershellJson(
    `Get-Content -LiteralPath ${quote(list)} -Encoding UTF8 | Where-Object { $_ } | ForEach-Object { $s = Get-AuthenticodeSignature -LiteralPath $_; [pscustomobject]@{ path = [string]$_; status = $s.Status.ToString(); signer = $s.SignerCertificate.Subject; issuer = $s.SignerCertificate.Issuer; timestamper = $s.TimeStamperCertificate.Subject } }`,
  );
}
const cnOf = (subject) => subject?.match(/CN=("([^"]+)"|[^,]+)/)?.slice(2).find(Boolean) ?? subject?.match(/CN=([^,]+)/)?.[1] ?? null;

function uninstallEntries(hive) {
  return powershellJson(
    `Get-ChildItem -Path '${hive}:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | Where-Object { $_.DisplayName -like 'Eidolon*' } | Select-Object DisplayName,DisplayVersion,Publisher,InstallLocation,UninstallString,QuietUninstallString`,
  );
}

function shortcutFacts() {
  if (!existsSync(START_MENU_LINK)) return { exists: false };
  const [facts] = powershellJson(
    `$lnk = ${quote(START_MENU_LINK)}
$target = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk).TargetPath
$folder = (New-Object -ComObject Shell.Application).Namespace([System.IO.Path]::GetDirectoryName($lnk))
$item = $folder.ParseName([System.IO.Path]::GetFileName($lnk))
$aumid = $null
try { $aumid = $item.ExtendedProperty('System.AppUserModel.ID') } catch {}
$start = $null
try { $start = @(Get-StartApps -Name 'Eidolon' | Select-Object Name,AppID) } catch { $start = "Get-StartApps unavailable: $($_.Exception.Message)" }
[pscustomobject]@{ target = $target; aumid = $aumid; startApps = $start }`,
  );
  // The shortcut's property store holds the ID as UTF-16: a third read that needs no shell.
  const raw = readFileSync(START_MENU_LINK).includes(Buffer.from(APP_USER_MODEL_ID, "utf16le"));
  return { exists: true, path: START_MENU_LINK, ...facts, aumidInLinkBytes: raw };
}

// A crash still leaves evidence.
process.on("uncaughtException", (error) => {
  writeEvidence(`windows-${LABEL}-${command}.json`, { label: LABEL, step: command, status: "fail", error: String(error?.stack ?? error) });
  console.error(error);
  process.exit(1);
});

if (command === "install") {
  const setup = setupIn(positional);
  const startedAt = Date.now();
  const [started] = powershellJson(`$p = Start-Process -FilePath ${quote(setup)} -ArgumentList '/S' -Wait -PassThru; [pscustomobject]@{ exitCode = $p.ExitCode }`);
  for (let i = 0; i < 120 && !existsSync(EXE); i++) await sleep(500);
  const user = uninstallEntries("HKCU");
  const machine = uninstallEntries("HKLM");
  const shortcut = shortcutFacts();
  const installed = signatures([EXE, UNINSTALLER].filter(existsSync));
  const aumid = shortcut.aumid || (shortcut.aumidInLinkBytes ? APP_USER_MODEL_ID : null);
  const evidence = {
    setup: basename(setup),
    setupExitCode: started?.exitCode,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    installDir: INSTALL_DIR,
    exe: existsSync(EXE),
    uninstaller: existsSync(UNINSTALLER),
    programFiles: ["ProgramFiles", "ProgramFiles(x86)"].map((v) => join(process.env[v] ?? "", "Eidolon")).filter(existsSync),
    uninstallEntryHKCU: user,
    uninstallEntryHKLM: machine,
    startMenuShortcut: shortcut,
    aumid,
    installedSignatures: installed.map((s) => ({ file: basename(s.path), status: s.status, signer: cnOf(s.signer) })),
    files: existsSync(INSTALL_DIR) ? walk(INSTALL_DIR).length : 0,
  };
  const pass =
    started?.exitCode === 0 &&
    evidence.exe &&
    evidence.uninstaller &&
    evidence.programFiles.length === 0 &&
    // electron-builder's entry has no InstallLocation: its uninstaller's path and /currentuser say it.
    user.some((e) => String(e.UninstallString ?? "").toLowerCase().includes(UNINSTALLER.toLowerCase()) && /\/currentuser\b/.test(e.UninstallString)) &&
    machine.length === 0 &&
    shortcut.exists &&
    aumid === APP_USER_MODEL_ID;
  finish("install", pass, evidence, evidence.exe);
}

/** Every file under `dir` with its size and SHA-256. */
function snapshot(dir) {
  if (!existsSync(dir)) return null;
  return Object.fromEntries(
    walk(dir)
      .sort()
      .map((f) => [relative(dir, f).split("\\").join("/"), `${statSync(f).size} ${createHash("sha256").update(readFileSync(f)).digest("hex")}`]),
  );
}

if (command === "uninstall") {
  const runDir = join(RUNS, option("run", "installed"));
  const home = join(runDir, "home");
  const shared = join(runDir, "home-shared-skills");
  const before = { home: snapshot(home), shared: snapshot(shared) };
  const startedAt = Date.now();
  const [started] = powershellJson(`$p = Start-Process -FilePath ${quote(UNINSTALLER)} -ArgumentList '/S' -Wait -PassThru; [pscustomobject]@{ exitCode = $p.ExitCode }`);
  // The uninstaller copies itself to %TEMP% and runs from there, so its first process returns early.
  for (let i = 0; i < 240 && (existsSync(EXE) || existsSync(UNINSTALLER)); i++) await sleep(500);
  await sleep(2000);
  const after = { home: snapshot(home), shared: snapshot(shared) };
  const changed = [];
  for (const part of ["home", "shared"]) {
    const a = before[part] ?? {};
    const b = after[part] ?? {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[key] !== b[key]) changed.push(`${part}/${key}`);
    if ((before[part] === null) !== (after[part] === null)) changed.push(`${part}/ (folder ${before[part] === null ? "appeared" : "vanished"})`);
  }
  const evidence = {
    uninstallerExitCode: started?.exitCode,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    installDirLeft: existsSync(INSTALL_DIR) ? walk(INSTALL_DIR).map((f) => relative(INSTALL_DIR, f)).slice(0, 20) : null,
    startMenuShortcutLeft: existsSync(START_MENU_LINK),
    uninstallEntryHKCU: uninstallEntries("HKCU"),
    dataHome: { path: home, files: Object.keys(before.home ?? {}).length, sharedSkillsFiles: Object.keys(before.shared ?? {}).length, changed },
    defaultDataHomeExists: existsSync(join(process.env.USERPROFILE ?? "", ".laplace", "eidolon")),
    defaultProfileExists: existsSync(join(process.env.APPDATA ?? "", "Eidolon")),
  };
  const pass = started?.exitCode === 0 && !existsSync(EXE) && evidence.dataHome.files > 0 && changed.length === 0;
  finish("uninstall", pass, evidence, !existsSync(EXE));
}

if (command === "signatures") {
  const dir = resolve(positional);
  const payload = join(dir, "resources", "eidolon");
  const listed = new Set(JSON.parse(readFileSync(join(SPIKE, ".stage", "win32-x64", "unsigned-pe.json"), "utf8")).map((n) => n.toLowerCase()));
  const setup = option("setup", null) === null ? null : setupIn(option("setup", null));
  const files = walk(dir).filter((f) => /\.(exe|dll|node)$/i.test(f));
  const results = signatures([...files, ...(setup ? [resolve(setup)] : [])]);
  const byPath = new Map(results.map((r) => [resolve(r.path).toLowerCase(), r]));
  const facts = (path) => {
    const r = byPath.get(resolve(path).toLowerCase());
    return { file: relative(dir, path).split("\\").join("/"), status: r?.status ?? "missing", signer: cnOf(r?.signer), timestamper: cnOf(r?.timestamper) };
  };
  const org = (f) => f.status === "Valid" && PUBLISHERS.includes(f.signer);
  const microsoft = (f) => f.status === "Valid" && /^Microsoft/.test(f.signer ?? "");
  const inPayload = files.filter((f) => resolve(f).toLowerCase().startsWith(payload.toLowerCase()));
  const exe = facts(join(dir, "Eidolon.exe"));
  const listedFiles = inPayload.filter((f) => listed.has(basename(f).toLowerCase())).map(facts);
  const microsoftFiles = inPayload
    .filter((f) => /^(onnxruntime\.dll|onnxruntime_binding\.node|vcruntime140(_1)?\.dll|msvcp140(_1|_atomic_wait)?\.dll)$/i.test(basename(f)))
    .map(facts);
  const otherPayload = inPayload.filter((f) => !listed.has(basename(f).toLowerCase())).map(facts).filter((f) => !microsoftFiles.some((m) => m.file === f.file));
  const electron = files.filter((f) => !inPayload.includes(f)).map(facts);
  const setupFacts = setup ? { file: basename(setup), ...(() => { const r = byPath.get(resolve(setup).toLowerCase()); return { status: r?.status, signer: cnOf(r?.signer), timestamper: cnOf(r?.timestamper) }; })() } : null;
  const updateYml = join(dir, "resources", "app-update.yml");
  const evidence = {
    exe,
    setup: setupFacts,
    listed: [...listed],
    listedFiles,
    microsoftFiles,
    otherPayloadFiles: otherPayload,
    electronFiles: electron,
    appUpdateYml: existsSync(updateYml) ? readFileSync(updateYml, "utf8") : null,
  };
  const pass =
    org(exe) &&
    (setupFacts === null || org(setupFacts)) &&
    listedFiles.length >= listed.size &&
    listedFiles.every(org) &&
    microsoftFiles.length > 0 &&
    microsoftFiles.every(microsoft) &&
    otherPayload.every((f) => f.status === "Valid");
  finish("signatures", pass, evidence);
}

console.error("usage: node scripts/windows.mjs install <setup or folder> | uninstall --run <name> | signatures <win-unpacked> --setup <setup or folder>");
process.exit(2);

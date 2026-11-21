// Stages the backend payload Eidolon's resources hold, for this machine's platform, in
// .stage/<platform>-<arch>/eidolon: the npm build (bun run build:npm) plus its runtime dependencies,
// installed by npm as real files and pruned to the target. On Windows it also copies the VC++
// runtime the natives import beside them, and lists the payload's unsigned PE files in
// .stage/win32-x64/unsigned-pe.json for the release overlay's signExts.
// usage: node scripts/stage.mjs [--pack <dir>]   (default: the checkout's apps/eidolon/pack)
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPe } from "./pe.mjs";

const SPIKE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(SPIKE, "..", "..");
const TARGET = `${process.platform}-${process.arch}`;
if (TARGET !== "darwin-arm64" && TARGET !== "win32-x64") {
  throw new Error(`the spike stages darwin-arm64 and win32-x64 only, not ${TARGET}`);
}
const packAt = process.argv.indexOf("--pack");
const PACK = resolve(packAt === -1 ? join(REPO, "apps", "eidolon", "pack") : process.argv[packAt + 1]);
const STAGE = join(SPIKE, ".stage", TARGET);
const PAYLOAD = join(STAGE, "eidolon");
const MODULES = join(PAYLOAD, "node_modules");
const ORT_BIN = join(MODULES, "onnxruntime-node", "bin", "napi-v6");
/** What the natives may import from the Visual C++ runtime, as the redistributable names them. */
const VC_RUNTIME = [
  "vcruntime140.dll",
  "vcruntime140_1.dll",
  "msvcp140.dll",
  "msvcp140_1.dll",
  "msvcp140_atomic_wait.dll",
];

const report = { target: TARGET, pack: PACK, startedAt: new Date().toISOString(), pruned: [] };

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}
const bytesOf = (path) =>
  statSync(path).isDirectory() ? walk(path).reduce((sum, f) => sum + statSync(f).size, 0) : statSync(path).size;
const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;
const rel = (path) => relative(PAYLOAD, path).split("\\").join("/");

function prune(path, why) {
  if (!existsSync(path)) return;
  report.pruned.push({ path: rel(path), mb: mb(bytesOf(path)), why });
  rmSync(path, { recursive: true, force: true });
}

if (!existsSync(join(PACK, "dist", "server.js"))) {
  throw new Error(`no npm build at ${PACK}: run bun run build:npm first`);
}
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
cpSync(PACK, PAYLOAD, { recursive: true });

// --os and --cpu keep LanceDB's optional binary for this target only.
const [os, cpu] = TARGET.split("-");
const npm = `npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock --os=${os} --cpu=${cpu}`;
console.log(`$ ${npm}`);
execSync(npm, { cwd: PAYLOAD, stdio: "inherit" });
report.installedMb = mb(bytesOf(MODULES));

prune(join(MODULES, ".bin"), "bin links");
prune(join(MODULES, "@types"), "types only");
prune(join(MODULES, "undici-types"), "types only");
for (const platform of readdirSync(ORT_BIN)) {
  if (platform !== process.platform) {
    prune(join(ORT_BIN, platform), "onnxruntime for another platform");
    continue;
  }
  for (const arch of readdirSync(join(ORT_BIN, platform))) {
    if (arch !== process.arch) prune(join(ORT_BIN, platform, arch), "onnxruntime for another arch");
  }
}
const ORT = join(ORT_BIN, process.platform, process.arch);
if (TARGET === "darwin-arm64") {
  // The binding loads @rpath/libonnxruntime.1.dylib; the versioned name is a second copy.
  const loaded = join(ORT, "libonnxruntime.1.dylib");
  const copy = join(ORT, "libonnxruntime.1.30.0.dylib");
  const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  if (existsSync(copy) && existsSync(loaded) && sha(copy) === sha(loaded)) {
    prune(copy, "a byte-identical copy of libonnxruntime.1.dylib, which the binding loads");
  }
} else {
  // eidolon opens CPU sessions only; onnxruntime.dll delay-loads these.
  for (const name of ["DirectML.dll", "dxcompiler.dll", "dxil.dll"]) {
    prune(join(ORT, name), "DirectML, which CPU sessions never load");
  }
}
report.ortFiles = readdirSync(ORT).sort();

/** The Microsoft.VC14x.CRT folder of the newest Visual Studio redistributable on this runner. */
function vcRedist() {
  const roots = [];
  const vswhere = join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (existsSync(vswhere)) {
    const out = execFileSync(vswhere, ["-all", "-products", "*", "-property", "installationPath"], {
      encoding: "utf8",
    });
    roots.push(...out.split(/\r?\n/).filter(Boolean));
  }
  const found = [];
  for (const root of roots) {
    const msvc = join(root, "VC", "Redist", "MSVC");
    if (!existsSync(msvc)) continue;
    for (const version of readdirSync(msvc)) {
      if (!/^\d+\.\d+\.\d+/.test(version)) continue;
      const x64 = join(msvc, version, "x64");
      if (!existsSync(x64)) continue;
      for (const crt of readdirSync(x64)) {
        const dir = join(x64, crt);
        if (/^Microsoft\.VC\d+\.CRT$/.test(crt) && VC_RUNTIME.every((dll) => existsSync(join(dir, dll)))) {
          found.push({ version, dir });
        }
      }
    }
  }
  const numeric = (v) => v.split(".").map(Number);
  found.sort((a, b) => {
    const [x, y] = [numeric(a.version), numeric(b.version)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
  report.vcRedistCandidates = found;
  if (found.length === 0) throw new Error(`no Visual Studio redist with ${VC_RUNTIME.join(", ")} under ${roots.join(", ") || "(no Visual Studio found)"}`);
  return found[0];
}

/** File versions, through PowerShell: the PE header holds none. */
function fileVersions(paths) {
  const list = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
  const script = `@(${list}) | ForEach-Object { $v = (Get-Item -LiteralPath $_).VersionInfo; [pscustomobject]@{ path = $_; file = $v.FileVersion; product = $v.ProductVersion } } | ConvertTo-Json -Compress`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

if (TARGET === "win32-x64") {
  const redist = vcRedist();
  const runtimeImports = new Map(
    VC_RUNTIME.map((dll) => [dll, readPe(join(redist.dir, dll)).imports.map((name) => name.toLowerCase())]),
  );
  /** `names` plus whatever runtime DLLs they import in turn. */
  const closure = (names) => {
    const out = new Set(names);
    for (let grew = true; grew; ) {
      grew = false;
      for (const dll of [...out]) {
        for (const dep of runtimeImports.get(dll) ?? []) {
          if (VC_RUNTIME.includes(dep) && !out.has(dep)) {
            out.add(dep);
            grew = true;
          }
        }
      }
    }
    return [...out].sort();
  };
  // Every folder holding a native addon gets the runtime DLLs its PE files import, beside them:
  // Node loads an addon with LOAD_WITH_ALTERED_SEARCH_PATH, which searches the addon's folder first.
  const natives = walk(MODULES).filter((f) => f.endsWith(".node"));
  const copies = [];
  for (const folder of [...new Set(natives.map((f) => dirname(f)))].sort()) {
    const pes = readdirSync(folder)
      .filter((name) => /\.(node|dll)$/i.test(name) && !VC_RUNTIME.includes(name.toLowerCase()))
      .map((name) => ({ name, pe: readPe(join(folder, name)) }))
      .filter((entry) => entry.pe !== null);
    const imported = pes.flatMap((entry) => entry.pe.imports.map((n) => n.toLowerCase())).filter((n) => VC_RUNTIME.includes(n));
    const needed = closure([...new Set(imported)]);
    for (const dll of needed) copyFileSync(join(redist.dir, dll), join(folder, dll));
    copies.push({
      folder: rel(folder),
      natives: pes.map((entry) => ({ name: entry.name, linker: entry.pe.linker, vcImports: entry.pe.imports.filter((n) => VC_RUNTIME.includes(n.toLowerCase())) })),
      copied: needed,
    });
  }
  const versions = fileVersions(VC_RUNTIME.map((dll) => join(redist.dir, dll)));
  report.vcRuntime = {
    from: redist.dir,
    redistVersion: redist.version,
    files: versions.map((v) => ({ name: basename(v.path), fileVersion: v.file, productVersion: v.product })),
    copies,
  };

  // Every PE file in the payload, and the .node and .dll ones with an empty certificate table.
  const pes = walk(PAYLOAD)
    .filter((f) => /\.(node|dll|exe)$/i.test(f))
    .map((f) => ({ path: rel(f), ...readPe(f) }));
  const unsigned = [...new Set(pes.filter((p) => !p.signed && /\.(node|dll)$/i.test(p.path)).map((p) => basename(p.path)))].sort();
  report.pe = pes.map(({ path, signed, certificateBytes, linker, imports, delayImports }) => ({
    path,
    signed,
    certificateBytes,
    linker,
    imports: imports.filter((n) => VC_RUNTIME.includes(n.toLowerCase())),
    delayImports,
  }));
  report.unsignedExe = pes.filter((p) => !p.signed && p.path.endsWith(".exe")).map((p) => p.path);
  report.unsignedPe = unsigned;
  writeFileSync(join(STAGE, "unsigned-pe.json"), `${JSON.stringify(unsigned, null, 1)}\n`);
}

const files = walk(PAYLOAD);
report.files = files.length;
report.payloadMb = mb(files.reduce((sum, f) => sum + statSync(f).size, 0));
const sizeOf = (path) => (existsSync(path) ? mb(bytesOf(path)) : null);
report.parts = {
  lancedb: sizeOf(join(MODULES, "@lancedb")),
  onnxruntime: sizeOf(join(MODULES, "onnxruntime-node")),
  sharp: mb(bytesOf(join(MODULES, "sharp")) + (existsSync(join(MODULES, "@img")) ? bytesOf(join(MODULES, "@img")) : 0)),
  web: sizeOf(join(PAYLOAD, "web")),
  dist: sizeOf(join(PAYLOAD, "dist")),
};
report.fileList = files.map(rel).sort();
report.finishedAt = new Date().toISOString();
writeFileSync(join(STAGE, "stage-report.json"), `${JSON.stringify(report, null, 1)}\n`);
const evidence = resolve(process.env.EIDOLON_SPIKE_EVIDENCE ?? join(SPIKE, ".evidence"));
mkdirSync(evidence, { recursive: true });
writeFileSync(join(evidence, `stage-${TARGET}.json`), `${JSON.stringify(report, null, 1)}\n`);
const { fileList: _list, pe: _pe, ...summary } = report;
console.log(JSON.stringify(summary, null, 1));

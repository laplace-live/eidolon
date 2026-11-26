// Which of the libraries a process mapped the natives check holds to the payload: stage.test.ts
// requires each one it keeps to load from there. And how a failed check says it ended.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkNatives, payloadLibraries } from "../scripts/natives.ts";

test("on Windows, the payload's natives and VC++ runtime, never the system's own C++ runtime", () => {
  const modules = "C:\\Program Files\\Eidolon\\resources\\eidolon\\node_modules";
  const zvec = `${modules}\\@zvec\\bindings-win32-x64`;
  const ort = `${modules}\\onnxruntime-node\\bin\\napi-v6\\win32\\x64`;
  const sharp = `${modules}\\@img\\sharp-win32-x64\\lib`;
  expect(
    payloadLibraries([
      "C:\\Program Files\\Eidolon\\Eidolon.exe",
      "C:\\WINDOWS\\SYSTEM32\\ntdll.dll",
      "C:\\WINDOWS\\System32\\USER32.dll",
      "C:\\WINDOWS\\System32\\gdi32full.dll",
      // USER32 → GDI32 → gdi32full maps it in every process with a window.
      "C:\\WINDOWS\\System32\\msvcp_win.dll",
      "C:\\WINDOWS\\System32\\ucrtbase.dll",
      `\\\\?\\${zvec}\\zvec_node_binding.node`,
      `\\\\?\\${ort}\\onnxruntime_binding.node`,
      `${ort}\\onnxruntime.dll`,
      `${ort}\\MSVCP140.dll`,
      `${ort}\\VCRUNTIME140_1.dll`,
      `\\\\?\\${sharp}\\sharp-win32-x64.node`,
      `${sharp}\\libvips-42.dll`,
    ]),
  ).toEqual([
    `${zvec}\\zvec_node_binding.node`,
    `${ort}\\onnxruntime_binding.node`,
    `${ort}\\onnxruntime.dll`,
    `${ort}\\MSVCP140.dll`,
    `${ort}\\VCRUNTIME140_1.dll`,
    `${sharp}\\sharp-win32-x64.node`,
    `${sharp}\\libvips-42.dll`,
  ]);
});

test("on macOS, the payload's natives, by their own names and not their folders'", () => {
  const modules = "/Users/sharp/LAPLACE Eidolon.app/Contents/Resources/eidolon/node_modules";
  expect(
    payloadLibraries([
      "/Users/sharp/LAPLACE Eidolon.app/Contents/MacOS/LAPLACE Eidolon",
      "/usr/lib/libc++.1.dylib",
      `${modules}/@zvec/bindings-darwin-arm64/zvec_node_binding.node`,
      `${modules}/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib`,
      `${modules}/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.17.3.dylib`,
    ]),
  ).toEqual([
    `${modules}/@zvec/bindings-darwin-arm64/zvec_node_binding.node`,
    `${modules}/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib`,
    `${modules}/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.17.3.dylib`,
  ]);
});

test("a check that never ran says why, as spawnSync gives it", () => {
  const runtime = join(tmpdir(), "eidolon-no-such-runtime");
  expect(() =>
    checkNatives("/payload", "@zvec/bindings-darwin-arm64", { command: runtime }),
  ).toThrow(`The natives check failed: spawnSync ${runtime} ENOENT:`);
});

// Windows ends a process with TerminateProcess, whatever signal process.kill names.
test.skipIf(process.platform === "win32")("a check a signal ended names the signal", () => {
  const runtime = {
    command: process.execPath,
    args: ["-e", "process.kill(process.pid, 'SIGKILL')"],
  };
  expect(() => checkNatives("/payload", "@zvec/bindings-darwin-arm64", runtime)).toThrow(
    "The natives check exited SIGKILL:",
  );
});

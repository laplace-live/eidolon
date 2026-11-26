// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/mcp/test/fixtures/exiting-parent-server.mjs@ac78a60
//
// Starts a helper that inherits stdout and stderr, then exits while the helper keeps running.
import { spawn } from "node:child_process";

const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: ["ignore", "inherit", "inherit"],
});
console.error(`helper ${helper.pid}`);
helper.unref();
process.exit(0);

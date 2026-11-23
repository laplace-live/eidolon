// Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>
// SPDX-License-Identifier: MIT
//
// Ported from cross-spawn lib/util/escape.js and lib/parse.js@77cd97f
//
// Windows runs a .cmd or .bat only through cmd.exe, which reads the command line before the batch
// file does: each word escaped so it reaches the program as it came.

// See http://www.robvanderwoude.com/escapechars.php
const metaCharsRegExp = /([()\][%!^"`<>&|;, *?])/g;

/** `command`, a program's path, escaped for cmd.exe. */
export function escapeCommand(command) {
  return command.replace(metaCharsRegExp, "^$1");
}

/**
 * `arg` quoted for the program's own parser and escaped for cmd.exe, then once more for each of the
 * `rereads` times cmd.exe reads it again: a batch file hands its arguments on through `%*`, which
 * cmd.exe reads a second time (cross-spawn's doubleEscape, `true` here too).
 */
export function escapeArgument(arg, rereads) {
  // Algorithm below is based on https://qntm.org/cmd: a run of backslashes doubles before a double
  // quote, which one more escapes, and before the end, which the closing quote follows, and stays
  // as it is elsewhere. A scan, since cross-spawn's backtracking-free regexes double only one
  // backslash of a run (https://github.com/moxystudio/node-cross-spawn/issues/188).
  let escaped = "";
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashes++;
      continue;
    }
    escaped += "\\".repeat(char === '"' ? backslashes * 2 + 1 : backslashes) + char;
    backslashes = 0;
  }
  escaped = `"${escaped}${"\\".repeat(backslashes * 2)}"`;

  // Escape meta chars
  escaped = escaped.replace(metaCharsRegExp, "^$1");

  // Escape them again for each time cmd.exe reads them again: one escape fewer than its reads lets
  // it act on them, one more leaves carets in them.
  for (let read = 0; read < Number(rereads); read++) {
    escaped = escaped.replace(metaCharsRegExp, "^$1");
  }

  return escaped;
}

/**
 * How cmd.exe (`comspec`) runs `file` with `args`, for spawn with windowsVerbatimArguments: /s
 * strips the quotes around the whole line, which keep cmd.exe's own parsing off it, each word
 * escaped for `rereads` as escapeArgument escapes it.
 */
export function cmdLine(comspec, file, args, rereads) {
  const line = [escapeCommand(file), ...args.map((arg) => escapeArgument(arg, rereads))];
  return { command: comspec, args: ["/d", "/s", "/c", `"${line.join(" ")}"`] };
}

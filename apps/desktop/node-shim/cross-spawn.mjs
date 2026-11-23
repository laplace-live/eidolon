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
 * `arg` quoted for the program's own parser and escaped for cmd.exe, twice with `doubleEscape`:
 * a batch file hands its arguments on through `%*`, which cmd.exe reads a second time.
 */
export function escapeArgument(arg, doubleEscape) {
  // Algorithm below is based on https://qntm.org/cmd
  // It's slightly altered to disable JS backtracking to avoid hanging on specially crafted input
  // Please see https://github.com/moxystudio/node-cross-spawn/pull/160 for more information

  // Sequence of backslashes followed by a double quote:
  // double up all the backslashes and escape the double quote
  let escaped = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');

  // Sequence of backslashes followed by the end of the string
  // (which will become a double quote later):
  // double up all the backslashes
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, "$1$1");

  // All other backslashes occur literally

  // Quote the whole thing:
  escaped = `"${escaped}"`;

  // Escape meta chars
  escaped = escaped.replace(metaCharsRegExp, "^$1");

  // Double escape meta chars if necessary
  if (doubleEscape) {
    escaped = escaped.replace(metaCharsRegExp, "^$1");
  }

  return escaped;
}

/**
 * How cmd.exe (`comspec`) runs `file` with `args`, for spawn with windowsVerbatimArguments: /s
 * strips the quotes around the whole line, which keep cmd.exe's own parsing off it.
 */
export function cmdLine(comspec, file, args, doubleEscape) {
  const line = [escapeCommand(file), ...args.map((arg) => escapeArgument(arg, doubleEscape))];
  return { command: comspec, args: ["/d", "/s", "/c", `"${line.join(" ")}"`] };
}

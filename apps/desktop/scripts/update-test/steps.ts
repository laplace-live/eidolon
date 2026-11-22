// main.log's lines from the updater's start to quitAndInstall, which the update test follows in
// order (docs/desktop.md, Updates): each with the time it may take after the one before, and the
// lines after which the update can't go on without a person.

/** One of the update's lines in main.log. */
export interface UpdateStep {
  /** The check it passes, as the test prints it. */
  readonly name: string;
  /** The line's message, or its start. */
  readonly line: string;
  /** How long after the step before it, or after the launch, the line may take to come. */
  readonly ms: number;
}

/** The update to `version`, from the updater's mode line to the install. */
export function updateSteps(version: string): readonly UpdateStep[] {
  return [
    {
      name: "its updater runs in background mode, under EIDOLON_DESKTOP_UPDATE_TEST",
      line: "Eidolon: updates are on in background mode (EIDOLON_DESKTOP_UPDATE_TEST)",
      ms: 120_000,
    },
    {
      name: "it checks the feed once its backend is ready",
      line: "Eidolon: checking for updates",
      ms: 240_000,
    },
    {
      name: `it finds ${version} on the feed`,
      line: `Eidolon: update available: ${version}`,
      ms: 60_000,
    },
    {
      name: "Download, the box's default, starts the download",
      line: `Eidolon: downloading ${version}`,
      ms: 30_000,
    },
    {
      // On macOS this includes Squirrel.Mac's own fetch and its check of the update's signature.
      name: `it downloads ${version}`,
      line: `Eidolon: update downloaded: ${version}`,
      ms: 600_000,
    },
    {
      name: "Restart, the box's default, restarts to install it",
      line: `Eidolon: restarting to install ${version}`,
      ms: 30_000,
    },
    {
      name: "the quit check lets it quit",
      line: "Eidolon: quitting to install the update",
      ms: 60_000,
    },
    {
      name: `it stops its backend and installs ${version}`,
      line: `Eidolon: installing ${version}`,
      ms: 120_000,
    },
  ];
}

/** After one of these, the update goes no further without a person. */
const STOPS = [
  /^Eidolon: updates are (?:off|faked)\b/,
  /^Eidolon: up to date: /,
  /^Eidolon: the update check failed: /,
  /^Eidolon: an update box didn't show: /,
  // Background mode would answer its Try Again over and over.
  /^Eidolon: the download of \S+ failed: /,
  /^Eidolon: \S+ can't be installed: /,
  /^Eidolon: \S+ stays downloaded\b/,
  /^Eidolon: the restart failed: /,
  /^Eidolon: restarting without the update$/,
];

/** A main.log line's message, without electron-log's `[date time] [level]` before it. */
function message(line: string): string {
  return line.replace(/^\[[^\]]*\] \[\w+\]\s*/, "");
}

/** How far a main.log has followed the steps. */
export interface Progress {
  /** The line of each step seen, in order: a step counts only after the one before it. */
  readonly lines: readonly string[];
  /** The first line after which the update can't go on; null while none has come. */
  readonly stopped: string | null;
}

export function follow(text: string, steps: readonly UpdateStep[]): Progress {
  const lines: string[] = [];
  let stopped: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const said = message(line);
    const next = steps[lines.length];
    if (next !== undefined && said.startsWith(next.line)) lines.push(line);
    else if (stopped === null && STOPS.some((stop) => stop.test(said))) stopped = line;
  }
  return { lines, stopped };
}

/** The version a log's last start line names, the line logStart() writes; null without one. */
export function startedVersion(text: string): string | null {
  let version: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const started = /^Eidolon (\S+)(?: \(unpackaged\))? · Electron /.exec(message(line));
    if (started !== null) version = started[1] as string;
  }
  return version;
}

/** A log's last `count` lines that aren't empty. */
export function tail(text: string, count: number): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-count);
}

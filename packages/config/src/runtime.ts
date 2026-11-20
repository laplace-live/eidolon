/**
 * What starts our own JS in a child: this runtime, and inside Electron the variable that makes its
 * binary act as Node. Merge `env` into any explicit child environment.
 */
export function jsRuntime(): {
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
} {
  return {
    command: process.execPath,
    env: process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" },
  };
}

/**
 * What starts our own JS in a child: this runtime, the flags that go before the script, and inside
 * Electron the variable that makes its binary act as Node. Merge `env` into any explicit child
 * environment.
 */
export function jsRuntime(): {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
} {
  const electron = process.versions.electron !== undefined;
  return {
    command: process.execPath,
    // In Electron's node mode the inspect fuse doesn't apply, so SIGUSR1 would open an inspector,
    // and the nodeOptions fuse drops NODE_EXTRA_CA_CERTS: the OS store is the only way a corporate
    // CA gets in.
    args: electron ? ["--disable-sigusr1", "--use-system-ca"] : [],
    env: electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
  };
}

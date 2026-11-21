const RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";

/**
 * The environment to start Electron's GUI with: `env` and `extra` without ELECTRON_RUN_AS_NODE, whose
 * every non-empty value, `0` included, starts the binary as Node instead. Windows reads the name in
 * any case.
 */
export function electronEnv(
  extra: NodeJS.ProcessEnv = {},
  { env = process.env, platform = process.platform } = {},
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...env, ...extra };
  for (const name of Object.keys(merged)) {
    if (name === RUN_AS_NODE || (platform === "win32" && name.toUpperCase() === RUN_AS_NODE)) {
      delete merged[name];
    }
  }
  return merged;
}

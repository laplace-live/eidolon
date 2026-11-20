/**
 * `name` as getenv reads it, or null when unset. Node's diagnostic report lists the C environment
 * (libuv's uv_os_environ), not the process.env object.
 */
export function cEnv(name: string): string | null {
  const report = process.report.getReport() as {
    readonly environmentVariables?: Readonly<Record<string, string>>;
  };
  return report.environmentVariables?.[name] ?? null;
}

// laplace-transcribe: turns audio into a transcript of timestamped scenes with Soniox.
import { type CommandDeps, resolveIo } from "./io.ts";

/** The `laplace-transcribe` command; resolves to its exit code. */
export async function transcribeMain(
  _argv: readonly string[],
  deps: CommandDeps = {},
): Promise<number> {
  resolveIo(deps).stderr("laplace-transcribe: not implemented yet\n");
  return 1;
}

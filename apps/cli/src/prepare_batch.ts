// laplace-prepare-batch: writes the new videos of a captured archive listing into a batch.
import { type CommandDeps, resolveIo } from "./io.ts";

/** The `laplace-prepare-batch` command; resolves to its exit code. */
export async function prepareBatchMain(
  _argv: readonly string[],
  deps: CommandDeps = {},
): Promise<number> {
  resolveIo(deps).stderr("laplace-prepare-batch: not implemented yet\n");
  return 1;
}

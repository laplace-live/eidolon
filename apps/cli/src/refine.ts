// laplace-refine: has an LLM write each transcript scene's heading, summary and details.
import { type CommandDeps, resolveIo } from "./io.ts";

/** The `laplace-refine` command; resolves to its exit code. */
export async function refineMain(
  _argv: readonly string[],
  deps: CommandDeps = {},
): Promise<number> {
  resolveIo(deps).stderr("laplace-refine: not implemented yet\n");
  return 1;
}

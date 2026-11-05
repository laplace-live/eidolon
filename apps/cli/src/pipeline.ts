// laplace-pipeline: runs download, transcribe, refine and ingest over a URL list.
import { type CommandDeps, resolveIo } from "./io.ts";

/** The `laplace-pipeline` command; resolves to its exit code. */
export async function pipelineMain(
  _argv: readonly string[],
  deps: CommandDeps = {},
): Promise<number> {
  resolveIo(deps).stderr("laplace-pipeline: not implemented yet\n");
  return 1;
}

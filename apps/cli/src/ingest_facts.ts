// laplace-ingest-facts: embeds the persona's fact files into the persona_facts table.
import { type CommandDeps, resolveIo } from "./io.ts";

/** The `laplace-ingest-facts` command; resolves to its exit code. */
export async function ingestFactsMain(
  _argv: readonly string[],
  deps: CommandDeps = {},
): Promise<number> {
  resolveIo(deps).stderr("laplace-ingest-facts: not implemented yet\n");
  return 1;
}

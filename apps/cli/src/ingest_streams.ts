// laplace-ingest-streams: embeds the refined scenes into the stream_chunks table.
import { type CommandDeps, resolveIo } from "./io.ts";

/** The `laplace-ingest-streams` command; resolves to its exit code. */
export async function ingestStreamsMain(
  _argv: readonly string[],
  deps: CommandDeps = {},
): Promise<number> {
  resolveIo(deps).stderr("laplace-ingest-streams: not implemented yet\n");
  return 1;
}

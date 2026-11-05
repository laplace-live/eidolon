// laplace-build-stream-catalog: writes stream_catalog.json, the broadcasts recalled by date.
import { type CommandDeps, resolveIo } from "./io.ts";

/** The `laplace-build-stream-catalog` command; resolves to its exit code. */
export async function buildStreamCatalogMain(
  _argv: readonly string[],
  deps: CommandDeps = {},
): Promise<number> {
  resolveIo(deps).stderr("laplace-build-stream-catalog: not implemented yet\n");
  return 1;
}

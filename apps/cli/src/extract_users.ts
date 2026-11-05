// laplace-extract-users: mines danmaku JSON for the viewer names a glossary should know.
import { type CommandDeps, resolveIo } from "./io.ts";

/** The `laplace-extract-users` command; resolves to its exit code. */
export async function extractUsersMain(
  _argv: readonly string[],
  deps: CommandDeps = {},
): Promise<number> {
  resolveIo(deps).stderr("laplace-extract-users: not implemented yet\n");
  return 1;
}

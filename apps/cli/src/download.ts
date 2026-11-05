// laplace-download: fetches the audio of a URL list's videos with yt-dlp.
import { type CommandDeps, resolveIo } from "./io.ts";

/** The `laplace-download` command; resolves to its exit code. */
export async function downloadMain(
  _argv: readonly string[],
  deps: CommandDeps = {},
): Promise<number> {
  resolveIo(deps).stderr("laplace-download: not implemented yet\n");
  return 1;
}

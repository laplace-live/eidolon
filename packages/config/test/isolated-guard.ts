// Imported first by every test file that deletes data-home folders. The isolating preload runs only
// when `bun test` starts at the repo root (bunfig.toml); from a subfolder EIDOLON_HOME stays unset
// and dataHome() is the developer's real data home, which those cleanups would delete.
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = process.env.EIDOLON_HOME;
if (home !== join(tmpdir(), `eidolon-test-home-${process.pid}`)) {
  throw new Error(
    `Refusing to run: EIDOLON_HOME is ${home === undefined ? "unset" : JSON.stringify(home)}, not ` +
      "this run's isolated temp home. Run `bun run test` (or `bun test`) from the repo root.",
  );
}

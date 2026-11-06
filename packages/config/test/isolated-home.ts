// Preloaded before every test file (bunfig.toml). Personas resolve from the repo's templates and an
// empty data home, never the developer's own; the parity tests that need the real index read it
// from EIDOLON_REAL_HOME.
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

process.env.EIDOLON_REAL_HOME ??=
  process.env.EIDOLON_HOME || join(homedir(), ".laplace", "eidolon");
process.env.EIDOLON_HOME = join(tmpdir(), `eidolon-test-home-${process.pid}`);
delete process.env.EIDOLON_PERSONA;
delete process.env.EIDOLON_APP_ROOT;

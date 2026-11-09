// main.ts's first import: applies the repo-root .env with python-dotenv semantics, file values over
// the inherited environment, as `load_dotenv(override=True)` applies them. EIDOLON_NO_DOTENV=1
// skips it, leaving only the process environment.
// Then the settings files (docs/personas.md), layered with the environment the .env just set.
import { envFlag, findDotenv, installSettings, loadDotenv } from "@eidolon/config";

if (!envFlag("EIDOLON_NO_DOTENV", false)) {
  loadDotenv(findDotenv(import.meta.dir), { override: true });
}
installSettings();

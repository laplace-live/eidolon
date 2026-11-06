// main.ts's first import: applies the repo-root .env with python-dotenv semantics, file values over
// the inherited environment, as bot.py's load_dotenv(override=True) does. EIDOLON_NO_DOTENV=1 skips
// it, leaving only the process environment.
// Then the settings files (docs/personas.md), beneath the environment the .env just set.
import { envFlag, findDotenv, installSettings, loadDotenv } from "@eidolon/config";

if (!envFlag("EIDOLON_NO_DOTENV", false)) {
  loadDotenv(findDotenv(import.meta.dir), { override: true });
}
installSettings();

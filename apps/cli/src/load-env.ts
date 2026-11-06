// main.ts's first import: applies the repo-root .env with python-dotenv semantics, file values over
// the inherited environment, as each Python CLI's load_dotenv(override=True) does.
// EIDOLON_NO_DOTENV=1 skips it, leaving only the process environment.
// Then the settings files (docs/personas.md), beneath the environment the .env just set, for the
// persona a `--persona` names.
import { envFlag, findDotenv, installSettings, loadDotenv } from "@eidolon/config";
import { personaArg } from "./persona-arg.ts";

if (!envFlag("EIDOLON_NO_DOTENV", false)) {
  loadDotenv(findDotenv(import.meta.dir), { override: true });
}
const persona = personaArg(Bun.argv.slice(2));
if (persona) process.env.EIDOLON_PERSONA = persona;
installSettings();

// main.ts's first import: applies the repo-root .env with python-dotenv semantics, file values over
// the inherited environment, as bot.py's load_dotenv(override=True) does.
// Then the settings files (docs/personas.md), beneath the environment the .env just set.
import { findDotenv, installSettings, loadDotenv } from "@eidolon/config";

loadDotenv(findDotenv(import.meta.dir), { override: true });
installSettings();

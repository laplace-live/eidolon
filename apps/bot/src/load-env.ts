// main.ts's first import: applies the repo-root .env with python-dotenv semantics, file values over
// the inherited environment, as bot.py's load_dotenv(override=True) does.
import { findDotenv, loadDotenv } from "@eidolon/config";

loadDotenv(findDotenv(import.meta.dir), { override: true });

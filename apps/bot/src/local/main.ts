// `pnpm local`: supervises the local web app's server (server.ts), and starts a fresh one when
// it exits 75 to apply settings read once at boot.

// The first two imports, in this order: the environment as this process started (environ.ts), then
// the .env over it, for the reason apps/bot/src/main.ts gives.
import "./environ.ts";
import "../load-env.ts";
import { supervise } from "./supervisor.ts";

process.exit(await supervise(process.argv.slice(2)));

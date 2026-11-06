// `bun run local`: supervises the local web app's server (server.ts), and starts a fresh one when
// it exits 75 to apply settings read once at boot.

// Must stay the first import, for the reason apps/bot/src/main.ts gives.
import "../load-env.ts";
import { supervise } from "./supervisor.ts";

process.exit(await supervise(Bun.argv.slice(2)));

// bin/eidolon.mjs: launcher.ts's main, apart from it so tests can import launcher.ts.
import { main } from "./launcher.ts";

main(process.argv.slice(2));

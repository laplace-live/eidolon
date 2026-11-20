// The environment this process started with, before load-env.ts applies the .env over it: what the
// children that apply the .env themselves (the server, CLI jobs) start with. Node's spawn passes
// process.env as it is now, and what this process applied from the .env would keep a key deleted
// from it since alive in each of them. The local entries import this module first.

// The local app runs on Node. Under Bun, its children would read a .env and a bunfig.toml from the
// folders they start in (a task's command, the data home), and web_fetch couldn't pin an address.
if (process.versions.bun !== undefined) {
  process.stderr.write(
    "eidolon: the local app runs on Node 24 or later: start it with `bun run app` or `node apps/bot/src/local/main.ts`.\n",
  );
  process.exit(1);
}

export const STARTED_ENV: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
);

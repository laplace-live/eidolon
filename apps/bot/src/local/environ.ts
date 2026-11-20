// The environment this process started with, before load-env.ts applies the .env over it: what the
// children that apply the .env themselves (the server, CLI jobs) start with. Node's spawn passes
// process.env as it is now, and what this process applied from the .env would keep a key deleted
// from it since alive in each of them. The local entries import this module first.
export const STARTED_ENV: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
);

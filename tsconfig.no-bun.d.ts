// What `bun` and `bun:*` resolve to under tsconfig.json: nothing. Resolving them to @types/bun would
// also declare the Bun global for every file, so runtime code using it would still type-check.
export {};

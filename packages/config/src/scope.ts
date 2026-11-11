// The persona withPersona runs as. The env readers and the persona lookups read it before what
// installSettings installed.
import { AsyncLocalStorage } from "node:async_hooks";
import type { LoadedSettings } from "./settings.ts";

/** What the env readers resolve against, beneath the environment. */
export interface FileLayer {
  /** The files' values, the local app's derived defaults beneath them. */
  readonly values: ReadonlyMap<string, string>;
  /** The variables the persona's file decides. */
  readonly owned: ReadonlySet<string>;
}

export interface PersonaScope extends FileLayer {
  readonly settings: LoadedSettings;
}

export const personaScopes = new AsyncLocalStorage<PersonaScope>();

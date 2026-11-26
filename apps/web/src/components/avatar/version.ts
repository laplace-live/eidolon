// Which picture of each persona the page shows. A document reuses an image it has already loaded
// under the same URL, whatever the response's caching headers say ("list of available images",
// https://html.spec.whatwg.org/multipage/images.html#list-of-available-images), so a replaced avatar
// loads again only under a new URL: each change bumps the persona's version, which goes in it.
import { useSyncExternalStore } from "react";
import { url } from "@/lib/api";

let hostEpoch = 0;
const versions = new Map<string, number>();
const listeners = new Set<() => void>();

/** Persona `id`'s picture changed: every avatar of hers on the page loads it again. */
export function avatarChanged(id: string): void {
  versions.set(id, (versions.get(id) ?? 0) + 1);
  for (const listener of listeners) listener();
}

/** Active Subspace host changed: bump every avatar URL past the previous host's image cache. */
export function avatarsResetForHost(): void {
  hostEpoch += 1_000_000;
  versions.clear();
  for (const listener of listeners) listener();
}

export function avatarVersion(id: string): number {
  return hostEpoch + (versions.get(id) ?? 0);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAvatarVersion(id: string): number {
  return useSyncExternalStore(
    subscribe,
    () => avatarVersion(id),
    () => avatarVersion(id),
  );
}

/** The avatar route's URL for the picture's `version`. */
export function avatarSrc(id: string, version: number): string {
  const src = url("GET /api/local/personas/:id/avatar", { params: { id } });
  return version === 0 ? src : `${src}?v=${version}`;
}

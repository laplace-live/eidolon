// Which picture of each persona the page shows. A document reuses an image it has already loaded
// under the same URL, whatever the response's caching headers say ("list of available images",
// https://html.spec.whatwg.org/multipage/images.html#list-of-available-images), so a replaced avatar
// loads again only under a new URL: each change bumps the persona's version, which goes in it.
import { useSyncExternalStore } from "react";
import { url } from "@/lib/api";

const versions = new Map<string, number>();
const listeners = new Set<() => void>();

/** Persona `id`'s picture changed: every avatar of hers on the page loads it again. */
export function avatarChanged(id: string): void {
  versions.set(id, avatarVersion(id) + 1);
  for (const listener of listeners) listener();
}

export function avatarVersion(id: string): number {
  return versions.get(id) ?? 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAvatarVersion(id: string): number {
  return useSyncExternalStore(subscribe, () => avatarVersion(id));
}

/**
 * Whether her avatar asks for the picture: her `avatar` flag says she has one, or her picture
 * changed on this page after whoever holds the flag read it.
 */
export function loadsPicture(avatar: boolean | undefined, version: number): boolean {
  return avatar !== false || version > 0;
}

/** The avatar route's URL for the picture's `version`. */
export function avatarSrc(id: string, version: number): string {
  const src = url("GET /api/local/personas/:id/avatar", { params: { id } });
  return version === 0 ? src : `${src}?v=${version}`;
}

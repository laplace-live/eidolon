// take_selfie's render arrives as root-relative paths in an RTVI server message. The page shows
// only same-origin /api/selfie/<id> paths: it never loads an image from wherever a message says.
const SELFIE_PATH = /^\/api\/selfie\/[\w-]{1,64}(?:\.[A-Za-z0-9]{1,8})?$/;

/** The selfie paths in a server message; none when it isn't a selfie. */
export function selfiePaths(data: unknown): string[] {
  if (typeof data !== "object" || data === null) return [];
  const { type, urls } = data as { readonly type?: unknown; readonly urls?: unknown };
  if (type !== "selfie" || !Array.isArray(urls)) return [];
  return urls.filter((url): url is string => typeof url === "string" && SELFIE_PATH.test(url));
}

/** Whose photo a server message says it is, as a group call's selfie does; null for no one. */
export function selfiePersona(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const { persona } = data as { readonly persona?: unknown };
  return typeof persona === "string" && persona !== "" ? persona : null;
}

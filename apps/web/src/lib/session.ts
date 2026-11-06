// The terminal prints, or opens, the app's URL with a link code as its fragment. The page trades
// the code for the session cookie and its proof once; the code never reaches storage, logs or a
// Referer.
import { ApiError, call } from "./api";
import { keepProof } from "./proof";

const LINK_CODE = /^\d+\.[\w-]+$/;

/** The link code in a pasted link, a bare fragment (`#<code>`) or the code itself. */
export function linkCodeIn(text: string): string | null {
  const trimmed = text.trim();
  const code = trimmed.slice(trimmed.lastIndexOf("#") + 1);
  return LINK_CODE.test(code) ? code : null;
}

/** The link code in the address bar's fragment, which it removes so a reload or copy can't reuse it. */
export function takeLinkCode(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState" | "state">,
): string | null {
  const code = location.hash ? linkCodeIn(location.hash) : null;
  if (code) history.replaceState(history.state, "", location.pathname + location.search);
  return code;
}

/** Sets the session cookie and keeps its proof; null on success, else why the code was refused. */
export async function exchangeLinkCode(code: string): Promise<ApiError | null> {
  try {
    const { proof } = await call("POST /api/local/session", { body: { code } });
    keepProof(proof);
    return null;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
}

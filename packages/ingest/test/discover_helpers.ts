// A fake Bilibili for laplace-discover's tests, here and in apps/cli: the homepage sets the cookies
// the API wants, and each API path answers as its route says.

export interface Sent {
  readonly url: URL;
  readonly referer: string | null;
  readonly cookie: string | null;
}

export type Route = (url: URL) => unknown;

/** Bilibili as `routes` answer it, by path: a value is the `data` of a success, a Response as is. */
export function fakeBilibili(routes: Readonly<Record<string, Route>>): {
  readonly fetch: typeof fetch;
  readonly sent: Sent[];
} {
  const sent: Sent[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    sent.push({ url, referer: headers.get("referer"), cookie: headers.get("cookie") });
    if (url.hostname === "www.bilibili.com") {
      return new Response("<html></html>", {
        headers: [
          ["set-cookie", "buvid3=ABC-123infoc; path=/; domain=.bilibili.com"],
          ["set-cookie", "b_nut=1795000000; path=/"],
          ["set-cookie", "other=x; path=/"],
        ],
      });
    }
    const route = routes[url.pathname];
    if (route === undefined) throw new Error(`unexpected request: ${url.href}`);
    const data = route(url);
    if (data instanceof Response) return data;
    return Response.json({ code: 0, message: "0", data });
  };
  return { fetch: fake as unknown as typeof fetch, sent };
}

/** `url` without its trailing slashes, cut by hand: /\/+$/ is quadratic on a long run of them. */
export function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
}

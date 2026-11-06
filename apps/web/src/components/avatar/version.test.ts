import { expect, test } from "bun:test";
import { avatarChanged, avatarSrc, avatarVersion } from "./version";

test("a changed picture gets a URL the page hasn't loaded, for that persona only", () => {
  const before = avatarSrc("milky-green", avatarVersion("milky-green"));
  expect(before).toBe("/api/local/personas/milky-green/avatar");

  avatarChanged("milky-green");
  const after = avatarSrc("milky-green", avatarVersion("milky-green"));
  expect(after).not.toBe(before);
  expect(after).toStartWith("/api/local/personas/milky-green/avatar?v=");

  avatarChanged("milky-green");
  expect(avatarSrc("milky-green", avatarVersion("milky-green"))).not.toBe(after);
  expect(avatarSrc("someone-else", avatarVersion("someone-else"))).toBe(
    "/api/local/personas/someone-else/avatar",
  );
});

test("the id is one encoded path segment", () => {
  expect(avatarSrc("a/b", 0)).toBe("/api/local/personas/a%2Fb/avatar");
});

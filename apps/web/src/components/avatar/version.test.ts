import { expect, test } from "vitest";
import { avatarChanged, avatarSrc, avatarsResetForHost, avatarVersion } from "./version";

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

test("switching Subspace hosts bumps every persona avatar version away from stale image cache", () => {
  const before = avatarSrc("someone-else", avatarVersion("someone-else"));
  avatarsResetForHost();
  const afterHostA = avatarSrc("someone-else", avatarVersion("someone-else"));
  expect(afterHostA).not.toBe(before);
  expect(afterHostA).toContain("?v=");

  avatarChanged("someone-else");
  const afterEdit = avatarSrc("someone-else", avatarVersion("someone-else"));
  avatarsResetForHost();
  const afterHostB = avatarSrc("someone-else", avatarVersion("someone-else"));
  expect(afterHostB).not.toBe(afterHostA);
  expect(afterHostB).not.toBe(afterEdit);
});

test("the id is one encoded path segment", () => {
  expect(avatarSrc("a/b", 0)).toBe("/api/local/personas/a%2Fb/avatar");
});

import { expect, test } from "bun:test";
import { monogram } from "./monogram";

test("CJK names keep up to two characters", () => {
  expect(monogram("奶绿")).toBe("奶绿");
  expect(monogram("明前奶绿")).toBe("明前");
  expect(monogram("绿")).toBe("绿");
  expect(monogram("さくら")).toBe("さく");
});

test("other names give initials", () => {
  expect(monogram("Milky Green")).toBe("MG");
  expect(monogram("  aria  ")).toBe("A");
  expect(monogram("Élodie de la Tour")).toBe("ÉD");
});

test("a grapheme is never split", () => {
  expect(monogram("👩‍🎤 star")).toBe("👩‍🎤S");
});

test("nothing to show gives a placeholder", () => {
  expect(monogram("")).toBe("?");
  expect(monogram("   ")).toBe("?");
});

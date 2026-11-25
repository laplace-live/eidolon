import { expect, test } from "vitest";
import { HeardPictures } from "./pictures";

test("a picture changes when the main window's version of it moves, per persona", () => {
  const heard = new HeardPictures();
  expect(heard.changed("milky-green", 2)).toBe(false);
  expect(heard.changed("milky-green", 2)).toBe(false);
  expect(heard.changed("milky-green", 3)).toBe(true);
  expect(heard.changed("hazel", 0)).toBe(false);
  expect(heard.changed("milky-green", 3)).toBe(false);
  // The main window loaded again, its versions back at 0.
  expect(heard.changed("milky-green", 0)).toBe(true);
  expect(heard.changed("hazel", 1)).toBe(true);
});

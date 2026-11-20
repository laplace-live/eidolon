import { expect, test } from "vitest";
import { sanitize } from "../src/tools/output.ts";

test("a command's output loses its control characters, DEL with them, but keeps its lines", () => {
  expect(sanitize("a\x7Fb\x07\n\x1b[31mred\x1b[0m\tend\r\nnext")).toBe("ab\nred\tend\nnext");
});

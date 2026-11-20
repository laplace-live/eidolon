import { expect, test } from "vitest";
import { parseInline, parseMarkdown } from "./markdown";

/** `value` without its positions, for the shape alone. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "at")
      .map(([key, inner]) => [key, shape(inner)]),
  );
}

const text = (value: string) => ({ kind: "text", text: value });
const line = (...parts: unknown[]) => ({ parts });

test("lines run together into paragraphs, a blank line between them", () => {
  expect(shape(parseMarkdown("Hello\nthere\n\nAgain"))).toEqual([
    { kind: "paragraph", lines: [line(text("Hello")), line(text("there"))] },
    { kind: "paragraph", lines: [line(text("Again"))] },
  ]);
  expect(parseMarkdown("")).toEqual([]);
  expect(parseMarkdown("\n \n")).toEqual([]);
});

test("headings, lists and rules are blocks of their own", () => {
  const blocks = parseMarkdown(
    "## What I did\n- wrote index.html\n- checked it\n---\n1. open it\n2) tick",
  );
  expect(shape(blocks)).toEqual([
    { kind: "heading", level: 2, content: [text("What I did")] },
    {
      kind: "list",
      ordered: false,
      start: 1,
      items: [line(text("wrote index.html")), line(text("checked it"))],
    },
    { kind: "rule" },
    { kind: "list", ordered: true, start: 1, items: [line(text("open it")), line(text("tick"))] },
  ]);
  expect(parseMarkdown("3. third\n4. fourth")[0]).toMatchObject({ ordered: true, start: 3 });
});

test("an indented line goes on with the list item above it", () => {
  expect(shape(parseMarkdown("* one\n  more of one\n* two\nafter"))).toEqual([
    {
      kind: "list",
      ordered: false,
      start: 1,
      items: [line(text("one more of one")), line(text("two"))],
    },
    { kind: "paragraph", lines: [line(text("after"))] },
  ]);
});

test("a fence keeps its lines as they are, to its end or the text's", () => {
  expect(shape(parseMarkdown("Run:\n```bash\nbun run app\n  # **not bold**\n```\nDone"))).toEqual([
    { kind: "paragraph", lines: [line(text("Run:"))] },
    { kind: "code", lang: "bash", text: "bun run app\n  # **not bold**" },
    { kind: "paragraph", lines: [line(text("Done"))] },
  ]);
  expect(shape(parseMarkdown("~~~\nopen"))).toEqual([{ kind: "code", lang: "", text: "open" }]);
});

test("a fence ends only at a line of its own mark, as long or longer, so it can hold a shorter one", () => {
  // The worker quoting a README it wrote, whose own fence opens and closes inside.
  const quoted = "````markdown\n# Setup\n```bash\nbun run app\n```\n````\nDone";
  expect(shape(parseMarkdown(quoted))).toEqual([
    { kind: "code", lang: "markdown", text: "# Setup\n```bash\nbun run app\n```" },
    { kind: "paragraph", lines: [line(text("Done"))] },
  ]);
  expect(shape(parseMarkdown("```\n```js\n~~~\n````"))).toEqual([
    { kind: "code", lang: "", text: "```js\n~~~" },
  ]);
});

test("a heading keeps the # its words end with; only a closing run after a space goes", () => {
  expect(shape(parseMarkdown("## Ported it to C#\n# Done ##\n### F# #"))).toEqual([
    { kind: "heading", level: 2, content: [text("Ported it to C#")] },
    { kind: "heading", level: 1, content: [text("Done")] },
    { kind: "heading", level: 3, content: [text("F#")] },
  ]);
});

test("code spans and bold inside a line", () => {
  expect(shape(parseInline("Open **index.html** with `bun run app`."))).toEqual([
    text("Open "),
    { kind: "strong", text: "index.html" },
    text(" with "),
    { kind: "code", text: "bun run app" },
    text("."),
  ]);
  // Marks inside a code span are its text.
  expect(shape(parseInline("`**`"))).toEqual([{ kind: "code", text: "**" }]);
  // An unclosed mark is text.
  expect(shape(parseInline("a ** b ` c"))).toEqual([text("a ** b ` c")]);
});

test("each piece says where it starts: a block or line its line, a part its offset", () => {
  expect(parseInline("a `b` **c** `b`").map((part) => part.at)).toEqual([0, 2, 5, 6, 11, 12]);
  const blocks = parseMarkdown("# T\n\npara\nmore\n- x\n- y\n```\ncode\n```\n---");
  expect(blocks.map((block) => block.at)).toEqual([0, 2, 4, 6, 9]);
  expect(blocks[1]).toMatchObject({ lines: [{ at: 2 }, { at: 3 }] });
  expect(blocks[2]).toMatchObject({ items: [{ at: 4 }, { at: 5 }] });
});

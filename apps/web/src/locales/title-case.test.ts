// laplace-chat's capitalization, held for every label written where the scanner can tell it is one:
// buttons, menu items, field and column labels, headings, setting names and aria-labels are Title
// Case; a sentence, a question or a status in progress keeps sentence case.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";
import { keepsSentenceCase, labelsIn, titleCase } from "../../scripts/title-case.ts";

/** Headings phrased as a sentence, which nothing in their text marks as one. */
const SENTENCE_HEADINGS = new Set(["You're all set"]);

const SRC = join(import.meta.dir, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === "test" || name === "types" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

const parsed = (source: string, tsx: boolean) =>
  parse(source, { sourceType: "module", plugins: tsx ? ["typescript", "jsx"] : ["typescript"] });

const labels = sources(SRC).flatMap((path) =>
  labelsIn(relative(SRC, path), readFileSync(path, "utf8"), parsed),
);

test("labels are found by where they are written, through conditionals and label maps", () => {
  const source = `
    const ROLE_LABELS = { mind: msg\`Chat model\` } satisfies Record<string, unknown>;
    const TIPS = { mind: msg\`chat model\` };
    export function A({ open }: { open: boolean }) {
      const { t } = useLingui();
      return (
        <div>
        <Button aria-label={t\`Close dialog\`} title={t\`a tooltip\`}>
          {open ? t\`Save changes\` : t\`Discard\`}
          <span className="max-sm:sr-only">{t\`hang up\`}</span>
        </Button>
        <p>{t\`not a label\`}</p>
        </div>
      );
    }`;
  expect(labelsIn("probe.tsx", source, parsed).map((label) => [label.slot, label.text])).toEqual([
    ["ROLE_LABELS", "Chat model"],
    ["aria-label", "Close dialog"],
    ["<Button>", "Save changes"],
    ["<Button>", "Discard"],
    ["<Button>", "hang up"],
  ]);
});

test("every label is in Title Case", () => {
  expect(labels.some((label) => label.slot === "<Button>" && label.text === "Add Provider")).toBe(
    true,
  );
  const wrong = labels
    .filter(
      (label) =>
        !keepsSentenceCase(label.text) &&
        !SENTENCE_HEADINGS.has(label.text) &&
        titleCase(label.text) !== label.text,
    )
    .map(
      (label) =>
        `${label.file}:${label.line} ${label.slot} "${label.text}" → "${titleCase(label.text)}"`,
    );
  expect(wrong).toEqual([]);
});

describe("titleCase", () => {
  test("lowercases articles, conjunctions and prepositions whatever their length", () => {
    expect(titleCase("Add to bookmarks")).toBe("Add to Bookmarks");
    expect(titleCase("Export by types")).toBe("Export by Types");
    expect(titleCase("Hide until next update")).toBe("Hide until Next Update");
    expect(titleCase("Anonymous calls per window")).toBe("Anonymous Calls per Window");
  });

  test("capitalizes the first and last words, a particle, and the word after a colon", () => {
    expect(titleCase("of the index")).toBe("Of the Index");
    expect(titleCase("Browser to read cookies from")).toBe("Browser to Read Cookies From");
    expect(titleCase("Turn on memory")).toBe("Turn On Memory");
    expect(titleCase("Back up")).toBe("Back Up");
    expect(titleCase("Off: three models")).toBe("Off: Three Models");
  });

  test("leaves placeholders, names, files, acronyms and units as written", () => {
    expect(titleCase("Show {count} more")).toBe("Show {count} More");
    expect(titleCase("Hide for {seconds}s")).toBe("Hide for {seconds}s");
    expect(titleCase("yt-dlp binary")).toBe("yt-dlp Binary");
    expect(titleCase("OpenRouter API base")).toBe("OpenRouter API Base");
    expect(titleCase("Group id")).toBe("Group ID");
    expect(titleCase("s1 (retires 2026-12-31)")).toBe("s1 (Retires 2026-12-31)");
  });

  test("a sentence, a question or a status in progress keeps sentence case", () => {
    expect(keepsSentenceCase("Change the embedding model?")).toBe(true);
    expect(keepsSentenceCase("Key removed.")).toBe(true);
    expect(keepsSentenceCase("{name} is thinking…")).toBe(true);
    expect(keepsSentenceCase("Add Provider")).toBe(false);
  });
});

// The Markdown a task's worker writes, read lightly: paragraphs, headings, lists, rules, fenced
// code, code spans and bold. Everything else stays text, and nothing becomes HTML. Each piece
// carries where it starts, which keys it when rendered.

export type Inline =
  | { readonly kind: "text"; readonly at: number; readonly text: string }
  | { readonly kind: "code"; readonly at: number; readonly text: string }
  | { readonly kind: "strong"; readonly at: number; readonly text: string };

/** A line of text, `at` its line number. */
export interface Line {
  readonly at: number;
  readonly parts: readonly Inline[];
}

export type Block =
  | { readonly kind: "paragraph"; readonly at: number; readonly lines: readonly Line[] }
  | {
      readonly kind: "heading";
      readonly at: number;
      readonly level: number;
      readonly content: readonly Inline[];
    }
  | {
      readonly kind: "list";
      readonly at: number;
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly Line[];
    }
  | { readonly kind: "code"; readonly at: number; readonly lang: string; readonly text: string }
  | { readonly kind: "rule"; readonly at: number };

const FENCE = /^\s*(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const CONTINUED = /^\s+\S/;
const STRONG = /\*\*(.+?)\*\*/;
const CODE = /`([^`]+)`/;

function strongs(text: string, from: number, into: Inline[]) {
  let rest = text;
  let at = from;
  for (let match = STRONG.exec(rest); match; match = STRONG.exec(rest)) {
    if (match.index > 0) into.push({ kind: "text", at, text: rest.slice(0, match.index) });
    into.push({ kind: "strong", at: at + match.index, text: match[1] as string });
    at += match.index + match[0].length;
    rest = rest.slice(match.index + match[0].length);
  }
  if (rest !== "") into.push({ kind: "text", at, text: rest });
}

/** A line's code spans and bold, each `at` its offset in the line; a mark left open is text. */
export function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  let rest = line;
  let at = 0;
  for (let match = CODE.exec(rest); match; match = CODE.exec(rest)) {
    strongs(rest.slice(0, match.index), at, out);
    out.push({ kind: "code", at: at + match.index, text: match[1] as string });
    at += match.index + match[0].length;
    rest = rest.slice(match.index + match[0].length);
  }
  strongs(rest, at, out);
  return out;
}

/** Whether `line` ends a fence opened with `mark`: its character alone, at least as many. */
function closes(line: string, mark: string): boolean {
  const run = line.trim();
  return run.length >= mark.length && run === (mark[0] as string).repeat(run.length);
}

interface Open {
  readonly at: number;
  readonly lines: { at: number; text: string }[];
}

export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: Block[] = [];
  let paragraph: Open | null = null;
  let list: (Open & { readonly ordered: boolean; readonly start: number }) | null = null;
  const parsed = (open: Open): Line[] =>
    open.lines.map((line) => ({ at: line.at, parts: parseInline(line.text) }));

  const flush = () => {
    if (paragraph !== null) {
      blocks.push({ kind: "paragraph", at: paragraph.at, lines: parsed(paragraph) });
      paragraph = null;
    }
    if (list !== null) {
      blocks.push({
        kind: "list",
        at: list.at,
        ordered: list.ordered,
        start: list.start,
        items: parsed(list),
      });
      list = null;
    }
  };

  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] as string;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const opened = at;
      const mark = fence[1] as string;
      const body: string[] = [];
      for (at++; at < lines.length && !closes(lines[at] as string, mark); at++) {
        body.push(lines[at] as string);
      }
      blocks.push({ kind: "code", at: opened, lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const last = list?.lines.at(-1);
    if (last && CONTINUED.test(line) && !BULLET.test(line) && !NUMBERED.test(line)) {
      last.text = `${last.text} ${line.trim()}`;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = (heading[1] as string).length;
      blocks.push({ kind: "heading", at, level, content: parseInline(heading[2] as string) });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule", at });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = numbered !== null;
      if (list === null || list.ordered !== ordered) {
        flush();
        list = { at, ordered, start: numbered ? Number(numbered[1]) : 1, lines: [] };
      }
      list.lines.push({ at, text: ((bullet ?? numbered)?.[bullet ? 1 : 2] ?? "").trim() });
      continue;
    }
    if (list !== null) flush();
    paragraph ??= { at, lines: [] };
    paragraph.lines.push({ at, text: line.trim() });
  }
  flush();
  return blocks;
}

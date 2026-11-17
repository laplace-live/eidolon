// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/src/core/tools/edit-diff.ts@ac78a60
//
// The edit tool's matching and diffs: each edit is found in the file's LF view, exactly or after
// fuzzy normalization, and spliced into the original text over what it matched, so the text around
// it keeps its bytes. pi rewrote each line a fuzzy match touched from its normalized form.
import {
  type ChangeObject,
  createTwoFilesPatch,
  diffLines,
  FILE_HEADERS_ONLY,
  formatPatch,
  type StructuredPatchHunk,
  structuredPatch,
} from "diff";

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * `replacements`, matched in `normalizeToLF(originalContent)`, applied to `originalContent` itself.
 * Text outside the replaced ranges keeps its bytes, line endings included, and line breaks in the
 * new text get the ending of the line where the replaced range starts. Normalized to LF, the result
 * equals the replacements applied to the normalized content.
 */
export function applyReplacementsToOriginal(
  originalContent: string,
  replacements: readonly TextReplacement[],
): string {
  // Only CRLF changes length when normalizing: the LF of the n-th CRLF (at original offset p) is at
  // p - n in the normalized text. Adding the number of CRLFs before a normalized offset gives the
  // original offset, and a range that covers that LF covers the whole CRLF.
  let crlfBefore = 0;
  let nextCrlf = originalContent.indexOf("\r\n");
  const toOriginal = (offset: number): number => {
    while (nextCrlf !== -1 && nextCrlf - crlfBefore < offset) {
      crlfBefore++;
      nextCrlf = originalContent.indexOf("\r\n", nextCrlf + 2);
    }
    return offset + crlfBefore;
  };

  const parts: string[] = [];
  let endsWithCr = false;
  const push = (part: string): void => {
    if (part.length === 0) return;
    // A CR before a seam and an LF after it would merge into one CRLF line break, for example a
    // kept lone CR followed by inserted text that starts with LF, or both sides of a deleted range.
    // Adding an LF turns the CR into a line break of its own, so the file gets the breaks the diff
    // shows.
    if (endsWithCr && part[0] === "\n") parts.push("\n");
    parts.push(part);
    endsWithCr = part[part.length - 1] === "\r";
  };
  let position = 0;
  for (const replacement of replacements) {
    const start = toOriginal(replacement.matchIndex);
    push(originalContent.slice(position, start));
    const ending = getLineEndingAt(originalContent, start);
    push(ending === "\n" ? replacement.newText : replacement.newText.replaceAll("\n", ending));
    position = toOriginal(replacement.matchIndex + replacement.matchLength);
  }
  push(originalContent.slice(position));
  return parts.join("");
}

/**
 * The line ending of the line holding `offset`: its own LF or CRLF, or the line before's for an
 * unterminated last line. A lone CR counts only in files without any LF (classic Mac line endings);
 * elsewhere it is more likely a control character inside a line.
 */
function getLineEndingAt(content: string, offset: number): "\r\n" | "\n" | "\r" {
  let lineFeed = content.indexOf("\n", offset);
  if (lineFeed === -1) lineFeed = content.lastIndexOf("\n", offset);
  if (lineFeed === -1) return content.includes("\r") ? "\r" : "\n";
  return content[lineFeed - 1] === "\r" ? "\r\n" : "\n";
}

/** NFKC, and ASCII for Unicode quotes, dashes and spaces. */
function normalizeChars(text: string): string {
  return (
    text
      .normalize("NFKC")
      .replace(/[\u{2018}\u{2019}\u{201a}\u{201b}]/gu, "'")
      .replace(/[\u{201c}\u{201d}\u{201e}\u{201f}]/gu, '"')
      // Hyphen, non-breaking hyphen, figure dash, en and em dashes, horizontal bar and minus.
      .replace(/[\u{2010}\u{2011}\u{2012}\u{2013}\u{2014}\u{2015}\u{2212}]/gu, "-")
      // NBSP, the en space to the hair space, narrow NBSP, medium math space, ideographic space.
      .replace(/[\u{a0}\u{2002}-\u{200a}\u{202f}\u{205f}\u{3000}]/gu, " ")
  );
}

/** A stretch of a text and what fuzzy matching sees of it. */
interface FuzzyPiece {
  /** Where the stretch starts in the text, and how long it is there. */
  readonly from: number;
  readonly length: number;
  /** Where its normalized text starts in the normalized whole. */
  readonly at: number;
  readonly text: string;
  /** Normalized one character for one, so an offset inside it maps straight back. */
  readonly linear: boolean;
}

/** A text as fuzzy matching sees it, and where each of its lines starts, to map a match back. */
interface FuzzyView {
  readonly text: string;
  readonly lines: readonly string[];
  /** Where each line starts in the text it was made from. */
  readonly from: readonly number[];
  /** Where each line starts in `text`. */
  readonly at: readonly number[];
}

// Runs normalizing leaves alone, ASCII and CJK ideographs, captured; else a character with the
// marks after it, which NFKC may compose with it.
const FUZZY_PIECE =
  /((?:[!-~](?!\p{M}))+|(?:[\t\v\f ](?!\p{M}))+|(?:[\u{3400}-\u{4dbf}\u{4e00}-\u{9fff}](?!\p{M}))+)|[^\p{M}]\p{M}*|\p{M}+/gu;

// Characters that normalize the same whatever is beside them, so a line of them normalizes whole as
// it does piece by piece: ASCII, general punctuation, CJK punctuation without its tone marks, CJK
// ideographs and fullwidth ASCII. Not kana, Hangul or combining marks, which compose with a neighbor.
const CONTEXT_FREE =
  /^[\p{ASCII}\u{2000}-\u{206f}\u{3000}-\u{3029}\u{3030}-\u{303f}\u{3400}-\u{4dbf}\u{4e00}-\u{9fff}\u{ff01}-\u{ff5e}]*$/u;

/**
 * `line` as fuzzy matching compares it, but for its trailing whitespace. A line normalizing changes
 * is normalized piece by piece, so that a match in it maps back to the text it covers alone.
 */
function fuzzyLine(line: string): string {
  const whole = normalizeChars(line);
  if (whole === line || CONTEXT_FREE.test(line)) return whole;
  return line.replace(
    FUZZY_PIECE,
    (piece, kept: string | undefined) => kept ?? normalizeChars(piece),
  );
}

/**
 * `text` as fuzzy matching compares it: NFKC, no trailing whitespace on any line, and ASCII for
 * Unicode quotes, dashes and spaces. Only a match's first and last lines are cut into pieces
 * (linePieces), so an exact edit of a large file allocates no more than its lines.
 */
function fuzzyView(text: string): FuzzyView {
  const lines = text.split("\n");
  const from: number[] = [];
  const at: number[] = [];
  const normalized: string[] = [];
  let offset = 0;
  let normalizedOffset = 0;
  for (const line of lines) {
    const kept = fuzzyLine(line).trimEnd();
    from.push(offset);
    at.push(normalizedOffset);
    normalized.push(kept);
    offset += line.length + 1;
    normalizedOffset += kept.length + 1;
  }
  return { text: normalized.join("\n"), lines, from, at };
}

/** `text` as fuzzy matching compares it (fuzzyView's text). */
function normalizeForFuzzyMatch(text: string): string {
  return fuzzyView(text).text;
}

/** The pieces of `view`'s line `index`, as fuzzyLine normalizes them, and the line feed after it. */
function linePieces(view: FuzzyView, index: number): FuzzyPiece[] {
  const line = view.lines[index] as string;
  const from = view.from[index] as number;
  const lineAt = view.at[index] as number;
  const found: FuzzyPiece[] = [];
  if (normalizeChars(line) === line) {
    found.push({ from, length: line.length, at: lineAt, text: line, linear: true });
  } else {
    let at = lineAt;
    for (const match of line.matchAll(FUZZY_PIECE)) {
      const original = match[0];
      const piece = match[1] ?? normalizeChars(original);
      const linear = piece === original || (original.length === 1 && piece.length === 1);
      found.push({ from: from + match.index, length: original.length, at, text: piece, linear });
      at += piece.length;
    }
  }
  // Trailing whitespace is trimmed: what lies past the kept text normalizes to nothing.
  const kept =
    lineAt +
    found
      .map((piece) => piece.text)
      .join("")
      .trimEnd().length;
  const pieces: FuzzyPiece[] = [];
  for (const piece of found) {
    const end = piece.at + piece.text.length;
    if (end <= kept) {
      pieces.push(piece);
    } else if (piece.at >= kept) {
      pieces.push({ ...piece, at: kept, text: "", linear: false });
    } else {
      const keep = kept - piece.at;
      // An unchanged run splits where the whitespace starts; anything else is cut whole.
      if (piece.linear) {
        pieces.push({ ...piece, length: keep, text: piece.text.slice(0, keep) });
        pieces.push({
          from: piece.from + keep,
          length: piece.length - keep,
          at: kept,
          text: "",
          linear: false,
        });
      } else {
        pieces.push({ ...piece, text: piece.text.slice(0, keep), linear: false });
      }
    }
  }
  if (index + 1 < view.lines.length) {
    pieces.push({ from: from + line.length, length: 1, at: kept, text: "\n", linear: true });
  }
  return pieces;
}

/** The index of the last of `starts`, which ascend, at or before `offset`. */
function lastAtOrBefore(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] as number) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The piece of `view` that holds `offset` in its normalized text. */
function pieceAt(view: FuzzyView, offset: number): FuzzyPiece {
  const pieces = linePieces(view, lastAtOrBefore(view.at, offset));
  const starts = pieces.map((piece) => piece.at);
  return pieces[lastAtOrBefore(starts, offset)] as FuzzyPiece;
}

/**
 * A match of `matchLength` at `matchIndex` in `view`'s text, replaced by `newText`, as a replacement
 * of the text the view was made from. A match that starts or ends inside a piece normalizing
 * changed takes the whole piece, its part outside the match normalized.
 */
function replacementOfView(view: FuzzyView, match: TextReplacement): TextReplacement {
  const end = match.matchIndex + match.matchLength;
  const first = pieceAt(view, match.matchIndex);
  const last = pieceAt(view, end - 1);
  const into = match.matchIndex - first.at;
  const intoLast = end - last.at;
  const start = first.linear ? first.from + into : first.from;
  const stop = last.linear ? last.from + intoLast : last.from + last.length;
  const prefix = first.linear ? "" : first.text.slice(0, into);
  const suffix = last.linear ? "" : last.text.slice(intoLast);
  return { matchIndex: start, matchLength: stop - start, newText: prefix + match.newText + suffix };
}

interface MatchedEdit {
  readonly editIndex: number;
  readonly matchIndex: number;
  readonly matchLength: number;
  readonly newText: string;
}

/** Replacement of `matchLength` characters at `matchIndex` with `newText`. */
export type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

function applyReplacements(content: string, replacements: readonly TextReplacement[]): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i] as TextReplacement;
    result =
      result.substring(0, replacement.matchIndex) +
      replacement.newText +
      result.substring(replacement.matchIndex + replacement.matchLength);
  }
  return result;
}

interface FuzzyMatchResult {
  readonly found: boolean;
  readonly index: number;
  readonly matchLength: number;
  /** False for an exact match. */
  readonly usedFuzzyMatch: boolean;
}

export interface Edit {
  readonly oldText: string;
  readonly newText: string;
}

export interface AppliedEditsResult {
  readonly baseContent: string;
  readonly newContent: string;
  /** Sorted replacements of `baseContent` that turn it into `newContent`. */
  readonly replacements: readonly TextReplacement[];
}

/**
 * `oldText` in `content`, exactly, else as `fuzzyOldText`, its fuzzy normalization; a fuzzy
 * match's offsets are in `content`, which is then the fuzzy-normalized content.
 */
function fuzzyFindText(content: string, oldText: string, fuzzyOldText: string): FuzzyMatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false };
  }
  const fuzzyIndex = content.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) {
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
  }
  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
  };
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
    );
  }
  return new Error(
    `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
  );
}

function getDuplicateError(
  path: string,
  editIndex: number,
  totalEdits: number,
  occurrences: number,
): Error {
  if (totalEdits === 1) {
    return new Error(
      `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
    );
  }
  return new Error(
    `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
  );
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) return new Error(`oldText must not be empty in ${path}.`);
  return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
    );
  }
  return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * `edits` applied to LF-normalized content, each matched against the same original rather than
 * one after another. When any edit needs fuzzy matching, all are matched in fuzzy-normalized space
 * and mapped back to the text they cover, so everything else keeps its bytes. Throws, naming
 * `path`, when an edit is empty, missing, not unique or overlaps another, or nothing changes.
 */
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: readonly Edit[],
  path: string,
): AppliedEditsResult {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  for (let i = 0; i < normalizedEdits.length; i++) {
    if ((normalizedEdits[i] as Edit).oldText.length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length);
    }
  }

  // Uniqueness is judged after fuzzy normalization, so the view is needed for exact matches too.
  const view = fuzzyView(normalizedContent);
  const fuzzyOldTexts = normalizedEdits.map((edit) => normalizeForFuzzyMatch(edit.oldText));
  const usedFuzzyMatch = normalizedEdits.some((edit) => !normalizedContent.includes(edit.oldText));
  const replacementBaseContent = usedFuzzyMatch ? view.text : normalizedContent;

  const matchedEdits: MatchedEdit[] = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i] as Edit;
    const fuzzyOldText = fuzzyOldTexts[i] as string;
    const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText, fuzzyOldText);
    if (!matchResult.found) throw getNotFoundError(path, i, normalizedEdits.length);

    const occurrences = view.text.split(fuzzyOldText).length - 1;
    if (occurrences > 1) throw getDuplicateError(path, i, normalizedEdits.length, occurrences);

    const matched = {
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText,
    };
    matchedEdits.push(
      usedFuzzyMatch ? { ...matched, ...replacementOfView(view, matched) } : matched,
    );
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1] as MatchedEdit;
    const current = matchedEdits[i] as MatchedEdit;
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  const baseContent = normalizedContent;
  const replacements = matchedEdits;
  const newContent = applyReplacements(baseContent, replacements);
  if (baseContent === newContent) throw getNoChangeError(path, normalizedEdits.length);

  return { baseContent, newContent, replacements };
}

/** A standard unified patch of the whole contents. */
export function generateUnifiedPatch(
  path: string,
  oldContent: string,
  newContent: string,
  contextLines = 4,
): string {
  return createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
    context: contextLines,
    headerOptions: FILE_HEADERS_ONLY,
  });
}

/**
 * A display diff of the whole contents, with line numbers and `contextLines` around each change,
 * and the first changed line of the new contents.
 */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const lineNumWidth = String(Math.max(countLines(oldContent), countLines(newContent))).length;
  const { output, firstChangedLine } = formatDisplayDiff(
    diffLines(oldContent, newContent),
    1,
    1,
    lineNumWidth,
    contextLines,
  );
  return { diff: output.join("\n"), firstChangedLine };
}

/** The lines `text.split("\n")` would give, counted without building the array. */
function countLines(text: string): number {
  return countLineFeeds(text, 0, text.length) + 1;
}

function countLineFeeds(text: string, start: number, end: number): number {
  let count = 0;
  for (
    let index = text.indexOf("\n", start);
    index !== -1 && index < end;
    index = text.indexOf("\n", index + 1)
  ) {
    count++;
  }
  return count;
}

/** jsdiff's line parts as display diff lines, numbered from the 1-based old and new lines given. */
function formatDisplayDiff(
  parts: readonly ChangeObject<string>[],
  oldStartLine: number,
  newStartLine: number,
  lineNumWidth: number,
  contextLines: number,
): { output: string[]; firstChangedLine: number | undefined } {
  const output: string[] = [];
  let oldLineNum = oldStartLine;
  let newLineNum = newStartLine;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;
  const context = (line: string): void => {
    output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
    oldLineNum++;
    newLineNum++;
  };
  const skip = (lines: number): void => {
    output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
    oldLineNum += lines;
    newLineNum += lines;
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as ChangeObject<string>;
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();

    if (part.added || part.removed) {
      firstChangedLine ??= newLineNum;
      for (const line of raw) {
        if (part.added) {
          output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
          newLineNum++;
        } else {
          output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
      continue;
    }

    const next = parts[i + 1];
    const hasLeadingChange = lastWasChange;
    const hasTrailingChange = next !== undefined && (next.added || next.removed);
    if (hasLeadingChange && hasTrailingChange) {
      if (raw.length <= contextLines * 2) {
        for (const line of raw) context(line);
      } else {
        for (const line of raw.slice(0, contextLines)) context(line);
        skip(raw.length - contextLines * 2);
        for (const line of raw.slice(raw.length - contextLines)) context(line);
      }
    } else if (hasLeadingChange) {
      const shown = raw.slice(0, contextLines);
      for (const line of shown) context(line);
      if (raw.length > shown.length) skip(raw.length - shown.length);
    } else if (hasTrailingChange) {
      const skipped = Math.max(0, raw.length - contextLines);
      if (skipped > 0) skip(skipped);
      for (const line of raw.slice(skipped)) context(line);
    } else {
      oldLineNum += raw.length;
      newLineNum += raw.length;
    }
    lastWasChange = false;
  }

  return { output, firstChangedLine };
}

/** An edit's display diff and unified patch, as the edit tool's details carry them. */
export interface EditDiff {
  readonly diff: string;
  readonly patch: string;
  /** The first changed line of the new file. */
  readonly firstChangedLine: number | undefined;
}

/**
 * Unchanged lines diffed on each side of a replacement: well above the 4 context lines shown, so
 * jsdiff aligns a change within its window as it would over the whole file.
 */
const DIFF_WINDOW_MARGIN_LINES = 32;

/**
 * An edit diffed only around its replacements, so time and memory follow the size of the change
 * rather than the file's. It matches generateDiffString and generateUnifiedPatch over the whole
 * contents, except that jsdiff may align runs of repeated lines differently within a window.
 */
export function generateEditDiff(
  path: string,
  baseContent: string,
  newContent: string,
  replacements: readonly TextReplacement[],
  contextLines = 4,
): EditDiff {
  const lineNumWidth = String(Math.max(countLines(baseContent), countLines(newContent))).length;
  const skipMarker = ` ${"".padStart(lineNumWidth, " ")} ...`;
  const output: string[] = [];
  const hunks: StructuredPatchHunk[] = [];
  let firstChangedLine: number | undefined;
  for (const window of getDiffWindows(baseContent, replacements)) {
    const oldText = baseContent.slice(window.oldStart, window.oldEnd);
    const newText = newContent.slice(window.newStart, window.newEnd);
    const shown = formatDisplayDiff(
      diffLines(oldText, newText),
      window.oldLine + 1,
      window.newLine + 1,
      lineNumWidth,
      contextLines,
    );
    firstChangedLine ??= shown.firstChangedLine;
    // Both windows around a run of unchanged lines mark it skipped; the whole-file diff shows one.
    if (output.at(-1) === skipMarker && shown.output[0] === skipMarker) shown.output.shift();
    // A loop, not push(...lines): spreading a replacement of many lines overflows the call stack.
    for (const line of shown.output) output.push(line);
    const patch = structuredPatch(path, path, oldText, newText, undefined, undefined, {
      context: contextLines,
    });
    for (const hunk of patch.hunks) {
      hunks.push({
        ...hunk,
        oldStart: hunk.oldStart + window.oldLine,
        newStart: hunk.newStart + window.newLine,
      });
    }
  }
  const patch = formatPatch(
    { oldFileName: path, newFileName: path, oldHeader: undefined, newHeader: undefined, hunks },
    FILE_HEADERS_ONLY,
  );
  return { diff: output.join("\n"), patch, firstChangedLine };
}

/** Matching ranges of the old and new contents around replacements: offsets and 0-based lines. */
interface DiffWindow {
  oldStart: number;
  oldEnd: number;
  oldLine: number;
  newStart: number;
  newEnd: number;
  newLine: number;
}

/** The start of the line that holds `offset`. */
function lineStartBefore(text: string, offset: number): number {
  // lastIndexOf takes a negative position as 0, and would find a line feed at offset 0.
  return offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
}

/**
 * Whole-line windows with a margin around `replacements`, which are sorted and disjoint; windows
 * that overlap merge.
 */
function getDiffWindows(
  baseContent: string,
  replacements: readonly TextReplacement[],
): DiffWindow[] {
  const windows: DiffWindow[] = [];
  // The offset and line deltas of the replacements before the current one, and a line cursor.
  let offsetDelta = 0;
  let lineDelta = 0;
  let cursorOffset = 0;
  let cursorLine = 0;
  for (const replacement of replacements) {
    const matchEnd = replacement.matchIndex + replacement.matchLength;
    let start = lineStartBefore(baseContent, replacement.matchIndex);
    for (let i = 0; i < DIFF_WINDOW_MARGIN_LINES && start > 0; i++) {
      start = lineStartBefore(baseContent, start - 1);
    }
    let end = matchEnd;
    for (let i = 0; i <= DIFF_WINDOW_MARGIN_LINES && end < baseContent.length; i++) {
      const lineFeed = baseContent.indexOf(
        "\n",
        i === 0 ? Math.max(matchEnd - 1, replacement.matchIndex) : end,
      );
      end = lineFeed === -1 ? baseContent.length : lineFeed + 1;
    }
    const replacementOffsetDelta = replacement.newText.length - replacement.matchLength;
    const replacementLineDelta =
      countLineFeeds(replacement.newText, 0, replacement.newText.length) -
      countLineFeeds(baseContent, replacement.matchIndex, matchEnd);
    const previous = windows.at(-1);
    if (previous && start <= previous.oldEnd) {
      previous.oldEnd = Math.max(previous.oldEnd, end);
      previous.newEnd = previous.oldEnd + offsetDelta + replacementOffsetDelta;
    } else {
      cursorLine += countLineFeeds(baseContent, cursorOffset, start);
      cursorOffset = start;
      windows.push({
        oldStart: start,
        oldEnd: end,
        oldLine: cursorLine,
        newStart: start + offsetDelta,
        newEnd: end + offsetDelta + replacementOffsetDelta,
        newLine: cursorLine + lineDelta,
      });
    }
    offsetDelta += replacementOffsetDelta;
    lineDelta += replacementLineDelta;
  }
  return windows;
}

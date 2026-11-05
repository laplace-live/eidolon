// Python's `difflib.get_close_matches`, for the near-miss file names a missing audio path offers.

class SequenceMatcher {
  #a: string[] = [];
  readonly #b: string[];
  readonly #b2j = new Map<string, number[]>();
  readonly #fullBCount = new Map<string, number>();

  constructor(b: string) {
    this.#b = [...b];
    this.#b.forEach((elt, i) => {
      const indices = this.#b2j.get(elt);
      if (indices) indices.push(i);
      else this.#b2j.set(elt, [i]);
      this.#fullBCount.set(elt, (this.#fullBCount.get(elt) ?? 0) + 1);
    });
    // autojunk: in a sequence of 200 or more, elements in over 1% of it are ignored as popular.
    const n = this.#b.length;
    if (n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [elt, indices] of [...this.#b2j]) {
        if (indices.length > ntest) this.#b2j.delete(elt);
      }
    }
  }

  setSeq1(a: string): void {
    this.#a = [...a];
  }

  #longestMatch(alo: number, ahi: number, blo: number, bhi: number): [number, number, number] {
    const a = this.#a;
    const b = this.#b;
    let [besti, bestj, bestsize] = [alo, blo, 0];
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of this.#b2j.get(a[i] as string) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestsize) [besti, bestj, bestsize] = [i - k + 1, j - k + 1, k];
      }
      j2len = next;
    }
    // Popular elements are left out of b2j only: the best match extends over them on both ends.
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      [besti, bestj, bestsize] = [besti - 1, bestj - 1, bestsize + 1];
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize++;
    }
    return [besti, bestj, bestsize];
  }

  ratio(): number {
    let matches = 0;
    const queue: [number, number, number, number][] = [[0, this.#a.length, 0, this.#b.length]];
    while (queue.length > 0) {
      const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
      const [i, j, k] = this.#longestMatch(alo, ahi, blo, bhi);
      if (!k) continue;
      matches += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
    return this.#score(matches);
  }

  quickRatio(): number {
    const avail = new Map<string, number>();
    let matches = 0;
    for (const elt of this.#a) {
      const numb = avail.has(elt) ? (avail.get(elt) as number) : (this.#fullBCount.get(elt) ?? 0);
      avail.set(elt, numb - 1);
      if (numb > 0) matches++;
    }
    return this.#score(matches);
  }

  realQuickRatio(): number {
    return this.#score(Math.min(this.#a.length, this.#b.length));
  }

  #score(matches: number): number {
    const length = this.#a.length + this.#b.length;
    return length ? (2 * matches) / length : 1;
  }
}

function compareCodePoints(x: string, y: string): number {
  const a = [...x];
  const b = [...y];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = (a[i] as string).codePointAt(0)! - (b[i] as string).codePointAt(0)!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** `difflib.get_close_matches(word, possibilities, n, cutoff)`: best first, ties by name, descending. */
export function closeMatches(
  word: string,
  possibilities: Iterable<string>,
  n = 3,
  cutoff = 0.6,
): string[] {
  const matcher = new SequenceMatcher(word);
  const scored: [number, string][] = [];
  for (const x of possibilities) {
    matcher.setSeq1(x);
    if (
      matcher.realQuickRatio() >= cutoff &&
      matcher.quickRatio() >= cutoff &&
      matcher.ratio() >= cutoff
    ) {
      scored.push([matcher.ratio(), x]);
    }
  }
  scored.sort((p, q) => q[0] - p[0] || compareCodePoints(q[1], p[1]));
  return scored.slice(0, n).map(([, x]) => x);
}

// A pure-TS port of jieba 0.42.1's `cut(HMM=True)` and `cut_for_search`, because BM25 only matches
// when query tokens equal the `tokens` column the Python ingest wrote. `data/jieba/dict.txt` is the
// package's own file, byte for byte; `hmm.json` is `json.dumps` of finalseg's prob_start,
// prob_trans and prob_emit, whose shortest-repr floats parse back to the same doubles.
import { readFileSync } from "node:fs";

const DICT_URL = new URL("../data/jieba/dict.txt", import.meta.url);
const HMM_URL = new URL("../data/jieba/hmm.json", import.meta.url);

const MIN_FLOAT = -3.14e100;

// Python `re_han_default` / finalseg's `re_han` and `re_skip`: ASCII-only alnum, and only the
// U+4E00–U+9FD5 CJK block, so Extension A and full-width forms are cut one character at a time.
const RE_HAN_DEFAULT = /([\u4E00-\u9FD5a-zA-Z0-9+#&._%-]+)/u;
const RE_HAN_FINALSEG = /([\u4E00-\u9FD5]+)/u;
const RE_SKIP_FINALSEG = /([a-zA-Z0-9]+(?:\.\p{Nd}+)?%?)/u;

// HMM states in Python's iteration order. Ties go to the larger letter: Python takes `max` over
// `(prob, state)` tuples.
const B = 0;
const M = 1;
const E = 2;
const S = 3;
const LETTERS = ["B", "M", "E", "S"] as const;
const PREV_STATUS: readonly (readonly [number, number])[] = [
  [E, S],
  [M, B],
  [B, M],
  [S, E],
];

interface HmmTables {
  readonly start: Float64Array;
  /** trans[from * 4 + to], MIN_FLOAT where jieba has no entry. */
  readonly trans: Float64Array;
  readonly emit: readonly Map<string, number>[];
}

interface HmmJson {
  start: Record<string, number>;
  trans: Record<string, Record<string, number>>;
  emit: Record<string, Record<string, number>>;
}

function loadHmm(): HmmTables {
  const raw = JSON.parse(readFileSync(HMM_URL, "utf8")) as HmmJson;
  const start = new Float64Array(4);
  const trans = new Float64Array(16).fill(MIN_FLOAT);
  const emit: Map<string, number>[] = [];
  for (let y = 0; y < 4; y++) {
    const letter = LETTERS[y] as string;
    start[y] = raw.start[letter] ?? MIN_FLOAT;
    const row = raw.trans[letter] ?? {};
    for (let to = 0; to < 4; to++) {
      const p = row[LETTERS[to] as string];
      if (p !== undefined) trans[y * 4 + to] = p;
    }
    emit.push(new Map(Object.entries(raw.emit[letter] ?? {})));
  }
  return { start, trans, emit };
}

/** bytes.strip(): the dictionary is read as bytes, so only ASCII whitespace is stripped. */
function stripAscii(line: string): string {
  let start = 0;
  let end = line.length;
  const ws = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d);
  while (start < end && ws(line.charCodeAt(start))) start++;
  while (end > start && ws(line.charCodeAt(end - 1))) end--;
  return line.slice(start, end);
}

/** `Tokenizer.gen_pfdict`: every word's frequency, plus each absent prefix at 0. */
function genPfdict(text: string, name: string): { freq: Map<string, number>; total: number } {
  const freq = new Map<string, number>();
  let total = 0;
  let lineno = 0;
  for (let pos = 0; pos < text.length; ) {
    let end = text.indexOf("\n", pos);
    if (end === -1) end = text.length;
    const line = stripAscii(text.slice(pos, end));
    pos = end + 1;
    lineno++;
    const parts = line.split(" ");
    const word = parts[0] as string;
    const count = parts[1];
    if (count === undefined || !/^[0-9]+$/.test(count)) {
      throw new Error(`invalid dictionary entry in ${name} at Line ${lineno}: ${line}`);
    }
    const n = Number(count);
    freq.set(word, n);
    total += n;
    let frag = "";
    for (const ch of word) {
      frag += ch;
      if (!freq.has(frag)) freq.set(frag, 0);
    }
  }
  return { freq, total };
}

export class JiebaTokenizer {
  static #default: JiebaTokenizer | null = null;

  /** The process-wide tokenizer over the vendored jieba 0.42.1 data. */
  static default(): JiebaTokenizer {
    JiebaTokenizer.#default ??= new JiebaTokenizer();
    return JiebaTokenizer.#default;
  }

  #freq: Map<string, number> | null = null;
  #logTotal = 0;
  #hmm: HmmTables | null = null;

  get initialized(): boolean {
    return this.#freq !== null;
  }

  /** Builds the prefix dict and loads the HMM tables. Idempotent. */
  initialize(): void {
    if (this.#freq !== null) return;
    const { freq, total } = genPfdict(readFileSync(DICT_URL, "utf8"), DICT_URL.pathname);
    this.#hmm = loadHmm();
    this.#logTotal = Math.log(total);
    this.#freq = freq;
  }

  /** `jieba.cut(sentence)` with HMM on. */
  cut(sentence: string): string[] {
    this.initialize();
    const out: string[] = [];
    const blocks = sentence.split(RE_HAN_DEFAULT);
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i] as string;
      if (!block) continue;
      // split() puts the captured han runs at odd indices.
      if (i % 2 === 1) {
        this.#cutDag(Array.from(block), out);
        continue;
      }
      // re_skip_default splits on "\r\n" or one whitespace character; jieba yields every other
      // character on its own.
      for (let j = 0; j < block.length; ) {
        if (block.charCodeAt(j) === 0x0d && block.charCodeAt(j + 1) === 0x0a) {
          out.push("\r\n");
          j += 2;
          continue;
        }
        const ch = String.fromCodePoint(block.codePointAt(j) as number);
        out.push(ch);
        j += ch.length;
      }
    }
    return out;
  }

  /** `jieba.cut_for_search(sentence)` with HMM on: dictionary 2- and 3-grams before each long word. */
  cutForSearch(sentence: string): string[] {
    const freq = this.#dict();
    const out: string[] = [];
    for (const word of this.cut(sentence)) {
      const chars = Array.from(word);
      const n = chars.length;
      if (n > 2) {
        for (let i = 0; i < n - 1; i++) {
          const gram = (chars[i] as string) + (chars[i + 1] as string);
          if (freq.get(gram)) out.push(gram);
        }
      }
      if (n > 3) {
        for (let i = 0; i < n - 2; i++) {
          const gram = (chars[i] as string) + (chars[i + 1] as string) + (chars[i + 2] as string);
          if (freq.get(gram)) out.push(gram);
        }
      }
      out.push(word);
    }
    return out;
  }

  #dict(): Map<string, number> {
    this.initialize();
    return this.#freq as Map<string, number>;
  }

  /** `__cut_DAG`: the max-probability dictionary route, with HMM over runs of single characters. */
  #cutDag(chars: readonly string[], out: string[]): void {
    const freq = this.#dict();
    const n = chars.length;
    const routeX = this.#route(chars, freq);
    let buf: string[] = [];
    const flush = () => {
      if (buf.length === 0) return;
      if (buf.length === 1) out.push(buf[0] as string);
      else {
        const joined = buf.join("");
        if (!freq.get(joined)) this.#finalsegCut(joined, out);
        else for (const ch of buf) out.push(ch);
      }
      buf = [];
    };
    for (let x = 0; x < n; ) {
      const y = (routeX[x] as number) + 1;
      if (y - x === 1) buf.push(chars[x] as string);
      else {
        flush();
        out.push(chars.slice(x, y).join(""));
      }
      x = y;
    }
    flush();
  }

  /** `get_DAG` + `calc`: for each start index, the end index of its best route. */
  #route(chars: readonly string[], freq: Map<string, number>): Int32Array {
    const n = chars.length;
    const dag: number[][] = new Array(n);
    for (let k = 0; k < n; k++) {
      const ends: number[] = [];
      let frag = chars[k] as string;
      for (let i = k; i < n; ) {
        const f = freq.get(frag);
        if (f === undefined) break;
        if (f) ends.push(i);
        i++;
        if (i < n) frag += chars[i] as string;
      }
      if (ends.length === 0) ends.push(k);
      dag[k] = ends;
    }
    const prob = new Float64Array(n + 1);
    const routeX = new Int32Array(n + 1);
    for (let idx = n - 1; idx >= 0; idx--) {
      let best = 0;
      let bestX = -1;
      let frag = "";
      let pos = idx;
      for (const x of dag[idx] as number[]) {
        while (pos <= x) frag += chars[pos++] as string;
        // Left to right, as Python evaluates it: float addition is not associative.
        const p = Math.log(freq.get(frag) || 1) - this.#logTotal + (prob[x + 1] as number);
        if (bestX === -1 || p > best || (p === best && x > bestX)) {
          best = p;
          bestX = x;
        }
      }
      prob[idx] = best;
      routeX[idx] = bestX;
    }
    return routeX;
  }

  /** `finalseg.cut`: Viterbi over CJK runs; other runs split on ASCII alnum (+ decimals, %). */
  #finalsegCut(text: string, out: string[]): void {
    const blocks = text.split(RE_HAN_FINALSEG);
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i] as string;
      if (i % 2 === 1) this.#viterbiCut(Array.from(block), out);
      else for (const piece of block.split(RE_SKIP_FINALSEG)) if (piece) out.push(piece);
    }
  }

  #viterbiCut(chars: readonly string[], out: string[]): void {
    const { start, trans, emit } = this.#hmm as HmmTables;
    const n = chars.length;
    let v = new Float64Array(4);
    const first = chars[0] as string;
    for (let y = 0; y < 4; y++) {
      v[y] = (start[y] as number) + ((emit[y] as Map<string, number>).get(first) ?? MIN_FLOAT);
    }
    const back = new Uint8Array(n * 4);
    for (let t = 1; t < n; t++) {
      const next = new Float64Array(4);
      const ch = chars[t] as string;
      for (let y = 0; y < 4; y++) {
        const em = (emit[y] as Map<string, number>).get(ch) ?? MIN_FLOAT;
        const [a, b] = PREV_STATUS[y] as readonly [number, number];
        const pa = (v[a] as number) + (trans[a * 4 + y] as number) + em;
        const pb = (v[b] as number) + (trans[b * 4 + y] as number) + em;
        const pick =
          pa > pb ? a : pb > pa ? b : (LETTERS[a] as string) > (LETTERS[b] as string) ? a : b;
        next[y] = pick === a ? pa : pb;
        back[t * 4 + y] = pick;
      }
      v = next;
    }
    const states = new Uint8Array(n);
    let state = (v[E] as number) > (v[S] as number) ? E : S;
    for (let t = n - 1; t >= 0; t--) {
      states[t] = state;
      if (t > 0) state = back[t * 4 + state] as number;
    }
    let begin = 0;
    let nexti = 0;
    for (let i = 0; i < n; i++) {
      const pos = states[i];
      if (pos === B) begin = i;
      else if (pos === E) {
        out.push(chars.slice(begin, i + 1).join(""));
        nexti = i + 1;
      } else if (pos === S) {
        out.push(chars[i] as string);
        nexti = i + 1;
      }
    }
    if (nexti < n) out.push(chars.slice(nexti).join(""));
  }
}

// Character sets as sorted lists of inclusive UTF-16 code-unit ranges.
// One representation covers literals ('a' is [[97, 97]]), classes ([a-z0-9])
// and the dot, which keeps the compiler and VM simple.

export type Range = readonly [lo: number, hi: number];

export interface CharSet {
  readonly ranges: readonly Range[];
  readonly negated: boolean;
  /** Human-readable form for program listings, e.g. 'a', [a-z], \d. */
  readonly label: string;
}

const MAX = 0xffff;

export function normalize(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

export function complement(ranges: readonly Range[]): Range[] {
  const out: Range[] = [];
  let next = 0;
  for (const [lo, hi] of normalize(ranges)) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= MAX) out.push([next, MAX]);
  return out;
}

const code = (c: string) => c.charCodeAt(0);

export const DIGIT: Range[] = [[code('0'), code('9')]];
export const WORD: Range[] = normalize([
  [code('0'), code('9')], [code('A'), code('Z')], [code('a'), code('z')], [code('_'), code('_')],
]);
// The same whitespace set JavaScript uses for \s.
export const SPACE: Range[] = normalize([
  [0x09, 0x0d], [0x20, 0x20], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a],
  [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff],
]);
export const LINE_TERMINATORS: Range[] = [[0x0a, 0x0a], [0x0d, 0x0d], [0x2028, 0x2029]];

export function literal(c: number): CharSet {
  return { ranges: [[c, c]], negated: false, label: JSON.stringify(String.fromCharCode(c)) };
}

export function dot(dotAll: boolean): CharSet {
  return dotAll
    ? { ranges: [[0, MAX]], negated: false, label: 'any' }
    : { ranges: LINE_TERMINATORS, negated: true, label: 'any-but-newline' };
}

function inRanges(ranges: readonly Range[], c: number): boolean {
  // Binary search: classes like \w or [^\s] have several ranges.
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid];
    if (c < a) hi = mid - 1;
    else if (c > b) lo = mid + 1;
    else return true;
  }
  return false;
}

export function matches(set: CharSet, c: number, ignoreCase: boolean): boolean {
  let hit = inRanges(set.ranges, c);
  if (!hit && ignoreCase) {
    const ch = String.fromCharCode(c);
    for (const variant of [ch.toLowerCase(), ch.toUpperCase()]) {
      if (variant.length === 1 && inRanges(set.ranges, variant.charCodeAt(0))) {
        hit = true;
        break;
      }
    }
  }
  return hit !== set.negated;
}

export function isWordChar(c: number): boolean {
  return inRanges(WORD, c);
}

export function isLineTerminator(c: number): boolean {
  return inRanges(LINE_TERMINATORS, c);
}

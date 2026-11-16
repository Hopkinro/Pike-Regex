// Pattern text -> abstract syntax tree, by recursive descent.
//
//   alternation := concat ('|' concat)*
//   concat      := repeat*
//   repeat      := atom ('*' | '+' | '?' | '{n}' | '{n,}' | '{n,m}')* ['?' for lazy]
//   atom        := '(' ['?:' | '?<name>'] alternation ')' | '[' class ']' | '.'
//                | '^' | '$' | '\' escape | literal

import {
  type CharSet, type Range, DIGIT, SPACE, WORD, complement, dot, literal, normalize,
} from './charset.ts';

export type AssertKind = 'start' | 'end' | 'word-boundary' | 'not-word-boundary';

export type Node =
  | { type: 'empty' }
  | { type: 'char'; set: CharSet }
  | { type: 'concat'; items: Node[] }
  | { type: 'alt'; options: Node[] }
  | { type: 'repeat'; node: Node; min: number; max: number; greedy: boolean }
  | { type: 'group'; node: Node; index: number; name?: string }
  | { type: 'noncapture'; node: Node }
  | { type: 'assert'; kind: AssertKind };

export interface Ast {
  root: Node;
  groupCount: number;
  groupNames: Map<string, number>;
}

export class RegexSyntaxError extends SyntaxError {
  readonly pattern: string;
  readonly position: number;

  constructor(message: string, pattern: string, position: number) {
    super(`${message} at position ${position}\n  ${pattern}\n  ${' '.repeat(position)}^`);
    this.name = 'RegexSyntaxError';
    this.pattern = pattern;
    this.position = position;
  }
}

const MAX_REPEAT = 1000;

export function parse(pattern: string, dotAll = false): Ast {
  let pos = 0;
  let groupCount = 0;
  const groupNames = new Map<string, number>();

  const fail = (message: string, at = pos): never => {
    throw new RegexSyntaxError(message, pattern, at);
  };
  const peek = () => pattern[pos];
  const eat = (c: string) => (pattern[pos] === c ? (pos++, true) : false);

  function alternation(): Node {
    const options = [concat()];
    while (eat('|')) options.push(concat());
    return options.length === 1 ? options[0] : { type: 'alt', options };
  }

  function concat(): Node {
    const items: Node[] = [];
    while (pos < pattern.length && peek() !== '|' && peek() !== ')') items.push(repeat());
    if (items.length === 0) return { type: 'empty' };
    return items.length === 1 ? items[0] : { type: 'concat', items };
  }

  /** Tries to read a quantifier; returns [min, max] or null. */
  function quantifier(): [number, number] | null {
    const quantStart = pos;
    if (eat('*')) return [0, Infinity];
    if (eat('+')) return [1, Infinity];
    if (eat('?')) return [0, 1];
    const m = peek() === '{' ? /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(pos)) : null;
    if (!m) return null; // a '{' that isn't a quantifier is just a literal
    pos += m[0].length;
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
    if (max < min) fail('numbers out of order in {} quantifier', quantStart);
    if (Math.max(min, max === Infinity ? 0 : max) > MAX_REPEAT) {
      fail(`repeat counts are limited to ${MAX_REPEAT}`, quantStart);
    }
    return [min, max];
  }

  function repeat(): Node {
    const start = pos;
    const node = atom();
    const q = quantifier();
    if (!q) return node;
    if (node.type === 'assert') fail('nothing to repeat', start);
    const greedy = !eat('?'); // x*? x+? x?? x{n,m}? are the lazy forms
    const afterQuant = pos;
    if (quantifier()) fail('nothing to repeat (stacked quantifiers)', afterQuant);
    return { type: 'repeat', node, min: q[0], max: q[1], greedy };
  }

  function atom(): Node {
    const start = pos;
    const c = pattern[pos++];
    switch (c) {
      case '(': {
        let node: Node;
        if (eat('?')) {
          if (eat(':')) {
            node = { type: 'noncapture', node: alternation() };
          } else if (eat('<')) {
            const m = /^([A-Za-z_$][\w$]*)>/.exec(pattern.slice(pos));
            if (!m) fail('invalid group name');
            const name = m![1];
            if (groupNames.has(name)) fail(`duplicate group name '${name}'`);
            pos += m![0].length;
            const index = ++groupCount;
            groupNames.set(name, index);
            node = { type: 'group', index, name, node: alternation() };
          } else {
            return fail('unsupported group syntax (lookaround is not supported)', start);
          }
        } else {
          const index = ++groupCount;
          node = { type: 'group', index, node: alternation() };
        }
        if (!eat(')')) fail('missing )', start);
        return node;
      }
      case ')':
        return fail('unmatched )', start);
      case '*': case '+': case '?':
        return fail('nothing to repeat', start);
      case '[':
        return { type: 'char', set: charClass(start) };
      case '.':
        return { type: 'char', set: dot(dotAll) };
      case '^':
        return { type: 'assert', kind: 'start' };
      case '$':
        return { type: 'assert', kind: 'end' };
      case '\\':
        return escape(false) as Node;
      default:
        return { type: 'char', set: literal(c.charCodeAt(0)) };
    }
  }

  /** Parses after a backslash. Inside a class, \b means backspace. */
  function escape(inClass: boolean): Node | Range[] {
    if (pos >= pattern.length) fail('\\ at end of pattern', pos - 1);
    const c = pattern[pos++];
    const classOf = (ranges: Range[], label: string, negated = false): Node | Range[] =>
      inClass
        ? negated ? complement(ranges) : ranges
        : { type: 'char', set: { ranges, negated, label } };
    switch (c) {
      case 'd': return classOf(DIGIT, '\\d');
      case 'D': return classOf(DIGIT, '\\D', true);
      case 'w': return classOf(WORD, '\\w');
      case 'W': return classOf(WORD, '\\W', true);
      case 's': return classOf(SPACE, '\\s');
      case 'S': return classOf(SPACE, '\\S', true);
      case 'b':
        if (inClass) return [[8, 8]];
        return { type: 'assert', kind: 'word-boundary' };
      case 'B':
        if (inClass) fail('\\B is not allowed in a class', pos - 2);
        return { type: 'assert', kind: 'not-word-boundary' };
    }
    const simple: Record<string, number> = { n: 10, r: 13, t: 9, v: 11, f: 12, '0': 0 };
    let code: number;
    if (c in simple) {
      code = simple[c];
    } else if (c === 'x' && /^[0-9a-fA-F]{2}/.test(pattern.slice(pos))) {
      code = parseInt(pattern.slice(pos, pos + 2), 16);
      pos += 2;
    } else if (c === 'u' && /^[0-9a-fA-F]{4}/.test(pattern.slice(pos))) {
      code = parseInt(pattern.slice(pos, pos + 4), 16);
      pos += 4;
    } else if (/[1-9]/.test(c)) {
      return fail('backreferences are not supported (they make matching NP-hard)', pos - 2);
    } else if (/[A-Za-z]/.test(c)) {
      return fail(`unknown escape \\${c}`, pos - 2);
    } else {
      code = c.charCodeAt(0); // \. \* \\ \/ and friends
    }
    return inClass ? [[code, code]] : { type: 'char', set: literal(code) };
  }

  function charClass(start: number): CharSet {
    const negated = eat('^');
    const ranges: Range[] = [];
    const single = (): Range[] => {
      if (pos >= pattern.length) fail('missing ]', start);
      if (eat('\\')) return escape(true) as Range[];
      const code = pattern.charCodeAt(pos++);
      return [[code, code]];
    };
    while (peek() !== ']') {
      const lo = single();
      if (peek() === '-' && pattern[pos + 1] !== ']' && pos + 1 < pattern.length) {
        pos++; // the '-'
        const rangeStart = pos;
        const hi = single();
        if (lo.length !== 1 || hi.length !== 1 || lo[0][0] !== lo[0][1] || hi[0][0] !== hi[0][1]) {
          fail('a class escape like \\d cannot be a range endpoint', rangeStart);
        }
        if (lo[0][0] > hi[0][0]) fail('range out of order in character class', rangeStart);
        ranges.push([lo[0][0], hi[0][0]]);
      } else {
        ranges.push(...lo);
      }
    }
    pos++; // ']'
    return { ranges: normalize(ranges), negated, label: pattern.slice(start, pos) };
  }

  const root = alternation();
  if (pos < pattern.length) fail('unmatched )');
  return { root, groupCount, groupNames };
}

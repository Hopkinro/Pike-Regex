// The public API, shaped like JavaScript's RegExp so the two can be swapped.

import { compile, disassemble, type Program } from './compiler.ts';
import { parse } from './parser.ts';
import { run, type VmStats } from './vm.ts';

export interface Match {
  /** Index of the first character of the match. */
  index: number;
  /** [whole match, group 1, group 2, ...]; unmatched groups are undefined. */
  captures: (string | undefined)[];
  /** Named groups, e.g. (?<year>\d{4}) gives groups.year. */
  groups: Record<string, string | undefined>;
  /** Start/end offsets for each capture, like the 'd' flag's `indices`. */
  indices: ([number, number] | undefined)[];
}

const FLAGS = new Set(['i', 'm', 's', 'g', 'y']);

export class Regex {
  readonly source: string;
  readonly flags: string;
  readonly program: Program;
  /** Named groups and their numbers, e.g. (?<year>...) gives year -> 1. */
  readonly groupNames: ReadonlyMap<string, number>;
  /** Used by the global/sticky flags, exactly like RegExp#lastIndex. */
  lastIndex = 0;

  constructor(source: string, flags = '') {
    for (const f of flags) {
      if (!FLAGS.has(f)) throw new SyntaxError(`unsupported flag '${f}' (supported: imsgy)`);
    }
    if (new Set(flags).size !== flags.length) throw new SyntaxError(`duplicate flag in '${flags}'`);
    this.source = source;
    this.flags = [...flags].sort().join('');
    const ast = parse(source, flags.includes('s'));
    this.program = compile(ast);
    this.groupNames = ast.groupNames;
  }

  get global(): boolean { return this.flags.includes('g'); }
  get sticky(): boolean { return this.flags.includes('y'); }

  /** Find the first match at or after `from`, ignoring lastIndex. */
  matchAt(input: string, from = 0, stats?: VmStats): Match | null {
    if (from > input.length) return null;
    const slots = run(this.program, input, from, {
      ignoreCase: this.flags.includes('i'),
      multiline: this.flags.includes('m'),
      sticky: this.sticky,
    }, stats);
    if (!slots) return null;

    const captures: (string | undefined)[] = [];
    const indices: ([number, number] | undefined)[] = [];
    for (let i = 0; i < this.program.captureSlots; i += 2) {
      const [s, e] = [slots[i], slots[i + 1]];
      const ok = s !== undefined && e !== undefined;
      captures.push(ok ? input.slice(s, e) : undefined);
      indices.push(ok ? [s, e] : undefined);
    }
    const groups: Record<string, string | undefined> = {};
    for (const [name, i] of this.groupNames) groups[name] = captures[i];
    return { index: indices[0]![0], captures, groups, indices };
  }

  /** Like RegExp#exec: honours and updates lastIndex for 'g' and 'y'. */
  exec(input: string): Match | null {
    const stateful = this.global || this.sticky;
    const match = this.matchAt(input, stateful ? this.lastIndex : 0);
    if (stateful) this.lastIndex = match ? match.indices[0]![1] : 0;
    return match;
  }

  test(input: string): boolean {
    return this.exec(input) !== null;
  }

  /** Every non-overlapping match, left to right (like String#matchAll). */
  *matchAll(input: string): Generator<Match> {
    let from = 0;
    while (from <= input.length) {
      const m = this.matchAt(input, from);
      if (!m) return;
      yield m;
      const end = m.indices[0]![1];
      from = end === m.index ? end + 1 : end; // step past empty matches
    }
  }

  /** Replace matches; `$1`, `$<name>` and `$&` work in the replacement string. */
  replace(input: string, replacement: string | ((m: Match) => string)): string {
    let out = '';
    let last = 0;
    for (const m of this.global ? this.matchAll(input) : [this.matchAt(input)].filter((x) => x !== null)) {
      out += input.slice(last, m.index);
      out += typeof replacement === 'function'
        ? replacement(m)
        : replacement.replace(/\$(\$|&|\d{1,2}|<([^>]*)>)/g, (tok, what: string, name?: string) => {
          if (what === '$') return '$';
          if (what === '&') return m.captures[0]!;
          if (name !== undefined) return m.groups[name] ?? '';
          const i = Number(what);
          return i < m.captures.length ? (m.captures[i] ?? '') : tok;
        });
      last = m.indices[0]![1];
    }
    return out + input.slice(last);
  }

  /** The compiled program, one instruction per line (handy for learning). */
  disassemble(): string {
    return disassemble(this.program);
  }

  toString(): string {
    return `/${this.source}/${this.flags}`;
  }
}

// The Pike VM: runs a compiled program over the input in a single left-to-right
// pass, keeping every possible match "thread" alive at once.
//
// Backtracking engines (JavaScript, Python, Perl, Java) try one path, and on
// failure rewind and try the next. Patterns like (a+)+b have exponentially many
// paths, so on "aaaa...a!" they take 2^n steps. Here, threads that reach the same
// instruction at the same input position are merged: at most one thread per
// instruction exists at any time, so the work is O(program size x input length).
// No pattern can make it slow.
//
// Threads are kept in priority order, which is what lets us report the same
// match a backtracking engine would (leftmost, then preferring earlier branches
// and greedy loops) instead of POSIX's leftmost-longest.

import { isLineTerminator, isWordChar, matches } from './charset.ts';
import type { Program } from './compiler.ts';
import type { AssertKind } from './parser.ts';

export interface VmOptions {
  ignoreCase: boolean;
  multiline: boolean;
  /** Only try a match starting exactly at `start` (the 'y' flag). */
  sticky: boolean;
}

type Slots = (number | undefined)[];

interface Thread {
  pc: number;
  slots: Slots;
}

export interface VmStats {
  steps: number; // instructions executed, for the benchmark
}

/**
 * Find the first (leftmost, priority-order) match at or after `start`.
 * Returns the capture slots, or null if there is no match.
 */
export function run(
  program: Program,
  input: string,
  start: number,
  options: VmOptions,
  stats?: VmStats,
): Slots | null {
  const { insts, slotCount, captureSlots } = program;
  const n = input.length;
  const registers = slotCount - captureSlots;
  // Two threads at the same instruction and position have the same future, so
  // only the higher-priority one is kept: `seen[pc] === generation`. That's the
  // whole trick behind linear time.
  //
  // With empty-check registers (see `check`), the future also depends on which
  // loop iterations haven't consumed anything yet, so the key becomes
  // (pc, bitmask of registers equal to pos). Still linear in the input: the
  // extra factor depends only on how many loops have possibly-empty bodies.
  const seen = new Int32Array(insts.length).fill(-1);
  const seenKeys = new Set<number>();
  let generation = 0;
  let steps = 0;
  const firstVisit = (pc: number, slots: Slots, pos: number): boolean => {
    if (registers === 0) {
      if (seen[pc] === generation) return false;
      seen[pc] = generation;
      return true;
    }
    let bits = 0;
    for (let r = 0; r < registers; r++) {
      if (slots[captureSlots + r] === pos) bits |= 1 << r;
    }
    const key = pc * 2 ** registers + bits;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  };
  const nextGeneration = () => {
    generation++;
    seenKeys.clear();
  };

  const assertion = (kind: AssertKind, pos: number): boolean => {
    switch (kind) {
      case 'start':
        return pos === 0 || (options.multiline && isLineTerminator(input.charCodeAt(pos - 1)));
      case 'end':
        return pos === n || (options.multiline && isLineTerminator(input.charCodeAt(pos)));
      case 'word-boundary':
      case 'not-word-boundary': {
        const before = pos > 0 && isWordChar(input.charCodeAt(pos - 1));
        const after = pos < n && isWordChar(input.charCodeAt(pos));
        return (before !== after) === (kind === 'word-boundary');
      }
    }
  };

  // Follow every non-consuming instruction from pc, depth-first in priority
  // order, and append the threads that end up waiting on a `char` (or `match`).
  // An explicit stack instead of recursion keeps huge programs off the JS stack.
  const addThread = (list: Thread[], pc0: number, slots0: Slots, pos: number): void => {
    const stack: Thread[] = [{ pc: pc0, slots: slots0 }];
    while (stack.length > 0) {
      const { pc, slots } = stack.pop()!;
      if (!firstVisit(pc, slots, pos)) continue;
      steps++;
      const inst = insts[pc];
      switch (inst.op) {
        case 'jmp':
          stack.push({ pc: inst.x, slots });
          break;
        case 'split': // push y first so x is explored first
          stack.push({ pc: inst.y, slots }, { pc: inst.x, slots });
          break;
        case 'save': {
          const copy = slots.slice(); // copy-on-write: threads share until they diverge
          copy[inst.slot] = pos;
          stack.push({ pc: pc + 1, slots: copy });
          break;
        }
        case 'assert':
          if (assertion(inst.kind, pos)) stack.push({ pc: pc + 1, slots });
          break;
        case 'mark': {
          const copy = slots.slice();
          copy[inst.reg] = pos;
          stack.push({ pc: pc + 1, slots: copy });
          break;
        }
        case 'check':
          if (slots[inst.reg] !== pos) stack.push({ pc: pc + 1, slots });
          break;
        case 'clear': {
          const copy = slots.slice();
          copy.fill(undefined, inst.from, inst.to + 1);
          stack.push({ pc: pc + 1, slots: copy });
          break;
        }
        default:
          list.push({ pc, slots });
      }
    }
  };

  let matched: Slots | null = null;
  const empty: Slots = new Array(slotCount).fill(undefined);
  let current: Thread[] = [];
  nextGeneration();
  addThread(current, 0, empty, start);

  for (let pos = start; pos <= n; pos++) {
    nextGeneration();
    const next: Thread[] = [];
    const c = pos < n ? input.charCodeAt(pos) : -1;
    for (const thread of current) {
      const inst = insts[thread.pc];
      steps++;
      if (inst.op === 'match') {
        matched = thread.slots;
        break; // every remaining thread has lower priority: cut them off
      }
      if (inst.op === 'char' && c >= 0 && matches(inst.set, c, options.ignoreCase)) {
        addThread(next, thread.pc + 1, thread.slots, pos + 1);
      }
    }
    // Unanchored search: also start a fresh attempt at the next position, at the
    // lowest priority, unless an earlier start already matched (leftmost wins).
    if (matched === null && !options.sticky && pos < n) {
      addThread(next, 0, empty, pos + 1);
    }
    current = next;
    if (current.length === 0 && (matched !== null || options.sticky)) break;
  }
  if (stats) stats.steps += steps;
  return matched;
}

// AST -> a little program for the Pike VM (Thompson's construction, with
// capture slots). Every regex becomes a list of six kinds of instruction:
//
//   char SET     consume one character if it's in SET, else this thread dies
//   split X, Y   fork: try X first (higher priority), then Y
//   jmp X        go to X
//   save N       record the current position in capture slot N
//   assert K     ^ $ \b \B: continue only if the condition holds here
//   clear A, B   forget captures A..B (start of each loop iteration, as JS does)
//   mark R       remember the current position in register R
//   check R      die if we haven't moved since `mark R` (JS's empty-iteration rule)
//   match        success
//
// Greedy vs lazy is just the order of a split's two branches.

import type { CharSet } from './charset.ts';
import type { AssertKind, Ast, Node } from './parser.ts';

export type Inst =
  | { op: 'char'; set: CharSet }
  | { op: 'split'; x: number; y: number }
  | { op: 'jmp'; x: number }
  | { op: 'save'; slot: number }
  | { op: 'assert'; kind: AssertKind }
  | { op: 'clear'; from: number; to: number }
  | { op: 'mark'; reg: number }
  | { op: 'check'; reg: number }
  | { op: 'match' };

export interface Program {
  insts: Inst[];
  /** Capture slots: 2 per group, plus 2 for the whole match. */
  captureSlots: number;
  /** Capture slots plus one register per loop that needs an empty check. */
  slotCount: number;
}

const MAX_PROGRAM = 50_000;
const MAX_REGISTERS = 24;

/** Can node match the empty string? */
function nullable(node: Node): boolean {
  switch (node.type) {
    case 'empty': case 'assert': return true;
    case 'char': return false;
    case 'concat': return node.items.every(nullable);
    case 'alt': return node.options.some(nullable);
    case 'repeat': return node.min === 0 || nullable(node.node);
    case 'group': case 'noncapture': return nullable(node.node);
  }
}

export function compile(ast: Ast): Program {
  const insts: Inst[] = [];
  const captureSlots = (ast.groupCount + 1) * 2;
  let registers = 0;
  // One register per loop in the pattern, shared by every copy of that loop
  // (copies run one after another, and `mark` resets the register on entry).
  const registerFor = new Map<Node, number>();
  const emit = (inst: Inst): number => {
    if (insts.length >= MAX_PROGRAM) {
      throw new RangeError(`pattern compiles to more than ${MAX_PROGRAM} instructions`);
    }
    return insts.push(inst) - 1;
  };

  function gen(node: Node): void {
    switch (node.type) {
      case 'empty':
        return;
      case 'char':
        emit({ op: 'char', set: node.set });
        return;
      case 'assert':
        emit({ op: 'assert', kind: node.kind });
        return;
      case 'concat':
        node.items.forEach(gen);
        return;
      case 'group':
        emit({ op: 'save', slot: node.index * 2 });
        gen(node.node);
        emit({ op: 'save', slot: node.index * 2 + 1 });
        return;
      case 'noncapture':
        gen(node.node);
        return;
      case 'alt': {
        //     split L1, L2
        // L1: <option 1>
        //     jmp END
        // L2: split L3, L4  ... and so on; the last option needs no split.
        const jumps: number[] = [];
        node.options.forEach((option, i) => {
          const last = i === node.options.length - 1;
          const split = last ? -1 : emit({ op: 'split', x: 0, y: 0 });
          if (!last) (insts[split] as { x: number }).x = insts.length;
          gen(option);
          if (!last) {
            jumps.push(emit({ op: 'jmp', x: 0 }));
            (insts[split] as { y: number }).y = insts.length;
          }
        });
        for (const j of jumps) (insts[j] as { x: number }).x = insts.length;
        return;
      }
      case 'repeat':
        genRepeat(node.node, node.min, node.max, node.greedy);
        return;
    }
  }

  // Splits are emitted with placeholder targets and patched once known.
  function split(preferred: number, other: number, greedy: boolean): Inst {
    return greedy ? { op: 'split', x: preferred, y: other } : { op: 'split', x: other, y: preferred };
  }

  function genRepeat(node: Node, min: number, max: number, greedy: boolean): void {
    // In JavaScript, each loop iteration starts with fresh captures, so
    // /(?:(a)|b)+/ on "ab" leaves group 1 undefined. Emit a `clear` per iteration.
    const groups = groupRange(node);
    // JavaScript also rejects an *optional* iteration that matches nothing, which
    // decides the result for patterns like /(\s??)+/. For loops whose body can
    // match empty, guard each optional iteration with mark/check on a register.
    let reg = -1;
    if (nullable(node)) {
      if (!registerFor.has(node)) registerFor.set(node, captureSlots + registers++);
      reg = registerFor.get(node)!;
      if (registers > MAX_REGISTERS) {
        throw new RangeError(`too many loops that can match empty (max ${MAX_REGISTERS})`);
      }
    }
    const iteration = (optional: boolean) => {
      if (optional && reg >= 0) emit({ op: 'mark', reg });
      if (groups) emit({ op: 'clear', from: groups[0] * 2, to: groups[1] * 2 + 1 });
      gen(node);
      if (optional && reg >= 0) emit({ op: 'check', reg });
    };

    // Required iterations are separate copies of the body: x{2,} = x x x*, and
    // x{2,4} = x x (x (x)?)?. Giving each copy its own instructions keeps the
    // VM's one-thread-per-instruction rule from merging threads that are in
    // different iterations.
    for (let i = 0; i < min; i++) iteration(false);

    if (max === Infinity) {
      // L: split BODY, END   BODY: x   jmp L   END:
      const loop = emit({ op: 'split', x: 0, y: 0 });
      iteration(true);
      emit({ op: 'jmp', x: loop });
      insts[loop] = split(loop + 1, insts.length, greedy);
      return;
    }

    const holes: number[] = [];
    for (let i = min; i < max; i++) {
      holes.push(emit({ op: 'split', x: 0, y: 0 }));
      iteration(true);
    }
    const end = insts.length;
    for (const h of holes) insts[h] = split(h + 1, end, greedy);
  }

  /** The [lowest, highest] capture group numbers inside node, if any. */
  function groupRange(node: Node): [number, number] | null {
    let lo = Infinity;
    let hi = -Infinity;
    const visit = (n: Node): void => {
      if (n.type === 'group') {
        lo = Math.min(lo, n.index);
        hi = Math.max(hi, n.index);
      }
      if (n.type === 'concat') n.items.forEach(visit);
      else if (n.type === 'alt') n.options.forEach(visit);
      else if (n.type === 'repeat' || n.type === 'group' || n.type === 'noncapture') visit(n.node);
    };
    visit(node);
    return lo <= hi ? [lo, hi] : null;
  }

  emit({ op: 'save', slot: 0 });
  gen(ast.root);
  emit({ op: 'save', slot: 1 });
  emit({ op: 'match' });
  return { insts, captureSlots, slotCount: captureSlots + registers };
}

/** Pretty-print a program, one instruction per line. */
export function disassemble(program: Program): string {
  const width = String(program.insts.length - 1).length;
  return program.insts
    .map((inst, pc) => {
      const at = String(pc).padStart(width);
      switch (inst.op) {
        case 'char': return `${at}  char   ${inst.set.label}`;
        case 'split': return `${at}  split  ${inst.x}, ${inst.y}`;
        case 'jmp': return `${at}  jmp    ${inst.x}`;
        case 'save': return `${at}  save   ${inst.slot}`;
        case 'assert': return `${at}  assert ${inst.kind}`;
        case 'clear': return `${at}  clear  ${inst.from}..${inst.to}`;
        case 'mark': return `${at}  mark   r${inst.reg}`;
        case 'check': return `${at}  check  r${inst.reg}`;
        case 'match': return `${at}  match`;
      }
    })
    .join('\n');
}

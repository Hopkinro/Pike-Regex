# pike-regex

**A regular-expression engine in TypeScript that no pattern can make slow.**

JavaScript's built-in `RegExp` (like Python's, Java's and Perl's) is a
*backtracking* engine. Some innocent-looking patterns make it explore exponentially
many paths, which has taken down real production systems. pike-regex compiles
patterns to a Thompson NFA and runs them with a **Pike VM**. It makes one pass over
the input and keeps every candidate match alive at once, so matching is linear in
the input length for every pattern.

It still returns **exactly the same matches and capture groups as JavaScript**,
checked by a differential fuzzer against V8 on 420,000 random patterns.

```text
$ node bench/pathological.ts
pattern /^(a+)+$/ on "a" x n + "!"

     n   built-in RegExp     pike-regex   VM steps
    20           7.0 ms         0.2 ms        380
    24          96.5 ms         0.2 ms        456
    28        1541.6 ms         0.3 ms        532
    30        6204.5 ms         0.2 ms        570
  1000        (skipped)         2.7 ms      19000
100000        (skipped)        64.9 ms    1900000
```

Each extra character doubles V8's work. pike-regex's work grows by a constant.

## Usage

```ts
import { Regex } from './src/index.ts';

const date = new Regex('(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})', 'g');
date.exec('due 2026-11-16')?.groups;          // { year: '2026', month: '11', day: '16' }
date.replace('2026-11-16', '$<day>/$<month>/$<year>');   // '16/11/2026'
[...new Regex('\\w+').matchAll('hi there')].map(m => m.captures[0]);  // ['hi', 'there']
```

It mirrors `RegExp`: `exec`, `test`, `matchAll`, `replace`, `lastIndex`, and the
`i m s g y` flags. Matches also carry `indices`, like the `d` flag.

```bash
$ node src/cli.ts '(\w+)@(\w+)\.com' 'ada@example.com, alan@turing.com'
"ada@example.com, alan@turing.com" @0: "ada@example.com" $1="ada" $2="example"
"ada@example.com, alan@turing.com" @17: "alan@turing.com" $1="alan" $2="turing"

$ node src/cli.ts 'a+b?' --program        # see what the VM actually runs
0  save   0
1  char   "a"
2  split  3, 5
3  char   "a"
4  jmp    2
5  split  6, 7
6  char   "b"
7  save   1
8  match
```

## How it works

Three stages, each in its own small file:

1. **[`parser.ts`](src/parser.ts)**: a recursive-descent parser turns the pattern
   into a syntax tree. Errors point at the problem:
   `missing ) at position 0 / (ab / ^`.
2. **[`compiler.ts`](src/compiler.ts)**: the tree becomes a program for a tiny
   virtual machine (Thompson's construction). There are only a handful of
   instructions: `char`, `split` (fork with a preference), `jmp`, `save` (record
   a capture position), `assert` (`^ $ \b \B`) and `match`. Greedy and lazy are
   just the order of a `split`'s two branches.
3. **[`vm.ts`](src/vm.ts)**: the Pike VM steps through the input one character
   at a time, advancing a list of threads in lock-step. **Two threads at the same
   instruction and position have identical futures, so only the higher-priority one
   is kept.** That rule caps the thread list at the program size, which gives the
   linear bound. Keeping the list in priority order is what makes the *results*
   match a backtracking engine (leftmost, then first alternative and greedy loops
   preferred), not POSIX's leftmost-longest.

### Matching JavaScript exactly was the hard part

A textbook Pike VM agrees with JavaScript on simple patterns but not in the
corners. The differential fuzzer ([`test/differential.test.ts`](test/differential.test.ts))
generates random patterns and inputs and compares every result against V8. It
found three real semantic gaps:

- **Captures reset on each loop iteration.** In JS, `/(?:(a)|b)+/` on `"ab"`
  leaves group 1 *undefined*, because the last iteration took the `b` branch.
  Fix: a `clear` instruction at the start of each iteration.
- **Empty iterations are rejected.** ECMAScript says an optional loop iteration
  that matches nothing *fails*, which changes which alternative wins. So
  `/(\s??)+/` matches `" "`, not `""`. Fix: `mark`/`check` instructions record the
  position at the start of an iteration and kill the thread if it hasn't moved.
- **That broke the merge rule.** With empty checks, two threads at the same
  instruction can have different futures: one has consumed input in its current
  iteration and the other hasn't. The merge key became *(instruction, which loop
  iterations are still empty)*. That's still linear in the input. The extra factor
  depends only on how many loops in the pattern have possibly-empty bodies.

After those fixes the fuzzer finds **zero** differences in 420,000 random cases.

## Supported syntax

| | |
| --- | --- |
| Characters | literals, `.`, `\d \w \s \D \W \S`, `\n \t \r \v \f \0`, `\xHH`, `\uHHHH`, escaped metacharacters |
| Classes | `[abc]`, `[a-z]`, `[^...]`, escapes inside classes |
| Quantifiers | `* + ? {n} {n,} {n,m}`, and lazy `*? +? ?? {n,m}?` |
| Groups | `( )`, `(?: )`, `(?<name> )` |
| Anchors | `^ $ \b \B` (with `m` for multiline) |
| Flags | `i` ignore case, `m` multiline, `s` dot-all, `g` global, `y` sticky |

**Deliberately not supported:** backreferences (`\1`) and lookaround (`(?=`,
`(?<=`). Matching with backreferences is NP-hard, so no engine can do it in
linear time; that's the price of the guarantee. RE2 and Rust's `regex` crate make
the same trade. Matching works on UTF-16 code units, like `RegExp` without the
`u` flag.

## Development

```bash
npm install        # TypeScript + esbuild, dev only; there are no runtime dependencies
npm test           # unit tests + the differential fuzzer
npm run typecheck
npm run bench      # the table above
npm run build      # browser bundle in dist/
```

Node 22.18+ runs the TypeScript source directly, so there's no build step for
Node.

## License

MIT

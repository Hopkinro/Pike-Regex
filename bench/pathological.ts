// Catastrophic backtracking, measured.
//
// /^(a+)+$/ against "aaaa...a!" can't match (the '!' fails the $), but a
// backtracking engine tries every way of splitting the a's between the inner
// and outer loops before giving up: about 2^n attempts. This is the bug behind
// real outages (Stack Overflow 2016, Cloudflare 2019) and the "ReDoS" class of
// attacks. The Pike VM does one pass over the input, whatever the pattern.

import { Regex } from '../src/index.ts';

const time = (fn: () => unknown): number => {
  const start = performance.now();
  fn();
  return performance.now() - start;
};

const pattern = '^(a+)+$';
const native = new RegExp(pattern);
const ours = new Regex(pattern);

console.log(`pattern /${pattern}/ on "a" x n + "!"\n`);
console.log('   n   built-in RegExp     pike-regex   VM steps');
let nativeGaveUp = false;
for (const n of [10, 14, 18, 20, 22, 24, 26, 28, 30, 1_000, 100_000]) {
  const input = 'a'.repeat(n) + '!';
  let nativeMs = '';
  if (!nativeGaveUp) {
    const ms = time(() => native.test(input));
    nativeMs = `${ms.toFixed(1)} ms`;
    if (ms > 4_000) nativeGaveUp = true; // each further step doubles; stop here
  } else {
    nativeMs = '(skipped)';
  }
  const stats = { steps: 0 };
  const oursMs = time(() => ours.matchAt(input, 0, stats));
  console.log(
    `${String(n).padStart(6)}   ${nativeMs.padStart(14)}   ${(oursMs.toFixed(1) + ' ms').padStart(12)}   ${String(stats.steps).padStart(8)}`,
  );
}
console.log('\nVM steps grow linearly with n; the built-in engine roughly doubles per extra "a".');

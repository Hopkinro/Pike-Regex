// Differential testing: generate thousands of random patterns and inputs, and
// check that this engine finds exactly what JavaScript's own RegExp finds:
// the same match position, the same matched text, the same capture groups.

import assert from 'node:assert/strict';
import { it } from 'node:test';

import { Regex } from '../src/index.ts';

// A small seeded PRNG (mulberry32), so any failure is reproducible.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generator(random: () => number) {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const atoms = ['a', 'b', 'c', '.', '[ab]', '[^a]', '[a-c]', '\\d', '\\w', '\\s', 'x', ' ', '1'];
  const quantifiers = ['', '', '', '*', '+', '?', '*?', '+?', '??', '{2}', '{1,2}', '{0,2}?', '{2,}'];

  function pattern(depth: number): string {
    const parts: string[] = [];
    const length = 1 + Math.floor(random() * 3);
    for (let i = 0; i < length; i++) {
      const roll = random();
      let atom: string;
      if (depth < 3 && roll < 0.2) atom = `(${pattern(depth + 1)})`;
      else if (depth < 3 && roll < 0.27) atom = `(?:${pattern(depth + 1)})`;
      else if (roll < 0.3) atom = pick(['^', '$', '\\b', '\\B']);
      else atom = pick(atoms);
      const isAssertion = ['^', '$', '\\b', '\\B'].includes(atom);
      parts.push(atom + (isAssertion ? '' : pick(quantifiers)));
    }
    let result = parts.join('');
    if (random() < 0.2) result += `|${pattern(depth + 1)}`;
    return result;
  }

  const text = () => Array.from({ length: Math.floor(random() * 10) }, () => pick(['a', 'b', 'c', '1', ' ', 'x', 'A', '\n'])).join('');
  return { pattern: () => pattern(0), text };
}

it('agrees with the built-in RegExp on 20,000 random cases', () => {
  const random = rng(20261116);
  const gen = generator(random);
  let checked = 0;
  for (let i = 0; i < 20_000; i++) {
    const source = gen.pattern();
    const flags = ['', 'i', 'm', 's'][i % 4];
    const input = gen.text();
    const native = new RegExp(source, flags).exec(input);
    const ours = new Regex(source, flags).matchAt(input);
    const context = `/${source}/${flags} on ${JSON.stringify(input)}`;
    if (native === null) {
      assert.equal(ours, null, context);
    } else {
      assert.ok(ours, context);
      assert.equal(ours.index, native.index, context);
      assert.deepEqual(ours.captures, [...native], context);
    }
    checked++;
  }
  assert.equal(checked, 20_000);
});

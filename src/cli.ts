#!/usr/bin/env node
// pike-regex PATTERN [TEXT...] [--flags imsy] [--program]
// Prints every match with its groups, or the compiled program with --program.

import { Regex, RegexSyntaxError } from './index.ts';

const args = process.argv.slice(2);
const flagIndex = args.indexOf('--flags');
const flags = flagIndex >= 0 ? args.splice(flagIndex, 2)[1] ?? '' : '';
const showProgram = args.includes('--program');
const [pattern, ...texts] = args.filter((a) => a !== '--program');

if (pattern === undefined) {
  console.error('usage: pike-regex PATTERN [TEXT...] [--flags imsy] [--program]');
  process.exit(2);
}

let regex: Regex;
try {
  regex = new Regex(pattern, flags);
} catch (err) {
  if (err instanceof RegexSyntaxError) {
    console.error(`syntax error: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

if (showProgram) console.log(regex.disassemble() + '\n');

let found = false;
for (const text of texts) {
  for (const m of regex.matchAll(text)) {
    found = true;
    const groups = m.captures.slice(1).map((g, i) => ` $${i + 1}=${g === undefined ? '-' : JSON.stringify(g)}`).join('');
    console.log(`${JSON.stringify(text)} @${m.index}: ${JSON.stringify(m.captures[0])}${groups}`);
  }
}
process.exit(texts.length === 0 || found ? 0 : 1);

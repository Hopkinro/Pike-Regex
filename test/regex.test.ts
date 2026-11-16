import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Regex, RegexSyntaxError } from '../src/index.ts';

const find = (pattern: string, input: string, flags = '') => new Regex(pattern, flags).matchAt(input)?.captures ?? null;

describe('matching', () => {
  it('handles literals, dot, classes and escapes', () => {
    assert.deepEqual(find('cat', 'concatenate'), ['cat']);
    assert.deepEqual(find('c.t', 'cut'), ['cut']);
    assert.deepEqual(find('[0-9]+', 'abc 123 def'), ['123']);
    assert.deepEqual(find('[^a-z ]+', 'abc XYZ def'), ['XYZ']);
    assert.deepEqual(find('\\d+\\.\\d+', 'pi is 3.14159'), ['3.14159']);
    assert.deepEqual(find('\\w+\\s\\w+', '  hello   there world'), ['there world']);
    assert.deepEqual(find('[\\d-]+', 'call 555-1234'), ['555-1234']);
    assert.deepEqual(find('a\\*b', 'a*b'), ['a*b']);
    assert.deepEqual(find('\\x41\\u0042', 'AB'), ['AB']);
    assert.equal(find('x', 'abc'), null);
  });

  it('prefers the leftmost match, then priority order (like JavaScript)', () => {
    assert.deepEqual(find('a|ab', 'ab'), ['a']); // POSIX would say 'ab'
    assert.deepEqual(find('ab|a', 'ab'), ['ab']);
    assert.deepEqual(find('b+', 'abbbc'), ['bbb']);
  });

  it('supports greedy and lazy quantifiers', () => {
    assert.deepEqual(find('<.+>', '<a><b>'), ['<a><b>']);
    assert.deepEqual(find('<.+?>', '<a><b>'), ['<a>']);
    assert.deepEqual(find('a{2,3}', 'aaaa'), ['aaa']);
    assert.deepEqual(find('a{2,3}?', 'aaaa'), ['aa']);
    assert.deepEqual(find('a{2,}', 'aaaaa'), ['aaaaa']);
    assert.deepEqual(find('a{3}', 'aa'), null);
    assert.deepEqual(find('ba??', 'ba'), ['b']);
  });

  it('extracts capture groups, including named and unmatched ones', () => {
    assert.deepEqual(find('(\\d{4})-(\\d{2})-(\\d{2})', 'on 2026-11-16!'), ['2026-11-16', '2026', '11', '16']);
    assert.deepEqual(find('(a)|(b)', 'b'), ['b', undefined, 'b']);
    assert.deepEqual(find('(?:ab)+(c)', 'ababc'), ['ababc', 'c']);
    const m = new Regex('(?<key>\\w+)=(?<value>\\w*)').matchAt('x  color=blue')!;
    assert.deepEqual(m.groups, { key: 'color', value: 'blue' });
    assert.deepEqual(m.indices[1], [3, 8]);
  });

  it('resets captures on each loop iteration, as JavaScript does', () => {
    assert.deepEqual(find('(?:(a)|b)+', 'ab'), ['ab', undefined]);
    assert.deepEqual(find('(a|b)*', 'abba'), ['abba', 'a']);
  });

  it('supports anchors and word boundaries', () => {
    assert.deepEqual(find('^abc', 'abcabc'), ['abc']);
    assert.equal(find('^abc', 'xabc'), null);
    assert.deepEqual(find('^b', 'a\nb', 'm'), ['b']);
    assert.equal(find('^b', 'a\nb'), null);
    assert.deepEqual(find('a$', 'a\nb', 'm'), ['a']);
    assert.deepEqual(find('\\bcat\\b', 'concat cat'), ['cat']);
    assert.equal(new Regex('\\bcat\\b').matchAt('concat cat')!.index, 7);
    assert.deepEqual(find('\\Bcat', 'concat'), ['cat']);
  });

  it('supports the i and s flags', () => {
    assert.deepEqual(find('hello', 'HeLLo', 'i'), ['HeLLo']);
    assert.deepEqual(find('[a-c]+', 'ABCD', 'i'), ['ABC']);
    assert.deepEqual(find('a.b', 'a\nb'), null);
    assert.deepEqual(find('a.b', 'a\nb', 's'), ['a\nb']);
  });

  it('never loops forever on empty iterations', () => {
    assert.deepEqual(find('(a*)*', 'b'), ['', undefined]);
    assert.deepEqual(find('(a*)+', 'b'), ['', '']);
    assert.deepEqual(find('(|a)*b', 'aab'), ['aab', 'a']);
  });
});

describe('API', () => {
  it('exec and test honour the g flag and lastIndex', () => {
    const r = new Regex('\\d+', 'g');
    assert.equal(r.exec('a1b22c333')!.captures[0], '1');
    assert.equal(r.exec('a1b22c333')!.captures[0], '22');
    assert.equal(r.exec('a1b22c333')!.captures[0], '333');
    assert.equal(r.exec('a1b22c333'), null);
    assert.equal(r.lastIndex, 0);
  });

  it('the y flag only matches at lastIndex', () => {
    const r = new Regex('a', 'y');
    assert.equal(r.test('ba'), false);
    r.lastIndex = 1;
    assert.equal(r.test('ba'), true);
  });

  it('matchAll steps over empty matches', () => {
    const all = [...new Regex('a*').matchAll('baac')].map((m) => [m.index, m.captures[0]]);
    assert.deepEqual(all, [[0, ''], [1, 'aa'], [3, ''], [4, '']]);
    assert.deepEqual(all, [...'baac'.matchAll(/a*/g)].map((m) => [m.index, m[0]]));
  });

  it('replace supports $1, $<name>, $& and functions', () => {
    const date = new Regex('(?<y>\\d{4})-(\\d\\d)-(\\d\\d)', 'g');
    assert.equal(date.replace('from 2026-11-16 to 2027-01-02', '$3/$2/$<y>'), 'from 16/11/2026 to 02/01/2027');
    assert.equal(new Regex('o', 'g').replace('foo', '[$&]'), 'f[o][o]');
    assert.equal(new Regex('\\d+').replace('a1b2', (m) => String(Number(m.captures[0]) * 10)), 'a10b2');
  });

  it('reports syntax errors with a position', () => {
    const cases: [string, RegExp][] = [
      ['(ab', /missing \)/], ['ab)', /unmatched \)/], ['*a', /nothing to repeat/],
      ['a**', /nothing to repeat/], ['[z-a]', /out of order/], ['a{3,2}', /out of order/],
      ['(a)\\1', /backreferences are not supported/], ['(?=a)', /lookaround/], ['abc\\', /end of pattern/],
      ['[abc', /missing \]/], ['\\q', /unknown escape/],
    ];
    for (const [pattern, message] of cases) {
      assert.throws(() => new Regex(pattern), (err: unknown) => {
        assert.ok(err instanceof RegexSyntaxError, pattern);
        assert.match(err.message, message);
        return true;
      });
    }
    assert.throws(() => new Regex('a', 'u'), /unsupported flag/);
  });

  it('disassembles to a readable program', () => {
    assert.equal(new Regex('a|b').disassemble(), [
      '0  save   0',
      '1  split  2, 4',
      '2  char   "a"',
      '3  jmp    5',
      '4  char   "b"',
      '5  save   1',
      '6  match',
    ].join('\n'));
  });
});

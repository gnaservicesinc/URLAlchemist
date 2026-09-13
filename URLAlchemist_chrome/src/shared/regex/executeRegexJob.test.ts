import { describe, expect, it } from 'vitest';
import { executeRegexJobRequest } from './executeRegexJob';

function transform(input: string, pattern: string, replacement: string, nthOccurrence = 1) {
  return executeRegexJobRequest({ kind: 'transform', input, pattern, replacement,
    action: 'SUBSTITUTE', matchMode: 'NTH_OCCURRENCE', nthOccurrence });
}

describe('selected regex matches', () => {
  it('advances empty matches over complete Unicode code points', () => {
    expect(transform('😀x', '(?:)', '!', 2).result).toBe('😀!x');
    expect(transform('😀x', '(?:)', '!', 3).result).toBe('😀x!');
    expect(transform('😀x', '(?:)', '!', 4)).toMatchObject({ matched: false, result: '😀x' });
    expect(transform('\ud800x', '(?:)', '!', 2).result).toBe('\ud800!x');
  });

  it.each([
    ['abc', '(?<=a)(b)(?=c)', '$1!', 'ab!c'],
    ['abc', '(?<=a)(?<letter>b)', '$<letter>!', 'ab!c'],
    ['abc', 'b', "$`-$&-$'", 'aa-b-cc'],
    ['abc', '(a)(b)?', '$12-$02-$3-$$', 'a2-b-$3-$c'],
    ['abc', 'b', '$<absent>', 'a$<absent>c'],
    ['abc', '(?<letter>b)', '$<absent>', 'ac'],
  ])('keeps match context and replacement semantics for %s / %s', (input, pattern, replacement, expected) => {
    expect(transform(input, pattern, replacement).result).toBe(expected);
    expect(transform(input, pattern, replacement).result).toBe(input.replace(new RegExp(pattern, 'u'), replacement));
  });

  it('retains lookaround when replacing text around a match', () => {
    expect(executeRegexJobRequest({ kind: 'transform', input: 'abc', pattern: '(?<=a)(b)(?=c)',
      replacement: '$1!', action: 'SUBSTITUTE', matchMode: 'AFTER_PATTERN' }).result).toBe('abb!');
  });
});

import safeRegex from 'safe-regex';

import type { ActionType, MatchMode, RegexJobRequest, RegexJobResponse } from '../types';

function parsePattern(pattern: string, forceGlobal: boolean): RegExp {
  let source = pattern;
  let flags = '';
  const literalMatch = pattern.match(/^\/([\s\S]*)\/([a-z]*)$/);

  if (literalMatch) {
    source = literalMatch[1];
    flags = literalMatch[2];
  }

  if (source.length > 500) {
    throw new Error('Regex patterns longer than 500 characters are rejected');
  }

  if (!safeRegex(source)) {
    throw new Error('Unsafe regular expression rejected');
  }

  const mergedFlags = new Set(flags.split('').filter(Boolean));
  mergedFlags.add('u');

  if (forceGlobal) {
    mergedFlags.add('g');
  }

  return new RegExp(source, Array.from(mergedFlags).join(''));
}

export function assertSafeRegexPattern(pattern: string): void {
  parsePattern(pattern, false);
}

function applyFragmentAction(fragment: string, action: ActionType, replacement: string): string {
  switch (action) {
    case 'REMOVE':
      return '';
    case 'APPEND':
      return `${fragment}${replacement}`;
    case 'PREPEND':
      return `${replacement}${fragment}`;
    case 'SUBSTITUTE':
    default:
      return replacement;
  }
}

function selectNthMatch(input: string, pattern: string, nthOccurrence: number): RegExpExecArray | null {
  const regex = parsePattern(pattern, true);
  let currentIndex = 0;
  let match: RegExpExecArray | null = regex.exec(input);

  while (match) {
    currentIndex += 1;

    if (currentIndex === nthOccurrence) {
      return match;
    }

    if (match[0] === '') {
      regex.lastIndex += 1;
    }

    match = regex.exec(input);
  }

  return null;
}

function transformStandard(input: string, pattern: string, action: ActionType, replacement: string): RegexJobResponse {
  const regex = parsePattern(pattern, true);
  const matched = regex.test(input);
  regex.lastIndex = 0;

  if (!matched) {
    return {
      kind: 'transform',
      matched: false,
      result: input,
    };
  }

  let nextValue = input;

  switch (action) {
    case 'REMOVE':
      nextValue = input.replace(regex, '');
      break;
    case 'APPEND':
      nextValue = input.replace(regex, `$&${replacement}`);
      break;
    case 'PREPEND':
      nextValue = input.replace(regex, `${replacement}$&`);
      break;
    case 'SUBSTITUTE':
    default:
      nextValue = input.replace(regex, replacement);
      break;
  }

  return {
    kind: 'transform',
    matched: true,
    result: nextValue,
  };
}

function transformAroundPattern(
  input: string,
  pattern: string,
  action: ActionType,
  replacement: string,
  mode: Exclude<MatchMode, 'STANDARD' | 'NTH_OCCURRENCE'>,
): RegexJobResponse {
  const regex = parsePattern(pattern, false);
  const match = regex.exec(input);

  if (!match || match.index === undefined) {
    return {
      kind: 'transform',
      matched: false,
      result: input,
    };
  }

  const before = input.slice(0, match.index);
  const matchedText = input.slice(match.index, match.index + match[0].length);
  const after = input.slice(match.index + match[0].length);

  if (mode === 'BEFORE_PATTERN') {
    return {
      kind: 'transform',
      matched: true,
      result: `${applyFragmentAction(before, action, replacement)}${matchedText}${after}`,
    };
  }

  return {
    kind: 'transform',
    matched: true,
    result: `${before}${matchedText}${applyFragmentAction(after, action, replacement)}`,
  };
}

function transformNthOccurrence(
  input: string,
  pattern: string,
  action: ActionType,
  replacement: string,
  nthOccurrence: number,
): RegexJobResponse {
  const match = selectNthMatch(input, pattern, nthOccurrence);

  if (!match || match.index === undefined) {
    return {
      kind: 'transform',
      matched: false,
      result: input,
    };
  }

  const before = input.slice(0, match.index);
  const matchedText = input.slice(match.index, match.index + match[0].length);
  const after = input.slice(match.index + match[0].length);

  return {
    kind: 'transform',
    matched: true,
    result: `${before}${applyFragmentAction(matchedText, action, replacement)}${after}`,
  };
}

export function executeRegexJobRequest(request: RegexJobRequest): RegexJobResponse {
  if (request.kind === 'test') {
    const regex = parsePattern(request.pattern, false);

    return {
      kind: 'test',
      matched: regex.test(request.input),
    };
  }

  if (request.matchMode === 'STANDARD') {
    return transformStandard(request.input, request.pattern, request.action, request.replacement);
  }

  if (request.matchMode === 'NTH_OCCURRENCE') {
    const nthOccurrence = Math.max(1, Math.trunc(request.nthOccurrence ?? 1));
    return transformNthOccurrence(request.input, request.pattern, request.action, request.replacement, nthOccurrence);
  }

  return transformAroundPattern(
    request.input,
    request.pattern,
    request.action,
    request.replacement,
    request.matchMode,
  );
}

import safeRegex from 'safe-regex';

import type { ActionType, MatchMode, RegexJobRequest, RegexJobResponse } from '../types';

/**
 * Defense-in-depth for ReDoS:
 * 1. Pattern length cap (500 chars) limits attack surface.
 * 2. safe-regex rejects known exponential patterns, but it has known false
 *    negatives. The dedicated Web Worker in pageRunner.ts enforces a hard
 *    50ms execution timeout as the final safety net.
 * 3. A heuristic nesting-depth check rejects deeply nested quantifiers that
 *    safe-regex may miss.
 */
function assertPatternDepth(source: string, maxDepth = 8): void {
  let depth = 0;
  let max = 0;
  for (const char of source) {
    if (char === '(') {
      depth += 1;
      max = Math.max(max, depth);
    } else if (char === ')') {
      depth -= 1;
    }
  }
  if (max > maxDepth) {
    throw new Error('Regex nesting depth exceeds the safety limit');
  }
}

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

  assertPatternDepth(source);

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

function resolveReplacement(pattern: string, match: RegExpExecArray, replacement: string): string {
  const regex = parsePattern(pattern, false);
  regex.lastIndex = 0;
  return match[0].replace(regex, replacement);
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
  const resolvedReplacement = resolveReplacement(pattern, match, replacement);

  if (mode === 'BEFORE_PATTERN') {
    return {
      kind: 'transform',
      matched: true,
      result: `${applyFragmentAction(before, action, resolvedReplacement)}${matchedText}${after}`,
    };
  }

  return {
    kind: 'transform',
    matched: true,
    result: `${before}${matchedText}${applyFragmentAction(after, action, resolvedReplacement)}`,
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
  const resolvedReplacement = resolveReplacement(pattern, match, replacement);

  return {
    kind: 'transform',
    matched: true,
    result: `${before}${applyFragmentAction(matchedText, action, resolvedReplacement)}${after}`,
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

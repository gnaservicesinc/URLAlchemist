import { escapeRegexLiteral } from '../shared/helpers';
import { assertSafeRegexPattern } from '../shared/regex/executeRegexJob';

export type RegexSourceMode = 'VISUAL' | 'MANUAL';
export type RegexTokenMode = 'EXACT' | 'FLEXIBLE';
export type RegexTokenPatternKind = 'AUTO' | 'NUMBER' | 'LETTERS' | 'WORD' | 'ANY_TEXT';

export interface RegexBuilderToken {
  id: string;
  text: string;
  mode: RegexTokenMode;
  patternKind: RegexTokenPatternKind;
}

export interface RegexBuilderConfig {
  sampleText: string;
  selectionStart: number;
  selectionEnd: number;
  tokens: RegexBuilderToken[];
  caseSensitive: boolean;
}

export interface RegexBuilderSelectionSuggestion {
  end: number;
  id: string;
  label: string;
  start: number;
}

const TOKEN_PATTERN = /([A-Za-z0-9_%-]+|[^A-Za-z0-9_%-]+)/g;

export function createDefaultRegexBuilder(): RegexBuilderConfig {
  return {
    sampleText: '',
    selectionStart: 0,
    selectionEnd: 0,
    tokens: [],
    caseSensitive: true,
  };
}

function createToken(text: string, index: number): RegexBuilderToken {
  return {
    id: `token-${index}-${text}`,
    text,
    mode: 'EXACT',
    patternKind: inferPatternKind(text),
  };
}

function tokenizeSelection(selection: string): RegexBuilderToken[] {
  const parts = selection.match(TOKEN_PATTERN) ?? [];
  return parts.map((part, index) => createToken(part, index));
}

function clampRange(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeSelectionBounds(sampleText: string, start: number, end: number): { start: number; end: number } {
  const length = sampleText.length;
  const safeStart = clampRange(start, 0, length);
  const safeEnd = clampRange(end, 0, length);

  return safeStart <= safeEnd ? { start: safeStart, end: safeEnd } : { start: safeEnd, end: safeStart };
}

function rebuildSelection(builder: RegexBuilderConfig, start: number, end: number): RegexBuilderConfig {
  const range = normalizeSelectionBounds(builder.sampleText, start, end);
  const selectedText = builder.sampleText.slice(range.start, range.end);

  return {
    ...builder,
    selectionStart: range.start,
    selectionEnd: range.end,
    tokens: selectedText ? tokenizeSelection(selectedText) : [],
  };
}

function inferPatternKind(text: string): RegexTokenPatternKind {
  if (/^\d+$/.test(text)) {
    return 'NUMBER';
  }

  if (/^[A-Za-z]+$/.test(text)) {
    return 'LETTERS';
  }

  if (/^[A-Za-z0-9_-]+$/.test(text)) {
    return 'WORD';
  }

  return 'ANY_TEXT';
}

function buildFlexiblePattern(token: RegexBuilderToken): string {
  const kind = token.patternKind === 'AUTO' ? inferPatternKind(token.text) : token.patternKind;

  switch (kind) {
    case 'NUMBER':
      return '\\d+';
    case 'LETTERS':
      return '[A-Za-z]+';
    case 'WORD':
      return '[A-Za-z0-9_-]+';
    case 'ANY_TEXT':
    case 'AUTO':
    default:
      return '[^/?#&=]+';
  }
}

function withFlags(pattern: string, flags: string): string {
  if (!pattern || !flags) {
    return pattern;
  }

  return `/${pattern.replace(/\//g, '\\/')}/${flags}`;
}

function truncateSuggestion(value: string, maxLength = 40): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}...`;
}

function createSuggestion(
  sampleText: string,
  label: string,
  start: number,
  end: number,
): RegexBuilderSelectionSuggestion | null {
  if (start < 0 || end <= start || end > sampleText.length) {
    return null;
  }

  return {
    id: `${start}:${end}:${label}`,
    label,
    start,
    end,
  };
}

function findSequentialMatch(input: string, needle: string, fromIndex: number): number {
  return input.indexOf(needle, fromIndex);
}

export function getRegexBuilderSuggestions(
  builder: RegexBuilderConfig,
): RegexBuilderSelectionSuggestion[] {
  const sampleText = builder.sampleText;
  if (!sampleText.trim()) {
    return [];
  }

  const suggestions: RegexBuilderSelectionSuggestion[] = [];
  const seen = new Set<string>();

  function pushSuggestion(label: string, start: number, end: number): void {
    const suggestion = createSuggestion(sampleText, label, start, end);
    if (!suggestion) {
      return;
    }

    const key = `${suggestion.start}:${suggestion.end}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    suggestions.push(suggestion);
  }

  pushSuggestion('Whole URL', 0, sampleText.length);

  try {
    const parsedUrl = new URL(sampleText);

    if (parsedUrl.host) {
      const hostStart = sampleText.indexOf(parsedUrl.host);
      pushSuggestion(`Site: ${truncateSuggestion(parsedUrl.host)}`, hostStart, hostStart + parsedUrl.host.length);
    }

    let searchStart = 0;
    parsedUrl.pathname
      .split('/')
      .filter(Boolean)
      .forEach((segment) => {
        const start = findSequentialMatch(sampleText, segment, searchStart);
        if (start < 0) {
          return;
        }

        pushSuggestion(`Path: ${truncateSuggestion(segment)}`, start, start + segment.length);
        searchStart = start + segment.length;
      });

    Array.from(parsedUrl.searchParams.entries()).forEach(([key, value]) => {
      const pair = `${key}=${value}`;
      const start = sampleText.indexOf(pair);
      if (start >= 0) {
        pushSuggestion(`Query: ${truncateSuggestion(pair)}`, start, start + pair.length);
      }
    });
  } catch {
    // Free-form text still works. We fall back to generic pieces below.
  }

  const genericMatches = sampleText.matchAll(/[^/?#&=\s]+/g);
  for (const match of genericMatches) {
    if (!match[0] || match.index === undefined || match[0].length < 3) {
      continue;
    }

    pushSuggestion(`Piece: ${truncateSuggestion(match[0])}`, match.index, match.index + match[0].length);

    if (suggestions.length >= 8) {
      break;
    }
  }

  return suggestions.slice(0, 8);
}

export function buildRegexFromBuilder(config: RegexBuilderConfig): string {
  const pattern = config.tokens
    .map((token) => (token.mode === 'FLEXIBLE' ? buildFlexiblePattern(token) : escapeRegexLiteral(token.text)))
    .join('');

  return config.caseSensitive ? pattern : withFlags(pattern, 'i');
}

export function setRegexBuilderSample(builder: RegexBuilderConfig, sampleText: string): RegexBuilderConfig {
  return rebuildSelection(
    {
      ...builder,
      sampleText,
    },
    builder.selectionStart,
    builder.selectionEnd,
  );
}

export function applyRegexBuilderSelection(
  builder: RegexBuilderConfig,
  selectionStart: number,
  selectionEnd: number,
): RegexBuilderConfig {
  return rebuildSelection(builder, selectionStart, selectionEnd);
}

export function selectWholeRegexBuilderSample(builder: RegexBuilderConfig): RegexBuilderConfig {
  return rebuildSelection(builder, 0, builder.sampleText.length);
}

export function getRegexBuilderSelectionText(builder: RegexBuilderConfig): string {
  return builder.sampleText.slice(builder.selectionStart, builder.selectionEnd);
}

export function toggleRegexBuilderTokenMode(builder: RegexBuilderConfig, tokenId: string): RegexBuilderConfig {
  return {
    ...builder,
    tokens: builder.tokens.map((token) =>
      token.id === tokenId
        ? {
            ...token,
            mode: token.mode === 'EXACT' ? 'FLEXIBLE' : 'EXACT',
          }
        : token,
    ),
  };
}

export function updateRegexBuilderTokenPatternKind(
  builder: RegexBuilderConfig,
  tokenId: string,
  patternKind: RegexTokenPatternKind,
): RegexBuilderConfig {
  return {
    ...builder,
    tokens: builder.tokens.map((token) =>
      token.id === tokenId
        ? {
            ...token,
            patternKind,
          }
        : token,
    ),
  };
}

export function seedRegexBuilderFromLiteral(helperMode: 'CONTAINS' | 'STARTS_WITH', helperInput: string): RegexBuilderConfig {
  const sampleText = helperInput;
  const base = createDefaultRegexBuilder();
  const seeded = setRegexBuilderSample(base, sampleText);
  const withSelection = selectWholeRegexBuilderSample(seeded);

  if (helperMode === 'STARTS_WITH') {
    return withSelection;
  }

  return withSelection;
}

export function getRegexBuilderPatternKindLabel(patternKind: RegexTokenPatternKind): string {
  switch (patternKind) {
    case 'NUMBER':
      return 'Numbers';
    case 'LETTERS':
      return 'Letters';
    case 'WORD':
      return 'Word';
    case 'ANY_TEXT':
      return 'Any URL text';
    case 'AUTO':
    default:
      return 'Smart guess';
  }
}

export function describeRegexBuilder(builder: RegexBuilderConfig): string {
  if (!builder.sampleText.trim()) {
    return 'Paste a sample URL first, or use a quick-pick suggestion once one appears.';
  }

  if (!builder.tokens.length) {
    return 'Pick the part of the sample URL you want this activity to match.';
  }

  const flexibleCount = builder.tokens.filter((token) => token.mode === 'FLEXIBLE').length;
  if (flexibleCount === 0) {
    return 'Right now this will match the selected text exactly as written.';
  }

  return `${flexibleCount} part${flexibleCount === 1 ? '' : 's'} can change while the rest stays exact.`;
}

export function validateEditorRegexPattern(pattern: string): string | null {
  if (!pattern.trim()) {
    return 'The generated pattern is empty.';
  }

  try {
    assertSafeRegexPattern(pattern);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'The regex pattern is invalid.';
  }
}

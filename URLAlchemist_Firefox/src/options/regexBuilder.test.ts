import { describe, expect, it } from 'vitest';

import {
  applyRegexBuilderSelection,
  buildRegexFromBuilder,
  createDefaultRegexBuilder,
  getRegexBuilderSuggestions,
  setRegexBuilderSample,
  toggleRegexBuilderTokenMode,
  updateRegexBuilderTokenPatternKind,
  validateEditorRegexPattern,
} from './regexBuilder';

describe('regexBuilder', () => {
  it('builds an exact pattern from a highlighted sample url segment', () => {
    const sample = 'https://example.com/products/12345?utm_source=newsletter';
    const selected = 'utm_source=newsletter';
    const start = sample.indexOf(selected);
    const end = start + selected.length;
    const builder = applyRegexBuilderSelection(setRegexBuilderSample(createDefaultRegexBuilder(), sample), start, end);

    expect(buildRegexFromBuilder(builder)).toBe('utm_source=newsletter');
  });

  it('lets a selected token become flexible', () => {
    const sample = 'https://example.com/products/12345?utm_source=newsletter';
    const selected = 'utm_source=newsletter';
    const start = sample.indexOf(selected);
    const end = start + selected.length;
    const builder = applyRegexBuilderSelection(setRegexBuilderSample(createDefaultRegexBuilder(), sample), start, end);
    const valueToken = builder.tokens[2];
    const flexible = updateRegexBuilderTokenPatternKind(
      toggleRegexBuilderTokenMode(builder, valueToken.id),
      valueToken.id,
      'WORD',
    );

    expect(buildRegexFromBuilder(flexible)).toBe('utm_source=[A-Za-z0-9_-]+');
  });

  it('offers quick-pick suggestions for sample url path segments', () => {
    const sample =
      'https://assets.somecoolwebsite.com/images/h_2000,f_auto,q_auto,fl_lossy,c_fill,g_auto/randomId/somefilename.jpg';
    const builder = setRegexBuilderSample(createDefaultRegexBuilder(), sample);
    const suggestions = getRegexBuilderSuggestions(builder);

    expect(suggestions.some((suggestion) => suggestion.label.includes('Path: h_2000,f_auto'))).toBe(true);
  });

  it('rejects unsafe manual regex patterns', () => {
    expect(validateEditorRegexPattern('(a+)+$')).toContain('Unsafe regular expression rejected');
  });
});

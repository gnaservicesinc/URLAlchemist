import { useRef } from 'react';

import type { ActivityDraft } from '../drafts';
import {
  applyRegexBuilderSelection,
  createDefaultRegexBuilder,
  describeRegexBuilder,
  getRegexBuilderPatternKindLabel,
  getRegexBuilderSelectionText,
  getRegexBuilderSuggestions,
  setRegexBuilderSample,
  toggleRegexBuilderTokenMode,
  updateRegexBuilderTokenPatternKind,
  type RegexTokenPatternKind,
} from '../regexBuilder';

interface RegexBuilderPanelProps {
  activity: ActivityDraft;
  advancedModeEnabled: boolean;
  validationError?: string | null;
  onUpdate: (updates: Partial<ActivityDraft>) => void;
}

function HintLabel({ children, hint }: { children: string; hint: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span>{children}</span>
      <span
        className="inline-flex h-5 w-5 cursor-help items-center justify-center rounded-full border border-amber-300 bg-amber-50 text-[11px] font-bold text-amber-700"
        title={hint}
      >
        ?
      </span>
    </span>
  );
}

const patternKindOptions: RegexTokenPatternKind[] = ['AUTO', 'NUMBER', 'LETTERS', 'WORD', 'ANY_TEXT'];

export function RegexBuilderPanel({
  activity,
  advancedModeEnabled,
  validationError,
  onUpdate,
}: RegexBuilderPanelProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const selectedText = getRegexBuilderSelectionText(activity.regexBuilder);
  const flexibleTokens = activity.regexBuilder.tokens.filter((token) => token.mode === 'FLEXIBLE');
  const suggestions = getRegexBuilderSuggestions(activity.regexBuilder);

  function updateSelection(selectionStart: number, selectionEnd: number): void {
    onUpdate({
      regexBuilder: applyRegexBuilderSelection(activity.regexBuilder, selectionStart, selectionEnd),
      regexSourceMode: 'VISUAL',
    });

    window.requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(selectionStart, selectionEnd);
      textareaRef.current?.focus();
    });
  }

  function captureSelection(): void {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    updateSelection(textarea.selectionStart ?? 0, textarea.selectionEnd ?? 0);
  }

  if (advancedModeEnabled) {
    return (
      <div className="rounded-[1.45rem] border border-slate-200 bg-[rgba(248,250,252,0.7)] p-4 lg:col-span-2">
        <label className="field-shell">
          <span className="field-label">
            <HintLabel
              hint="Manual regex is for expert users. We still validate it before the pack can be saved."
            >
              Manual Regex
            </HintLabel>
          </span>
          <textarea
            className="field-textarea min-h-24 font-mono text-xs"
            placeholder="Example: h_\\d+,f_auto,q_auto"
            value={activity.regexSourceMode === 'MANUAL' ? activity.helperInput : activity.pattern}
            onChange={(event) =>
              onUpdate({
                helperInput: event.target.value,
                regexSourceMode: 'MANUAL',
              })
            }
          />
        </label>
        <p className="mt-3 text-xs text-slate-500">
          Advanced mode edits the stored regex directly. If this regex came from the sample builder, you are now
          editing that generated pattern by hand.
        </p>
        {validationError ? (
          <p className="mt-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{validationError}</p>
        ) : null}
      </div>
    );
  }

  if (activity.regexSourceMode === 'MANUAL') {
    return (
      <div className="rounded-[1.45rem] border border-slate-200 bg-[rgba(248,250,252,0.7)] p-4 lg:col-span-2">
        <div className="rounded-3xl border border-amber-200 bg-amber-50/80 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700">Advanced Regex Hidden</p>
          <p className="mt-2 text-sm text-amber-950">
            This activity currently uses a manual regex. Beginner mode keeps it safe and read-only instead of trying
            to guess how to rebuild it visually.
          </p>
          <div className="mt-3 rounded-2xl border border-amber-200 bg-white/85 px-4 py-3 font-mono text-xs text-slate-800">
            {activity.pattern || 'No regex stored yet.'}
          </div>
          <button
            className="ghost-button mt-4"
            title="Clear the manual regex and start fresh with the sample URL builder."
            type="button"
            onClick={() =>
              onUpdate({
                helperInput: '',
                regexBuilder: createDefaultRegexBuilder(),
                regexSourceMode: 'VISUAL',
              })
            }
          >
            Start Over With Sample URL Builder
          </button>
        </div>
        {validationError ? (
          <p className="mt-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{validationError}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-[1.45rem] border border-slate-200 bg-[rgba(248,250,252,0.7)] p-4 lg:col-span-2">
      <div className="space-y-4">
        <section className="rounded-3xl border border-slate-200 bg-white/85 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Step 1</p>
          <label className="field-shell mt-3">
            <span className="field-label">
              <HintLabel
                hint="Paste a real example URL here. Then pick the part you want this activity to match."
              >
                Paste a Sample URL
              </HintLabel>
            </span>
            <textarea
              ref={textareaRef}
              className="field-textarea min-h-24 font-mono text-xs"
              placeholder="https://assets.somecoolwebsite.com/images/h_2000,f_auto,q_auto/randomId/photo.jpg"
              value={activity.regexBuilder.sampleText}
              onChange={(event) =>
                onUpdate({
                  regexBuilder: setRegexBuilderSample(activity.regexBuilder, event.target.value),
                  regexSourceMode: 'VISUAL',
                })
              }
              onKeyUp={captureSelection}
              onMouseUp={captureSelection}
            />
          </label>

          {suggestions.length > 0 ? (
            <div className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Quick Picks</p>
              <p className="mt-2 text-xs text-slate-500">
                Click the chunk you want to match. This is usually easier than highlighting by hand.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion.id}
                    className="ghost-button"
                    title="Use this suggested part of the sample URL."
                    type="button"
                    onClick={() => updateSelection(suggestion.start, suggestion.end)}
                  >
                    {suggestion.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white/85 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Step 2</p>
          <div className="mt-3 rounded-2xl border border-dashed border-amber-300 bg-amber-50/80 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700">Selected Text</p>
            <p className="mt-2 break-all font-mono text-sm text-amber-950">
              {selectedText || 'Nothing selected yet. Pick a quick suggestion or highlight text in the sample URL.'}
            </p>
          </div>
          <p className="mt-3 text-xs text-slate-500">{describeRegexBuilder(activity.regexBuilder)}</p>
        </section>

        {activity.regexBuilder.tokens.length > 0 ? (
          <section className="rounded-3xl border border-slate-200 bg-white/85 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Step 3</p>
            <p className="mt-3 text-sm text-slate-700">
              Leave pieces cream when they must stay exact. Click a piece to turn it blue if that part can change.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {activity.regexBuilder.tokens.map((token) => (
                <button
                  key={token.id}
                  className={
                    token.mode === 'FLEXIBLE'
                      ? 'rounded-full border border-sky-300 bg-sky-100 px-3 py-2 font-mono text-xs font-semibold text-sky-800'
                      : 'rounded-full border border-slate-300 bg-slate-100 px-3 py-2 font-mono text-xs font-semibold text-slate-700'
                  }
                  title={
                    token.mode === 'FLEXIBLE'
                      ? 'This piece can change. Click again to make it exact.'
                      : 'This piece must match exactly. Click to let it change.'
                  }
                  type="button"
                  onClick={() =>
                    onUpdate({
                      regexBuilder: toggleRegexBuilderTokenMode(activity.regexBuilder, token.id),
                      regexSourceMode: 'VISUAL',
                    })
                  }
                >
                  {token.text === ' ' ? '[space]' : token.text}
                </button>
              ))}
            </div>

            {flexibleTokens.length > 0 ? (
              <div className="mt-4 grid gap-3">
                {flexibleTokens.map((token) => (
                  <div
                    key={token.id}
                    className="rounded-2xl border border-sky-200 bg-sky-50/80 px-4 py-3 sm:flex sm:items-center sm:justify-between sm:gap-4"
                  >
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">
                        Flexible Piece
                      </p>
                      <p className="mt-1 break-all font-mono text-sm text-sky-950">{token.text}</p>
                    </div>
                    <label className="field-shell mt-3 sm:mt-0 sm:min-w-52">
                      <span className="field-label">
                        <HintLabel
                          hint="Choose what this changing piece usually looks like. Smart guess works well most of the time."
                        >
                          What Kind of Text Is This?
                        </HintLabel>
                      </span>
                      <select
                        className="field-select"
                        value={token.patternKind}
                        onChange={(event) =>
                          onUpdate({
                            regexBuilder: updateRegexBuilderTokenPatternKind(
                              activity.regexBuilder,
                              token.id,
                              event.target.value as RegexTokenPatternKind,
                            ),
                            regexSourceMode: 'VISUAL',
                          })
                        }
                      >
                        {patternKindOptions.map((patternKind) => (
                          <option key={patternKind} value={patternKind}>
                            {getRegexBuilderPatternKindLabel(patternKind)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>

      {validationError ? (
        <p className="mt-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{validationError}</p>
      ) : null}
    </div>
  );
}

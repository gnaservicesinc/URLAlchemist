import { OFFSCREEN_CLIPBOARD_MESSAGE, OFFSCREEN_REGEX_MESSAGE } from '../shared/messages';
import type { ClipboardResponse, OffscreenMessage, RuntimeResponse } from '../shared/messages';
import { createPageRegexExecutor } from '../shared/regex/pageRunner';
import type { RegexJobResponse } from '../shared/types';

const regexExecutor = createPageRegexExecutor();

chrome.runtime.onMessage.addListener((message: OffscreenMessage, _sender, sendResponse) => {
  if (message.type === OFFSCREEN_REGEX_MESSAGE) {
    void (async () => {
      try {
        const response: RegexJobResponse =
          message.request.kind === 'test'
            ? {
                kind: 'test',
                matched: await regexExecutor.test(message.request.input, message.request.pattern),
              }
            : {
                kind: 'transform',
                ...(await regexExecutor.transform(message.request)),
              };

        sendResponse({
          ok: true,
          data: response,
        } satisfies RuntimeResponse<RegexJobResponse>);
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Offscreen regex execution failed',
        } satisfies RuntimeResponse<RegexJobResponse>);
      }
    })();

    return true;
  }

  if (message.type === OFFSCREEN_CLIPBOARD_MESSAGE) {
    void (async () => {
      try {
        const text = await navigator.clipboard.readText();

        sendResponse({
          ok: true,
          data: {
            text,
          },
        } satisfies RuntimeResponse<ClipboardResponse>);
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Clipboard read failed',
        } satisfies RuntimeResponse<ClipboardResponse>);
      }
    })();

    return true;
  }

  return undefined;
});

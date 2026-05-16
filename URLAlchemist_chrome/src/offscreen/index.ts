import { CLIPBOARD_MAX_TEXT_BYTES } from '../shared/constants';
import { OFFSCREEN_CLIPBOARD_BINARY_WRITE_MESSAGE, OFFSCREEN_CLIPBOARD_MESSAGE, OFFSCREEN_CLIPBOARD_WRITE_MESSAGE, OFFSCREEN_REGEX_MESSAGE } from '../shared/messages';
import type { ClipboardResponse, OffscreenMessage, RuntimeResponse } from '../shared/messages';
import { createPageRegexExecutor } from '../shared/regex/pageRunner';
import type { RegexJobResponse } from '../shared/types';

const regexExecutor = createPageRegexExecutor();

function fallbackWriteText(text: string): void {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) {
    throw new Error('Clipboard write fallback failed');
  }
}

async function writeTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    fallbackWriteText(text);
  }
}

chrome.runtime.onMessage.addListener((message: OffscreenMessage, _sender, sendResponse) => {
  if (message.type === OFFSCREEN_REGEX_MESSAGE) {
    void (async () => {
      try {
        const response: RegexJobResponse =
          message.request.kind === 'test'
            ? {
                kind: 'test',
                matched: await regexExecutor.test(message.request.input, message.request.pattern, message.request.timeoutMs),
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
        if (new TextEncoder().encode(text).byteLength > CLIPBOARD_MAX_TEXT_BYTES) {
          sendResponse({
            ok: false,
            error: `Clipboard text exceeds the ${CLIPBOARD_MAX_TEXT_BYTES / 1024 / 1024}MB size limit`,
          } satisfies RuntimeResponse<ClipboardResponse>);
          return;
        }

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

  if (message.type === OFFSCREEN_CLIPBOARD_WRITE_MESSAGE) {
    void (async () => {
      try {
        await writeTextToClipboard(message.text);

        sendResponse({
          ok: true,
          data: null,
        } satisfies RuntimeResponse<null>);
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Clipboard write failed',
        } satisfies RuntimeResponse<null>);
      }
    })();

    return true;
  }

  if (message.type === OFFSCREEN_CLIPBOARD_BINARY_WRITE_MESSAGE) {
    void (async () => {
      try {
        const bytes = Uint8Array.from(atob(message.dataBase64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: message.mimeType });
        await navigator.clipboard.write([new ClipboardItem({ [message.mimeType]: blob })]);

        sendResponse({
          ok: true,
          data: null,
        } satisfies RuntimeResponse<null>);
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Binary clipboard write failed',
        } satisfies RuntimeResponse<null>);
      }
    })();

    return true;
  }

  return undefined;
});

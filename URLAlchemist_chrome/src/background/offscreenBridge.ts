import {
  OFFSCREEN_CLIPBOARD_MESSAGE,
  OFFSCREEN_CLIPBOARD_WRITE_MESSAGE,
  OFFSCREEN_REGEX_MESSAGE,
  type ClipboardResponse,
  type RuntimeResponse,
} from '../shared/messages';
import type { RegexExecutor } from '../shared/engine/runtime';
import type { RegexJobResponse, RegexTransformRequest } from '../shared/types';

let creatingDocumentPromise: Promise<void> | null = null;

async function hasOffscreenDocument(): Promise<boolean> {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  });

  return contexts.length > 0;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (!creatingDocumentPromise) {
    creatingDocumentPromise = (async () => {
      try {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: [chrome.offscreen.Reason.CLIPBOARD],
          justification: 'URL Alchemist uses an offscreen page to sandbox regex execution and read clipboard placeholders',
        });
      } catch (error) {
        // Race or already-exists: re-check before throwing
        if (await hasOffscreenDocument()) {
          return;
        }
        throw error;
      }
    })().finally(() => {
      creatingDocumentPromise = null;
    });
  }

  await creatingDocumentPromise;
}

async function sendOffscreenMessage<T>(message: object): Promise<T> {
  await ensureOffscreenDocument();
  const response = (await chrome.runtime.sendMessage(message)) as RuntimeResponse<T> | undefined;

  if (!response) {
    throw new Error('The offscreen document did not respond');
  }

  if (!response.ok) {
    throw new Error(response.error);
  }

  return response.data;
}

export function createOffscreenRegexExecutor(timeoutMs?: number): RegexExecutor {
  return {
    async test(input, pattern) {
      const response = await sendOffscreenMessage<RegexJobResponse>({
        type: OFFSCREEN_REGEX_MESSAGE,
        request: {
          kind: 'test',
          input,
          pattern,
          timeoutMs,
        },
      });

      return response.matched;
    },
    async transform(request: Omit<RegexTransformRequest, 'kind'>) {
      const response = await sendOffscreenMessage<RegexJobResponse>({
        type: OFFSCREEN_REGEX_MESSAGE,
        request: {
          kind: 'transform',
          ...request,
          timeoutMs,
        },
      });

      return {
        matched: response.matched,
        result: response.result ?? request.input,
      };
    },
  };
}

export async function readClipboardFromOffscreen(): Promise<string> {
  const permissionGranted = await chrome.permissions.contains({
    permissions: ['clipboardRead'],
  });

  if (!permissionGranted) {
    throw new Error('Clipboard access requires the optional clipboardRead permission');
  }

  const response = await sendOffscreenMessage<ClipboardResponse>({
    type: OFFSCREEN_CLIPBOARD_MESSAGE,
  });

  return response.text;
}

export async function writeClipboardFromOffscreen(text: string): Promise<void> {
  const permissionGranted = await chrome.permissions.contains({
    permissions: ['clipboardWrite'],
  });

  if (!permissionGranted) {
    throw new Error('Clipboard writes require the optional clipboardWrite permission');
  }

  await sendOffscreenMessage<null>({
    type: OFFSCREEN_CLIPBOARD_WRITE_MESSAGE,
    text,
  });
}

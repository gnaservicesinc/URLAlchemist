import {
  OFFSCREEN_CLIPBOARD_BINARY_WRITE_MESSAGE,
  OFFSCREEN_CLIPBOARD_MESSAGE,
  OFFSCREEN_CLIPBOARD_WRITE_MESSAGE,
  OFFSCREEN_REGEX_MESSAGE,
  type ClipboardResponse,
  type RuntimeResponse,
} from '../shared/messages';
import {
  CLIPBOARD_BINARY_MAX_TIMEOUT_MS,
  CLIPBOARD_BINARY_WORST_CASE_BYTES_PER_SECOND,
} from '../shared/constants';
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
  const timeoutMs = 30_000;
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    const response = (await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise<undefined>((_, reject) => {
        timeoutId = globalThis.setTimeout(() => reject(new Error(`Offscreen message timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ])) as RuntimeResponse<T> | undefined;

    if (!response) {
      throw new Error('The offscreen document did not respond');
    }

    if (!response.ok) {
      throw new Error(response.error);
    }

    return response.data;
  } finally {
    if (timeoutId !== undefined) {
      globalThis.clearTimeout(timeoutId);
    }
  }
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

/**
 * Derive a timeout for binary clipboard payloads based on data size.
 *
 * Formula: worst-case seconds-per-byte x payload bytes x 2 (safety margin),
 * clamped between 30s (the generic offscreen message timeout) and 5min
 * (prevents absurd values while never limiting realistic payloads).
 */
function clipboardBinaryTimeoutMs(payloadBytes: number): number {
  const computed = Math.ceil(
    (payloadBytes / CLIPBOARD_BINARY_WORST_CASE_BYTES_PER_SECOND) * 1000 * 2,
  );
  return Math.min(CLIPBOARD_BINARY_MAX_TIMEOUT_MS, Math.max(30_000, computed));
}

export async function writeClipboardBinaryFromOffscreen(mimeType: string, dataBase64: string): Promise<void> {
  const permissionGranted = await chrome.permissions.contains({
    permissions: ['clipboardWrite'],
  });

  if (!permissionGranted) {
    throw new Error('Clipboard writes require the optional clipboardWrite permission');
  }

  const payloadBytes = new TextEncoder().encode(dataBase64).byteLength;
  const timeoutMs = clipboardBinaryTimeoutMs(payloadBytes);

  // Use a dedicated timeout instead of the shared 30s sendOffscreenMessage default.
  const message = {
    type: OFFSCREEN_CLIPBOARD_BINARY_WRITE_MESSAGE as typeof OFFSCREEN_CLIPBOARD_BINARY_WRITE_MESSAGE,
    mimeType,
    dataBase64,
  };
  await ensureOffscreenDocument();
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  const response = (await Promise.race([
    chrome.runtime.sendMessage(message),
    new Promise<undefined>((_, reject) => {
      timeoutId = globalThis.setTimeout(
        () => reject(new Error(`Binary clipboard write timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timeoutId !== undefined) {
      globalThis.clearTimeout(timeoutId);
    }
  })) as RuntimeResponse<null> | undefined;

  if (!response) {
    throw new Error('The offscreen document did not respond');
  }

  if (!response.ok) {
    throw new Error(response.error);
  }
}

import type { RegexJobRequest, RegexJobResponse } from './types';
import type { GraphValue } from './v2/types';
import type { DisplayRequest, UserInteractionRequest } from './v2/vm';

export const OFFSCREEN_REGEX_MESSAGE = 'URL_ALCHEMIST_OFFSCREEN_REGEX';
export const OFFSCREEN_CLIPBOARD_MESSAGE = 'URL_ALCHEMIST_OFFSCREEN_CLIPBOARD';
export const OFFSCREEN_CLIPBOARD_WRITE_MESSAGE = 'URL_ALCHEMIST_OFFSCREEN_CLIPBOARD_WRITE';
export const HOTKEY_TRIGGER_MESSAGE = 'URL_ALCHEMIST_HOTKEY_TRIGGER';
export const CONTENT_INTERACTION_MESSAGE = 'URL_ALCHEMIST_CONTENT_INTERACTION';
export const CONTENT_DISPLAY_MESSAGE = 'URL_ALCHEMIST_CONTENT_DISPLAY';
export const CONTENT_MUTATE_TEXT_MESSAGE = 'URL_ALCHEMIST_CONTENT_MUTATE_TEXT';
export const CONTENT_READ_SOURCE_MESSAGE = 'URL_ALCHEMIST_CONTENT_READ_SOURCE';

export interface OffscreenRegexMessage {
  type: typeof OFFSCREEN_REGEX_MESSAGE;
  request: RegexJobRequest;
}

export interface OffscreenClipboardMessage {
  type: typeof OFFSCREEN_CLIPBOARD_MESSAGE;
}

export interface OffscreenClipboardWriteMessage {
  type: typeof OFFSCREEN_CLIPBOARD_WRITE_MESSAGE;
  text: string;
}

export interface RuntimeSourceContext {
  linkUrl?: string;
  pageTitle?: string;
  selectedText?: string;
  tabId?: number;
}

export interface HotkeyTriggerMessage extends RuntimeSourceContext {
  type: typeof HOTKEY_TRIGGER_MESSAGE;
  hotkey: string;
  url: string;
}

export type OffscreenMessage = OffscreenRegexMessage | OffscreenClipboardMessage | OffscreenClipboardWriteMessage;

export interface ContentInteractionMessage {
  type: typeof CONTENT_INTERACTION_MESSAGE;
  requestId: string;
  request: UserInteractionRequest;
}

export interface ContentDisplayMessage {
  type: typeof CONTENT_DISPLAY_MESSAGE;
  requestId: string;
  request: DisplayRequest;
}

export interface ContentMutateTextMessage {
  type: typeof CONTENT_MUTATE_TEXT_MESSAGE;
  requestId: string;
  value: GraphValue;
}

export interface ContentReadSourceMessage {
  type: typeof CONTENT_READ_SOURCE_MESSAGE;
  requestId: string;
  source: string;
}

export type ContentRuntimeMessage = ContentInteractionMessage | ContentDisplayMessage | ContentMutateTextMessage | ContentReadSourceMessage;

export interface RuntimeSuccess<T> {
  ok: true;
  data: T;
}

export interface RuntimeFailure {
  ok: false;
  error: string;
}

export type RuntimeResponse<T> = RuntimeSuccess<T> | RuntimeFailure;

export interface ClipboardResponse {
  text: string;
}

export type RegexResponse = RuntimeResponse<RegexJobResponse>;
export type ContentGraphResponse = RuntimeResponse<GraphValue>;

export function isContentRuntimeMessage(message: unknown): message is ContentRuntimeMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    'requestId' in message &&
    typeof (message as { requestId?: unknown }).requestId === 'string' &&
    (
      (message as { type?: unknown }).type === CONTENT_INTERACTION_MESSAGE ||
      (message as { type?: unknown }).type === CONTENT_DISPLAY_MESSAGE ||
      (message as { type?: unknown }).type === CONTENT_MUTATE_TEXT_MESSAGE ||
      (message as { type?: unknown }).type === CONTENT_READ_SOURCE_MESSAGE
    )
  );
}

export function isHotkeyTriggerMessage(message: unknown): message is HotkeyTriggerMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    'hotkey' in message &&
    'url' in message &&
    (message as HotkeyTriggerMessage).type === HOTKEY_TRIGGER_MESSAGE &&
    typeof (message as HotkeyTriggerMessage).hotkey === 'string' &&
    typeof (message as HotkeyTriggerMessage).url === 'string' &&
    ((message as HotkeyTriggerMessage).selectedText === undefined || typeof (message as HotkeyTriggerMessage).selectedText === 'string') &&
    ((message as HotkeyTriggerMessage).linkUrl === undefined || typeof (message as HotkeyTriggerMessage).linkUrl === 'string') &&
    ((message as HotkeyTriggerMessage).pageTitle === undefined || typeof (message as HotkeyTriggerMessage).pageTitle === 'string')
  );
}

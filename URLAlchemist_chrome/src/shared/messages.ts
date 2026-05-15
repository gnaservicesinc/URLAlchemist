import type { RegexJobRequest, RegexJobResponse } from './types';

export const OFFSCREEN_REGEX_MESSAGE = 'URL_ALCHEMIST_OFFSCREEN_REGEX';
export const OFFSCREEN_CLIPBOARD_MESSAGE = 'URL_ALCHEMIST_OFFSCREEN_CLIPBOARD';
export const OFFSCREEN_CLIPBOARD_WRITE_MESSAGE = 'URL_ALCHEMIST_OFFSCREEN_CLIPBOARD_WRITE';
export const HOTKEY_TRIGGER_MESSAGE = 'URL_ALCHEMIST_HOTKEY_TRIGGER';

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
}

export interface HotkeyTriggerMessage extends RuntimeSourceContext {
  type: typeof HOTKEY_TRIGGER_MESSAGE;
  hotkey: string;
  url: string;
}

export type OffscreenMessage = OffscreenRegexMessage | OffscreenClipboardMessage | OffscreenClipboardWriteMessage;

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

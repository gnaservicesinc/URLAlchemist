import type { RegexJobRequest, RegexJobResponse } from './types';

export const OFFSCREEN_REGEX_MESSAGE = 'URL_ALCHEMIST_OFFSCREEN_REGEX';
export const OFFSCREEN_CLIPBOARD_MESSAGE = 'URL_ALCHEMIST_OFFSCREEN_CLIPBOARD';

export interface OffscreenRegexMessage {
  type: typeof OFFSCREEN_REGEX_MESSAGE;
  request: RegexJobRequest;
}

export interface OffscreenClipboardMessage {
  type: typeof OFFSCREEN_CLIPBOARD_MESSAGE;
}

export type OffscreenMessage = OffscreenRegexMessage | OffscreenClipboardMessage;

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

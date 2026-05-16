import type { RegexJobRequest, RegexJobResponse } from './types';
import type { GraphValue, OverlayRuntimeEvent } from './v2/types';
import type { DisplayRequest, OverlayControlRequest, OverlayDrawRequest, UserInteractionRequest } from './v2/vm';

export const OFFSCREEN_REGEX_MESSAGE = 'URL_ALCHEMIST_OFFSCREEN_REGEX';
export const OFFSCREEN_CLIPBOARD_MESSAGE = 'URL_ALCHEMIST_OFFSCREEN_CLIPBOARD';
export const OFFSCREEN_CLIPBOARD_WRITE_MESSAGE = 'URL_ALCHEMIST_OFFSCREEN_CLIPBOARD_WRITE';
export const OFFSCREEN_CLIPBOARD_BINARY_WRITE_MESSAGE = 'URL_ALCHEMIST_OFFSCREEN_CLIPBOARD_BINARY_WRITE';
export const HOTKEY_TRIGGER_MESSAGE = 'URL_ALCHEMIST_HOTKEY_TRIGGER';
export const CONTENT_INTERACTION_MESSAGE = 'URL_ALCHEMIST_CONTENT_INTERACTION';
export const CONTENT_DISPLAY_MESSAGE = 'URL_ALCHEMIST_CONTENT_DISPLAY';
export const CONTENT_MUTATE_TEXT_MESSAGE = 'URL_ALCHEMIST_CONTENT_MUTATE_TEXT';
export const CONTENT_READ_SOURCE_MESSAGE = 'URL_ALCHEMIST_CONTENT_READ_SOURCE';
export const CONTENT_OVERLAY_CONTROL_MESSAGE = 'URL_ALCHEMIST_CONTENT_OVERLAY_CONTROL';
export const CONTENT_OVERLAY_DRAW_MESSAGE = 'URL_ALCHEMIST_CONTENT_OVERLAY_DRAW';
export const OVERLAY_APP_EVENT_MESSAGE = 'URL_ALCHEMIST_OVERLAY_APP_EVENT';

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

export interface OffscreenClipboardBinaryWriteMessage {
  type: typeof OFFSCREEN_CLIPBOARD_BINARY_WRITE_MESSAGE;
  mimeType: string;
  dataBase64: string;
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

export type OffscreenMessage = OffscreenRegexMessage | OffscreenClipboardMessage | OffscreenClipboardWriteMessage | OffscreenClipboardBinaryWriteMessage;

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

export interface ContentOverlayControlMessage {
  type: typeof CONTENT_OVERLAY_CONTROL_MESSAGE;
  requestId: string;
  packId: string;
  request: OverlayControlRequest;
}

export interface ContentOverlayDrawMessage {
  type: typeof CONTENT_OVERLAY_DRAW_MESSAGE;
  requestId: string;
  packId: string;
  request: OverlayDrawRequest;
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

export type ContentRuntimeMessage =
  | ContentInteractionMessage
  | ContentDisplayMessage
  | ContentOverlayControlMessage
  | ContentOverlayDrawMessage
  | ContentMutateTextMessage
  | ContentReadSourceMessage;

export interface OverlayAppEventMessage extends RuntimeSourceContext {
  type: typeof OVERLAY_APP_EVENT_MESSAGE;
  packId: string;
  url: string;
  event: OverlayRuntimeEvent;
}

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
      (message as { type?: unknown }).type === CONTENT_OVERLAY_CONTROL_MESSAGE ||
      (message as { type?: unknown }).type === CONTENT_OVERLAY_DRAW_MESSAGE ||
      (message as { type?: unknown }).type === CONTENT_MUTATE_TEXT_MESSAGE ||
      (message as { type?: unknown }).type === CONTENT_READ_SOURCE_MESSAGE
    )
  );
}

export function isOverlayAppEventMessage(message: unknown): message is OverlayAppEventMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    'packId' in message &&
    'url' in message &&
    'event' in message &&
    (message as OverlayAppEventMessage).type === OVERLAY_APP_EVENT_MESSAGE &&
    typeof (message as OverlayAppEventMessage).packId === 'string' &&
    typeof (message as OverlayAppEventMessage).url === 'string' &&
    typeof (message as { event?: unknown }).event === 'object' &&
    (message as { event?: unknown }).event !== null
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

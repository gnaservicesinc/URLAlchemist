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
export const CONTENT_BLOCKER_START_RECURRING_MESSAGE = 'URL_ALCHEMIST_CONTENT_BLOCKER_START_RECURRING';
export const CONTENT_BLOCKER_RECURRING_CHECK_MESSAGE = 'URL_ALCHEMIST_CONTENT_BLOCKER_RECURRING_CHECK';
export const CONTENT_BLOCKER_CHALLENGE_COMPLETE_MESSAGE = 'URL_ALCHEMIST_CONTENT_BLOCKER_CHALLENGE_COMPLETE';
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
  secondsOnPage?: number;
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

export interface ContentBlockerStartRecurringMessage {
  type: typeof CONTENT_BLOCKER_START_RECURRING_MESSAGE;
  requestId: string;
  packId: string;
  intervalSeconds: number;
}

export type ContentRuntimeMessage =
  | ContentInteractionMessage
  | ContentDisplayMessage
  | ContentOverlayControlMessage
  | ContentOverlayDrawMessage
  | ContentBlockerStartRecurringMessage
  | ContentMutateTextMessage
  | ContentReadSourceMessage;

export interface ContentBlockerRecurringCheckMessage {
  type: typeof CONTENT_BLOCKER_RECURRING_CHECK_MESSAGE;
  packId: string;
  url: string;
  secondsOnPage: number;
}

export interface ContentBlockerChallengeCompleteMessage {
  type: typeof CONTENT_BLOCKER_CHALLENGE_COMPLETE_MESSAGE;
  packId: string;
  sourceUrl: string;
}

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

const MAX_RUNTIME_ID_BYTES = 256;
const MAX_RUNTIME_URL_BYTES = 8192;
const MAX_RUNTIME_CONTEXT_BYTES = 65536;
const MAX_RUNTIME_KEY_BYTES = 128;
const MAX_RUNTIME_REASON_BYTES = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isStringWithin(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && utf8ByteLength(value) <= maxBytes;
}

function isOptionalStringWithin(value: unknown, maxBytes: number): boolean {
  return value === undefined || isStringWithin(value, maxBytes);
}

function isOptionalRuntimeTabId(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && (value as number) >= 0);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function hasValidRuntimeContext(value: Record<string, unknown>): boolean {
  return (
    isOptionalStringWithin(value.selectedText, MAX_RUNTIME_CONTEXT_BYTES) &&
    isOptionalStringWithin(value.linkUrl, MAX_RUNTIME_URL_BYTES) &&
    isOptionalStringWithin(value.pageTitle, MAX_RUNTIME_CONTEXT_BYTES) &&
    (value.secondsOnPage === undefined || (isFiniteNumber(value.secondsOnPage) && value.secondsOnPage >= 0)) &&
    isOptionalRuntimeTabId(value.tabId)
  );
}

function isOverlayRuntimeEvent(value: unknown): value is OverlayRuntimeEvent {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return false;
  }

  switch (value.kind) {
    case 'trigger':
      return (
        hasOnlyKeys(value, ['kind', 'hotkey', 'url']) &&
        isOptionalStringWithin(value.hotkey, MAX_RUNTIME_KEY_BYTES) &&
        isOptionalStringWithin(value.url, MAX_RUNTIME_URL_BYTES)
      );
    case 'keyboard':
      return (
        hasOnlyKeys(value, ['kind', 'eventType', 'key', 'code', 'keyCode', 'repeat']) &&
        (value.eventType === 'keydown' || value.eventType === 'keyup') &&
        isStringWithin(value.key, MAX_RUNTIME_KEY_BYTES) &&
        isStringWithin(value.code, MAX_RUNTIME_KEY_BYTES) &&
        Number.isInteger(value.keyCode) &&
        (value.repeat === undefined || typeof value.repeat === 'boolean')
      );
    case 'mouse':
      return (
        hasOnlyKeys(value, ['kind', 'eventType', 'button', 'buttons', 'x', 'y']) &&
        (
          value.eventType === 'pointermove' ||
          value.eventType === 'pointerdown' ||
          value.eventType === 'pointerup' ||
          value.eventType === 'pointerleave'
        ) &&
        Number.isInteger(value.button) &&
        Number.isInteger(value.buttons) &&
        isFiniteNumber(value.x) &&
        isFiniteNumber(value.y)
      );
    case 'tick':
      return (
        hasOnlyKeys(value, ['kind', 'tick', 'deltaMs']) &&
        isNonNegativeInteger(value.tick) &&
        isFiniteNumber(value.deltaMs) &&
        value.deltaMs >= 0
      );
    case 'close':
      return hasOnlyKeys(value, ['kind', 'reason']) && isStringWithin(value.reason, MAX_RUNTIME_REASON_BYTES);
    default:
      return false;
  }
}

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
      (message as { type?: unknown }).type === CONTENT_BLOCKER_START_RECURRING_MESSAGE ||
      (message as { type?: unknown }).type === CONTENT_MUTATE_TEXT_MESSAGE ||
      (message as { type?: unknown }).type === CONTENT_READ_SOURCE_MESSAGE
    )
  );
}

export function isContentBlockerRecurringCheckMessage(message: unknown): message is ContentBlockerRecurringCheckMessage {
  return (
    isRecord(message) &&
    message.type === CONTENT_BLOCKER_RECURRING_CHECK_MESSAGE &&
    isStringWithin(message.packId, MAX_RUNTIME_ID_BYTES) &&
    isStringWithin(message.url, MAX_RUNTIME_URL_BYTES) &&
    isFiniteNumber(message.secondsOnPage) &&
    message.secondsOnPage >= 0
  );
}

export function isContentBlockerChallengeCompleteMessage(message: unknown): message is ContentBlockerChallengeCompleteMessage {
  return (
    isRecord(message) &&
    message.type === CONTENT_BLOCKER_CHALLENGE_COMPLETE_MESSAGE &&
    isStringWithin(message.packId, MAX_RUNTIME_ID_BYTES) &&
    isStringWithin(message.sourceUrl, MAX_RUNTIME_URL_BYTES)
  );
}

export function isOverlayAppEventMessage(message: unknown): message is OverlayAppEventMessage {
  return (
    isRecord(message) &&
    message.type === OVERLAY_APP_EVENT_MESSAGE &&
    isStringWithin(message.packId, MAX_RUNTIME_ID_BYTES) &&
    isStringWithin(message.url, MAX_RUNTIME_URL_BYTES) &&
    isOverlayRuntimeEvent(message.event) &&
    hasValidRuntimeContext(message)
  );
}

export function isHotkeyTriggerMessage(message: unknown): message is HotkeyTriggerMessage {
  return (
    isRecord(message) &&
    message.type === HOTKEY_TRIGGER_MESSAGE &&
    isStringWithin(message.hotkey, MAX_RUNTIME_KEY_BYTES) &&
    isStringWithin(message.url, MAX_RUNTIME_URL_BYTES) &&
    hasValidRuntimeContext(message)
  );
}

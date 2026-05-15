import {
  CONTENT_DISPLAY_MESSAGE,
  CONTENT_INTERACTION_MESSAGE,
  CONTENT_MUTATE_TEXT_MESSAGE,
  CONTENT_READ_SOURCE_MESSAGE,
  HOTKEY_TRIGGER_MESSAGE,
  isContentRuntimeMessage,
  type ContentRuntimeMessage,
  type RuntimeResponse,
} from '../shared/messages';
import type { AssetRef, GraphValue } from '../shared/v2/types';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable || target.closest('[contenteditable="true"]')) {
    return true;
  }

  return ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
}

function normalizeKeyToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }

  switch (trimmed.toLowerCase()) {
    case ' ':
    case 'space':
    case 'spacebar':
      return 'Space';
    case 'arrowleft':
    case 'left':
      return 'ArrowLeft';
    case 'arrowright':
    case 'right':
      return 'ArrowRight';
    case 'arrowup':
    case 'up':
      return 'ArrowUp';
    case 'arrowdown':
    case 'down':
      return 'ArrowDown';
    case 'esc':
      return 'Escape';
    case 'return':
      return 'Enter';
    case 'comma':
      return ',';
    case 'period':
      return '.';
    default:
      break;
  }

  if (/^(control|ctrl)$/i.test(trimmed)) {
    return 'Ctrl';
  }

  if (/^(alt|option|opt)$/i.test(trimmed)) {
    return 'Alt';
  }

  if (/^shift$/i.test(trimmed)) {
    return 'Shift';
  }

  if (/^(command|cmd|meta|os)$/i.test(trimmed)) {
    return 'Command';
  }

  if (/^f\d{1,2}$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  if (trimmed === 'Dead' || trimmed === 'Process' || trimmed === 'Unidentified') {
    return null;
  }

  if (trimmed.length === 1) {
    return /[a-z]/i.test(trimmed) ? trimmed.toUpperCase() : trimmed;
  }

  return trimmed.length <= 1 ? trimmed.toUpperCase() : `${trimmed.slice(0, 1).toUpperCase()}${trimmed.slice(1).toLowerCase()}`;
}

function toHotkey(event: KeyboardEvent): string | null {
  const key = normalizeKeyToken(event.key);
  if (!key || ['Ctrl', 'Alt', 'Shift', 'Command'].includes(key)) {
    return null;
  }

  const modifiers: string[] = [];
  if (event.ctrlKey) {
    modifiers.push('Ctrl');
  }
  if (event.altKey) {
    modifiers.push('Alt');
  }
  if (event.shiftKey) {
    modifiers.push('Shift');
  }
  if (event.metaKey) {
    modifiers.push('Command');
  }

  if (!modifiers.some((modifier) => modifier !== 'Shift')) {
    return null;
  }

  return [...modifiers, key].join('+');
}

if (window.top === window) {
  window.addEventListener(
    'keydown',
    (event) => {
      if (!event.isTrusted || event.defaultPrevented || event.repeat || isEditableTarget(event.target)) {
        return;
      }

      const hotkey = toHotkey(event);
      if (!hotkey) {
        return;
      }

      chrome.runtime.sendMessage(
        {
          type: HOTKEY_TRIGGER_MESSAGE,
          hotkey,
          pageTitle: document.title,
          selectedText: window.getSelection()?.toString() ?? '',
          url: window.location.href,
        },
        () => {
          void chrome.runtime.lastError;
        },
      );
    },
    { capture: true },
  );
}

function gv(value: unknown): GraphValue {
  if (typeof value === 'boolean') {
    return { type: 'bool', value: value ? 1 : 0 };
  }

  if (typeof value === 'number') {
    return { type: Number.isInteger(value) ? 'number' : 'floatingPoint', value } as GraphValue;
  }

  if (typeof value === 'string') {
    return { type: 'string', value };
  }

  if (value && typeof value === 'object' && 'type' in value) {
    return value as GraphValue;
  }

  return { type: 'Any', value };
}

function dict(entries: Record<string, unknown>): GraphValue {
  return {
    type: 'dict',
    value: Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, gv(value)])),
  };
}

function assetUrl(asset?: AssetRef): string {
  if (!asset) {
    return '';
  }

  if (asset.source === 'embedded' && asset.dataBase64 && asset.mimeType) {
    return `data:${asset.mimeType};base64,${asset.dataBase64}`;
  }

  return asset.url ?? '';
}

function overlayShell(): { root: HTMLDivElement; panel: HTMLDivElement; close: HTMLButtonElement; cleanup: () => void } {
  const root = document.createElement('div');
  root.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2147483647',
    'background:rgba(15,23,42,0.44)',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
  ].join(';');

  const panel = document.createElement('div');
  panel.style.cssText = [
    'width:min(760px,calc(100vw - 32px))',
    'max-height:calc(100vh - 32px)',
    'overflow:auto',
    'background:white',
    'border:1px solid rgba(15,23,42,0.14)',
    'border-radius:12px',
    'box-shadow:0 24px 80px rgba(15,23,42,0.34)',
    'padding:20px',
    'color:#0f172a',
  ].join(';');

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.style.cssText = 'margin-top:16px;border:1px solid #cbd5e1;background:#f8fafc;color:#0f172a;border-radius:8px;padding:8px 12px;font-weight:600;cursor:pointer';

  root.append(panel);
  document.documentElement.append(root);

  return {
    root,
    panel,
    close,
    cleanup: () => root.remove(),
  };
}

async function handleInteraction(message: Extract<ContentRuntimeMessage, { type: typeof CONTENT_INTERACTION_MESSAGE }>): Promise<GraphValue> {
  const { request } = message;
  const ui = overlayShell();
  const title = document.createElement('div');
  title.textContent = request.message;
  title.style.cssText = 'font-size:16px;font-weight:700;margin-bottom:12px';
  ui.panel.append(title);

  return new Promise((resolve) => {
    const finish = (value: GraphValue) => {
      ui.cleanup();
      resolve(value);
    };

    if (request.kind === 'CONFIRM') {
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
      const no = ui.close;
      const yes = document.createElement('button');
      yes.type = 'button';
      yes.textContent = 'Confirm';
      yes.style.cssText = 'border:0;background:#0f172a;color:white;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer';
      no.addEventListener('click', () => finish(dict({ ok: true, cancelled: false, value: false, source: 'confirm' })));
      yes.addEventListener('click', () => finish(dict({ ok: true, cancelled: false, value: true, source: 'confirm' })));
      actions.append(no, yes);
      ui.panel.append(actions);
      return;
    }

    if (request.kind === 'PICK_FILE_OR_URL') {
      const input = document.createElement('input');
      input.type = 'url';
      input.placeholder = 'https://example.com/video.mp4';
      input.value = request.defaultValue ?? '';
      input.style.cssText = 'width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:9px 10px;margin-bottom:10px';
      const file = document.createElement('input');
      file.type = 'file';
      file.style.cssText = 'display:block;margin-bottom:14px';
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
      const cancel = ui.close;
      const submit = document.createElement('button');
      submit.type = 'button';
      submit.textContent = 'Use';
      submit.style.cssText = 'border:0;background:#0f172a;color:white;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer';
      cancel.addEventListener('click', () => finish(dict({ ok: false, cancelled: true, value: null, source: 'user' })));
      submit.addEventListener('click', () => {
        const selected = file.files?.[0];
        if (selected) {
          finish(dict({
            ok: true,
            cancelled: false,
            value: selected.name,
            source: 'picked-file',
            name: selected.name,
            mimeType: selected.type || 'application/octet-stream',
            sizeBytes: selected.size,
          }));
          return;
        }

        finish(dict({ ok: Boolean(input.value.trim()), cancelled: !input.value.trim(), value: input.value.trim(), source: 'url' }));
      });
      actions.append(cancel, submit);
      ui.panel.append(input, file, actions);
      return;
    }

    const input = document.createElement('input');
    input.type = request.kind === 'PROMPT_NUMBER' ? 'number' : 'text';
    input.placeholder = request.placeholder ?? '';
    input.value = request.defaultValue ?? '';
    if (request.minValue !== undefined) {
      input.min = String(request.minValue);
    }
    if (request.maxValue !== undefined) {
      input.max = String(request.maxValue);
    }
    input.style.cssText = 'width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:9px 10px;margin-bottom:14px';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
    const cancel = ui.close;
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.textContent = 'Submit';
    submit.style.cssText = 'border:0;background:#0f172a;color:white;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer';
    cancel.addEventListener('click', () => finish(dict({ ok: false, cancelled: true, value: null, source: 'user' })));
    submit.addEventListener('click', () => {
      const value = request.kind === 'PROMPT_NUMBER' ? Number(input.value) : input.value;
      const valid = request.kind !== 'PROMPT_NUMBER' || Number.isFinite(value);
      finish(dict({ ok: valid, cancelled: false, value: valid ? value : null, source: 'user', error: valid ? '' : 'Not a valid number' }));
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        submit.click();
      }
    });
    actions.append(cancel, submit);
    ui.panel.append(input, actions);
    input.focus();
  });
}

function runOverlayInputCapture(request: Extract<ContentRuntimeMessage, { type: typeof CONTENT_DISPLAY_MESSAGE }>['request']): Promise<GraphValue> {
  const ui = overlayShell();
  const start = performance.now();
  const events: Array<Record<string, unknown>> = [];
  const pressed = new Set<string>();
  let lastPointer: { x: number; y: number; buttons: number } | null = null;

  const title = document.createElement('div');
  title.textContent = request.message || 'Overlay input capture';
  title.style.cssText = 'font-size:16px;font-weight:700;margin-bottom:10px';
  const instructions = document.createElement('p');
  instructions.textContent = [
    request.captureKeyboard ? 'Keyboard is captured.' : '',
    request.captureMouse ? 'Mouse is captured inside this panel.' : '',
    'Close or press Escape to finish.',
  ].filter(Boolean).join(' ');
  instructions.style.cssText = 'margin:0 0 12px;color:#475569;font-size:13px';
  const target = document.createElement('div');
  target.tabIndex = 0;
  target.style.cssText = [
    'min-height:220px',
    'border:1px dashed #94a3b8',
    'border-radius:10px',
    'background:#f8fafc',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'text-align:center',
    'padding:18px',
    'outline:none',
    'color:#334155',
    'font-weight:700',
  ].join(';');
  target.textContent = 'Press keys or move/click the mouse here.';
  ui.panel.append(title, instructions, target, ui.close);
  target.focus();

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId = 0;
    const addEvent = (event: Record<string, unknown>) => {
      if (events.length >= 200) {
        return;
      }
      events.push({
        ...event,
        t: Math.round(performance.now() - start),
      });
    };

    const finish = (finishReason: string) => {
      if (settled) {
        return;
      }
      settled = true;
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('keyup', keyUp, true);
      target.removeEventListener('pointermove', pointerMove);
      target.removeEventListener('pointerdown', pointerDown);
      target.removeEventListener('pointerup', pointerUp);
      window.clearTimeout(timeoutId);
      ui.cleanup();
      resolve(dict({
        ok: true,
        cancelled: finishReason === 'closed' || finishReason === 'escape',
        reason: finishReason,
        durationSeconds: Math.round((performance.now() - start) / 100) / 10,
        events,
        keys: Array.from(pressed),
        pointer: lastPointer,
        keyboardCaptured: Boolean(request.captureKeyboard),
        mouseCaptured: Boolean(request.captureMouse),
      }));
    };

    const keyDown = (event: KeyboardEvent) => {
      if (!request.captureKeyboard || settled) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        finish('escape');
        return;
      }
      pressed.add(event.key);
      addEvent({ type: 'keydown', key: event.key, code: event.code });
    };

    const keyUp = (event: KeyboardEvent) => {
      if (!request.captureKeyboard || settled) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      pressed.delete(event.key);
      addEvent({ type: 'keyup', key: event.key, code: event.code });
    };

    const pointerMove = (event: PointerEvent) => {
      if (!request.captureMouse || settled) {
        return;
      }
      const rect = target.getBoundingClientRect();
      lastPointer = {
        x: Math.round(event.clientX - rect.left),
        y: Math.round(event.clientY - rect.top),
        buttons: event.buttons,
      };
      addEvent({ type: 'pointermove', ...lastPointer });
    };

    const pointerDown = (event: PointerEvent) => {
      if (!request.captureMouse || settled) {
        return;
      }
      event.preventDefault();
      const rect = target.getBoundingClientRect();
      lastPointer = {
        x: Math.round(event.clientX - rect.left),
        y: Math.round(event.clientY - rect.top),
        buttons: event.buttons,
      };
      addEvent({ type: 'pointerdown', button: event.button, ...lastPointer });
    };

    const pointerUp = (event: PointerEvent) => {
      if (!request.captureMouse || settled) {
        return;
      }
      event.preventDefault();
      const rect = target.getBoundingClientRect();
      lastPointer = {
        x: Math.round(event.clientX - rect.left),
        y: Math.round(event.clientY - rect.top),
        buttons: event.buttons,
      };
      addEvent({ type: 'pointerup', button: event.button, ...lastPointer });
    };

    ui.close.addEventListener('click', () => finish('closed'));
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('keyup', keyUp, true);
    target.addEventListener('pointermove', pointerMove);
    target.addEventListener('pointerdown', pointerDown);
    target.addEventListener('pointerup', pointerUp);
    if (request.timeoutMs) {
      timeoutId = window.setTimeout(() => finish('timeout'), request.timeoutMs);
    }
  });
}

async function handleDisplay(message: Extract<ContentRuntimeMessage, { type: typeof CONTENT_DISPLAY_MESSAGE }>): Promise<GraphValue> {
  const { request } = message;
  if (request.type === 'input-capture') {
    return runOverlayInputCapture(request);
  }

  const ui = overlayShell();
  const start = performance.now();
  const title = document.createElement('div');
  title.textContent = request.message || 'URL Alchemist';
  title.style.cssText = 'font-size:16px;font-weight:700;margin-bottom:12px;white-space:pre-wrap';
  ui.panel.append(title);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason: string, media?: HTMLMediaElement) => {
      if (settled) {
        return;
      }
      settled = true;
      const stoppedAt = media?.currentTime ?? 0;
      const duration = Number.isFinite(media?.duration) ? media!.duration : 0;
      const completed = reason === 'ended' || (duration > 0 && stoppedAt >= duration - 0.25);
      ui.cleanup();
      resolve(dict({
        ok: true,
        completed,
        cancelled: reason === 'closed',
        stoppedAtSeconds: stoppedAt,
        durationSeconds: duration,
        watchedPercent: duration > 0 ? Math.min(100, Math.round((stoppedAt / duration) * 100)) : 0,
        reason,
      }));
    };

    const url = assetUrl(request.asset);
    if (request.type === 'image') {
      const image = document.createElement('img');
      image.alt = request.message || 'URL Alchemist image';
      image.src = url;
      image.style.cssText = 'display:block;max-width:100%;max-height:70vh;margin:auto;border-radius:8px';
      ui.panel.append(image);
      if (request.stopMode === 'CLICK') {
        image.style.cursor = 'pointer';
        image.addEventListener('click', () => finish('clicked'));
      }
      if (request.stopMode === 'TIMEOUT' && request.timeoutMs) {
        window.setTimeout(() => finish('timeout'), request.timeoutMs);
      }
      ui.close.addEventListener('click', () => finish('closed'));
      ui.panel.append(ui.close);
      return;
    }

    if (request.type === 'video' || request.type === 'sound') {
      const media = request.type === 'video' ? document.createElement('video') : document.createElement('audio');
      media.src = url;
      media.controls = true;
      media.autoplay = true;
      media.style.cssText = request.type === 'video' ? 'display:block;width:100%;max-height:70vh;border-radius:8px;background:#020617' : 'display:block;width:100%';
      media.addEventListener('ended', () => finish('ended', media));
      ui.close.addEventListener('click', () => finish('closed', media));
      ui.panel.append(media, ui.close);
      void media.play().catch(() => undefined);
      return;
    }

    const body = document.createElement('p');
    body.textContent = request.message;
    body.style.cssText = 'white-space:pre-wrap;margin:0;color:#334155';
    ui.close.addEventListener('click', () => finish('closed'));
    ui.panel.append(body, ui.close);
    if (request.timeoutMs) {
      window.setTimeout(() => finish('timeout'), Math.max(0, request.timeoutMs - (performance.now() - start)));
    }
  });
}

function mutateText(value: GraphValue): GraphValue {
  const replacement = typeof value.value === 'string' ? value.value : JSON.stringify(value.value);
  if (!document.body || !replacement) {
    return dict({ ok: false, changed: 0, error: 'No page body or replacement text' });
  }

  let changed = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.trim()) {
      nodes.push(node as Text);
    }
  }
  nodes.slice(0, 2000).forEach((node) => {
    node.textContent = replacement;
    changed += 1;
  });
  return dict({ ok: true, changed, source: 'pageText' });
}

function readPageSource(source: string): GraphValue {
  if (source === 'pageText') {
    return { type: 'string', value: document.body?.innerText ?? '' };
  }

  if (source === 'rawHtml') {
    return { type: 'string', value: document.documentElement.outerHTML };
  }

  if (source === 'pageLinks') {
    return {
      type: 'data',
      value: Array.from(document.links, (link) => ({
        href: link.href,
        text: link.textContent?.trim() ?? '',
      })).slice(0, 1000),
    };
  }

  if (source === 'pageMetadata') {
    return dict({
      title: document.title,
      url: window.location.href,
      language: document.documentElement.lang,
    });
  }

  return { type: 'string', value: '' };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isContentRuntimeMessage(message)) {
    return;
  }

  const run = async (): Promise<RuntimeResponse<GraphValue>> => {
    try {
      if (message.type === CONTENT_INTERACTION_MESSAGE) {
        return { ok: true, data: await handleInteraction(message) };
      }
      if (message.type === CONTENT_DISPLAY_MESSAGE) {
        return { ok: true, data: await handleDisplay(message) };
      }
      if (message.type === CONTENT_MUTATE_TEXT_MESSAGE) {
        return { ok: true, data: mutateText(message.value) };
      }
      if (message.type === CONTENT_READ_SOURCE_MESSAGE) {
        return { ok: true, data: readPageSource(message.source) };
      }
      return { ok: false, error: 'Unsupported content runtime message' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  void run().then(sendResponse);
  return true;
});

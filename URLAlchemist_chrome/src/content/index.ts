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

function runSpaceDefender(request: Extract<ContentRuntimeMessage, { type: typeof CONTENT_DISPLAY_MESSAGE }>['request']): Promise<GraphValue> {
  const ui = overlayShell();
  const start = performance.now();
  ui.panel.style.cssText = [
    'width:min(780px,calc(100vw - 24px))',
    'max-height:calc(100vh - 24px)',
    'overflow:hidden',
    'background:#020617',
    'border:1px solid rgba(148,163,184,0.4)',
    'border-radius:12px',
    'box-shadow:0 24px 80px rgba(15,23,42,0.45)',
    'padding:14px',
    'color:#e2e8f0',
  ].join(';');
  ui.root.style.background = 'rgba(2,6,23,0.72)';

  const title = document.createElement('div');
  title.textContent = request.message || 'Space Defender';
  title.style.cssText = 'font-size:15px;font-weight:800;margin-bottom:8px;color:#f8fafc';
  const status = document.createElement('div');
  status.textContent = 'Arrow keys or mouse move, Space or click to fire, Escape closes.';
  status.style.cssText = 'font-size:12px;margin-bottom:10px;color:#94a3b8';
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 420;
  canvas.tabIndex = 0;
  canvas.style.cssText = 'display:block;width:100%;aspect-ratio:12/7;background:#030712;border:1px solid #1e293b;border-radius:10px;outline:none';
  const close = ui.close;
  close.style.cssText = 'margin-top:10px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer';
  ui.panel.append(title, status, canvas, close);
  canvas.focus();

  const context = canvas.getContext('2d');
  if (!context) {
    ui.cleanup();
    return Promise.resolve(dict({ ok: false, cancelled: true, reason: 'canvas-unavailable' }));
  }

  type Shot = { x: number; y: number; dy: number; enemy: boolean };
  type Invader = { x: number; y: number; alive: boolean };
  const keys = new Set<string>();
  const shots: Shot[] = [];
  const invaders: Invader[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 9; col += 1) {
      invaders.push({ x: 92 + col * 58, y: 62 + row * 42, alive: true });
    }
  }

  let playerX = canvas.width / 2;
  let invaderDirection = 1;
  let score = 0;
  let lives = 3;
  let lastShot = 0;
  let lastEnemyShot = 0;
  let lastFrame = performance.now();
  let animation = 0;
  let settled = false;
  let reason = 'closed';

  return new Promise((resolve) => {
    const finish = (finishReason: string) => {
      if (settled) {
        return;
      }
      settled = true;
      reason = finishReason;
      cancelAnimationFrame(animation);
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('keyup', keyUp, true);
      canvas.removeEventListener('pointermove', pointerMove);
      canvas.removeEventListener('pointerdown', pointerDown);
      ui.cleanup();
      resolve(dict({
        ok: true,
        completed: finishReason === 'won',
        cancelled: finishReason === 'closed' || finishReason === 'escape',
        score,
        lives,
        reason,
        durationSeconds: Math.round((performance.now() - start) / 100) / 10,
        keyboardCaptured: Boolean(request.captureKeyboard),
        mouseCaptured: Boolean(request.captureMouse),
      }));
    };

    const fire = () => {
      const now = performance.now();
      if (now - lastShot < 220) {
        return;
      }
      lastShot = now;
      shots.push({ x: playerX, y: 356, dy: -430, enemy: false });
    };

    const keyDown = (event: KeyboardEvent) => {
      if (!request.captureKeyboard || settled) {
        return;
      }
      if (['ArrowLeft', 'ArrowRight', ' ', 'Spacebar', 'Space', 'Escape'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (event.key === 'Escape') {
        finish('escape');
        return;
      }
      if (event.key === ' ' || event.key === 'Spacebar' || event.key === 'Space') {
        fire();
      }
      keys.add(event.key);
    };

    const keyUp = (event: KeyboardEvent) => {
      keys.delete(event.key);
    };

    const pointerMove = (event: PointerEvent) => {
      if (!request.captureMouse) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      playerX = Math.max(24, Math.min(canvas.width - 24, ((event.clientX - rect.left) / rect.width) * canvas.width));
    };

    const pointerDown = (event: PointerEvent) => {
      if (!request.captureMouse) {
        return;
      }
      event.preventDefault();
      fire();
    };

    const drawShip = () => {
      context.fillStyle = '#38bdf8';
      context.beginPath();
      context.moveTo(playerX, 330);
      context.lineTo(playerX - 24, 374);
      context.lineTo(playerX + 24, 374);
      context.closePath();
      context.fill();
      context.fillStyle = '#e0f2fe';
      context.fillRect(playerX - 5, 342, 10, 18);
    };

    const drawInvader = (invader: Invader) => {
      context.fillStyle = '#facc15';
      context.fillRect(invader.x - 16, invader.y - 10, 32, 18);
      context.fillStyle = '#020617';
      context.fillRect(invader.x - 9, invader.y - 5, 5, 5);
      context.fillRect(invader.x + 4, invader.y - 5, 5, 5);
      context.fillStyle = '#f97316';
      context.fillRect(invader.x - 22, invader.y + 8, 8, 8);
      context.fillRect(invader.x + 14, invader.y + 8, 8, 8);
    };

    const update = (now: number) => {
      const dt = Math.min(0.034, (now - lastFrame) / 1000);
      lastFrame = now;
      if (keys.has('ArrowLeft')) {
        playerX -= 310 * dt;
      }
      if (keys.has('ArrowRight')) {
        playerX += 310 * dt;
      }
      playerX = Math.max(24, Math.min(canvas.width - 24, playerX));

      let edgeHit = false;
      invaders.forEach((invader) => {
        if (!invader.alive) {
          return;
        }
        invader.x += invaderDirection * 34 * dt;
        edgeHit = edgeHit || invader.x > canvas.width - 38 || invader.x < 38;
      });
      if (edgeHit) {
        invaderDirection *= -1;
        invaders.forEach((invader) => {
          invader.y += 18;
        });
      }

      const living = invaders.filter((invader) => invader.alive);
      if (living.length > 0 && now - lastEnemyShot > 900) {
        lastEnemyShot = now;
        const shooter = living[Math.floor(Math.random() * living.length)];
        shots.push({ x: shooter.x, y: shooter.y + 16, dy: 220, enemy: true });
      }

      shots.forEach((shot) => {
        shot.y += shot.dy * dt;
      });

      shots.forEach((shot) => {
        if (shot.enemy) {
          if (Math.abs(shot.x - playerX) < 24 && shot.y > 324 && shot.y < 376) {
            shot.y = canvas.height + 99;
            lives -= 1;
          }
          return;
        }
        invaders.forEach((invader) => {
          if (invader.alive && Math.abs(shot.x - invader.x) < 22 && Math.abs(shot.y - invader.y) < 20) {
            invader.alive = false;
            shot.y = -99;
            score += 10;
          }
        });
      });

      for (let index = shots.length - 1; index >= 0; index -= 1) {
        if (shots[index].y < -20 || shots[index].y > canvas.height + 20) {
          shots.splice(index, 1);
        }
      }

      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#020617';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#0f172a';
      for (let x = 0; x < canvas.width; x += 48) {
        context.fillRect(x, 398, 24, 2);
      }
      context.fillStyle = '#e2e8f0';
      context.font = '16px system-ui, sans-serif';
      context.fillText(`Score ${score}`, 18, 28);
      context.fillText(`Lives ${lives}`, canvas.width - 92, 28);
      invaders.filter((invader) => invader.alive).forEach(drawInvader);
      shots.forEach((shot) => {
        context.fillStyle = shot.enemy ? '#fb7185' : '#67e8f9';
        context.fillRect(shot.x - 2, shot.y - 10, 4, 14);
      });
      drawShip();

      if (lives <= 0 || living.some((invader) => invader.y > 306)) {
        finish('lost');
        return;
      }
      if (living.length === 0) {
        finish('won');
        return;
      }
      if (request.timeoutMs && now - start > request.timeoutMs) {
        finish('timeout');
        return;
      }

      animation = requestAnimationFrame(update);
    };

    close.addEventListener('click', () => finish('closed'));
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('keyup', keyUp, true);
    canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerdown', pointerDown);
    animation = requestAnimationFrame(update);
  });
}

async function handleDisplay(message: Extract<ContentRuntimeMessage, { type: typeof CONTENT_DISPLAY_MESSAGE }>): Promise<GraphValue> {
  const { request } = message;
  if (request.type === 'arcade-game') {
    return runSpaceDefender(request);
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

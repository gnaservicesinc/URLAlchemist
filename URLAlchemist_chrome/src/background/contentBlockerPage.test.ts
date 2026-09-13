import { afterEach, expect, it, vi } from 'vitest';

class Element {
  children: Element[] = [];
  textContent = '';
  hidden = false;
  disabled = true;
  events = new Map<string, () => void>();
  classList = { add: vi.fn() };
  append(...children: Element[]) { this.children.push(...children); }
  addEventListener(name: string, callback: () => void) { this.events.set(name, callback); }
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function loadPage(tasks: string) {
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  vi.stubGlobal('document', { getElementById: get, createElement: () => new Element() });
  vi.stubGlobal('window', { location: { search: '?' + new URLSearchParams({ mode: 'challenge', tasks }) } });
  vi.stubGlobal('chrome', { storage: {} }); // no session storage
  // @ts-expect-error This production guard-page script deliberately has no TS declaration.
  await import('../../public/content-blocker.js');
  return get;
}

it('retains configured fallback challenges and gates continuation on completion', async () => {
  const get = await loadPage(JSON.stringify([{ kind: 'confirm', label: 'Read first', text: 'Proceed?' }]));
  await vi.waitFor(() => expect(get('challenge-tasks').children).toHaveLength(1));
  expect(get('continue-button').disabled).toBe(true);
  const task = get('challenge-tasks').children[0];
  expect(task.children[0].textContent).toBe('Read first');
  task.children[2].events.get('click')!();
  expect(get('continue-button').disabled).toBe(false);
});

it.each(['{invalid', '{}'])('fails closed when fallback challenge data is invalid: %s', async (tasks) => {
  const get = await loadPage(tasks);
  await vi.waitFor(() => expect(get('continue-button').hidden).toBe(true));
  expect(get('guard-message').textContent).toBe('The challenge configuration could not be loaded.');
});

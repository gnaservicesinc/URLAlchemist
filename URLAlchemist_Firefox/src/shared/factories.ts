import { getDefaultHotkey } from './hotkeys';
import type { ActionPack, Activity } from './types';

export function createActivity(order: number): Activity {
  return {
    id: crypto.randomUUID(),
    order,
    action: 'SUBSTITUTE',
    pattern: '',
    match_mode: 'STANDARD',
    nth_occurrence: 1,
    payload: '',
    payload_vars: false,
  };
}

export function createPack(): ActionPack {
  return {
    id: crypto.randomUUID(),
    name: 'Untitled Pack',
    version: 1,
    enabled: true,
    metadata: {
      created_at: Date.now(),
      author: '',
      description: '',
    },
    trigger: {
      type: 'ALWAYS',
      hotkey: getDefaultHotkey(),
      scope_regex: '',
    },
    activities: [createActivity(1)],
  };
}

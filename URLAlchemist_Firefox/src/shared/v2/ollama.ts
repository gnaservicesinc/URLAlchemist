import type { GlobalSettings, WorkspaceTriggerType } from '../types';
import { BLOCK_DEFINITIONS } from './blockRegistry';
import { createDefaultWorkspace } from './workspace';
import type { WorkspaceFileV2 } from './types';

const OLLAMA_TRIGGER_TYPES = ['INPUT_DATA', 'HOTKEY', 'CONTEXT_MENU', 'INTERVAL', 'CONDITIONAL', 'NEVER'] as const;
const OLLAMA_DRAFT_KEYS = new Set(['name', 'description', 'trigger']);

export function validateOllamaEndpoint(rawEndpoint: string): string {
  let url: URL;
  try {
    url = new URL(rawEndpoint);
  } catch {
    throw new Error('Ollama endpoint must be a valid URL.');
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error('Ollama endpoint must be local, for example http://127.0.0.1:11434.');
  }

  url.username = '';
  url.password = '';
  url.hash = '';
  url.pathname = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

export interface OllamaWorkspaceDraft {
  name?: string;
  description?: string;
  trigger?: WorkspaceTriggerType;
}

export interface OllamaModelSummary {
  name: string;
  model?: string;
  modifiedAt?: string;
  size?: number;
  digest?: string;
}

export function workspaceFromOllamaDraft(draft: OllamaWorkspaceDraft, base: WorkspaceFileV2 = createDefaultWorkspace()): WorkspaceFileV2 {
  const now = Date.now();
  return {
    ...base,
    metadata: {
      ...base.metadata,
      name: typeof draft.name === 'string' && draft.name.trim() ? draft.name.trim().slice(0, 200) : base.metadata.name,
      description: typeof draft.description === 'string' ? draft.description.slice(0, 4096) : base.metadata.description,
      updated_at: now,
    },
    trigger: {
      ...base.trigger,
      type: draft.trigger && OLLAMA_TRIGGER_TYPES.includes(draft.trigger)
        ? draft.trigger
        : base.trigger.type,
    },
  };
}

function validateOllamaModelsResponse(value: unknown): OllamaModelSummary[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Ollama returned an invalid model list.');
  }

  const models = (value as { models?: unknown }).models;
  if (!Array.isArray(models)) {
    throw new Error('Ollama returned an invalid model list.');
  }

  const summaries: OllamaModelSummary[] = [];
  models.forEach((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return;
    }

    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' && record.name.trim()
      ? record.name.trim()
      : typeof record.model === 'string' && record.model.trim()
        ? record.model.trim()
        : '';
    if (!name) {
      return;
    }

    summaries.push({
      name,
      model: typeof record.model === 'string' ? record.model : undefined,
      modifiedAt: typeof record.modified_at === 'string' ? record.modified_at : undefined,
      size: typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : undefined,
      digest: typeof record.digest === 'string' ? record.digest : undefined,
    });
  });
  return summaries;
}

export async function listOllamaModels(
  settings: Pick<GlobalSettings, 'ollamaEndpoint' | 'ollamaTimeoutMs'>,
): Promise<OllamaModelSummary[]> {
  const endpoint = `${validateOllamaEndpoint(settings.ollamaEndpoint)}/api/tags`;
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), Math.max(1_000, Math.min(120_000, settings.ollamaTimeoutMs)));
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Ollama model list failed with HTTP ${response.status}. Confirm the local Ollama server is running.`);
    }

    return validateOllamaModelsResponse(await response.json());
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Ollama model list timed out. Confirm the local Ollama server is running.');
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function validateOllamaDraft(value: unknown): OllamaWorkspaceDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Ollama returned an invalid workspace draft.');
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!OLLAMA_DRAFT_KEYS.has(key)) {
      throw new Error(`Ollama returned unsupported recipe key "${key}".`);
    }
  }

  const draft: OllamaWorkspaceDraft = {};
  if (typeof record.name === 'string' && record.name.trim()) {
    draft.name = record.name.trim().slice(0, 200);
  }
  if (typeof record.description === 'string') {
    draft.description = record.description.slice(0, 4096);
  }
  if (typeof record.trigger === 'string' && OLLAMA_TRIGGER_TYPES.includes(record.trigger as WorkspaceTriggerType)) {
    draft.trigger = record.trigger as WorkspaceTriggerType;
  }
  return draft;
}

function blockCatalogSummary(): string {
  return BLOCK_DEFINITIONS
    .map((definition) => `${definition.kind}: ${definition.label} [${definition.category}]`)
    .join('\n');
}

export async function requestOllamaWorkspaceDraft(
  settings: Pick<GlobalSettings, 'ollamaEndpoint' | 'ollamaModel' | 'ollamaTimeoutMs'>,
  prompt: string,
  currentWorkspace: WorkspaceFileV2,
): Promise<OllamaWorkspaceDraft> {
  const endpoint = `${validateOllamaEndpoint(settings.ollamaEndpoint)}/api/generate`;
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), Math.max(1_000, Math.min(120_000, settings.ollamaTimeoutMs)));
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.ollamaModel,
        stream: false,
        format: 'json',
        prompt: [
          'Return only strict JSON with optional keys: name, description, trigger.',
          'Do not include JavaScript, code execution, HTML, or markdown.',
          'This is a planning recipe only. The extension will validate and apply it deterministically.',
          `Available blocks:\n${blockCatalogSummary()}`,
          `Current workspace name: ${currentWorkspace.metadata.name}`,
          `Current trigger: ${currentWorkspace.trigger.type}`,
          `User request: ${prompt}`,
        ].join('\n'),
      }),
    });
    if (!response.ok) {
      throw new Error(`Ollama request failed with HTTP ${response.status}`);
    }

    const body = await response.json() as { response?: unknown };
    const text = typeof body.response === 'string' ? body.response : '{}';
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Ollama returned an invalid workspace draft.');
    }
    return validateOllamaDraft(parsed);
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

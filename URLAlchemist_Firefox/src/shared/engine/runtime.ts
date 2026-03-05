import type { RegexTransformRequest } from '../types';

export interface RegexExecutor {
  test(input: string, pattern: string): Promise<boolean>;
  transform(request: Omit<RegexTransformRequest, 'kind'>): Promise<{
    matched: boolean;
    result: string;
  }>;
}

export interface EngineRuntime {
  regex: RegexExecutor;
  readClipboard: () => Promise<string>;
  now?: () => Date;
}

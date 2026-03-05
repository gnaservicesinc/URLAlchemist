import type { RegexJobRequest, RegexJobResponse } from '../types';

export interface RegexWorkerRequestEnvelope {
  id: string;
  request: RegexJobRequest;
}

export type RegexWorkerResponseEnvelope =
  | {
      id: string;
      ok: true;
      response: RegexJobResponse;
    }
  | {
      id: string;
      ok: false;
      error: string;
    };

export type ApiErrorKind =
  | 'invalid-url'
  | 'mixed-content'
  | 'unreachable'
  | 'cors'
  | 'timeout'
  | 'auth'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'server'
  | 'http'
  | 'bad-response'
  | 'session'
  | 'upstream-auth';

export interface ApiErrorInit {
  kind: ApiErrorKind;
  title: string;
  hint: string;
  status?: number;
  detail?: string;
}

/** Error with a short title, an actionable hint, and a machine-readable kind. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly hint: string;
  readonly status?: number;
  readonly detail?: string;

  constructor(init: ApiErrorInit) {
    super(init.title);
    this.name = 'ApiError';
    this.kind = init.kind;
    this.hint = init.hint;
    this.status = init.status;
    this.detail = init.detail;
  }
}

export function describeError(err: unknown): { title: string; hint: string; kind?: ApiErrorKind } {
  if (err instanceof ApiError) return { title: err.message, hint: err.hint, ...(err.kind === 'session' ? { kind: err.kind } : {}) };
  return { title: err instanceof Error ? err.message : 'Something went wrong', hint: '' };
}

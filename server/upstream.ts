/**
 * Fixed whitelist of Overseerr calls. Every upstream URL and body is rebuilt here from
 * validated values; nothing from the browser request is forwarded verbatim.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface UpstreamCall {
  method: 'GET' | 'POST';
  /** Path + query relative to `<OVERSEERR_URL>/api/v1`. */
  path: string;
  body?: string;
  /** auth/me responses are reduced to a few non-sensitive fields. */
  pickUser?: boolean;
  /** Title detail responses are reduced to id + title/name. */
  pickTitle?: boolean;
}

const FILTERS = new Set(['all', 'available', 'partial', 'allavailable', 'processing', 'pending']);

function int(raw: unknown, name: string, min: number, max: number, dflt?: number): number {
  if (raw === undefined && dflt !== undefined) return dflt;
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) throw new RouteError(400, 'bad-request', `Invalid ${name}.`);
  const n = Number(raw);
  if (n < min || n > max) throw new RouteError(400, 'bad-request', `Invalid ${name}.`);
  return n;
}

function onlyQuery(query: Record<string, unknown>, allowed: string[]) {
  for (const k of Object.keys(query)) if (!allowed.includes(k)) throw new RouteError(400, 'bad-request', 'Unexpected query parameter.');
}

function requestBody(body: unknown): string {
  const bad = () => new RouteError(400, 'bad-request', 'Invalid request body.');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad();
  const b = body as Record<string, unknown>;
  const { mediaType, mediaId, seasons } = b;
  const extra = Object.keys(b).filter((k) => !['mediaType', 'mediaId', 'seasons'].includes(k));
  if (extra.length) throw bad();
  if (typeof mediaId !== 'number' || !Number.isInteger(mediaId) || mediaId < 1 || mediaId > 999_999_999) throw bad();
  if (mediaType === 'movie') {
    if (seasons !== undefined) throw bad();
    return JSON.stringify({ mediaType: 'movie', mediaId });
  }
  if (mediaType === 'tv') {
    // The app only ever requests season 1 of a show.
    if (seasons !== undefined && !(Array.isArray(seasons) && seasons.length === 1 && seasons[0] === 1)) throw bad();
    return JSON.stringify({ mediaType: 'tv', mediaId, seasons: [1] });
  }
  throw bad();
}

/** `path` is relative to /api/v1 (e.g. "/media"). Throws RouteError for anything off-whitelist. */
export function resolveRoute(method: string, path: string, query: Record<string, unknown>, body: unknown): UpstreamCall {
  let m: RegExpExecArray | null;
  if (path === '/auth/me') {
    if (method !== 'GET') throw new RouteError(405, 'method-not-allowed', 'Method not allowed.');
    onlyQuery(query, []);
    return { method: 'GET', path: '/auth/me', pickUser: true };
  }
  if (path === '/media') {
    if (method !== 'GET') throw new RouteError(405, 'method-not-allowed', 'Method not allowed.');
    onlyQuery(query, ['filter', 'take', 'skip']);
    const filter = query.filter;
    if (typeof filter !== 'string' || !FILTERS.has(filter)) throw new RouteError(400, 'bad-request', 'Invalid filter.');
    const take = int(query.take, 'take', 1, 100, 20);
    const skip = int(query.skip, 'skip', 0, 1_000_000, 0);
    return { method: 'GET', path: `/media?filter=${filter}&take=${take}&skip=${skip}` };
  }
  if ((m = /^\/(movie|tv)\/(\d{1,9})\/(recommendations|similar)$/.exec(path))) {
    if (method !== 'GET') throw new RouteError(405, 'method-not-allowed', 'Method not allowed.');
    onlyQuery(query, ['page']);
    const id = Number(m[2]);
    if (id < 1) throw new RouteError(400, 'bad-request', 'Invalid id.');
    const page = int(query.page, 'page', 1, 500, 1);
    return { method: 'GET', path: `/${m[1]}/${id}/${m[3]}?page=${page}` };
  }
  if ((m = /^\/(movie|tv)\/(\d{1,9})$/.exec(path))) {
    if (method !== 'GET') throw new RouteError(405, 'method-not-allowed', 'Method not allowed.');
    onlyQuery(query, []);
    const id = Number(m[2]);
    if (id < 1) throw new RouteError(400, 'bad-request', 'Invalid id.');
    return { method: 'GET', path: `/${m[1]}/${id}`, pickTitle: true };
  }
  if (path === '/request') {
    if (method !== 'POST') throw new RouteError(405, 'method-not-allowed', 'Method not allowed.');
    onlyQuery(query, []);
    return { method: 'POST', path: '/request', body: requestBody(body) };
  }
  throw new RouteError(404, 'not-found', 'Not found.');
}

export interface ProxyResult {
  status: number;
  json: Record<string, unknown> | unknown[];
}

const err = (status: number, code: string, message: string): ProxyResult => ({ status, json: { code, message } });

export async function callUpstream(
  call: UpstreamCall,
  cfg: { overseerrUrl: string; apiKey: string; timeoutMs: number },
  fetchImpl: FetchLike,
): Promise<ProxyResult> {
  const redact = (s: string) => (cfg.apiKey ? s.split(cfg.apiKey).join('[redacted]') : s);
  const headers: Record<string, string> = { 'X-Api-Key': cfg.apiKey, Accept: 'application/json' };
  if (call.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
  let text: string;
  try {
    res = await fetchImpl(`${cfg.overseerrUrl}/api/v1${call.path}`, {
      method: call.method,
      headers,
      body: call.body,
      redirect: 'manual',
      signal: ctl.signal,
    });
    text = await res.text();
  } catch (e) {
    if (ctl.signal.aborted) return err(504, 'upstream-timeout', 'Overseerr did not answer in time.');
    void e; // deliberately not logged or echoed: may embed the upstream URL
    return err(502, 'upstream-unreachable', 'The app server could not reach Overseerr. Check OVERSEERR_URL and the Tailscale connection.');
  } finally {
    clearTimeout(timer);
  }

  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = undefined;
  }
  const detail = (): string | undefined => {
    const msg = (parsed as { message?: unknown } | undefined)?.message;
    return typeof msg === 'string' ? redact(msg).slice(0, 300) : undefined;
  };

  const s = res.status;
  if (s === 401) {
    return err(502, 'upstream-auth', 'Overseerr rejected the server-side API key (OVERSEERR_API_KEY).');
  }
  if (s === 403) return err(403, 'upstream-forbidden', detail() ?? 'Overseerr denied that request.');
  if (s === 404) return err(404, 'upstream-not-found', detail() ?? 'Overseerr could not find that.');
  if (s === 409) return err(409, 'upstream-conflict', detail() ?? 'Already requested.');
  if (s >= 300 && s < 400) return err(502, 'upstream-redirect', 'Overseerr answered with a redirect; check OVERSEERR_URL.');
  if (s >= 400 && s < 500) return err(s, 'upstream-rejected', detail() ?? 'Overseerr rejected the request.');
  if (s >= 500) return err(502, 'upstream-error', `Overseerr failed with status ${s}.`);
  if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
    return err(502, 'upstream-bad-response', 'Overseerr did not return JSON; check OVERSEERR_URL.');
  }

  if (call.pickUser) {
    const u = parsed as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of ['id', 'email', 'displayName', 'username', 'plexUsername', 'jellyfinUsername']) if (u[k] !== undefined) out[k] = u[k];
    return { status: 200, json: out };
  }
  if (call.pickTitle) {
    const d = parsed as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (typeof d.id === 'number') out.id = d.id;
    for (const k of ['title', 'name']) if (typeof d[k] === 'string') out[k] = redact(d[k] as string).slice(0, 300);
    return { status: 200, json: out };
  }
  return { status: 200, json: JSON.parse(redact(JSON.stringify(parsed))) };
}

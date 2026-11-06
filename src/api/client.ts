import { ApiError } from './errors';
import type { MediaFilter, MediaPage, MediaType, ResultsPage, UserInfo } from './types';

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  /**
   * Server mode: talk to this app's own same-origin /api/v1 proxy with the login
   * session cookie. No URL or API key is used or sent; the server holds them.
   */
  sameOrigin?: boolean;
  fetchImpl?: typeof fetch;
  /** Protocol of the page making the calls; defaults to location.protocol. */
  pageProtocol?: string;
  timeoutMs?: number;
}

export interface OverseerrClient {
  getMe(): Promise<UserInfo>;
  getMediaPage(filter: MediaFilter, take: number, skip: number): Promise<MediaPage>;
  getTitles(type: MediaType, id: number, kind: 'recommendations' | 'similar', page: number): Promise<ResultsPage>;
  requestTitle(type: MediaType, id: number): Promise<unknown>;
}

/** Trim, drop trailing slashes and a pasted /api/v1 suffix; validate http(s). */
export function normalizeBaseUrl(input: string): string {
  const raw = input.trim();
  if (!raw) {
    throw new ApiError({ kind: 'invalid-url', title: 'Server URL is empty', hint: 'Enter the address of your Overseerr or Jellyseerr, e.g. https://overseerr.your-tailnet.ts.net' });
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ApiError({ kind: 'invalid-url', title: 'That is not a valid URL', hint: 'Include the scheme, e.g. https://overseerr.your-tailnet.ts.net' });
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ApiError({ kind: 'invalid-url', title: 'URL must start with http:// or https://', hint: 'Use the address you open in your browser.' });
  }
  const path = u.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  return `${u.origin}${path}`;
}

function isPotentiallyTrustworthy(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';
}

export function createClient(opts: ClientOptions): OverseerrClient {
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? 20000;
  const pageProtocol = opts.pageProtocol ?? (typeof location !== 'undefined' ? location.protocol : 'https:');

  async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await run(ctl.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = opts.sameOrigin ? `/api/v1${path}` : `${normalizeBaseUrl(opts.baseUrl)}/api/v1${path}`;
    const parsed = opts.sameOrigin ? null : new URL(url);
    if (parsed && pageProtocol === 'https:' && parsed.protocol === 'http:' && !isPotentiallyTrustworthy(parsed.hostname)) {
      throw new ApiError({
        kind: 'mixed-content',
        title: 'Browser blocks http:// from this https:// page',
        hint: 'This page is served over HTTPS, so the browser refuses plain-HTTP servers. Put your Overseerr behind an HTTPS reverse proxy (see the README: Caddy + tailscale serve) and use its https:// URL.',
      });
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (!opts.sameOrigin) headers['X-Api-Key'] = opts.apiKey;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await withTimeout((signal) =>
        fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: opts.sameOrigin ? 'same-origin' : 'omit',
          signal,
        }),
      );
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e instanceof DOMException && e.name === 'AbortError') {
        throw new ApiError({ kind: 'timeout', title: 'The server took too long to respond', hint: `No answer within ${Math.round(timeoutMs / 1000)}s. Check that the server and your VPN/tailnet are up.` });
      }
      if (opts.sameOrigin) {
        throw new ApiError({ kind: 'unreachable', title: 'Could not reach the app server', hint: 'The server may be waking up or restarting. Wait a few seconds and try again.' });
      }
      throw await classifyNetworkFailure(url);
    }

    if (!res.ok) throw await httpError(res, method, path);
    try {
      return (await res.json()) as T;
    } catch {
      throw new ApiError({
        kind: 'bad-response',
        title: 'The server did not return JSON',
        hint: 'The URL probably points at something other than Overseerr/Jellyseerr (or a login page). Use the base address, without /api/v1.',
        status: res.status,
      });
    }
  }

  /** fetch() only says "TypeError"; a no-cors probe tells CORS apart from "unreachable". */
  async function classifyNetworkFailure(url: string): Promise<ApiError> {
    let reachable = false;
    try {
      await withTimeout((signal) => fetchImpl(url, { mode: 'no-cors', credentials: 'omit', signal }));
      reachable = true;
    } catch {
      /* unreachable */
    }
    if (reachable) {
      return new ApiError({
        kind: 'cors',
        title: 'Server reachable, but the browser blocked the response (CORS)',
        hint: 'Overseerr and Jellyseerr do not send CORS headers themselves. Front them with a reverse proxy that allows this page\'s origin and the X-Api-Key, Content-Type and Accept headers, and answers OPTIONS preflights. See the README for the Caddy config.',
      });
    }
    return new ApiError({
      kind: 'unreachable',
      title: 'Could not reach the server',
      hint: 'Check the URL, that the server is running, and that this device is connected to your tailnet/VPN. An untrusted TLS certificate also shows up as this error.',
    });
  }

  async function httpError(res: Response, method: string, path: string): Promise<ApiError> {
    let detail: string | undefined;
    let code: string | undefined;
    try {
      const j = (await res.json()) as { message?: unknown; code?: unknown };
      if (typeof j?.message === 'string') detail = j.message;
      if (typeof j?.code === 'string') code = j.code;
    } catch {
      /* no body */
    }
    const status = res.status;
    const base = { status, detail };
    if (opts.sameOrigin) {
      if (code === 'upstream-auth') {
        return new ApiError({ kind: 'upstream-auth', title: 'Overseerr rejected the server’s API key', hint: 'The OVERSEERR_API_KEY configured on the app server is wrong or was revoked. Update it on the server and restart; signing in again will not help.', ...base });
      }
      if (status === 401 || code === 'session') {
        return new ApiError({ kind: 'session', title: 'Your session has expired', hint: 'Sign in again to continue.', ...base });
      }
      if (code === 'upstream-forbidden') {
        return new ApiError({ kind: 'forbidden', title: detail ?? 'Overseerr denied that request', hint: 'The server’s API key user lacks permission for this, or has hit its request quota.', ...base });
      }
    }
    if (status === 401 || (status === 403 && method === 'GET')) {
      return new ApiError({ kind: 'auth', title: 'The API key was rejected', hint: 'Copy the API key from Overseerr under Settings > General and paste it again.', ...base });
    }
    if (status === 403) {
      return new ApiError({ kind: 'forbidden', title: detail ?? 'This account may not make that request', hint: 'The API key\'s user lacks the Request permission or has hit its quota.', ...base });
    }
    if (status === 404) {
      return new ApiError({ kind: 'not-found', title: `Not found: ${path}`, hint: 'Check the URL points at Overseerr/Jellyseerr itself (no extra path) and that it is a recent version.', ...base });
    }
    if (status === 409) {
      return new ApiError({ kind: 'conflict', title: detail ?? 'Already requested', hint: 'Overseerr says this title already exists or was requested.', ...base });
    }
    if (status >= 500) {
      return new ApiError({ kind: 'server', title: `Server error (${status})`, hint: detail ?? 'Overseerr failed to handle the call. Check its logs and try again.', ...base });
    }
    return new ApiError({ kind: 'http', title: `Unexpected response (${status})`, hint: detail ?? '', ...base });
  }

  return {
    getMe: () => call<UserInfo>('GET', '/auth/me'),
    getMediaPage: (filter, take, skip) => call<MediaPage>('GET', `/media?filter=${filter}&take=${take}&skip=${skip}`),
    getTitles: (type, id, kind, page) => call<ResultsPage>('GET', `/${type}/${id}/${kind}?page=${page}`),
    requestTitle: (type, id) =>
      call('POST', '/request', type === 'tv' ? { mediaType: 'tv', mediaId: id, seasons: [1] } : { mediaType: 'movie', mediaId: id }),
  };
}

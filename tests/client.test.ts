import { describe, expect, it, vi } from 'vitest';
import { createClient, normalizeBaseUrl } from '../src/api/client';
import { ApiError } from '../src/api/errors';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const opts = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) => ({
  baseUrl: 'https://overseerr.example.ts.net',
  apiKey: 'KEY',
  fetchImpl,
  pageProtocol: 'https:',
  ...extra,
});

async function kindOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return (e as ApiError).kind;
  }
  throw new Error('expected rejection');
}

describe('normalizeBaseUrl', () => {
  it('trims whitespace, trailing slashes and a pasted /api/v1 suffix', () => {
    expect(normalizeBaseUrl(' https://a.example/ ')).toBe('https://a.example');
    expect(normalizeBaseUrl('https://a.example/api/v1/')).toBe('https://a.example');
    expect(normalizeBaseUrl('https://a.example/sub')).toBe('https://a.example/sub');
  });
  it('rejects empty, non-http and malformed values', () => {
    expect(() => normalizeBaseUrl('')).toThrow(ApiError);
    expect(() => normalizeBaseUrl('ftp://x')).toThrow(ApiError);
    expect(() => normalizeBaseUrl('not a url')).toThrow(ApiError);
  });
});

describe('client requests', () => {
  it('sends X-Api-Key + Accept on GET /api/v1/auth/me', async () => {
    const f = vi.fn(async () => json({ id: 1, displayName: 'Ann' }));
    const me = await createClient(opts(f as never)).getMe();
    expect(me.displayName).toBe('Ann');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://overseerr.example.ts.net/api/v1/auth/me');
    const h = init.headers as Record<string, string>;
    expect(h['X-Api-Key']).toBe('KEY');
    expect(h['Accept']).toBe('application/json');
    expect(init.credentials).toBe('omit');
  });

  it('builds media paging, recommendations and similar URLs', async () => {
    const f = vi.fn(async () => json({ results: [] }));
    const c = createClient(opts(f as never));
    await c.getMediaPage('allavailable', 50, 100);
    await c.getTitles('movie', 7, 'recommendations', 2);
    await c.getTitles('tv', 9, 'similar', 1);
    const urls = f.mock.calls.map((x) => (x as unknown[])[0]);
    expect(urls).toEqual([
      'https://overseerr.example.ts.net/api/v1/media?filter=allavailable&take=50&skip=100',
      'https://overseerr.example.ts.net/api/v1/movie/7/recommendations?page=2',
      'https://overseerr.example.ts.net/api/v1/tv/9/similar?page=1',
    ]);
  });

  it('POSTs a movie request body', async () => {
    const f = vi.fn(async () => json({ id: 1 }));
    await createClient(opts(f as never)).requestTitle('movie', 603);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/v1\/request$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ mediaType: 'movie', mediaId: 603 });
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('POSTs a TV request for season 1', async () => {
    const f = vi.fn(async () => json({ id: 1 }));
    await createClient(opts(f as never)).requestTitle('tv', 1399);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ mediaType: 'tv', mediaId: 1399, seasons: [1] });
  });
});

describe('error classification', () => {
  it('flags http URL from https page as mixed-content without calling fetch', async () => {
    const f = vi.fn();
    const c = createClient(opts(f as never, { baseUrl: 'http://100.64.0.1:5055' }));
    expect(await kindOf(c.getMe())).toBe('mixed-content');
    expect(f).not.toHaveBeenCalled();
  });

  it('allows http://localhost from an https page (potentially trustworthy)', async () => {
    const f = vi.fn(async () => json({ id: 1 }));
    await createClient(opts(f as never, { baseUrl: 'http://localhost:5055' })).getMe();
    expect(f).toHaveBeenCalled();
  });

  it('allows http when the page itself is http', async () => {
    const f = vi.fn(async () => json({ id: 1 }));
    await createClient(opts(f as never, { baseUrl: 'http://box:5055', pageProtocol: 'http:' })).getMe();
    expect(f).toHaveBeenCalled();
  });

  it('network failure + no-cors probe also failing => unreachable', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await kindOf(createClient(opts(f as never)).getMe())).toBe('unreachable');
  });

  it('network failure but no-cors probe succeeds => cors', async () => {
    let n = 0;
    const f = vi.fn(async (_u: string, init?: RequestInit) => {
      n++;
      if (init?.mode === 'no-cors') return new Response('', { status: 200 });
      throw new TypeError('Failed to fetch');
    });
    expect(await kindOf(createClient(opts(f as never)).getMe())).toBe('cors');
    expect(n).toBe(2);
  });

  it('maps 401/403 to auth on reads', async () => {
    for (const s of [401, 403]) {
      const f = async () => json({ message: 'nope' }, s);
      expect(await kindOf(createClient(opts(f as never)).getMe())).toBe('auth');
    }
  });

  it('maps 403 on POST /request to forbidden with server message', async () => {
    const f = async () => json({ message: 'Quota exceeded' }, 403);
    const p = createClient(opts(f as never)).requestTitle('movie', 1);
    await expect(p).rejects.toMatchObject({ kind: 'forbidden', detail: 'Quota exceeded' });
  });

  it('maps 409, 404, 500, 418', async () => {
    const mk = (s: number) => createClient(opts((async () => json({}, s)) as never)).getMe();
    expect(await kindOf(mk(409))).toBe('conflict');
    expect(await kindOf(mk(404))).toBe('not-found');
    expect(await kindOf(mk(500))).toBe('server');
    expect(await kindOf(mk(418))).toBe('http');
  });

  it('maps HTML / non-JSON 200 to bad-response', async () => {
    const f = async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
    expect(await kindOf(createClient(opts(f as never)).getMe())).toBe('bad-response');
  });

  it('maps abort-by-timeout to timeout', async () => {
    const f = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      });
    const c = createClient(opts(f as never, { timeoutMs: 10 }));
    expect(await kindOf(c.getMe())).toBe('timeout');
  });
});

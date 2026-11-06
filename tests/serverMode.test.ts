import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/api/client';
import { ApiError } from '../src/api/errors';

const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('client in server (same-origin) mode', () => {
  it('calls relative /api/v1 with the session cookie and no API key', async () => {
    const f = vi.fn(async () => res({ id: 1 }));
    const c = createClient({ baseUrl: '', apiKey: '', sameOrigin: true, fetchImpl: f as unknown as typeof fetch });
    await c.getMe();
    await c.requestTitle('tv', 5);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/auth/me');
    expect(init.credentials).toBe('same-origin');
    expect(Object.keys(init.headers as object).map((k) => k.toLowerCase())).not.toContain('x-api-key');
    const [, post] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(post.body as string)).toEqual({ mediaType: 'tv', mediaId: 5, seasons: [1] });
  });

  it('tells a session 401 apart from an upstream key rejection', async () => {
    const mk = (r: Response) => createClient({ baseUrl: '', apiKey: '', sameOrigin: true, fetchImpl: (async () => r) as unknown as typeof fetch });
    const session = await mk(res({ code: 'session' }, 401)).getMe().catch((e) => e);
    expect(session).toBeInstanceOf(ApiError);
    expect(session.kind).toBe('session');
    const upstream = await mk(res({ code: 'upstream-auth', message: 'x' }, 502)).getMe().catch((e) => e);
    expect(upstream.kind).toBe('upstream-auth');
    expect(upstream.message).toMatch(/server/i);
  });
});

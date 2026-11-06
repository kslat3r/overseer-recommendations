import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { ConfigError, loadConfig, type ServerConfig } from '../server/config';
import { createSessionStore, createThrottle } from '../server/session';
import type { FetchLike } from '../server/upstream';

const API_KEY = 'super-secret-upstream-key-123';
const PASSWORD = 'correct horse battery staple';

const baseConfig = (over: Partial<ServerConfig> = {}): ServerConfig => ({
  overseerrUrl: 'http://overseerr.test:5055',
  apiKey: API_KEY,
  appPassword: PASSWORD,
  port: 0,
  production: false,
  trustProxy: 1,
  sessionTtlMs: 60_000,
  staticDir: '/nonexistent-static-dir',
  upstreamTimeoutMs: 1000,
  ...over,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const servers: { close(): void }[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

async function start(opts: { fetchImpl?: FetchLike; config?: Partial<ServerConfig>; now?: () => number } = {}) {
  const fetchImpl = opts.fetchImpl ?? vi.fn<FetchLike>(async () => json({ results: [] }));
  const app = createApp({ config: baseConfig(opts.config), fetchImpl, now: opts.now });
  const server = await new Promise<Server>((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const req = (path: string, init: RequestInit = {}) => fetch(base + path, { redirect: 'manual', ...init });
  return { base, req, fetchImpl: fetchImpl as ReturnType<typeof vi.fn<FetchLike>> };
}

async function login(req: Awaited<ReturnType<typeof start>>['req'], password = PASSWORD, headers: Record<string, string> = {}) {
  return req('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ password }).toString(),
  });
}

async function session(s: Awaited<ReturnType<typeof start>>) {
  const res = await login(s.req);
  expect(res.status).toBe(303);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

describe('auth gate', () => {
  it('serves only health and login without a session', async () => {
    const s = await start();
    expect((await s.req('/healthz')).status).toBe(200);
    expect(await (await s.req('/healthz')).json()).toEqual({ ok: true });
    expect((await s.req('/login')).status).toBe(200);
    expect((await s.req('/login.css')).status).toBe(200);

    const page = await s.req('/');
    expect(page.status).toBe(303);
    expect(page.headers.get('location')).toBe('/login');
    expect((await s.req('/assets/index.js')).status).toBe(303);
    for (const p of ['/api/status', '/api/v1/auth/me', '/api/v1/media?filter=all']) {
      const r = await s.req(p);
      expect(r.status).toBe(401);
      expect((await r.json()).code).toBe('session');
    }
    expect((await s.req('/api/v1/request', { method: 'POST' })).status).toBe(401);
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a bad password and accepts the good one', async () => {
    const s = await start();
    const bad = await login(s.req, 'nope');
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();
    expect(await bad.text()).toContain('Incorrect password');
    expect((await login(s.req, '')).status).toBe(401);

    const ok = await login(s.req);
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/');
    const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0];
    expect((await s.req('/api/status', { headers: { cookie } })).status).toBe(200);
  });

  it('sets httpOnly SameSite=Strict cookies, Secure only in production', async () => {
    const dev = await start();
    const devCookie = (await login(dev.req)).headers.get('set-cookie')!;
    expect(devCookie).toMatch(/HttpOnly/i);
    expect(devCookie).toMatch(/SameSite=Strict/i);
    expect(devCookie).toMatch(/Max-Age=60/i);
    expect(devCookie).not.toMatch(/Secure/i);

    const prod = await start({ config: { production: true } });
    const prodRes = await login(prod.req);
    expect(prodRes.headers.get('set-cookie')).toMatch(/Secure/i);
    expect(prodRes.headers.get('strict-transport-security')).toBeTruthy();
  });

  it('rejects tampered, foreign and expired sessions and supports logout', async () => {
    let t = 1_000_000;
    const s = await start({ now: () => t });
    const cookie = await session(s);
    const ok = (c: string) => s.req('/api/status', { headers: { cookie: c } });
    expect((await ok(cookie)).status).toBe(200);

    const value = cookie.split('=')[1];
    const [id, exp, sig] = value.split('.');
    expect((await ok(`overseer_session=${id}.${Number(exp) + 1}.${sig}`)).status).toBe(401);
    expect((await ok(`overseer_session=${id}.${exp}.${sig.slice(0, -2)}AA`)).status).toBe(401);
    expect((await ok('overseer_session=garbage')).status).toBe(401);

    // A validly signed cookie from another process (different key) is refused.
    const other = await start();
    expect((await ok(await session(other))).status).toBe(401);

    t += 60_001;
    expect((await ok(cookie)).status).toBe(401);

    t += 0;
    const fresh = await session(s);
    expect((await ok(fresh)).status).toBe(200);
    const out = await s.req('/logout', { method: 'POST', headers: { cookie: fresh } });
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toMatch(/overseer_session=;/);
    expect((await ok(fresh)).status).toBe(401);
  });

  it('throttles repeated failed logins, even with the right password afterwards', async () => {
    const s = await start();
    for (let i = 0; i < 5; i++) expect((await login(s.req, 'wrong' + i)).status).toBe(401);
    const blocked = await login(s.req, PASSWORD);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(blocked.headers.get('set-cookie')).toBeNull();
  });

  it('refuses cross-origin POSTs and sends security headers', async () => {
    const s = await start();
    const r = await login(s.req, PASSWORD, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(r.headers.get('set-cookie')).toBeNull();
    const same = await login(s.req, PASSWORD, { origin: s.base });
    expect(same.status).toBe(303);
    expect((await login(s.req, PASSWORD, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await login(s.req, PASSWORD, { 'sec-fetch-site': 'same-origin', origin: 'null' })).status).toBe(303);
    expect((await login(s.req, PASSWORD, { origin: 'null' })).status).toBe(403);
    const h =(await s.req('/login')).headers;
    expect(h.get('content-security-policy')).toContain("default-src 'self'");
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('x-frame-options')).toBe('DENY');
    expect(h.get('x-powered-by')).toBeNull();
  });

  it('limits body sizes', async () => {
    const s = await start();
    const cookie = await session(s);
    const r = await s.req('/api/v1/request', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ mediaType: 'movie', mediaId: 1, pad: 'x'.repeat(5000) }) });
    expect(r.status).toBe(413);
    const l = await login(s.req, 'x'.repeat(5000));
    expect(l.status).toBe(413);
  });
});

describe('API whitelist and upstream calls', () => {
  it('forwards whitelisted GETs with rebuilt URLs and the server-side key', async () => {
    const s = await start();
    const cookie = await session(s);
    const get = (p: string) => s.req(p, { headers: { cookie } });
    expect((await get('/api/v1/media?filter=available&take=50&skip=100')).status).toBe(200);
    expect((await get('/api/v1/movie/603/recommendations?page=2')).status).toBe(200);
    expect((await get('/api/v1/tv/1399/similar')).status).toBe(200);

    const calls = s.fetchImpl.mock.calls;
    expect(calls.map((c) => c[0])).toEqual([
      'http://overseerr.test:5055/api/v1/media?filter=available&take=50&skip=100',
      'http://overseerr.test:5055/api/v1/movie/603/recommendations?page=2',
      'http://overseerr.test:5055/api/v1/tv/1399/similar?page=1',
    ]);
    for (const [, init] of calls) {
      expect((init!.headers as Record<string, string>)['X-Api-Key']).toBe(API_KEY);
      expect(init!.redirect).toBe('manual');
    }
  });

  it('reduces auth/me to non-sensitive fields', async () => {
    const s = await start({ fetchImpl: async () => json({ id: 1, displayName: 'Ann', email: 'a@b.c', apiKey: API_KEY, settings: { secret: 1 } }) });
    const cookie = await session(s);
    const body = await (await s.req('/api/v1/auth/me', { headers: { cookie } })).json();
    expect(body).toEqual({ id: 1, email: 'a@b.c', displayName: 'Ann' });
  });

  it('rejects arbitrary routes, methods and invalid input without calling upstream', async () => {
    const s = await start();
    const cookie = await session(s);
    const get = (p: string) => s.req(p, { headers: { cookie } });
    const bad: [string, number][] = [
      ['/api/v1/settings/main', 404],
      ['/api/v1/user', 404],
      ['/api/v1/auth/me/../logout', 404],
      ['/api/v1/auth/me?x=1', 400],
      ['/api/v1/media', 400],
      ['/api/v1/media?filter=bogus', 400],
      ['/api/v1/media?filter=all&take=0', 400],
      ['/api/v1/media?filter=all&take=101', 400],
      ['/api/v1/media?filter=all&skip=-1', 400],
      ['/api/v1/media?filter=all&take=5&take=6', 400],
      ['/api/v1/media?filter=all&extra=1', 400],
      ['/api/v1/movie/abc/similar', 404],
      ['/api/v1/movie/0/similar', 400],
      ['/api/v1/movie/1/credits', 404],
      ['/api/v1/movie/1/similar?page=0', 400],
      ['/api/v1/movie/1/similar?page=9999', 400],
      ['/api/v1/movie/1/similar?page=1%0d%0aX:1', 400],
      ['/api/v1/person/1/similar', 404],
      ['/api/other', 404],
    ];
    for (const [p, status] of bad) expect([p, (await get(p)).status]).toEqual([p, status]);
    expect((await s.req('/api/v1/auth/me', { method: 'DELETE', headers: { cookie, 'content-type': 'application/json' } })).status).toBe(405);
    expect((await s.req('/api/v1/media?filter=all', { method: 'POST', headers: { cookie } })).status).toBe(405);
    expect((await s.req('/api/v1/request', { method: 'GET', headers: { cookie } })).status).toBe(405);
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });

  const post = (s: Awaited<ReturnType<typeof start>>, cookie: string, body: unknown) =>
    s.req('/api/v1/request', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('requests a movie with a movie-only body', async () => {
    const s = await start({ fetchImpl: vi.fn<FetchLike>(async () => json({ id: 9 })) });
    const cookie = await session(s);
    expect((await post(s, cookie, { mediaType: 'movie', mediaId: 603 })).status).toBe(200);
    const [url, init] = s.fetchImpl.mock.calls[0];
    expect(url).toBe('http://overseerr.test:5055/api/v1/request');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({ mediaType: 'movie', mediaId: 603 });
  });

  it('requests TV with seasons exactly [1]', async () => {
    const s = await start({ fetchImpl: vi.fn<FetchLike>(async () => json({ id: 9 })) });
    const cookie = await session(s);
    expect((await post(s, cookie, { mediaType: 'tv', mediaId: 1399 })).status).toBe(200);
    expect((await post(s, cookie, { mediaType: 'tv', mediaId: 1399, seasons: [1] })).status).toBe(200);
    for (const [, init] of s.fetchImpl.mock.calls) expect(JSON.parse(init!.body as string)).toEqual({ mediaType: 'tv', mediaId: 1399, seasons: [1] });
    const n = s.fetchImpl.mock.calls.length;
    for (const body of [
      { mediaType: 'tv', mediaId: 1, seasons: [1, 2] },
      { mediaType: 'tv', mediaId: 1, seasons: [2] },
      { mediaType: 'tv', mediaId: 1, seasons: 'all' },
      { mediaType: 'movie', mediaId: 1, seasons: [1] },
      { mediaType: 'movie', mediaId: '1' },
      { mediaType: 'movie', mediaId: 1.5 },
      { mediaType: 'movie', mediaId: -1 },
      { mediaType: 'book', mediaId: 1 },
      { mediaType: 'movie', mediaId: 1, is4k: true },
      { mediaType: 'movie', mediaId: 1, userId: 1 },
      [],
      null,
    ]) {
      expect([body, (await post(s, cookie, body)).status]).toEqual([body, 400]);
    }
    expect(s.fetchImpl.mock.calls.length).toBe(n);
  });
});

describe('upstream errors and secrecy', () => {
  const run = async (fetchImpl: FetchLike) => {
    const s = await start({ fetchImpl });
    const cookie = await session(s);
    const r = await s.req('/api/v1/media?filter=all', { headers: { cookie } });
    return { status: r.status, text: await r.text() };
  };

  it('distinguishes an upstream 401 from a session 401', async () => {
    const up = await run(async () => json({ message: 'Unauthorized' }, 401));
    expect(up.status).toBe(502);
    expect(JSON.parse(up.text).code).toBe('upstream-auth');
    expect(up.text).not.toContain(API_KEY);

    const s = await start();
    const noSession = await s.req('/api/v1/media?filter=all');
    expect(noSession.status).toBe(401);
    expect((await noSession.json()).code).toBe('session');
  });

  it('maps other upstream failures without leaking the key, URL or internals', async () => {
    const cases: [FetchLike, number, string][] = [
      [async () => json({ message: `forbidden for ${API_KEY}` }, 403), 403, 'upstream-forbidden'],
      [async () => json({ message: 'nope' }, 404), 404, 'upstream-not-found'],
      [async () => json({ message: 'exists' }, 409), 409, 'upstream-conflict'],
      [async () => json({ message: 'boom', stack: API_KEY }, 500), 502, 'upstream-error'],
      [async () => new Response('', { status: 302, headers: { location: `http://x/?k=${API_KEY}` } }), 502, 'upstream-redirect'],
      [async () => new Response('<html>login</html>', { status: 200 }), 502, 'upstream-bad-response'],
      [async () => { throw new Error(`connect ECONNREFUSED overseerr.test:5055 key=${API_KEY}`); }, 502, 'upstream-unreachable'],
    ];
    for (const [f, status, code] of cases) {
      const r = await run(f);
      expect([r.status, JSON.parse(r.text).code]).toEqual([status, code]);
      expect(r.text).not.toContain(API_KEY);
      expect(r.text).not.toContain('overseerr.test');
    }
  });

  it('times out slow upstreams', async () => {
    const s = await start({
      config: { upstreamTimeoutMs: 30 },
      fetchImpl: (_u, init) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted')))),
    });
    const cookie = await session(s);
    const r = await s.req('/api/v1/media?filter=all', { headers: { cookie } });
    expect(r.status).toBe(504);
  });

  it('does not put the API key or upstream URL into any response, header or log', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const s = await start({ fetchImpl: async () => json({ results: [{ tmdbId: 1, note: `has ${API_KEY}` }] }) });
    const cookie = await session(s);
    const outputs: string[] = [];
    for (const p of ['/login', '/api/status', '/api/v1/media?filter=all', '/api/v1/media?filter=nope', '/api/missing', '/nope']) {
      const r = await s.req(p, { headers: { cookie } });
      outputs.push(await r.text(), JSON.stringify([...r.headers]));
    }
    for (const o of outputs) {
      expect(o).not.toContain(API_KEY);
      expect(o).not.toContain(PASSWORD);
      expect(o).not.toContain('overseerr.test');
    }
    expect(outputs.join()).toContain('[redacted]');
    for (const sp of spies) expect(JSON.stringify(sp.mock.calls)).not.toContain(API_KEY);
    spies.forEach((sp) => sp.mockRestore());
  });
});

describe('config, sessions and throttle units', () => {
  it('requires APP_PASSWORD and the upstream settings without echoing values', () => {
    const env = { OVERSEERR_URL: 'https://o.example/api/v1/', OVERSEERR_API_KEY: API_KEY, APP_PASSWORD: PASSWORD };
    expect(loadConfig(env)).toMatchObject({ overseerrUrl: 'https://o.example', port: 8080, production: false });
    for (const k of Object.keys(env)) {
      expect(() => loadConfig({ ...env, [k]: '' })).toThrow(ConfigError);
    }
    expect(() => loadConfig({ ...env, OVERSEERR_URL: 'ftp://x' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, PORT: 'abc' })).toThrow(ConfigError);
    try {
      loadConfig({ ...env, APP_PASSWORD: '' });
    } catch (e) {
      expect(String(e)).not.toContain(API_KEY);
    }
  });

  it('session store expires and prunes', () => {
    let t = 0;
    const store = createSessionStore({ ttlMs: 100, now: () => t, maxSessions: 2 });
    const a = store.create().token;
    expect(store.validate(a)).toBe(true);
    store.create();
    store.create();
    expect(store.size()).toBeLessThanOrEqual(2);
    t = 101;
    expect(store.validate(a)).toBe(false);
  });

  it('throttle window slides', () => {
    let t = 0;
    const th = createThrottle({ limit: 2, windowMs: 1000, now: () => t });
    th.fail('k');
    th.fail('k');
    expect(th.retryAfter('k')).toBe(1);
    t = 1001;
    expect(th.retryAfter('k')).toBe(0);
  });
});

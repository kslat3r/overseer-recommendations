import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerConfig } from './config.js';
import { LOGIN_CSS, loginPage } from './loginPage.js';
import { COOKIE_NAME, createSessionStore, createThrottle, parseCookies, safeEqual, type SessionStore } from './session.js';
import { callUpstream, resolveRoute, RouteError, type FetchLike } from './upstream.js';

export interface AppDeps {
  config: ServerConfig;
  /** Injected for tests; production passes the proxied (tailnet) fetch. */
  fetchImpl: FetchLike;
  now?: () => number;
  sessions?: SessionStore;
}

const noStore = (res: Response) => res.set('Cache-Control', 'no-store');

export function createApp(deps: AppDeps) {
  const { config, fetchImpl } = deps;
  const now = deps.now ?? Date.now;
  const sessions = deps.sessions ?? createSessionStore({ ttlMs: config.sessionTtlMs, now });
  const ipThrottle = createThrottle({ limit: 5, windowMs: 15 * 60_000, now });
  const globalThrottle = createThrottle({ limit: 40, windowMs: 15 * 60_000, now });
  const staticDir = config.staticDir ?? path.resolve(import.meta.dirname, '..', 'dist');

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', config.trustProxy);

  // Security headers on every response.
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://image.tmdb.org data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  // CSRF defence in depth (cookies are already SameSite=Strict): reject cross-origin POSTs.
  app.use((req, res, next) => {
    if (req.method === 'POST') {
      // Browsers send Sec-Fetch-Site; it is authoritative. (Origin may legitimately be "null"
      // on same-origin form posts because of our Referrer-Policy: no-referrer.)
      const site = req.get('sec-fetch-site');
      const origin = req.get('origin');
      let ok = true;
      if (site) {
        ok = site === 'same-origin' || site === 'none';
      } else if (origin) {
        let host: string | undefined;
        try {
          host = new URL(origin).host;
        } catch {
          /* invalid or "null" */
        }
        const forwarded = config.trustProxy > 0 ? req.get('x-forwarded-host')?.split(',')[0].trim() : undefined;
        ok = !!host && (host === req.get('host') || host === forwarded);
      }
      if (!ok) {
        res.status(403).json({ code: 'bad-origin', message: 'Cross-origin request refused.' });
        return;
      }
    }
    next();
  });

  const cookieToken = (req: Request) => parseCookies(req.get('cookie'))[COOKIE_NAME];

  // ---- Public: health and login only ----
  app.get('/healthz', (_req, res) => {
    noStore(res).json({ ok: true });
  });
  app.get('/login.css', (_req, res) => {
    res.type('text/css').send(LOGIN_CSS);
  });
  app.get('/login', (req, res) => {
    noStore(res);
    if (sessions.validate(cookieToken(req))) {
      res.redirect(303, '/');
      return;
    }
    res.type('html').send(loginPage());
  });
  app.post('/login', express.urlencoded({ extended: false, limit: '2kb', parameterLimit: 5 }), (req, res) => {
    noStore(res);
    const ipKey = `ip:${req.ip ?? 'unknown'}`;
    const wait = Math.max(ipThrottle.retryAfter(ipKey), globalThrottle.retryAfter('global'));
    if (wait > 0) {
      res.set('Retry-After', String(wait)).status(429).type('html').send(loginPage(`Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`));
      return;
    }
    const pw = typeof req.body?.password === 'string' ? req.body.password : '';
    if (pw.length > 0 && pw.length <= 1024 && safeEqual(pw, config.appPassword)) {
      ipThrottle.reset(ipKey);
      const { token } = sessions.create();
      res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'strict', secure: config.production, path: '/', maxAge: config.sessionTtlMs });
      res.redirect(303, '/');
      return;
    }
    ipThrottle.fail(ipKey);
    globalThrottle.fail('global');
    res.status(401).type('html').send(loginPage('Incorrect password.'));
  });
  app.post('/logout', (req, res) => {
    noStore(res);
    sessions.destroy(cookieToken(req));
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', secure: config.production, path: '/' });
    res.status(200).json({ ok: true });
  });

  // ---- Gate: everything below needs a valid session ----
  app.use((req, res, next) => {
    if (sessions.validate(cookieToken(req))) {
      next();
      return;
    }
    noStore(res);
    if (req.path.startsWith('/api/') || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.status(401).json({ code: 'session', message: 'Sign in required.' });
      return;
    }
    res.redirect(303, '/login');
  });

  // App status lets the SPA detect server mode. Exposes nothing about the upstream.
  app.get('/api/status', (_req, res) => {
    noStore(res).json({ mode: 'server', version: 1 });
  });

  app.use('/api/v1', express.json({ limit: '1kb', strict: true }), async (req, res) => {
    noStore(res);
    try {
      const call = resolveRoute(req.method, req.path, req.query as Record<string, unknown>, req.body);
      const out = await callUpstream(call, { overseerrUrl: config.overseerrUrl, apiKey: config.apiKey, timeoutMs: config.upstreamTimeoutMs }, fetchImpl);
      res.status(out.status).json(out.json);
    } catch (e) {
      if (e instanceof RouteError) {
        res.status(e.status).json({ code: e.code, message: e.message });
        return;
      }
      res.status(500).json({ code: 'internal', message: 'Internal error.' });
    }
  });
  app.use('/api', (_req, res) => {
    noStore(res).status(404).json({ code: 'not-found', message: 'Not found.' });
  });

  // ---- Frontend (Vite dist) ----
  if (fs.existsSync(staticDir)) {
    app.use(
      express.static(staticDir, {
        dotfiles: 'ignore',
        index: 'index.html',
        // HTML must be re-gated on every load (a cached page would bypass the login after logout).
        setHeaders: (res, file) => {
          res.setHeader('Cache-Control', file.endsWith('.html') ? 'no-store' : 'private, max-age=3600');
        },
      }),
    );
  }
  app.use((_req, res) => {
    res.status(404).type('text').send('Not found');
  });

  // Body-parser and other errors: never leak details.
  app.use((err: { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    res.status(status).json({ code: status === 413 ? 'too-large' : status === 500 ? 'internal' : 'bad-request', message: status === 500 ? 'Internal error.' : 'Bad request.' });
  });

  return app;
}

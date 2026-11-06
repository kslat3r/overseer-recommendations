import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'overseer_session';

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** Constant-time string comparison (both sides hashed so length does not leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export interface SessionStore {
  create(): { token: string; expiresAt: number };
  validate(token: string | undefined): boolean;
  destroy(token: string | undefined): void;
  size(): number;
}

/**
 * In-memory sessions. The cookie value is `id.expiry.hmac`; the HMAC key is random per
 * process, so tampering is detected and every restart logs everyone out.
 */
export function createSessionStore(opts: { ttlMs: number; now?: () => number; maxSessions?: number }): SessionStore {
  const now = opts.now ?? Date.now;
  const max = opts.maxSessions ?? 500;
  const secret = randomBytes(32);
  const live = new Map<string, number>(); // id -> expiresAt

  const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');

  function parse(token: string | undefined): { id: string; exp: number } | null {
    if (!token || token.length > 200) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [id, expRaw, sig] = parts;
    const expected = sign(`${id}.${expRaw}`);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const exp = Number(expRaw);
    if (!Number.isFinite(exp)) return null;
    return { id, exp };
  }

  function prune() {
    const t = now();
    for (const [id, exp] of live) if (exp <= t) live.delete(id);
    while (live.size >= max) live.delete(live.keys().next().value as string);
  }

  return {
    create() {
      prune();
      const id = randomBytes(32).toString('base64url');
      const expiresAt = now() + opts.ttlMs;
      live.set(id, expiresAt);
      return { token: `${id}.${expiresAt}.${sign(`${id}.${expiresAt}`)}`, expiresAt };
    },
    validate(token) {
      const p = parse(token);
      if (!p) return false;
      const exp = live.get(p.id);
      if (exp === undefined || exp !== p.exp) return false;
      if (exp <= now()) {
        live.delete(p.id);
        return false;
      }
      return true;
    },
    destroy(token) {
      const p = parse(token);
      if (p) live.delete(p.id);
    },
    size: () => live.size,
  };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

/** Sliding-window failure limiter: `limit` failures per `windowMs` per key. */
export function createThrottle(opts: { limit: number; windowMs: number; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const fails = new Map<string, number[]>();
  const recent = (key: string): number[] => {
    const t = now();
    const list = (fails.get(key) ?? []).filter((x) => x > t - opts.windowMs);
    if (list.length) fails.set(key, list);
    else fails.delete(key);
    return list;
  };
  return {
    /** Seconds until another attempt is allowed, or 0. */
    retryAfter(key: string): number {
      const list = recent(key);
      if (list.length < opts.limit) return 0;
      return Math.max(1, Math.ceil((list[0] + opts.windowMs - now()) / 1000));
    },
    fail(key: string) {
      const list = recent(key);
      list.push(now());
      fails.set(key, list);
      if (fails.size > 10_000) fails.delete(fails.keys().next().value as string);
    },
    reset(key: string) {
      fails.delete(key);
    },
  };
}

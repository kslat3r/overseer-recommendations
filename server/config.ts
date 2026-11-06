export interface ServerConfig {
  overseerrUrl: string;
  apiKey: string;
  appPassword: string;
  port: number;
  production: boolean;
  trustProxy: number;
  sessionTtlMs: number;
  staticDir?: string;
  upstreamTimeoutMs: number;
}

export class ConfigError extends Error {}

/** Trim, drop trailing slashes and a pasted /api/v1 suffix; require http(s). */
export function normalizeUpstreamUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new ConfigError('OVERSEERR_URL is not a valid URL (include http:// or https://).');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigError('OVERSEERR_URL must start with http:// or https://.');
  if (u.username || u.password) throw new ConfigError('OVERSEERR_URL must not contain credentials.');
  const path = u.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  return `${u.origin}${path}`;
}

/** Reads and validates configuration. Error messages never contain secret values. */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const missing = ['OVERSEERR_URL', 'OVERSEERR_API_KEY', 'APP_PASSWORD'].filter((k) => !env[k]?.trim());
  if (missing.length) throw new ConfigError(`Missing required environment variable(s): ${missing.join(', ')}`);
  const port = env.PORT ? Number(env.PORT) : 8080;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError('PORT must be an integer between 0 and 65535.');
  const ttlHours = env.SESSION_TTL_HOURS ? Number(env.SESSION_TTL_HOURS) : 12;
  if (!(ttlHours > 0 && ttlHours <= 24 * 30)) throw new ConfigError('SESSION_TTL_HOURS must be between 0 and 720.');
  return {
    overseerrUrl: normalizeUpstreamUrl(env.OVERSEERR_URL!),
    apiKey: env.OVERSEERR_API_KEY!.trim(),
    appPassword: env.APP_PASSWORD!,
    port,
    production: env.NODE_ENV === 'production',
    trustProxy: env.TRUST_PROXY_HOPS ? Number(env.TRUST_PROXY_HOPS) : 1,
    sessionTtlMs: Math.round(ttlHours * 3600_000),
    staticDir: env.STATIC_DIR || undefined,
    upstreamTimeoutMs: 20_000,
  };
}

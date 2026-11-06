import http from 'node:http';
import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { FetchLike } from './upstream.js';

const MAX_BYTES = 20 * 1024 * 1024;
const NULL_BODY = new Set([101, 204, 205, 304]);

/**
 * A minimal fetch() that tunnels through an HTTP proxy (tailscaled's loopback
 * outbound proxy) using a per-request agent. It is used only for Overseerr calls;
 * nothing global (no env proxy vars, no global dispatcher) is touched.
 * An empty proxy URL means connect directly.
 */
export function createUpstreamFetch(proxyUrl: string | undefined): FetchLike {
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const target = new URL(url);
      const lib = target.protocol === 'https:' ? https : http;
      const headers = { ...(init.headers as Record<string, string>) };
      if (init.body !== undefined && init.body !== null) headers['Content-Length'] = String(Buffer.byteLength(String(init.body)));
      const req = lib.request(target, { method: init.method, headers, agent, signal: init.signal ?? undefined }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy(new Error('response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('error', reject);
        res.on('end', () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) for (const x of v) h.append(k, x);
            else if (v !== undefined) h.set(k, v);
          }
          const status = res.statusCode ?? 502;
          resolve(new Response(NULL_BODY.has(status) ? null : Buffer.concat(chunks), { status, headers: h }));
        });
      });
      req.on('error', reject);
      req.end(init.body === undefined || init.body === null ? undefined : String(init.body));
    });
}

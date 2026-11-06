import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createUpstreamFetch } from '../server/proxiedFetch';

const servers: http.Server[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

type Seen = { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string };

async function listen(handler: http.RequestListener) {
  const sv = http.createServer(handler);
  await new Promise<void>((r) => sv.listen(0, '127.0.0.1', r));
  servers.push(sv);
  return (sv.address() as AddressInfo).port;
}

function recorder(seen: Seen[], reply: (res: http.ServerResponse) => void): http.RequestListener {
  return (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      reply(res);
    });
  };
}

const reply = (res: http.ServerResponse) => {
  res.writeHead(201, { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] });
  res.end(JSON.stringify({ ok: true }));
};

describe('createUpstreamFetch', () => {
  it('fetches directly when the proxy is empty', async () => {
    const seen: Seen[] = [];
    const port = await listen(recorder(seen, reply));
    const f = createUpstreamFetch('');
    const res = await f(`http://127.0.0.1:${port}/api/v1/request?x=1`, {
      method: 'POST',
      headers: { 'X-Api-Key': 'k', 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/api/v1/request?x=1');
    expect(seen[0].headers['x-api-key']).toBe('k');
    expect(seen[0].headers['content-length']).toBe('7');
    expect(seen[0].body).toBe('{"a":1}');
  });

  it('tunnels through an HTTP proxy via CONNECT',async () => {
    const targetSeen: Seen[] = [];
    const targetPort = await listen(recorder(targetSeen, reply));
    const connects: string[] = [];
    // Tiny CONNECT proxy (https-proxy-agent always tunnels, as tailscaled's proxy supports):
    // records the requested authority and splices to the target.
    const proxy = http.createServer();
    proxy.on('connect', (req, clientSocket, head) => {
      connects.push(req.url ?? '');
      const [host, port] = (req.url ?? '').split(':');
      const upstream = net.connect(Number(port), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    servers.push(proxy);
    const proxyPort = (proxy.address() as AddressInfo).port;
    const f = createUpstreamFetch(`http://127.0.0.1:${proxyPort}`);
    const res = await f(`http://127.0.0.1:${targetPort}/api/v1/search?q=a`, {
      method: 'GET',
      headers: { 'X-Api-Key': 'k2' },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(connects).toEqual([`127.0.0.1:${targetPort}`]);
    expect(targetSeen).toHaveLength(1);
    expect(targetSeen[0].url).toBe('/api/v1/search?q=a');
    expect(targetSeen[0].headers['x-api-key']).toBe('k2');
  });

  it('returns a null body for 204 and rejects on connection errors', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const f = createUpstreamFetch(undefined);
    const res = await f(`http://127.0.0.1:${port}/`, { method: 'DELETE', headers: {} });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    servers.pop()!.close();
    await expect(f(`http://127.0.0.1:${port}/`, { method: 'GET', headers: {} })).rejects.toThrow();
  });
});

// Tiny fake Overseerr for the server-mode E2E: node e2e/fake-overseerr.mjs [port]
// Requires X-Api-Key: e2e-key. Library = movie 1; recommendations = movies 100..103.
import http from 'node:http';

const KEY = 'e2e-key';
const port = Number(process.argv[2] ?? 5055);
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

http
  .createServer((req, res) => {
    if (req.headers['x-api-key'] !== KEY) return send(res, 401, { message: 'Unauthorized' });
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/api/v1/auth/me') return send(res, 200, { id: 1, displayName: 'E2E User', apiKey: KEY });
    if (p === '/api/v1/media') {
      const f = url.searchParams.get('filter');
      return send(res, 200, { pageInfo: { pages: 1, pageSize: 100, results: f === 'available' ? 1 : 0, page: 1 }, results: f === 'available' ? [{ tmdbId: 1, mediaType: 'movie', status: 5 }] : [] });
    }
    if (/^\/api\/v1\/movie\/1\/recommendations$/.test(p)) {
      return send(res, 200, {
        page: 1,
        totalPages: 1,
        results: [100, 101, 102, 103].map((id) => ({ id, mediaType: 'movie', title: `Fake Movie ${id}`, releaseDate: '2020-01-01', voteAverage: 7, overview: 'Fake.' })),
      });
    }
    if (/^\/api\/v1\/movie\/1\/similar$/.test(p)) return send(res, 200, { page: 1, totalPages: 1, results: [] });
    if (p === '/api/v1/request' && req.method === 'POST') return send(res, 201, { id: 1 });
    send(res, 404, { message: 'nope' });
  })
  .listen(port, '127.0.0.1', () => console.log(`fake overseerr on ${port}`));

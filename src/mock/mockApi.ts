import type { MediaInfo, TitleResult } from '../api/types';

export interface MockFixtures {
  /** Library/processing/pending media, with status codes (Overseerr MediaStatus). */
  media: MediaInfo[];
  /** key "movie:123" -> recommended titles */
  recommendations: Record<string, TitleResult[]>;
  /** key "movie:123" -> similar titles */
  similar: Record<string, TitleResult[]>;
  /** key "movie:123" -> display name of a library title (served by GET /movie/123 or /tv/123). */
  names?: Record<string, string>;
}

export interface MockOptions {
  apiKey?: string;
  fixtures?: MockFixtures;
  /** TMDB ids for which POST /request should fail with 500. */
  failRequestFor?: number[];
  latencyMs?: number;
}

export interface MockCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: unknown;
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** In-memory fake of the subset of the Overseerr API this app uses. */
export function createMockApi(opts: MockOptions = {}) {
  const fx = opts.fixtures ?? defaultFixtures();
  const apiKey = opts.apiKey ?? 'demo-key';
  const calls: MockCall[] = [];
  const requested: { mediaType: string; mediaId: number; seasons?: number[] }[] = [];

  const statusFilters: Record<string, number[]> = {
    all: [1, 2, 3, 4, 5, 6],
    available: [5],
    partial: [4],
    allavailable: [4, 5],
    processing: [3],
    pending: [2],
  };

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname.replace(/^.*?(\/api\/v1)/, '$1');
    calls.push({ method, path, query: url.searchParams, body });

    if (init?.mode === 'no-cors') return new Response('', { status: 200 });
    if (headers['X-Api-Key'] !== apiKey) return jsonRes({ message: 'Forbidden' }, 403);

    if (method === 'GET' && path === '/api/v1/auth/me') {
      return jsonRes({ id: 1, displayName: 'Demo User', email: 'demo@example.invalid' });
    }
    if (method === 'GET' && path === '/api/v1/media') {
      const allowed = statusFilters[url.searchParams.get('filter') ?? 'all'] ?? [];
      const take = Number(url.searchParams.get('take') ?? 20);
      const skip = Number(url.searchParams.get('skip') ?? 0);
      const all = fx.media.filter((m) => allowed.includes(m.status ?? 1));
      return jsonRes({
        pageInfo: { pages: Math.ceil(all.length / take), pageSize: take, results: all.length, page: Math.floor(skip / take) + 1 },
        results: all.slice(skip, skip + take),
      });
    }
    const d = path.match(/^\/api\/v1\/(movie|tv)\/(\d+)$/);
    if (method === 'GET' && d) {
      const name = fx.names?.[`${d[1]}:${d[2]}`];
      if (!name) return jsonRes({ message: 'Not found' }, 404);
      return jsonRes({ id: Number(d[2]), ...(d[1] === 'movie' ? { title: name } : { name }) });
    }
    const m = path.match(/^\/api\/v1\/(movie|tv)\/(\d+)\/(recommendations|similar)$/);
    if (method === 'GET' && m) {
      const table = m[3] === 'recommendations' ? fx.recommendations : fx.similar;
      const page = Number(url.searchParams.get('page') ?? 1);
      const results = page === 1 ? (table[`${m[1]}:${m[2]}`] ?? []) : [];
      return jsonRes({ page, totalPages: 1, totalResults: results.length, results });
    }
    if (method === 'POST' && path === '/api/v1/request') {
      if (opts.failRequestFor?.includes(body.mediaId)) return jsonRes({ message: 'Internal error' }, 500);
      requested.push(body);
      return jsonRes({ id: requested.length, status: 1, media: { tmdbId: body.mediaId } }, 201);
    }
    return jsonRes({ message: 'Not found' }, 404);
  };

  return { fetch: fetchImpl as typeof fetch, calls, requested, apiKey };
}

const t = (
  id: number,
  mediaType: 'movie' | 'tv',
  title: string,
  year: string,
  voteAverage: number,
  overview: string,
): TitleResult => ({
  id,
  mediaType,
  ...(mediaType === 'movie' ? { title, releaseDate: `${year}-06-01` } : { name: title, firstAirDate: `${year}-06-01` }),
  posterPath: null,
  overview,
  voteAverage,
  mediaInfo: null,
});

/** Small deterministic dataset used by tests and by the in-app demo mode. */
export function defaultFixtures(): MockFixtures {
  const neon = t(101, 'movie', 'Neon Meridian', '2019', 7.9, 'A courier crosses a flooded megacity with a memory that is not hers.');
  const glass = t(102, 'movie', 'The Glass Orchard', '2008', 7.2, 'Three siblings reunite to sell the family orchard and uncover why it never freezes.');
  const dust = t(103, 'tv', 'Dust & Lanterns', '2021', 8.4, 'A caravan of cartographers maps a desert that rearranges itself every night.');
  const quiet = t(104, 'movie', 'Quiet Engines', '1999', 6.5, 'A retired pilot restores a rocket in his garage, one rivet at a time.');
  const salt = t(105, 'tv', 'Salt Road', '2016', 7.7, 'Smugglers, a lighthouse keeper, and a very polite inspector.');
  const owned = t(1, 'movie', 'Already In Library', '2010', 8, 'Should be filtered out.');
  const asked = t(2, 'tv', 'Already Requested', '2020', 8, 'Should be filtered out.');
  const skipMe = t(106, 'movie', 'Skipped Before', '2012', 9, 'Filtered when skipped.');
  return {
    media: [
      { id: 1, tmdbId: 1, mediaType: 'movie', status: 5 },
      { id: 2, tmdbId: 10, mediaType: 'movie', status: 5 },
      { id: 3, tmdbId: 11, mediaType: 'tv', status: 4 },
      { id: 4, tmdbId: 12, mediaType: 'movie', status: 3 },
      { id: 5, tmdbId: 2, mediaType: 'tv', status: 2 },
    ],
    names: { 'movie:1': 'Already In Library', 'movie:10': 'Blade Runner', 'tv:11': 'Severance', 'movie:12': 'Arrival' },
    recommendations: {
      'movie:10': [neon, glass, owned, skipMe],
      'tv:11': [neon, dust, asked],
      'movie:12': [neon, quiet],
    },
    similar: {
      'movie:10': [glass, salt],
      'tv:11': [dust, salt, { ...quiet, mediaInfo: { status: 5 } }],
      'movie:12': [neon],
    },
  };
}

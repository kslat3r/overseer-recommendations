import { describe, expect, it } from 'vitest';
import { createClient } from '../src/api/client';
import { createMockApi, defaultFixtures } from '../src/mock/mockApi';
import { buildRecommendations, scanLibrary } from '../src/core/recommend';

const setup = (extra: Parameters<typeof createMockApi>[0] = {}) => {
  const mock = createMockApi(extra);
  const client = createClient({
    baseUrl: 'https://o.example',
    apiKey: mock.apiKey,
    fetchImpl: mock.fetch,
    pageProtocol: 'https:',
  });
  return { mock, client };
};

describe('scanLibrary', () => {
  it('collects available/partial/processing sources and excludes pending from sources but not from exclusions', async () => {
    const { client } = setup();
    const lib = await scanLibrary(client);
    expect([...lib.sources.keys()].sort()).toEqual(['movie:10', 'movie:12', 'movie:1', 'tv:11'].sort());
    expect(lib.exclude.has('tv:2')).toBe(true); // pending request
    expect(lib.exclude.has('movie:10')).toBe(true);
    expect(lib.sources.has('tv:2')).toBe(false);
  });

  it('pages through /media until exhausted', async () => {
    const fx = defaultFixtures();
    fx.media = Array.from({ length: 125 }, (_, i) => ({ id: i, tmdbId: 1000 + i, mediaType: 'movie' as const, status: 5 }));
    const { client, mock } = setup({ fixtures: fx });
    const lib = await scanLibrary(client, { pageSize: 50 });
    expect(lib.sources.size).toBe(125);
    const skips = mock.calls.filter((c) => c.query.get('filter') === 'available').map((c) => c.query.get('skip'));
    expect(skips).toEqual(['0', '50', '100']);
  });

  it('uses the documented filters', async () => {
    const { client, mock } = setup();
    await scanLibrary(client);
    const filters = new Set(mock.calls.filter((c) => c.path === '/api/v1/media').map((c) => c.query.get('filter')));
    expect(filters).toEqual(new Set(['available', 'partial', 'allavailable', 'processing', 'pending']));
  });
});

describe('buildRecommendations', () => {
  it('dedupes, filters library/requests/skipped, ranks by distinct source count', async () => {
    const { client } = setup();
    const { candidates } = await buildRecommendations(client, { skipped: new Set(['movie:106']) });
    expect(candidates.map((c) => [c.key, c.sourceCount])).toEqual([
      ['movie:101', 3],
      ['tv:105', 2],
      ['tv:103', 1], // higher TMDB rating wins tie
      ['movie:102', 1],
    ]);
  });

  it('counts a source once even if it lists a title in both recommendations and similar', async () => {
    const { client } = setup();
    const { candidates } = await buildRecommendations(client, { skipped: new Set() });
    expect(candidates.find((c) => c.key === 'tv:103')!.sourceCount).toBe(1);
  });

  it('filters titles Overseerr already marks as requested/available (mediaInfo.status)', async () => {
    const { client } = setup();
    const { candidates } = await buildRecommendations(client, { skipped: new Set() });
    expect(candidates.some((c) => c.key === 'movie:104')).toBe(false);
  });

  it('does not conflate movie:N and tv:N', async () => {
    const fx = defaultFixtures();
    fx.recommendations['movie:10'] = [{ id: 500, mediaType: 'movie', title: 'M', voteAverage: 5 }];
    fx.recommendations['tv:11'] = [{ id: 500, mediaType: 'tv', name: 'T', voteAverage: 5 }];
    fx.recommendations['movie:12'] = [];
    fx.similar = {};
    const { client } = setup({ fixtures: fx });
    const { candidates } = await buildRecommendations(client, { skipped: new Set() });
    expect(candidates.map((c) => c.key).sort()).toEqual(['movie:500', 'tv:500']);
  });

  it('maps display fields', async () => {
    const { client } = setup();
    const { candidates } = await buildRecommendations(client, { skipped: new Set(['movie:106']) });
    expect(candidates[0]).toMatchObject({ title: 'Neon Meridian', year: '2019', mediaType: 'movie', voteAverage: 7.9 });
    expect(candidates[2]).toMatchObject({ title: 'Dust & Lanterns', year: '2021', mediaType: 'tv' });
  });

  it('tolerates per-source failures but reports them, and throws if everything fails', async () => {
    const { client, mock } = setup();
    const orig = mock.fetch;
    let first = true;
    const flaky = createClient({
      baseUrl: 'https://o.example',
      apiKey: mock.apiKey,
      pageProtocol: 'https:',
      fetchImpl: ((u: string, i: RequestInit) => {
        if (String(u).includes('/movie/10/recommendations') && first) {
          first = false;
          return Promise.resolve(new Response('{}', { status: 500 }));
        }
        return orig(u, i);
      }) as typeof fetch,
    });
    const r = await buildRecommendations(flaky, { skipped: new Set() });
    expect(r.stats.sourceFailures).toBe(1);
    expect(r.candidates.length).toBeGreaterThan(0);

    const dead = createClient({
      baseUrl: 'https://o.example',
      apiKey: mock.apiKey,
      pageProtocol: 'https:',
      fetchImpl: ((u: string, i: RequestInit) =>
        String(u).includes('/recommendations') || String(u).includes('/similar')
          ? Promise.resolve(new Response('{}', { status: 500 }))
          : orig(u, i)) as typeof fetch,
    });
    await expect(buildRecommendations(dead, { skipped: new Set() })).rejects.toMatchObject({ kind: 'server' });
    void client;
  });

  it('returns empty (no error) when the library is empty', async () => {
    const fx = defaultFixtures();
    fx.media = [];
    const { client } = setup({ fixtures: fx });
    const r = await buildRecommendations(client, { skipped: new Set() });
    expect(r.candidates).toEqual([]);
    expect(r.stats.librarySize).toBe(0);
  });

  it('caps the number of source titles scanned', async () => {
    const { client, mock } = setup();
    await buildRecommendations(client, { skipped: new Set(), maxSources: 2 });
    const recCalls = mock.calls.filter((c) => c.path.endsWith('/recommendations'));
    expect(recCalls.length).toBe(2);
  });
});

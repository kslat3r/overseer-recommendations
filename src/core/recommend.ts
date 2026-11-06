import type { OverseerrClient } from '../api/client';
import { ApiError } from '../api/errors';
import type { Candidate, MediaFilter, MediaInfo, MediaType, TitleResult } from '../api/types';

export interface Library {
  /** Library titles used to seed recommendations, keyed "movie:123". */
  sources: Map<string, { mediaType: MediaType; tmdbId: number }>;
  /** Everything that must never be recommended: library + processing + pending. */
  exclude: Set<string>;
}

const keyOf = (t: MediaType, id: number) => `${t}:${id}`;
const asType = (m: MediaInfo): MediaType | null => (m.mediaType === 'movie' || m.mediaType === 'tv' ? m.mediaType : null);

async function pageAll(client: OverseerrClient, filter: MediaFilter, pageSize: number): Promise<MediaInfo[]> {
  const out: MediaInfo[] = [];
  for (let skip = 0; ; skip += pageSize) {
    const page = await client.getMediaPage(filter, pageSize, skip);
    const results = page.results ?? [];
    out.push(...results);
    const total = page.pageInfo?.results;
    if (results.length < pageSize || (total !== undefined && skip + pageSize >= total)) break;
  }
  return out;
}

export async function scanLibrary(client: OverseerrClient, o: { pageSize?: number } = {}): Promise<Library> {
  const pageSize = o.pageSize ?? 100;
  const sources: Library['sources'] = new Map();
  const exclude = new Set<string>();
  const add = (m: MediaInfo, asSource: boolean) => {
    const t = asType(m);
    if (!t) return;
    const k = keyOf(t, m.tmdbId);
    exclude.add(k);
    if (asSource) sources.set(k, { mediaType: t, tmdbId: m.tmdbId });
  };
  for (const f of ['available', 'partial', 'processing'] as const) {
    for (const m of await pageAll(client, f, pageSize)) add(m, true);
  }
  // Belt and braces for exclusions (any available or partially available item).
  for (const m of await pageAll(client, 'allavailable', pageSize)) add(m, false);
  // Pending requests are not in the library yet: exclude, but do not seed from them.
  for (const m of await pageAll(client, 'pending', pageSize)) add(m, false);
  return { sources, exclude };
}

export interface BuildOptions {
  skipped: Set<string>;
  maxSources?: number;
  pageSize?: number;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface BuildResult {
  candidates: Candidate[];
  stats: { librarySize: number; sourcesScanned: number; sourceFailures: number };
}

const year = (r: TitleResult) => (r.releaseDate ?? r.firstAirDate ?? '').slice(0, 4);

export async function buildRecommendations(client: OverseerrClient, o: BuildOptions): Promise<BuildResult> {
  const lib = await scanLibrary(client, { pageSize: o.pageSize });
  const sources = [...lib.sources.entries()].slice(0, o.maxSources ?? 150);
  const found = new Map<string, { c: Candidate; from: Set<string> }>();
  const blocked = new Set<string>();
  let failures = 0;
  let attempts = 0;
  let lastError: unknown;
  let done = 0;

  const work = sources.map(([srcKey, src]) => async () => {
    for (const kind of ['recommendations', 'similar'] as const) {
      attempts++;
      let page;
      try {
        page = await client.getTitles(src.mediaType, src.tmdbId, kind, 1);
      } catch (e) {
        failures++;
        lastError = e;
        continue;
      }
      for (const r of page.results ?? []) {
        const t: MediaType | null = r.mediaType === 'movie' || r.mediaType === 'tv' ? r.mediaType : r.mediaType ? null : src.mediaType;
        if (!t) continue;
        const k = keyOf(t, r.id);
        const st = r.mediaInfo?.status;
        // Overseerr's own status on any listing wins, even if other listings lack it.
        if (st !== undefined && st >= 2 && st <= 5) blocked.add(k);
        if (lib.exclude.has(k) || o.skipped.has(k)) continue;
        let entry = found.get(k);
        if (!entry) {
          entry = {
            from: new Set(),
            c: {
              key: k,
              tmdbId: r.id,
              mediaType: t,
              title: r.title ?? r.name ?? 'Untitled',
              year: year(r),
              overview: r.overview ?? '',
              posterPath: r.posterPath ?? null,
              voteAverage: r.voteAverage ?? 0,
              sourceCount: 0,
            },
          };
          found.set(k, entry);
        }
        entry.from.add(srcKey);
      }
    }
    o.onProgress?.(++done, sources.length);
  });

  let next = 0;
  const workers = Array.from({ length: Math.min(o.concurrency ?? 6, work.length) }, async () => {
    while (next < work.length) await work[next++]();
  });
  await Promise.all(workers);

  if (attempts > 0 && failures === attempts) {
    throw lastError instanceof ApiError ? lastError : new Error('Every recommendation lookup failed');
  }

  const candidates = [...found.values()].filter(({ c }) => !blocked.has(c.key)).map(({ c, from }) => ({ ...c, sourceCount: from.size }));
  candidates.sort((a, b) => b.sourceCount - a.sourceCount || b.voteAverage - a.voteAverage || a.title.localeCompare(b.title));
  return { candidates, stats: { librarySize: lib.sources.size, sourcesScanned: sources.length, sourceFailures: failures } };
}

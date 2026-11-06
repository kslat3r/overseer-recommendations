import { describe, expect, it } from 'vitest';
import { createClient } from '../src/api/client';
import { createMockApi } from '../src/mock/mockApi';
import { buildRecommendations } from '../src/core/recommend';
import { requestCandidate } from '../src/core/actions';
import { createSkipStore, loadSettings, saveSettings, clearSettings } from '../src/core/storage';

class MemStorage implements Storage {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

const mk = (opts = {}) => {
  const mock = createMockApi(opts);
  const client = createClient({ baseUrl: 'https://o.example', apiKey: mock.apiKey, fetchImpl: mock.fetch, pageProtocol: 'https:' });
  return { mock, client };
};

describe('request flow (swipe right)', () => {
  it('requests a movie, then a tv show with season 1, and does not skip on success', async () => {
    const { mock, client } = mk();
    const store = createSkipStore(new MemStorage());
    const { candidates } = await buildRecommendations(client, { skipped: store.all() });
    const movie = candidates.find((c) => c.mediaType === 'movie')!;
    const tv = candidates.find((c) => c.mediaType === 'tv')!;
    await requestCandidate(client, movie);
    await requestCandidate(client, tv);
    expect(mock.requested).toEqual([
      { mediaType: 'movie', mediaId: movie.tmdbId },
      { mediaType: 'tv', mediaId: tv.tmdbId, seasons: [1] },
    ]);
    expect(store.all().size).toBe(0);
  });

  it('on request failure throws and does NOT mark skipped', async () => {
    const { client } = mk({ failRequestFor: [101] });
    const store = createSkipStore(new MemStorage());
    const { candidates } = await buildRecommendations(client, { skipped: store.all() });
    await expect(requestCandidate(client, candidates[0], store)).rejects.toMatchObject({ kind: 'server' });
    expect(store.has(candidates[0].key)).toBe(false);
  });
});

describe('storage', () => {
  it('persists skipped keys and excludes them on rebuild', async () => {
    const mem = new MemStorage();
    const s1 = createSkipStore(mem);
    s1.add('movie:101');
    const s2 = createSkipStore(mem);
    expect(s2.has('movie:101')).toBe(true);
    const { client } = mk();
    const { candidates } = await buildRecommendations(client, { skipped: s2.all() });
    expect(candidates.some((c) => c.key === 'movie:101')).toBe(false);
    s2.clear();
    expect(createSkipStore(mem).all().size).toBe(0);
  });

  it('survives corrupt storage', () => {
    const mem = new MemStorage();
    mem.setItem('overseer-recs:skipped', '{oops');
    mem.setItem('overseer-recs:settings', 'nope');
    expect(createSkipStore(mem).all().size).toBe(0);
    expect(loadSettings(mem)).toEqual({ baseUrl: '', apiKey: '', demo: false });
  });

  it('saves and clears settings', () => {
    const mem = new MemStorage();
    saveSettings({ baseUrl: 'https://x', apiKey: 'k', demo: false }, mem);
    expect(loadSettings(mem).apiKey).toBe('k');
    clearSettings(mem);
    expect(loadSettings(mem).apiKey).toBe('');
  });
});

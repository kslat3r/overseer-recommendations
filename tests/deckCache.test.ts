import { describe, expect, it } from 'vitest';
import type { Candidate } from '../src/api/types';
import { CACHE_TTL_MS, clearDeck, loadDeck, removeFromDeck, saveDeck } from '../src/core/deckCache';

class MemStorage implements Storage {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

const c = (id: number, extra: Partial<Candidate> = {}): Candidate => ({
  key: `movie:${id}`,
  tmdbId: id,
  mediaType: 'movie',
  title: `T${id}`,
  year: '2020',
  overview: 'Long synopsis',
  posterPath: '/p.jpg',
  voteAverage: 7,
  sourceCount: 2,
  sourceTitles: ['A', 'B'],
  ...extra,
});

describe('deck cache', () => {
  it('round-trips a fresh deck including overview, poster and source titles', () => {
    const s = new MemStorage();
    saveDeck([c(1), c(2)], 1000, s);
    expect(loadDeck(new Set(), 1000 + CACHE_TTL_MS - 1, s)).toEqual([c(1), c(2)]);
  });

  it('expires after the TTL', () => {
    const s = new MemStorage();
    saveDeck([c(1)], 1000, s);
    expect(loadDeck(new Set(), 1000 + CACHE_TTL_MS, s)).toBeNull();
  });

  it('is null when missing or corrupt', () => {
    const s = new MemStorage();
    expect(loadDeck(new Set(), 0, s)).toBeNull();
    s.setItem('overseer-recs:deck', '{nope');
    expect(loadDeck(new Set(), 0, s)).toBeNull();
  });

  it('filters skipped keys on load', () => {
    const s = new MemStorage();
    saveDeck([c(1), c(2), c(3)], 1000, s);
    expect(loadDeck(new Set(['movie:2']), 1001, s)?.map((x) => x.key)).toEqual(['movie:1', 'movie:3']);
  });

  it('removeFromDeck drops one title without extending the TTL', () => {
    const s = new MemStorage();
    saveDeck([c(1), c(2)], 1000, s);
    removeFromDeck('movie:1', s);
    expect(loadDeck(new Set(), 1001, s)?.map((x) => x.key)).toEqual(['movie:2']);
    expect(loadDeck(new Set(), 1000 + CACHE_TTL_MS, s)).toBeNull();
  });

  it('stores only display fields, never secrets', () => {
    const s = new MemStorage();
    const leaky = { ...c(1), apiKey: 'sekrit-key', baseUrl: 'https://o.example', password: 'pw' } as Candidate;
    saveDeck([leaky], 1000, s);
    const raw = s.getItem('overseer-recs:deck')!;
    expect(raw).not.toMatch(/sekrit-key|o\.example|password|apiKey|baseUrl/);
    expect([...s.m.keys()]).toEqual(['overseer-recs:deck']);
  });

  it('clears', () => {
    const s = new MemStorage();
    saveDeck([c(1)], 1000, s);
    clearDeck(s);
    expect(loadDeck(new Set(), 1001, s)).toBeNull();
    expect(s.length).toBe(0);
  });
});

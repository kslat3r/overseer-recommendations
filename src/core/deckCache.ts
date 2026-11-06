import type { Candidate } from '../api/types';

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DECK_KEY = 'overseer-recs:deck';

/** Only display fields are cached: never settings, URLs, keys or passwords. */
const pick = (c: Candidate): Candidate => ({
  key: c.key,
  tmdbId: c.tmdbId,
  mediaType: c.mediaType,
  title: c.title,
  year: c.year,
  overview: c.overview,
  posterPath: c.posterPath,
  voteAverage: c.voteAverage,
  sourceCount: c.sourceCount,
  sourceTitles: [...c.sourceTitles],
});

const valid = (c: unknown): c is Candidate => {
  const x = c as Candidate;
  return !!x && typeof x.key === 'string' && typeof x.title === 'string' && Array.isArray(x.sourceTitles) && (x.mediaType === 'movie' || x.mediaType === 'tv');
};

const store = (s?: Storage) => s ?? localStorage;

export function saveDeck(deck: Candidate[], now = Date.now(), storage?: Storage): void {
  try {
    store(storage).setItem(DECK_KEY, JSON.stringify({ savedAt: now, deck: deck.map(pick) }));
  } catch {
    /* storage full/blocked: just no cache */
  }
}

/** Fresh cached deck minus skipped keys, or null when missing, expired or corrupt. */
export function loadDeck(skipped: Set<string>, now = Date.now(), storage?: Storage): Candidate[] | null {
  try {
    const j = JSON.parse(store(storage).getItem(DECK_KEY) ?? 'null');
    if (!j || typeof j.savedAt !== 'number' || !Array.isArray(j.deck)) return null;
    if (now - j.savedAt >= CACHE_TTL_MS || j.savedAt > now) return null;
    return j.deck.filter(valid).filter((c: Candidate) => !skipped.has(c.key));
  } catch {
    return null;
  }
}

/** Drop one title from the cached deck, keeping the original timestamp (TTL is not extended). */
export function removeFromDeck(key: string, storage?: Storage): void {
  try {
    const s = store(storage);
    const j = JSON.parse(s.getItem(DECK_KEY) ?? 'null');
    if (!j || !Array.isArray(j.deck)) return;
    j.deck = j.deck.filter((c: { key?: string }) => c?.key !== key);
    s.setItem(DECK_KEY, JSON.stringify(j));
  } catch {
    /* ignore */
  }
}

export function clearDeck(storage?: Storage): void {
  try {
    store(storage).removeItem(DECK_KEY);
  } catch {
    /* ignore */
  }
}

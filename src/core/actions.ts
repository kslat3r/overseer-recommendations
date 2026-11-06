import type { OverseerrClient } from '../api/client';
import type { Candidate } from '../api/types';
import type { SkipStore } from './storage';

/** Request a candidate. Throws on failure; never touches the skip list. */
export async function requestCandidate(client: OverseerrClient, c: Candidate, _skips?: SkipStore): Promise<void> {
  await client.requestTitle(c.mediaType, c.tmdbId);
}

export type MediaType = 'movie' | 'tv';

/** Overseerr MediaStatus: 1 UNKNOWN, 2 PENDING, 3 PROCESSING, 4 PARTIALLY_AVAILABLE, 5 AVAILABLE, 6 DELETED */
export interface MediaInfo {
  id?: number;
  tmdbId: number;
  mediaType?: MediaType;
  status?: number;
}

export interface PageInfo {
  pages: number;
  pageSize: number;
  results: number;
  page: number;
}

export interface MediaPage {
  pageInfo?: PageInfo;
  results: MediaInfo[];
}

/** Subset of MovieResult / TvResult we rely on. */
export interface TitleResult {
  id: number;
  mediaType?: string;
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  posterPath?: string | null;
  overview?: string;
  voteAverage?: number;
  mediaInfo?: { status?: number } | null;
}

export interface ResultsPage {
  page?: number;
  totalPages?: number;
  totalResults?: number;
  results: TitleResult[];
}

/** Subset of MovieDetails / TvDetails: movies carry `title`, shows carry `name`. */
export interface TitleDetail {
  id?: number;
  title?: string;
  name?: string;
}

export interface UserInfo {
  id: number;
  email?: string;
  displayName?: string;
  username?: string;
  plexUsername?: string;
  jellyfinUsername?: string;
}

export type MediaFilter = 'all' | 'available' | 'partial' | 'allavailable' | 'processing' | 'pending';

export interface Candidate {
  key: string; // "movie:123"
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  year: string;
  overview: string;
  posterPath: string | null;
  voteAverage: number;
  /** Distinct library titles that produced this pick. */
  sourceCount: number;
  /** Names of those library titles, unique and sorted by name. */
  sourceTitles: string[];
}

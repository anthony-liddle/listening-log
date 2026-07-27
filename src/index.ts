/**
 * listening-log
 *
 * Reads a hand-maintained `listening.yaml`, aggregates plays into albums, and
 * enriches each album against the Apple Music catalog with Discogs as a
 * fallback.
 *
 * The Apple Music credentials here sign a *developer* token, which authorizes
 * the catalog endpoints under `/v1/catalog/...`. That is a deliberate boundary:
 * recently-played lives behind `/v1/me/...` and a music user token, which has
 * no documented refresh and no published lifetime. See the README.
 */

// Composable pieces, for callers who want one stage rather than the pipeline.
export { aggregateRows, matchKey } from '@/aggregate.js';
export type { AppleMusicMatch, AppleMusicOptions } from '@/apple-music.js';
export { lookupAlbumById, resolveArtworkUrl, searchAlbum } from '@/apple-music.js';
export type { DiscogsMatch, DiscogsOptions } from '@/discogs.js';
export { getRelease, searchRelease } from '@/discogs.js';
export type { Cache, CacheEntry, EnrichOptions } from '@/enrich.js';
export { enrichAlbum, hashAlbumKey, shouldRefetch } from '@/enrich.js';
export type {
  AppleMusicCredentials,
  CacheConfig,
  GetListeningLogOptions,
  ListeningYamlInput,
} from '@/orchestrator.js';
// The main entry point.
export { getListeningLog, MAX_LIMIT } from '@/orchestrator.js';
export type { ParseListeningLogResult } from '@/parse.js';
export { parseListeningLog } from '@/parse.js';
// Public data shapes.
export type {
  AggregatedAlbum,
  ListeningEntry,
  ListeningFormat,
  ListeningLogResult,
  RawListeningRow,
} from '@/types.js';

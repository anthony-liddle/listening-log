import type { JsonFetcher } from '@/http.js';
import type { ListeningFormat } from '@/types.js';

const API = 'https://api.discogs.com';

/**
 * What this package keeps from Discogs.
 *
 * Only the release ID, for now. Discogs carries far more (pressing year, label,
 * country, matrix numbers), and that depth is the obvious next thing to surface,
 * but nothing renders it yet and speculative fields age badly in a cache file.
 */
export interface DiscogsMatch {
  releaseId: number;
}

export interface DiscogsOptions {
  fetchJson: JsonFetcher;
  userToken: string;
}

/**
 * How a listening format maps onto Discogs' format vocabulary.
 *
 * `digital` is absent deliberately. Discogs catalogs pressings, and constraining
 * a search to "File" would rule out the physical release that is almost always
 * the better match for an album played through a streaming service.
 */
const DISCOGS_FORMAT: Partial<Record<ListeningFormat, string>> = {
  vinyl: 'Vinyl',
  cd: 'CD',
  cassette: 'Cassette',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Discogs release IDs are integers; anything else is not a release we can use. */
function asReleaseId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function authHeaders(options: DiscogsOptions): Record<string, string> {
  return { Authorization: `Discogs token=${options.userToken}` };
}

/**
 * Fetch a release by ID.
 *
 * This is cascade step four, and it is the one step that runs even when Apple
 * Music already matched. A yaml row naming a `discogsReleaseId` is asserting
 * something Apple Music cannot represent: which pressing this actually was.
 *
 * @returns the distilled match, or undefined when Discogs has no such release
 */
export async function getRelease(
  releaseId: number,
  options: DiscogsOptions,
): Promise<DiscogsMatch | undefined> {
  const result = await options.fetchJson(`${API}/releases/${releaseId}`, authHeaders(options));
  if (!result.ok || !isPlainObject(result.data)) {
    return undefined;
  }
  const id = asReleaseId(result.data.id);
  return id === undefined ? undefined : { releaseId: id };
}

/**
 * Search for a release by title and artist, optionally biased to a format.
 *
 * Cascade step three, reached only when Apple Music came up empty. That is the
 * common shape of a miss: a small-label cassette or a pressing that never made
 * it to streaming, which is exactly where Discogs is strongest.
 *
 * @returns the top match, or undefined when nothing matched
 */
export async function searchRelease(
  title: string,
  artist: string,
  format: ListeningFormat | undefined,
  options: DiscogsOptions,
): Promise<DiscogsMatch | undefined> {
  const query = new URLSearchParams({
    release_title: title,
    artist,
    type: 'release',
    per_page: '1',
  });
  const discogsFormat = format === undefined ? undefined : DISCOGS_FORMAT[format];
  if (discogsFormat !== undefined) {
    query.set('format', discogsFormat);
  }

  const result = await options.fetchJson(
    `${API}/database/search?${query.toString()}`,
    authHeaders(options),
  );
  if (!result.ok || !isPlainObject(result.data) || !Array.isArray(result.data.results)) {
    return undefined;
  }
  const first = result.data.results[0];
  if (!isPlainObject(first)) {
    return undefined;
  }
  const id = asReleaseId(first.id);
  return id === undefined ? undefined : { releaseId: id };
}

import type { JsonFetcher } from '@/http.js';

const CATALOG = 'https://api.music.apple.com/v1/catalog';

/**
 * What this package keeps from an Apple Music album. Distilled on purpose: the
 * cache stores this, not the raw response, so the cache file stays readable
 * when you are trying to work out why an album got the wrong cover.
 */
export interface AppleMusicMatch {
  albumId: string;
  /** Canonical music.apple.com deep link. */
  url?: string;
  /**
   * Apple's artwork URL exactly as returned, placeholders and all. Stored raw
   * rather than resolved so that changing `artworkSize` between builds takes
   * effect immediately instead of requiring a cache bust.
   */
  artworkTemplate?: string;
}

export interface AppleMusicOptions {
  fetchJson: JsonFetcher;
  /** A signed developer token. Authorizes /v1/catalog, never /v1/me. */
  developerToken: string;
  /** ISO 3166 alpha-2 storefront code. Every catalog endpoint requires one. */
  storefront: string;
}

/**
 * Turn Apple's artwork template into a URL a browser can actually load.
 *
 * Apple returns something like `.../{w}x{h}bb.jpg`, with those braces literal.
 * A template used unmodified as an img src is a broken image on the page, so
 * the substitution happens here, at output time.
 */
export function resolveArtworkUrl(template: string, size: number): string {
  return template.replace('{w}', String(size)).replace('{h}', String(size));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Narrow one album resource from a catalog response into the fields we keep. */
function distill(album: unknown): AppleMusicMatch | undefined {
  if (!isPlainObject(album)) {
    return undefined;
  }
  const albumId = asString(album.id);
  if (albumId === undefined) {
    return undefined;
  }
  const attributes = isPlainObject(album.attributes) ? album.attributes : {};
  const artwork = isPlainObject(attributes.artwork) ? attributes.artwork : undefined;
  return {
    albumId,
    url: asString(attributes.url),
    artworkTemplate: artwork ? asString(artwork.url) : undefined,
  };
}

/** The first album in a `{ data: [...] }` envelope. */
function firstFromData(payload: unknown): AppleMusicMatch | undefined {
  if (!isPlainObject(payload) || !Array.isArray(payload.data)) {
    return undefined;
  }
  return distill(payload.data[0]);
}

function authHeaders(options: AppleMusicOptions): Record<string, string> {
  return { Authorization: `Bearer ${options.developerToken}` };
}

/**
 * Fetch one album by its catalog ID.
 *
 * `GET /v1/catalog/{storefront}/albums/{id}`
 *
 * This is cascade step one, taken whenever a yaml row names an album ID. It is
 * the only exact path: everything else is a search, with a search's ambiguity.
 *
 * @returns the distilled match, or undefined when the catalog has no such album
 */
export async function lookupAlbumById(
  albumId: string,
  options: AppleMusicOptions,
): Promise<AppleMusicMatch | undefined> {
  const url = `${CATALOG}/${options.storefront}/albums/${encodeURIComponent(albumId)}`;
  const result = await options.fetchJson(url, authHeaders(options));
  return result.ok ? firstFromData(result.data) : undefined;
}

/**
 * Search the catalog for an album by title and artist.
 *
 * `GET /v1/catalog/{storefront}/search?term=...&types=albums&limit=1`
 *
 * Apple's `term` uses `+` between words, which is exactly what URLSearchParams
 * produces for a space, so the query is built with it rather than by hand.
 *
 * Cascade step two. Only the top result is considered: past the first hit the
 * matches get speculative fast, and a wrong cover is worse than none. When this
 * picks badly, the fix is to pin `appleMusicAlbumId` on the yaml row.
 *
 * @returns the distilled top match, or undefined when nothing matched
 */
export async function searchAlbum(
  title: string,
  artist: string,
  options: AppleMusicOptions,
): Promise<AppleMusicMatch | undefined> {
  const query = new URLSearchParams({
    term: `${title} ${artist}`,
    types: 'albums',
    limit: '1',
  });
  const url = `${CATALOG}/${options.storefront}/search?${query.toString()}`;
  const result = await options.fetchJson(url, authHeaders(options));
  if (!result.ok || !isPlainObject(result.data)) {
    return undefined;
  }
  const results = isPlainObject(result.data.results) ? result.data.results : {};
  const albums = isPlainObject(results.albums) ? results.albums : undefined;
  return albums ? firstFromData(albums) : undefined;
}

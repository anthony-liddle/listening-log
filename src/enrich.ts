import { createHash } from 'node:crypto';
import {
  type AppleMusicMatch,
  lookupAlbumById,
  resolveArtworkUrl,
  searchAlbum,
} from '@/apple-music.js';
import { type DiscogsMatch, getRelease, searchRelease } from '@/discogs.js';
import type { JsonFetcher, JsonResult } from '@/http.js';
import type { AggregatedAlbum, ListeningEntry } from '@/types.js';

/**
 * One row of the cache file.
 *
 * The two match shapes share a row type rather than splitting into separate
 * files because the key prefix already says which one is populated, and one
 * git-tracked JSON file is easier to read through than two.
 */
export interface CacheEntry {
  /** ISO date (YYYY-MM-DD) this row was written. */
  fetchedAt: string;
  /** The key this row is filed under. Duplicated into the value so the file reads on its own. */
  key: string;
  /**
   * The service answered clearly that it has nothing. Distinct from an absent
   * row, which means "never asked", and from a failure, which is never written.
   */
  notFound?: boolean;
  appleMusic?: AppleMusicMatch;
  discogs?: DiscogsMatch;
}

/** The cache file. Keys are namespaced: `am:id:`, `am:q:`, `dg:id:`, `dg:q:`. */
export type Cache = Record<string, CacheEntry>;

export interface EnrichOptions {
  fetchJson: JsonFetcher;
  /** A signed Apple Music developer token. */
  developerToken: string;
  /** ISO 3166 alpha-2 storefront code. */
  storefront: string;
  /** Pixel size to resolve artwork templates at. */
  artworkSize: number;
  /** Mutated in place; the orchestrator writes it to disk afterward. */
  cache: Cache;
  /** Soft failures are appended here. */
  warnings: string[];
  /** When absent, the Discogs steps of the cascade are skipped entirely. */
  discogsToken?: string;
  /** Refetch rows older than this many days. Default 180. */
  maxAgeDays?: number;
  /** Force a refetch of these keys, however fresh they are. */
  bust?: string[];
}

const DEFAULT_MAX_AGE_DAYS = 180;

/** Normalize for hashing exactly as the aggregator normalizes for matching. */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * A compact, stable cache key for a title-and-artist lookup.
 *
 * Searches have no ID to file under until after they resolve, so the query
 * itself becomes the key. Sixteen hex characters is far more than enough to
 * keep a personal listening log collision-free, and it keeps the cache file
 * scannable.
 */
export function hashAlbumKey(title: string, artist: string): string {
  return createHash('sha256')
    .update(`${normalize(title)}|${normalize(artist)}`)
    .digest('hex')
    .slice(0, 16);
}

/** True when a cache row is older than maxAgeDays and should be refetched. */
export function shouldRefetch(entry: CacheEntry, maxAgeDays: number): boolean {
  const ageDays = (Date.now() - new Date(entry.fetchedAt).getTime()) / 86_400_000;
  return ageDays > maxAgeDays;
}

/**
 * Enrich one album through the cascade, consulting and updating the cache.
 *
 * The cascade never fails hard. An album that matches nothing still comes back
 * as a complete entry built from what the yaml row said, plus a warning. A
 * missing cover is a worse page; a thrown error is no page.
 *
 * @param album an aggregated album, already stripped of private plays
 * @returns the entry, enriched as far as the cascade got
 */
export async function enrichAlbum(
  album: AggregatedAlbum,
  options: EnrichOptions,
): Promise<ListeningEntry> {
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const bust = new Set(options.bust ?? []);
  const today = new Date().toISOString().slice(0, 10);

  /**
   * Whether the current lookup hit a transport or HTTP failure. Tracked by
   * wrapping the fetcher so a failure never gets written to the cache as though
   * it were an answer: a service that did not respond taught us nothing, and
   * remembering it as "not found" would hide the album for six months.
   */
  let failed = false;
  const fetchJson: JsonFetcher = async (url, headers) => {
    const result: JsonResult = await options.fetchJson(url, headers);
    if (!result.ok && result.failed) {
      failed = true;
    }
    return result;
  };

  const appleOptions = {
    fetchJson,
    developerToken: options.developerToken,
    storefront: options.storefront,
  };

  /** A cache row usable right now: present, not busted, not stale. */
  const usable = (key: string): CacheEntry | undefined => {
    const row = options.cache[key];
    if (row === undefined || bust.has(key) || shouldRefetch(row, maxAgeDays)) {
      return undefined;
    }
    return row;
  };

  /**
   * Run a lookup through the cache: serve a usable row, otherwise fetch, then
   * record the outcome. A failure is deliberately not recorded.
   */
  async function cached<K extends 'appleMusic' | 'discogs'>(
    key: string,
    field: K,
    lookup: () => Promise<CacheEntry[K]>,
  ): Promise<CacheEntry[K]> {
    const row = usable(key);
    if (row !== undefined) {
      return row[field];
    }

    failed = false;
    const match = await lookup();

    if (failed) {
      return undefined;
    }
    options.cache[key] =
      match === undefined
        ? { fetchedAt: today, key, notFound: true }
        : { fetchedAt: today, key, [field]: match };
    return match;
  }

  // Steps 1 and 2. A row that names an album ID gets an exact lookup; anything
  // else gets a search. They are alternatives, never both.
  const apple = album.appleMusicAlbumId
    ? await cached(`am:id:${album.appleMusicAlbumId}`, 'appleMusic', () =>
        lookupAlbumById(album.appleMusicAlbumId as string, appleOptions),
      )
    : await cached(`am:q:${hashAlbumKey(album.title, album.artist)}`, 'appleMusic', () =>
        searchAlbum(album.title, album.artist, appleOptions),
      );

  let discogs: DiscogsMatch | undefined;

  if (options.discogsToken !== undefined) {
    const discogsOptions = { fetchJson, userToken: options.discogsToken };

    // Step 4. An explicit release ID is a claim about which pressing this was,
    // which Apple Music cannot express, so it is fetched even on an Apple hit.
    if (album.discogsReleaseId !== undefined) {
      discogs = await cached(`dg:id:${album.discogsReleaseId}`, 'discogs', () =>
        getRelease(album.discogsReleaseId as number, discogsOptions),
      );
    } else if (apple === undefined) {
      // Step 3. Only worth the request when Apple Music came up empty.
      discogs = await cached(`dg:q:${hashAlbumKey(album.title, album.artist)}`, 'discogs', () =>
        searchRelease(album.title, album.artist, album.format, discogsOptions),
      );
    }
  }

  const entry: ListeningEntry = {
    title: album.title,
    artist: album.artist,
    format: album.format,
    playedAt: album.playedAt,
    playCount: album.playCount,
    source: album.source,
  };

  if (apple !== undefined) {
    entry.appleMusicAlbumId = apple.albumId;
    entry.appleMusicUrl = apple.url;
    if (apple.artworkTemplate !== undefined) {
      entry.artwork = {
        url: resolveArtworkUrl(apple.artworkTemplate, options.artworkSize),
        width: options.artworkSize,
        height: options.artworkSize,
      };
    }
  }

  // The row's own release ID stands even if the fetch missed. The user wrote it
  // down; a Discogs miss is not grounds for discarding what they recorded.
  entry.discogsReleaseId = discogs?.releaseId ?? album.discogsReleaseId;

  if (apple === undefined && entry.discogsReleaseId === undefined) {
    options.warnings.push(
      `No catalog match for '${album.title}' by ${album.artist}; the entry keeps its logged data only`,
    );
  }

  return entry;
}

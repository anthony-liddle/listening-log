import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { pemFromBase64, signDeveloperToken } from 'apple-music-developer-token';
import { aggregateRows } from '@/aggregate.js';
import { type Cache, enrichAlbum } from '@/enrich.js';
import { createJsonFetcher } from '@/http.js';
import { parseListeningLog } from '@/parse.js';
import type { ListeningLogResult } from '@/types.js';

/** Where the listening log comes from. The package parses a string; fetching is yours. */
export type ListeningYamlInput =
  | { path: string }
  | { content: string; format?: 'yaml' | 'json' }
  | { fetch: () => Promise<string> };

/**
 * Apple Music credentials, in either of two shapes.
 *
 * Raw credentials are the convenient default: hand over the same environment
 * variables you already have and signing happens internally. A pre-signed token
 * is the escape hatch for a build that already signs one somewhere else and
 * would rather not mint a second.
 */
export type AppleMusicCredentials =
  | { developerToken: string }
  | { keyId: string; teamId: string; privateKeyBase64: string };

export type CacheConfig = false | string | { path: string; maxAgeDays?: number; bust?: string[] };

export interface GetListeningLogOptions {
  listeningYaml: ListeningYamlInput;
  appleMusic: AppleMusicCredentials;
  /** Without this, the Discogs steps of the cascade never run. */
  discogs?: { userToken: string };
  /** Cap on returned entries, clamped to {@link MAX_LIMIT}. */
  limit?: number;
  cache?: CacheConfig;
  /** Required: Discogs asks callers to identify themselves. */
  userAgent: string;
  /** ISO 3166 alpha-2 storefront code. Default 'us'. */
  storefront?: string;
  /** Pixel size to resolve Apple artwork at. Default 500. */
  artworkSize?: number;
  /** Minimum ms between outbound requests. Default 1000. */
  rateLimitMs?: number;
  /** Override fetch. Exists so tests never reach the network. */
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * The most entries this package will return.
 *
 * The surface it feeds shows a handful of albums. A cap keeps a runaway log
 * from turning a page build into a few hundred catalog requests.
 */
export const MAX_LIMIT = 50;

const DEFAULT_STOREFRONT = 'us';
const DEFAULT_ARTWORK_SIZE = 500;
const DEFAULT_RATE_LIMIT_MS = 1000;

/** Map a file extension to a parser. Unknown extensions get no guess. */
function inferFormatFromPath(path: string): 'yaml' | 'json' | undefined {
  const ext = extname(path).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') {
    return 'yaml';
  }
  return ext === '.json' ? 'json' : undefined;
}

/** Resolve the input to text plus a parser choice, reporting problems as warnings. */
async function resolveInput(
  input: ListeningYamlInput,
  warnings: string[],
): Promise<{ content: string; format: 'yaml' | 'json' } | undefined> {
  try {
    if ('content' in input) {
      return { content: input.content, format: input.format ?? 'yaml' };
    }
    if ('fetch' in input) {
      return { content: await input.fetch(), format: 'yaml' };
    }
    const format = inferFormatFromPath(input.path);
    if (format === undefined) {
      warnings.push(`${input.path} has an unrecognized extension; expected .yaml, .yml, or .json`);
      return undefined;
    }
    return { content: await readFile(input.path, 'utf-8'), format };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Could not read the listening log: ${message}`);
    return undefined;
  }
}

/** Normalize the three cache shapes into one. */
function resolveCacheConfig(
  cache: CacheConfig | undefined,
): { path: string; maxAgeDays?: number; bust?: string[] } | undefined {
  if (cache === undefined || cache === false) {
    return undefined;
  }
  return typeof cache === 'string' ? { path: cache } : cache;
}

/**
 * Read the cache file. A missing file is the ordinary first-build case and is
 * not worth a warning. Anything else that goes wrong warns and starts fresh,
 * so a corrupt cache costs a slow build rather than a failed one.
 */
async function readCacheFile(path: string, warnings: string[]): Promise<Cache> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {};
    }
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Cache file ${path} could not be read (${message}); starting fresh`);
    return {};
  }
  try {
    return JSON.parse(raw) as Cache;
  } catch {
    warnings.push(`Cache file ${path} is not valid JSON; starting fresh`);
    return {};
  }
}

/**
 * Write the cache atomically: a sibling temp file, then a rename over the
 * target. The cache is git-tracked, and a build interrupted mid-write should
 * not leave a half-written file staged.
 */
async function writeCacheFile(path: string, cache: Cache): Promise<void> {
  const tmp = `${path}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`, 'utf-8');
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/**
 * Produce a developer token, signing one when given raw credentials.
 *
 * Signing happens once per run rather than once per album: the token is valid
 * for the whole build, and re-signing per request would be pure ceremony.
 */
async function resolveDeveloperToken(credentials: AppleMusicCredentials): Promise<string> {
  if ('developerToken' in credentials) {
    return credentials.developerToken;
  }
  return signDeveloperToken({
    privateKey: pemFromBase64(credentials.privateKeyBase64),
    keyId: credentials.keyId,
    teamId: credentials.teamId,
  });
}

/**
 * Read a listening log and return recent albums, enriched.
 *
 * The pipeline runs in a fixed order, and the order matters:
 *
 * 1. Resolve and parse the source.
 * 2. Drop private rows.
 * 3. Aggregate plays into albums.
 * 4. Enrich each album once.
 * 5. Sort by playedAt, most recent first.
 * 6. Clamp to the limit.
 *
 * Step two lands before step three deliberately. A private row that reached the
 * aggregator would inflate playCount and could hand an album its format, source,
 * or catalog ID through a play the user asked to keep out of the output.
 *
 * Nothing here throws for data reasons. Bad rows, unreachable catalogs, and
 * corrupt caches all degrade to warnings, because a personal site should still
 * build when Discogs is having an afternoon.
 */
export async function getListeningLog(
  options: GetListeningLogOptions,
): Promise<ListeningLogResult> {
  const warnings: string[] = [];

  const source = await resolveInput(options.listeningYaml, warnings);
  if (source === undefined) {
    return { entries: [], warnings };
  }

  const parsed = parseListeningLog(source.content, source.format);
  warnings.push(...parsed.warnings);

  // Private rows drop inside aggregateRows, before any merging happens.
  const albums = aggregateRows(parsed.rows);

  const cacheConfig = resolveCacheConfig(options.cache);
  const cache = cacheConfig ? await readCacheFile(cacheConfig.path, warnings) : {};

  const fetchJson = createJsonFetcher({
    fetchImpl: options.fetchImpl,
    userAgent: options.userAgent,
    rateLimitMs: options.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS,
    // One shared budget, so the rate limit means something across both services.
    rateLimiterState: { nextAllowedAt: 0 },
    warnings,
  });

  const developerToken = await resolveDeveloperToken(options.appleMusic);

  const entries = [];
  for (const albumToEnrich of albums) {
    entries.push(
      await enrichAlbum(albumToEnrich, {
        fetchJson,
        developerToken,
        storefront: options.storefront ?? DEFAULT_STOREFRONT,
        artworkSize: options.artworkSize ?? DEFAULT_ARTWORK_SIZE,
        cache,
        warnings,
        discogsToken: options.discogs?.userToken,
        maxAgeDays: cacheConfig?.maxAgeDays,
        bust: cacheConfig?.bust,
      }),
    );
  }

  // ISO dates compare correctly as strings, so no Date objects are needed.
  entries.sort((a, b) => (a.playedAt < b.playedAt ? 1 : a.playedAt > b.playedAt ? -1 : 0));

  let limited = entries;
  if (options.limit !== undefined) {
    if (options.limit > MAX_LIMIT) {
      warnings.push(
        `limit of ${options.limit} exceeds the maximum of ${MAX_LIMIT}; returning at most ${MAX_LIMIT} entries`,
      );
    }
    limited = entries.slice(0, Math.max(0, Math.min(options.limit, MAX_LIMIT)));
  } else if (entries.length > MAX_LIMIT) {
    warnings.push(`Returning the ${MAX_LIMIT} most recent of ${entries.length} albums`);
    limited = entries.slice(0, MAX_LIMIT);
  }

  if (cacheConfig) {
    await writeCacheFile(cacheConfig.path, cache);
  }

  return {
    entries: limited,
    warnings,
    // Entries are sorted descending, so the first is the most recent.
    lastEntryDate: limited[0]?.playedAt,
  };
}

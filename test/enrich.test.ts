import { describe, expect, test, vi } from 'vitest';
import { type Cache, enrichAlbum, hashAlbumKey, shouldRefetch } from '@/enrich.js';
import { createJsonFetcher } from '@/http.js';
import type { AggregatedAlbum } from '@/types.js';

const CATALOG = 'https://api.music.apple.com/v1/catalog';
const DISCOGS = 'https://api.discogs.com';

const APPLE_ALBUM = {
  id: '1109714933',
  attributes: {
    name: 'Kid A',
    artistName: 'Radiohead',
    url: 'https://music.apple.com/us/album/kid-a/1109714933',
    artwork: { url: 'https://art.test/{w}x{h}bb.jpg', width: 3000, height: 3000 },
  },
};

function album(overrides: Partial<AggregatedAlbum> = {}): AggregatedAlbum {
  return {
    title: 'Kid A',
    artist: 'Radiohead',
    format: 'vinyl',
    playedAt: '2026-05-28',
    playCount: 1,
    ...overrides,
  };
}

/** Build enrich options over a canned route table. */
function harness(routes: Record<string, { status?: number; body?: unknown }>) {
  const seen: string[] = [];
  const warnings: string[] = [];
  const impl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const key = String(url);
    seen.push(key);
    const route = routes[key] ?? { status: 404 };
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      json: async () => route.body,
    } as Response;
  });
  const fetchJson = createJsonFetcher({
    fetchImpl: impl,
    userAgent: 'ua',
    rateLimitMs: 0,
    warnings,
  });
  return { fetchJson, seen, warnings };
}

const byIdRoute = (id: string) => `${CATALOG}/us/albums/${id}`;
const searchRoute = (term: string) => `${CATALOG}/us/search?term=${term}&types=albums&limit=1`;

/** Standard options, with Apple Music configured and Discogs off unless asked. */
function options(
  h: ReturnType<typeof harness>,
  extra: { discogsToken?: string; cache?: Cache; maxAgeDays?: number; bust?: string[] } = {},
) {
  return {
    fetchJson: h.fetchJson,
    developerToken: 'jwt',
    storefront: 'us',
    artworkSize: 500,
    cache: extra.cache ?? {},
    warnings: h.warnings,
    discogsToken: extra.discogsToken,
    maxAgeDays: extra.maxAgeDays,
    bust: extra.bust,
  };
}

describe('shouldRefetch', () => {
  test('is false for an entry fetched today', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(shouldRefetch({ fetchedAt: today, key: 'am:id:1' }, 180)).toBe(false);
  });

  test('is true for an entry older than maxAgeDays', () => {
    expect(shouldRefetch({ fetchedAt: '2000-01-01', key: 'am:id:1' }, 180)).toBe(true);
  });
});

describe('hashAlbumKey', () => {
  test('is stable across case and whitespace differences', () => {
    expect(hashAlbumKey('Kid A', 'Radiohead')).toBe(hashAlbumKey('  kid a ', 'RADIOHEAD'));
  });

  test('differs for different albums', () => {
    expect(hashAlbumKey('Kid A', 'Radiohead')).not.toBe(hashAlbumKey('Damaged', 'Black Flag'));
  });
});

describe('enrichAlbum cascade', () => {
  test('step 1: looks the album up by id when the row names one', async () => {
    const h = harness({ [byIdRoute('1109714933')]: { body: { data: [APPLE_ALBUM] } } });

    const entry = await enrichAlbum(album({ appleMusicAlbumId: '1109714933' }), options(h));

    expect(h.seen).toEqual([byIdRoute('1109714933')]);
    expect(entry.appleMusicAlbumId).toBe('1109714933');
    expect(entry.appleMusicUrl).toBe('https://music.apple.com/us/album/kid-a/1109714933');
  });

  test('step 2: searches by title and artist when no id is given', async () => {
    const h = harness({
      [searchRoute('Kid+A+Radiohead')]: { body: { results: { albums: { data: [APPLE_ALBUM] } } } },
    });

    const entry = await enrichAlbum(album(), options(h));

    expect(h.seen).toEqual([searchRoute('Kid+A+Radiohead')]);
    expect(entry.appleMusicAlbumId).toBe('1109714933');
  });

  test('resolves artwork to a usable URL at the configured size', async () => {
    const h = harness({
      [searchRoute('Kid+A+Radiohead')]: { body: { results: { albums: { data: [APPLE_ALBUM] } } } },
    });

    const entry = await enrichAlbum(album(), options(h));

    expect(entry.artwork).toEqual({
      url: 'https://art.test/500x500bb.jpg',
      width: 500,
      height: 500,
    });
  });

  test('step 3: falls back to a Discogs search when Apple Music misses', async () => {
    const search = `${DISCOGS}/database/search?release_title=Kid+A&artist=Radiohead&type=release&per_page=1&format=Vinyl`;
    const h = harness({ [search]: { body: { results: [{ id: 999 }] } } });

    const entry = await enrichAlbum(album(), options(h, { discogsToken: 'tok' }));

    expect(entry.discogsReleaseId).toBe(999);
  });

  test('does not fall back to Discogs when it is not configured', async () => {
    const h = harness({});

    const entry = await enrichAlbum(album(), options(h));

    expect(entry.discogsReleaseId).toBeUndefined();
    expect(h.seen.every((url) => !url.includes('discogs'))).toBe(true);
  });

  test('does not fall back to Discogs when Apple Music already matched', async () => {
    const h = harness({
      [searchRoute('Kid+A+Radiohead')]: { body: { results: { albums: { data: [APPLE_ALBUM] } } } },
    });

    await enrichAlbum(album(), options(h, { discogsToken: 'tok' }));

    expect(h.seen.some((url) => url.includes('database/search'))).toBe(false);
  });

  /** Step 4 is the pressing-provenance path, and it runs regardless of Apple. */
  test('step 4: fetches a named Discogs release even when Apple Music matched', async () => {
    const h = harness({
      [byIdRoute('1109714933')]: { body: { data: [APPLE_ALBUM] } },
      [`${DISCOGS}/releases/384821`]: { body: { id: 384821 } },
    });

    const entry = await enrichAlbum(
      album({ appleMusicAlbumId: '1109714933', discogsReleaseId: 384821 }),
      options(h, { discogsToken: 'tok' }),
    );

    expect(entry.appleMusicAlbumId).toBe('1109714933');
    expect(entry.discogsReleaseId).toBe(384821);
    expect(h.seen).toContain(`${DISCOGS}/releases/384821`);
  });

  test('step 5: still emits the entry from source data when everything misses', async () => {
    const h = harness({});

    const entry = await enrichAlbum(album({ source: 'the shelf' }), options(h));

    expect(entry).toMatchObject({
      title: 'Kid A',
      artist: 'Radiohead',
      format: 'vinyl',
      playedAt: '2026-05-28',
      playCount: 1,
      source: 'the shelf',
    });
    expect(entry.appleMusicAlbumId).toBeUndefined();
  });

  test('warns when an album matches nothing at all', async () => {
    const h = harness({});

    await enrichAlbum(album(), options(h));

    expect(h.warnings.some((w) => w.includes('Kid A'))).toBe(true);
  });

  test('keeps the row-supplied discogsReleaseId even when the fetch misses', async () => {
    const h = harness({});

    const entry = await enrichAlbum(
      album({ discogsReleaseId: 384821 }),
      options(h, { discogsToken: 'tok' }),
    );

    expect(entry.discogsReleaseId).toBe(384821);
  });
});

describe('enrichAlbum cache', () => {
  test('writes an Apple Music hit under an am:id key', async () => {
    const h = harness({ [byIdRoute('111')]: { body: { data: [APPLE_ALBUM] } } });
    const cache: Cache = {};

    await enrichAlbum(album({ appleMusicAlbumId: '111' }), options(h, { cache }));

    expect(Object.keys(cache)).toEqual(['am:id:111']);
    expect(cache['am:id:111']?.appleMusic?.albumId).toBe('1109714933');
  });

  test('writes a search hit under an am:q key', async () => {
    const h = harness({
      [searchRoute('Kid+A+Radiohead')]: { body: { results: { albums: { data: [APPLE_ALBUM] } } } },
    });
    const cache: Cache = {};

    await enrichAlbum(album(), options(h, { cache }));

    expect(Object.keys(cache)).toEqual([`am:q:${hashAlbumKey('Kid A', 'Radiohead')}`]);
  });

  test('serves a warm cache without any network call', async () => {
    const h = harness({});
    const cache: Cache = {
      'am:id:111': {
        fetchedAt: new Date().toISOString().slice(0, 10),
        key: 'am:id:111',
        appleMusic: { albumId: '111', url: 'u', artworkTemplate: 'https://art.test/{w}x{h}.jpg' },
      },
    };

    const entry = await enrichAlbum(album({ appleMusicAlbumId: '111' }), options(h, { cache }));

    expect(h.seen).toEqual([]);
    expect(entry.appleMusicUrl).toBe('u');
  });

  /**
   * The template is what gets cached, so changing artworkSize takes effect on
   * the next build instead of waiting for a bust.
   */
  test('resolves artwork from a cached template at the current size', async () => {
    const h = harness({});
    const cache: Cache = {
      'am:id:111': {
        fetchedAt: new Date().toISOString().slice(0, 10),
        key: 'am:id:111',
        appleMusic: { albumId: '111', artworkTemplate: 'https://art.test/{w}x{h}.jpg' },
      },
    };

    const entry = await enrichAlbum(album({ appleMusicAlbumId: '111' }), {
      ...options(h, { cache }),
      artworkSize: 1200,
    });

    expect(entry.artwork?.url).toBe('https://art.test/1200x1200.jpg');
    expect(entry.artwork?.width).toBe(1200);
  });

  test('remembers a definitive miss so the next build skips the request', async () => {
    const h = harness({});
    const cache: Cache = {};

    await enrichAlbum(album({ appleMusicAlbumId: '111' }), options(h, { cache }));

    expect(cache['am:id:111']?.notFound).toBe(true);
  });

  test('refetches an entry older than maxAgeDays', async () => {
    const h = harness({ [byIdRoute('111')]: { body: { data: [APPLE_ALBUM] } } });
    const cache: Cache = {
      'am:id:111': { fetchedAt: '2000-01-01', key: 'am:id:111', notFound: true },
    };

    await enrichAlbum(album({ appleMusicAlbumId: '111' }), options(h, { cache, maxAgeDays: 180 }));

    expect(h.seen).toEqual([byIdRoute('111')]);
  });

  test('refetches a busted key even when it is fresh', async () => {
    const h = harness({ [byIdRoute('111')]: { body: { data: [APPLE_ALBUM] } } });
    const cache: Cache = {
      'am:id:111': {
        fetchedAt: new Date().toISOString().slice(0, 10),
        key: 'am:id:111',
        notFound: true,
      },
    };

    await enrichAlbum(
      album({ appleMusicAlbumId: '111' }),
      options(h, { cache, bust: ['am:id:111'] }),
    );

    expect(h.seen).toEqual([byIdRoute('111')]);
  });

  /**
   * A service that failed to answer taught us nothing. Caching that as a fact
   * would turn one bad afternoon into six months of missing covers.
   */
  test('does not cache anything when the request failed at the transport layer', async () => {
    const h = harness({ [byIdRoute('111')]: { status: 503 } });
    const cache: Cache = {};

    await enrichAlbum(album({ appleMusicAlbumId: '111' }), options(h, { cache }));

    expect(cache).toEqual({});
  });

  test('writes a Discogs hit under a dg:id key', async () => {
    const h = harness({ [`${DISCOGS}/releases/384821`]: { body: { id: 384821 } } });
    const cache: Cache = {};

    await enrichAlbum(
      album({ appleMusicAlbumId: 'x', discogsReleaseId: 384821 }),
      options(h, { cache, discogsToken: 'tok' }),
    );

    expect(cache['dg:id:384821']?.discogs?.releaseId).toBe(384821);
  });
});

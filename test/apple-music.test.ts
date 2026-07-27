import { describe, expect, test, vi } from 'vitest';
import { lookupAlbumById, resolveArtworkUrl, searchAlbum } from '@/apple-music.js';
import { createJsonFetcher } from '@/http.js';

/** One album object shaped like Apple's catalog response. */
const ALBUM = {
  id: '1109714933',
  type: 'albums',
  attributes: {
    name: 'Kid A',
    artistName: 'Radiohead',
    url: 'https://music.apple.com/us/album/kid-a/1109714933',
    artwork: {
      url: 'https://is1-ssl.mzstatic.com/image/thumb/abc/{w}x{h}bb.jpg',
      width: 3000,
      height: 3000,
    },
  },
};

/** A fetcher over a canned URL-to-response map, plus the URLs it was asked for. */
function fetcherFor(routes: Record<string, { status?: number; body?: unknown }>) {
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
  return {
    fetchJson: createJsonFetcher({ fetchImpl: impl, userAgent: 'ua', rateLimitMs: 0, warnings }),
    seen,
    warnings,
    impl,
  };
}

const BASE = 'https://api.music.apple.com/v1/catalog';

describe('resolveArtworkUrl', () => {
  /**
   * Apple hands back a template, not a URL. Dropped into an img src unmodified
   * it does not load, which is the sort of thing that looks fine in a test and
   * breaks on the page.
   */
  test('substitutes the requested size into the {w}x{h} placeholders', () => {
    expect(resolveArtworkUrl('https://example.test/{w}x{h}bb.jpg', 500)).toBe(
      'https://example.test/500x500bb.jpg',
    );
  });

  test('leaves a template without placeholders untouched', () => {
    expect(resolveArtworkUrl('https://example.test/fixed.jpg', 500)).toBe(
      'https://example.test/fixed.jpg',
    );
  });
});

describe('lookupAlbumById', () => {
  test('requests the documented by-id endpoint for the given storefront', async () => {
    const { fetchJson, seen } = fetcherFor({
      [`${BASE}/us/albums/1109714933`]: { body: { data: [ALBUM] } },
    });

    await lookupAlbumById('1109714933', { fetchJson, developerToken: 't', storefront: 'us' });

    expect(seen).toEqual([`${BASE}/us/albums/1109714933`]);
  });

  test('honors a non-default storefront', async () => {
    const { fetchJson, seen } = fetcherFor({
      [`${BASE}/gb/albums/123`]: { body: { data: [ALBUM] } },
    });

    await lookupAlbumById('123', { fetchJson, developerToken: 't', storefront: 'gb' });

    expect(seen[0]).toContain('/gb/albums/123');
  });

  test('sends the developer token as a bearer credential', async () => {
    const { fetchJson, impl } = fetcherFor({
      [`${BASE}/us/albums/1109714933`]: { body: { data: [ALBUM] } },
    });

    await lookupAlbumById('1109714933', {
      fetchJson,
      developerToken: 'signed-jwt',
      storefront: 'us',
    });

    const headers = (impl.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer signed-jwt');
  });

  test('distills the album into id, url, and the raw artwork template', async () => {
    const { fetchJson } = fetcherFor({
      [`${BASE}/us/albums/1109714933`]: { body: { data: [ALBUM] } },
    });

    const match = await lookupAlbumById('1109714933', {
      fetchJson,
      developerToken: 't',
      storefront: 'us',
    });

    expect(match).toEqual({
      albumId: '1109714933',
      url: 'https://music.apple.com/us/album/kid-a/1109714933',
      artworkTemplate: 'https://is1-ssl.mzstatic.com/image/thumb/abc/{w}x{h}bb.jpg',
    });
  });

  test('returns undefined when the catalog has no such album', async () => {
    const { fetchJson } = fetcherFor({});

    const match = await lookupAlbumById('nope', {
      fetchJson,
      developerToken: 't',
      storefront: 'us',
    });

    expect(match).toBeUndefined();
  });

  test('returns undefined when the response has an empty data array', async () => {
    const { fetchJson } = fetcherFor({
      [`${BASE}/us/albums/1109714933`]: { body: { data: [] } },
    });

    const match = await lookupAlbumById('1109714933', {
      fetchJson,
      developerToken: 't',
      storefront: 'us',
    });

    expect(match).toBeUndefined();
  });

  test('tolerates an album with no artwork', async () => {
    const { fetchJson } = fetcherFor({
      [`${BASE}/us/albums/1`]: {
        body: { data: [{ id: '1', attributes: { name: 'X', artistName: 'Y', url: 'u' } }] },
      },
    });

    const match = await lookupAlbumById('1', { fetchJson, developerToken: 't', storefront: 'us' });

    expect(match).toEqual({ albumId: '1', url: 'u', artworkTemplate: undefined });
  });
});

describe('searchAlbum', () => {
  test('searches the documented endpoint with types=albums', async () => {
    const url = `${BASE}/us/search?term=Kid+A+Radiohead&types=albums&limit=1`;
    const { fetchJson, seen } = fetcherFor({
      [url]: { body: { results: { albums: { data: [ALBUM] } } } },
    });

    await searchAlbum('Kid A', 'Radiohead', {
      fetchJson,
      developerToken: 't',
      storefront: 'us',
    });

    expect(seen).toEqual([url]);
  });

  test('distills the first search result', async () => {
    const url = `${BASE}/us/search?term=Kid+A+Radiohead&types=albums&limit=1`;
    const { fetchJson } = fetcherFor({
      [url]: { body: { results: { albums: { data: [ALBUM] } } } },
    });

    const match = await searchAlbum('Kid A', 'Radiohead', {
      fetchJson,
      developerToken: 't',
      storefront: 'us',
    });

    expect(match?.albumId).toBe('1109714933');
  });

  test('returns undefined when the search finds no albums', async () => {
    const url = `${BASE}/us/search?term=Nope+Nobody&types=albums&limit=1`;
    const { fetchJson } = fetcherFor({ [url]: { body: { results: {} } } });

    const match = await searchAlbum('Nope', 'Nobody', {
      fetchJson,
      developerToken: 't',
      storefront: 'us',
    });

    expect(match).toBeUndefined();
  });

  test('percent-encodes characters that would break the query', async () => {
    const { fetchJson, seen } = fetcherFor({});

    await searchAlbum('Rock & Roll', 'AC/DC', {
      fetchJson,
      developerToken: 't',
      storefront: 'us',
    });

    expect(seen[0]).toContain('term=Rock+%26+Roll+AC%2FDC');
  });
});

import { describe, expect, test, vi } from 'vitest';
import { getRelease, searchRelease } from '@/discogs.js';
import { createJsonFetcher } from '@/http.js';

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

const BASE = 'https://api.discogs.com';

describe('getRelease', () => {
  test('requests the release endpoint by id', async () => {
    const { fetchJson, seen } = fetcherFor({
      [`${BASE}/releases/384821`]: { body: { id: 384821 } },
    });

    await getRelease(384821, { fetchJson, userToken: 'tok' });

    expect(seen).toEqual([`${BASE}/releases/384821`]);
  });

  test('authorizes with a Discogs token header', async () => {
    const { fetchJson, impl } = fetcherFor({
      [`${BASE}/releases/384821`]: { body: { id: 384821 } },
    });

    await getRelease(384821, { fetchJson, userToken: 'tok' });

    const headers = (impl.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Discogs token=tok');
  });

  test('returns the release id on a hit', async () => {
    const { fetchJson } = fetcherFor({
      [`${BASE}/releases/384821`]: { body: { id: 384821, title: 'Damaged' } },
    });

    expect(await getRelease(384821, { fetchJson, userToken: 'tok' })).toEqual({
      releaseId: 384821,
    });
  });

  test('returns undefined when the release does not exist', async () => {
    const { fetchJson } = fetcherFor({});

    expect(await getRelease(1, { fetchJson, userToken: 'tok' })).toBeUndefined();
  });
});

describe('searchRelease', () => {
  test('searches by release title and artist', async () => {
    const url = `${BASE}/database/search?release_title=Damaged&artist=Black+Flag&type=release&per_page=1`;
    const { fetchJson, seen } = fetcherFor({
      [url]: { body: { results: [{ id: 384821 }] } },
    });

    await searchRelease('Damaged', 'Black Flag', undefined, { fetchJson, userToken: 'tok' });

    expect(seen).toEqual([url]);
  });

  /**
   * Format biasing is the reason format is required on every row. Apple Music's
   * coverage of cassette-era small-label releases is patchy, so when the
   * fallback runs it should be looking for the pressing that was actually played.
   */
  test('biases the search toward the played format', async () => {
    const { fetchJson, seen } = fetcherFor({});

    await searchRelease('Damaged', 'Black Flag', 'cassette', {
      fetchJson,
      userToken: 'tok',
    });

    expect(seen[0]).toContain('format=Cassette');
  });

  test('maps each listening format to its Discogs equivalent', async () => {
    for (const [format, expected] of [
      ['vinyl', 'Vinyl'],
      ['cd', 'CD'],
      ['cassette', 'Cassette'],
    ] as const) {
      const { fetchJson, seen } = fetcherFor({});
      await searchRelease('T', 'A', format, { fetchJson, userToken: 'tok' });
      expect(seen[0]).toContain(`format=${expected}`);
    }
  });

  /** Digital is not a pressing, so constraining on it would only lose matches. */
  test('does not constrain on format for a digital play', async () => {
    const { fetchJson, seen } = fetcherFor({});

    await searchRelease('T', 'A', 'digital', { fetchJson, userToken: 'tok' });

    expect(seen[0]).not.toContain('format=');
  });

  test('returns the first result id', async () => {
    const url = `${BASE}/database/search?release_title=Damaged&artist=Black+Flag&type=release&per_page=1`;
    const { fetchJson } = fetcherFor({ [url]: { body: { results: [{ id: 384821 }] } } });

    const match = await searchRelease('Damaged', 'Black Flag', undefined, {
      fetchJson,
      userToken: 'tok',
    });

    expect(match).toEqual({ releaseId: 384821 });
  });

  test('returns undefined when the search yields nothing', async () => {
    const url = `${BASE}/database/search?release_title=Nope&artist=Nobody&type=release&per_page=1`;
    const { fetchJson } = fetcherFor({ [url]: { body: { results: [] } } });

    expect(
      await searchRelease('Nope', 'Nobody', undefined, { fetchJson, userToken: 'tok' }),
    ).toBeUndefined();
  });
});

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { getListeningLog } from '@/orchestrator.js';

const CATALOG = 'https://api.music.apple.com/v1/catalog';

const APPLE_ALBUM = {
  id: '1109714933',
  attributes: {
    name: 'Kid A',
    artistName: 'Radiohead',
    url: 'https://music.apple.com/us/album/kid-a/1109714933',
    artwork: { url: 'https://art.test/{w}x{h}bb.jpg', width: 3000, height: 3000 },
  },
};

/** A fetch that answers a route table, defaulting to 404. */
function fakeFetch(routes: Record<string, { status?: number; body?: unknown }> = {}) {
  const seen: string[] = [];
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
  return { impl, seen };
}

const YAML_ONE = `- title: "Kid A"
  artist: "Radiohead"
  format: vinyl
  playedAt: 2026-05-28
`;

/** Baseline options: content input, pre-signed token, cache off, no network hits. */
function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    listeningYaml: { content: YAML_ONE, format: 'yaml' as const },
    appleMusic: { developerToken: 'jwt' },
    userAgent: 'listening-log-test/0.0.0',
    cache: false as const,
    rateLimitMs: 0,
    fetchImpl: fakeFetch().impl,
    ...overrides,
  };
}

let tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'listening-log-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  tempDirs = [];
});

describe('input resolution', () => {
  test('reads yaml from content', async () => {
    const result = await getListeningLog(baseOptions());

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe('Kid A');
  });

  test('reads yaml from a path, inferring the format from the extension', async () => {
    const path = join(await tempDir(), 'listening.yaml');
    await writeFile(path, YAML_ONE, 'utf-8');

    const result = await getListeningLog(baseOptions({ listeningYaml: { path } }));

    expect(result.entries).toHaveLength(1);
  });

  test('reads json from a .json path', async () => {
    const path = join(await tempDir(), 'listening.json');
    await writeFile(
      path,
      JSON.stringify([
        { title: 'Kid A', artist: 'Radiohead', format: 'vinyl', playedAt: '2026-05-28' },
      ]),
      'utf-8',
    );

    const result = await getListeningLog(baseOptions({ listeningYaml: { path } }));

    expect(result.entries).toHaveLength(1);
  });

  test('reads yaml from a fetch function', async () => {
    const result = await getListeningLog(
      baseOptions({ listeningYaml: { fetch: async () => YAML_ONE } }),
    );

    expect(result.entries).toHaveLength(1);
  });

  test('defaults content without an explicit format to yaml', async () => {
    const result = await getListeningLog(baseOptions({ listeningYaml: { content: YAML_ONE } }));

    expect(result.entries).toHaveLength(1);
  });

  test('warns and returns nothing for a path with an unrecognized extension', async () => {
    const path = join(await tempDir(), 'listening.txt');
    await writeFile(path, YAML_ONE, 'utf-8');

    const result = await getListeningLog(baseOptions({ listeningYaml: { path } }));

    expect(result.entries).toEqual([]);
    expect(result.warnings[0]).toContain('extension');
  });

  test('warns rather than throwing when the file cannot be read', async () => {
    const result = await getListeningLog(
      baseOptions({ listeningYaml: { path: '/no/such/listening.yaml' } }),
    );

    expect(result.entries).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe('credentials', () => {
  test('signs a developer token when given raw credentials', async () => {
    const sign = vi.fn(async () => 'freshly-signed');
    vi.doMock('apple-music-developer-token', () => ({
      signDeveloperToken: sign,
      pemFromBase64: (value: string) => `PEM:${value}`,
    }));
    vi.resetModules();
    const { getListeningLog: fresh } = await import('@/orchestrator.js');

    const { impl, seen } = fakeFetch({
      [`${CATALOG}/us/search?term=Kid+A+Radiohead&types=albums&limit=1`]: {
        body: { results: { albums: { data: [APPLE_ALBUM] } } },
      },
    });

    await fresh(
      baseOptions({
        appleMusic: { keyId: 'ABCDE12345', teamId: 'FGHIJ67890', privateKeyBase64: 'Zm9v' },
        fetchImpl: impl,
      }) as Parameters<typeof fresh>[0],
    );

    expect(sign).toHaveBeenCalledOnce();
    expect(seen).toHaveLength(1);
    vi.doUnmock('apple-music-developer-token');
    vi.resetModules();
  });

  test('signs once for the whole run, not once per album', async () => {
    const sign = vi.fn(async () => 'freshly-signed');
    vi.doMock('apple-music-developer-token', () => ({
      signDeveloperToken: sign,
      pemFromBase64: (value: string) => `PEM:${value}`,
    }));
    vi.resetModules();
    const { getListeningLog: fresh } = await import('@/orchestrator.js');

    await fresh(
      baseOptions({
        listeningYaml: {
          content: `${YAML_ONE}- title: "Damaged"
  artist: "Black Flag"
  format: cassette
  playedAt: 2026-05-27
`,
        },
        appleMusic: { keyId: 'ABCDE12345', teamId: 'FGHIJ67890', privateKeyBase64: 'Zm9v' },
      }) as Parameters<typeof fresh>[0],
    );

    expect(sign).toHaveBeenCalledOnce();
    vi.doUnmock('apple-music-developer-token');
    vi.resetModules();
  });
});

describe('pipeline', () => {
  test('sorts entries by playedAt, most recent first', async () => {
    const content = `- title: "Older"
  artist: "A"
  format: cd
  playedAt: 2026-05-01
- title: "Newer"
  artist: "B"
  format: cd
  playedAt: 2026-05-30
`;

    const result = await getListeningLog(baseOptions({ listeningYaml: { content } }));

    expect(result.entries.map((e) => e.title)).toEqual(['Newer', 'Older']);
  });

  test('reports lastEntryDate as the most recent playedAt', async () => {
    const content = `- title: "Older"
  artist: "A"
  format: cd
  playedAt: 2026-05-01
- title: "Newer"
  artist: "B"
  format: cd
  playedAt: 2026-05-30
`;

    const result = await getListeningLog(baseOptions({ listeningYaml: { content } }));

    expect(result.lastEntryDate).toBe('2026-05-30');
  });

  test('leaves lastEntryDate undefined when there are no entries', async () => {
    const result = await getListeningLog(baseOptions({ listeningYaml: { content: '' } }));

    expect(result.entries).toEqual([]);
    expect(result.lastEntryDate).toBeUndefined();
  });

  test('applies the requested limit', async () => {
    const content = Array.from(
      { length: 5 },
      (_, i) => `- title: "T${i}"\n  artist: "A"\n  format: cd\n  playedAt: 2026-05-0${i + 1}\n`,
    ).join('');

    const result = await getListeningLog(baseOptions({ listeningYaml: { content }, limit: 2 }));

    expect(result.entries).toHaveLength(2);
  });

  /** Silent truncation would read to a caller as "this is everything". */
  test('clamps a limit above the ceiling and says so', async () => {
    const result = await getListeningLog(baseOptions({ limit: 500 }));

    expect(result.warnings.some((w) => w.includes('50'))).toBe(true);
  });

  test('caps at the ceiling even when no limit was requested', async () => {
    const content = Array.from(
      { length: 60 },
      (_, i) =>
        `- title: "T${i}"\n  artist: "A"\n  format: cd\n  playedAt: 2026-05-${String((i % 28) + 1).padStart(2, '0')}\n`,
    ).join('');

    const result = await getListeningLog(baseOptions({ listeningYaml: { content } }));

    expect(result.entries).toHaveLength(50);
    expect(result.warnings.some((w) => w.includes('60'))).toBe(true);
  });

  test('returns nothing for a limit of zero', async () => {
    const result = await getListeningLog(baseOptions({ limit: 0 }));

    expect(result.entries).toEqual([]);
    expect(result.lastEntryDate).toBeUndefined();
  });

  test('enriches an album once no matter how many times it was played', async () => {
    const content = `- title: "Kid A"
  artist: "Radiohead"
  format: vinyl
  playedAt: 2026-05-01
- title: "Kid A"
  artist: "Radiohead"
  format: digital
  playedAt: 2026-05-02
`;
    const { impl, seen } = fakeFetch();

    const result = await getListeningLog(
      baseOptions({ listeningYaml: { content }, fetchImpl: impl }),
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.playCount).toBe(2);
    expect(seen).toHaveLength(1);
  });

  test('excludes an album whose every play is private', async () => {
    const content = `- title: "Secret"
  artist: "A"
  format: cd
  playedAt: 2026-05-01
  private: true
`;

    const result = await getListeningLog(baseOptions({ listeningYaml: { content } }));

    expect(result.entries).toEqual([]);
  });

  test('surfaces parse warnings alongside the entries that survived', async () => {
    const content = `- title: "Bad"
  format: cd
  playedAt: 2026-05-01
${YAML_ONE}`;

    const result = await getListeningLog(baseOptions({ listeningYaml: { content } }));

    expect(result.entries).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes('artist'))).toBe(true);
  });
});

describe('cache', () => {
  test('writes enrichment to the configured cache path', async () => {
    const path = join(await tempDir(), 'cache.json');
    const { impl } = fakeFetch({
      [`${CATALOG}/us/search?term=Kid+A+Radiohead&types=albums&limit=1`]: {
        body: { results: { albums: { data: [APPLE_ALBUM] } } },
      },
    });

    await getListeningLog(baseOptions({ cache: path, fetchImpl: impl }));

    const written = JSON.parse(await readFile(path, 'utf-8'));
    expect(Object.keys(written)[0]?.startsWith('am:q:')).toBe(true);
  });

  test('serves a warm cache without touching the network', async () => {
    const path = join(await tempDir(), 'cache.json');
    const first = fakeFetch({
      [`${CATALOG}/us/search?term=Kid+A+Radiohead&types=albums&limit=1`]: {
        body: { results: { albums: { data: [APPLE_ALBUM] } } },
      },
    });
    await getListeningLog(baseOptions({ cache: path, fetchImpl: first.impl }));

    const second = fakeFetch();
    const result = await getListeningLog(baseOptions({ cache: path, fetchImpl: second.impl }));

    expect(second.seen).toEqual([]);
    expect(result.entries[0]?.appleMusicAlbumId).toBe('1109714933');
  });

  /** The yaml is the source. There is nothing to cache from it. */
  test('never caches the yaml source', async () => {
    const path = join(await tempDir(), 'cache.json');

    await getListeningLog(baseOptions({ cache: path }));

    const written = JSON.parse(await readFile(path, 'utf-8'));
    for (const key of Object.keys(written)) {
      expect(key.startsWith('am:') || key.startsWith('dg:')).toBe(true);
    }
    expect(JSON.stringify(written)).not.toContain('Kid A');
  });

  test('writes no cache file when caching is off', async () => {
    const dir = await tempDir();
    const path = join(dir, 'cache.json');

    await getListeningLog(baseOptions({ cache: false }));

    await expect(readFile(path, 'utf-8')).rejects.toThrow();
  });

  test('accepts the object form with maxAgeDays and bust', async () => {
    const path = join(await tempDir(), 'cache.json');
    const { impl } = fakeFetch({
      [`${CATALOG}/us/search?term=Kid+A+Radiohead&types=albums&limit=1`]: {
        body: { results: { albums: { data: [APPLE_ALBUM] } } },
      },
    });

    const result = await getListeningLog(
      baseOptions({ cache: { path, maxAgeDays: 30, bust: [] }, fetchImpl: impl }),
    );

    expect(result.entries[0]?.appleMusicAlbumId).toBe('1109714933');
  });

  test('starts fresh and warns when the cache file is not valid JSON', async () => {
    const path = join(await tempDir(), 'cache.json');
    await writeFile(path, 'not json at all', 'utf-8');

    const result = await getListeningLog(baseOptions({ cache: path }));

    expect(result.warnings.some((w) => w.includes('JSON'))).toBe(true);
  });

  test('treats a missing cache file as an empty cache, without warning', async () => {
    const path = join(await tempDir(), 'nope.json');

    const result = await getListeningLog(baseOptions({ cache: path }));

    expect(result.warnings.some((w) => w.includes('could not be read'))).toBe(false);
  });
});

describe('storefront', () => {
  test('defaults to the us storefront', async () => {
    const { impl, seen } = fakeFetch();

    await getListeningLog(baseOptions({ fetchImpl: impl }));

    expect(seen[0]).toContain('/catalog/us/');
  });

  test('honors an explicit storefront', async () => {
    const { impl, seen } = fakeFetch();

    await getListeningLog(baseOptions({ fetchImpl: impl, storefront: 'gb' }));

    expect(seen[0]).toContain('/catalog/gb/');
  });
});

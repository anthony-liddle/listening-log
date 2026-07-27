import { describe, expect, test } from 'vitest';
import * as api from '@/index.js';

/**
 * The barrel is the package's contract. These assertions exist so that removing
 * or renaming an export is a deliberate act with a failing test attached, not
 * something that slips out in a refactor.
 */
describe('public surface', () => {
  test('exports the main entry point', () => {
    expect(typeof api.getListeningLog).toBe('function');
  });

  test('exports the limit ceiling as a value consumers can read', () => {
    expect(api.MAX_LIMIT).toBe(50);
  });

  test('exports every composable piece as a callable', () => {
    // Listed statically rather than looked up by name: a dynamic index would
    // defeat tree shaking for consumers and hide a typo behind a passing test.
    const pieces = [
      api.aggregateRows,
      api.matchKey,
      api.parseListeningLog,
      api.enrichAlbum,
      api.hashAlbumKey,
      api.shouldRefetch,
      api.lookupAlbumById,
      api.searchAlbum,
      api.resolveArtworkUrl,
      api.getRelease,
      api.searchRelease,
    ];

    expect(pieces).toHaveLength(11);
    for (const piece of pieces) {
      expect(typeof piece).toBe('function');
    }
  });

  test('runs end to end through the barrel export', async () => {
    const result = await api.getListeningLog({
      listeningYaml: {
        content: `- title: "Kid A"
  artist: "Radiohead"
  format: vinyl
  playedAt: 2026-05-28
`,
      },
      appleMusic: { developerToken: 'jwt' },
      userAgent: 'listening-log-test/0.0.0',
      cache: false,
      rateLimitMs: 0,
      fetchImpl: async () => ({ ok: false, status: 404 }) as Response,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe('Kid A');
  });
});

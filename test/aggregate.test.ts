import { describe, expect, test } from 'vitest';
import { aggregateRows } from '@/aggregate.js';
import type { RawListeningRow } from '@/types.js';

/** Build a row with sensible defaults, overriding only what a test cares about. */
function row(overrides: Partial<RawListeningRow> = {}): RawListeningRow {
  return {
    title: 'Kid A',
    artist: 'Radiohead',
    format: 'vinyl',
    playedAt: '2026-05-28',
    ...overrides,
  };
}

describe('aggregateRows', () => {
  test('passes a single row through as one album with playCount 1', () => {
    const albums = aggregateRows([row()]);

    expect(albums).toHaveLength(1);
    expect(albums[0]).toMatchObject({
      title: 'Kid A',
      artist: 'Radiohead',
      format: 'vinyl',
      playedAt: '2026-05-28',
      playCount: 1,
    });
  });

  test('aggregates rows whose title and artist differ only by case and whitespace', () => {
    const albums = aggregateRows([
      row({ playedAt: '2026-05-01' }),
      row({ title: '  kid a  ', artist: 'RADIOHEAD', playedAt: '2026-05-02' }),
    ]);

    expect(albums).toHaveLength(1);
    expect(albums[0]?.playCount).toBe(2);
  });

  test('keeps the first row spelling of title and artist', () => {
    const albums = aggregateRows([
      row({ playedAt: '2026-05-01' }),
      row({ title: 'kid a', artist: 'radiohead', playedAt: '2026-05-02' }),
    ]);

    expect(albums[0]?.title).toBe('Kid A');
    expect(albums[0]?.artist).toBe('Radiohead');
  });

  test('keeps differently-titled editions separate', () => {
    const albums = aggregateRows([row(), row({ title: 'Kid A (Remastered)' })]);

    expect(albums).toHaveLength(2);
  });

  test('keeps the same title by a different artist separate', () => {
    const albums = aggregateRows([
      row({ title: 'Damaged' }),
      row({ title: 'Damaged', artist: 'Black Flag' }),
    ]);

    expect(albums).toHaveLength(2);
  });

  /** Format is deliberately not part of the match key: the album is the unit. */
  test('aggregates a vinyl play and a digital play into one album', () => {
    const albums = aggregateRows([
      row({ format: 'vinyl', playedAt: '2026-05-01' }),
      row({ format: 'digital', playedAt: '2026-05-02' }),
    ]);

    expect(albums).toHaveLength(1);
    expect(albums[0]?.playCount).toBe(2);
  });

  test('takes format from the most recent play', () => {
    const albums = aggregateRows([
      row({ format: 'vinyl', playedAt: '2026-05-02' }),
      row({ format: 'digital', playedAt: '2026-05-01' }),
    ]);

    expect(albums[0]?.format).toBe('vinyl');
  });

  test('takes playedAt as the max across aggregated rows', () => {
    const albums = aggregateRows([
      row({ playedAt: '2026-05-01' }),
      row({ playedAt: '2026-05-30' }),
      row({ playedAt: '2026-05-15' }),
    ]);

    expect(albums[0]?.playedAt).toBe('2026-05-30');
  });

  test('takes source from the most recent play', () => {
    const albums = aggregateRows([
      row({ playedAt: '2026-05-01', source: 'older' }),
      row({ playedAt: '2026-05-02', source: 'newer' }),
    ]);

    expect(albums[0]?.source).toBe('newer');
  });

  /**
   * playedAt is date-granularity, so "last-played wins" has no meaning when two
   * plays share a date, which happens the moment you play a record and then
   * stream it the same evening. Source-file order breaks the tie: the row
   * written later wins. Deterministic, and it matches how the file reads.
   */
  test('breaks a same-day tie with source-file order, later row winning', () => {
    const albums = aggregateRows([
      row({ format: 'vinyl', playedAt: '2026-05-28' }),
      row({ format: 'digital', playedAt: '2026-05-28' }),
    ]);

    expect(albums).toHaveLength(1);
    expect(albums[0]?.format).toBe('digital');
  });

  test('takes the first non-null appleMusicAlbumId', () => {
    const albums = aggregateRows([
      row({ playedAt: '2026-05-01' }),
      row({ playedAt: '2026-05-02', appleMusicAlbumId: '111' }),
    ]);

    expect(albums[0]?.appleMusicAlbumId).toBe('111');
  });

  test('prefers the most recent row when two rows disagree on appleMusicAlbumId', () => {
    const albums = aggregateRows([
      row({ playedAt: '2026-05-01', appleMusicAlbumId: 'older' }),
      row({ playedAt: '2026-05-02', appleMusicAlbumId: 'newer' }),
    ]);

    expect(albums[0]?.appleMusicAlbumId).toBe('newer');
  });

  test('prefers the most recent row when two rows disagree on discogsReleaseId', () => {
    const albums = aggregateRows([
      row({ playedAt: '2026-05-01', discogsReleaseId: 1 }),
      row({ playedAt: '2026-05-02', discogsReleaseId: 2 }),
    ]);

    expect(albums[0]?.discogsReleaseId).toBe(2);
  });

  describe('private rows', () => {
    test('excludes a private row from playCount', () => {
      const albums = aggregateRows([
        row({ playedAt: '2026-05-01' }),
        row({ playedAt: '2026-05-02', private: true }),
      ]);

      expect(albums).toHaveLength(1);
      expect(albums[0]?.playCount).toBe(1);
    });

    test('computes last-played fields from non-private rows only', () => {
      const albums = aggregateRows([
        row({ format: 'vinyl', playedAt: '2026-05-01', source: 'public' }),
        row({ format: 'digital', playedAt: '2026-05-30', source: 'secret', private: true }),
      ]);

      expect(albums[0]?.playedAt).toBe('2026-05-01');
      expect(albums[0]?.format).toBe('vinyl');
      expect(albums[0]?.source).toBe('public');
    });

    test('omits an album entirely when every row for it is private', () => {
      const albums = aggregateRows([
        row({ playedAt: '2026-05-01', private: true }),
        row({ playedAt: '2026-05-02', private: true }),
      ]);

      expect(albums).toEqual([]);
    });

    test('keeps other albums when one album is fully private', () => {
      const albums = aggregateRows([
        row({ title: 'Secret', private: true }),
        row({ title: 'Public' }),
      ]);

      expect(albums).toHaveLength(1);
      expect(albums[0]?.title).toBe('Public');
    });

    test('never carries a private row catalog ID into the album', () => {
      const albums = aggregateRows([
        row({ playedAt: '2026-05-01' }),
        row({ playedAt: '2026-05-30', appleMusicAlbumId: 'from-private', private: true }),
      ]);

      expect(albums[0]?.appleMusicAlbumId).toBeUndefined();
    });
  });

  test('returns an empty array for no rows', () => {
    expect(aggregateRows([])).toEqual([]);
  });
});

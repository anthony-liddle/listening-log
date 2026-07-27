import { describe, expect, test } from 'vitest';
import { parseListeningLog } from '@/parse.js';

describe('parseListeningLog', () => {
  test('parses a minimal valid yaml row', () => {
    const result = parseListeningLog(
      `- title: "Kid A"
  artist: "Radiohead"
  format: vinyl
  playedAt: 2026-05-28
`,
      'yaml',
    );

    expect(result.warnings).toEqual([]);
    expect(result.rows).toEqual([
      { title: 'Kid A', artist: 'Radiohead', format: 'vinyl', playedAt: '2026-05-28' },
    ]);
  });

  /**
   * The whole date validator rests on this. Real listening.yaml rows are written
   * unquoted, and a YAML parser that resolved them to Date objects would make a
   * string-based ISO check reject every row in the user's actual file. Locked
   * with a test so an upstream schema change surfaces here and not at dogfooding.
   */
  test('reads an unquoted playedAt as a string, not a Date', () => {
    const result = parseListeningLog(
      `- title: "Kid A"
  artist: "Radiohead"
  format: vinyl
  playedAt: 2026-05-28
`,
      'yaml',
    );

    expect(typeof result.rows[0]?.playedAt).toBe('string');
    expect(result.rows[0]?.playedAt).toBe('2026-05-28');
  });

  test('quoted and unquoted playedAt produce the same value', () => {
    const result = parseListeningLog(
      `- title: "A"
  artist: "X"
  format: cd
  playedAt: 2026-05-28
- title: "B"
  artist: "X"
  format: cd
  playedAt: "2026-05-28"
`,
      'yaml',
    );

    expect(result.rows[0]?.playedAt).toBe(result.rows[1]?.playedAt);
  });

  test('parses every optional field', () => {
    const result = parseListeningLog(
      `- title: "Damaged"
  artist: "Black Flag"
  format: cassette
  playedAt: 2026-05-28
  appleMusicAlbumId: "1234567890"
  discogsReleaseId: 384821
  source: "Music Millennium used bin"
  private: true
`,
      'yaml',
    );

    expect(result.warnings).toEqual([]);
    expect(result.rows[0]).toEqual({
      title: 'Damaged',
      artist: 'Black Flag',
      format: 'cassette',
      playedAt: '2026-05-28',
      appleMusicAlbumId: '1234567890',
      discogsReleaseId: 384821,
      source: 'Music Millennium used bin',
      private: true,
    });
  });

  test('parses JSON with the same result as the equivalent YAML', () => {
    const json = parseListeningLog(
      JSON.stringify([
        { title: 'Kid A', artist: 'Radiohead', format: 'vinyl', playedAt: '2026-05-28' },
      ]),
      'json',
    );

    expect(json.warnings).toEqual([]);
    expect(json.rows).toEqual([
      { title: 'Kid A', artist: 'Radiohead', format: 'vinyl', playedAt: '2026-05-28' },
    ]);
  });

  test('skips a row missing a required field, warning and keeping the rest', () => {
    const result = parseListeningLog(
      `- title: "No Artist"
  format: vinyl
  playedAt: 2026-05-28
- title: "Kid A"
  artist: "Radiohead"
  format: vinyl
  playedAt: 2026-05-28
`,
      'yaml',
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.title).toBe('Kid A');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('artist');
  });

  test('rejects a format outside the enum', () => {
    const result = parseListeningLog(
      `- title: "Kid A"
  artist: "Radiohead"
  format: minidisc
  playedAt: 2026-05-28
`,
      'yaml',
    );

    expect(result.rows).toEqual([]);
    expect(result.warnings[0]).toContain('format');
    expect(result.warnings[0]).toContain('minidisc');
  });

  test('rejects a playedAt that is not ISO YYYY-MM-DD', () => {
    const result = parseListeningLog(
      `- title: "Kid A"
  artist: "Radiohead"
  format: vinyl
  playedAt: "May 28 2026"
`,
      'yaml',
    );

    expect(result.rows).toEqual([]);
    expect(result.warnings[0]).toContain('playedAt');
  });

  test('rejects a calendar-invalid date that matches the ISO shape', () => {
    const result = parseListeningLog(
      `- title: "Kid A"
  artist: "Radiohead"
  format: vinyl
  playedAt: "2026-02-30"
`,
      'yaml',
    );

    expect(result.rows).toEqual([]);
    expect(result.warnings[0]).toContain('playedAt');
  });

  test('warns on an unknown field but keeps the row', () => {
    const result = parseListeningLog(
      `- title: "Kid A"
  artist: "Radiohead"
  format: vinyl
  playedAt: 2026-05-28
  rating: 5
`,
      'yaml',
    );

    expect(result.rows).toHaveLength(1);
    expect(result.warnings[0]).toContain('rating');
  });

  test('returns one warning for malformed YAML rather than throwing', () => {
    const result = parseListeningLog('- title: "unclosed\n  artist: [', 'yaml');

    expect(result.rows).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  test('returns a warning when the root is not a list', () => {
    const result = parseListeningLog('title: "Kid A"', 'yaml');

    expect(result.rows).toEqual([]);
    expect(result.warnings[0]).toContain('list');
  });

  test('treats an empty file as zero rows without warning', () => {
    const result = parseListeningLog('', 'yaml');

    expect(result.rows).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('rejects a non-string appleMusicAlbumId', () => {
    const result = parseListeningLog(
      `- title: "Kid A"
  artist: "Radiohead"
  format: vinyl
  playedAt: 2026-05-28
  appleMusicAlbumId: 1234567890
`,
      'yaml',
    );

    expect(result.rows).toEqual([]);
    expect(result.warnings[0]).toContain('appleMusicAlbumId');
  });

  test('rejects a non-string source', () => {
    const result = parseListeningLog(
      `- title: "Kid A"
  artist: "Radiohead"
  format: vinyl
  playedAt: 2026-05-28
  source: 42
`,
      'yaml',
    );

    expect(result.rows).toEqual([]);
    expect(result.warnings[0]).toContain('source');
  });

  test('rejects a non-boolean private', () => {
    const result = parseListeningLog(
      `- title: "Kid A"
  artist: "Radiohead"
  format: vinyl
  playedAt: 2026-05-28
  private: "yes"
`,
      'yaml',
    );

    expect(result.rows).toEqual([]);
    expect(result.warnings[0]).toContain('private');
  });

  test('rejects a row that is not an object', () => {
    const result = parseListeningLog('- "just a string"', 'yaml');

    expect(result.rows).toEqual([]);
    expect(result.warnings[0]).toContain('object');
  });

  test('rejects a non-integer discogsReleaseId', () => {
    const result = parseListeningLog(
      `- title: "Kid A"
  artist: "Radiohead"
  format: vinyl
  playedAt: 2026-05-28
  discogsReleaseId: 3.5
`,
      'yaml',
    );

    expect(result.rows).toEqual([]);
    expect(result.warnings[0]).toContain('discogsReleaseId');
  });

  test('rejects a discogsReleaseId that is not a number', () => {
    const result = parseListeningLog(
      `- title: "Kid A"
  artist: "Radiohead"
  format: vinyl
  playedAt: 2026-05-28
  discogsReleaseId: "384821"
`,
      'yaml',
    );

    expect(result.rows).toEqual([]);
    expect(result.warnings[0]).toContain('discogsReleaseId');
  });
});

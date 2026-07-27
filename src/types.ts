/**
 * How an album was played. Required on every yaml row, never inferred.
 *
 * Cassette earns its place here: it is a real listening surface, and Apple
 * Music's catalog coverage is uneven for cassette-era small-label releases,
 * so knowing the format lets the Discogs fallback bias its lookups.
 */
export type ListeningFormat = 'vinyl' | 'cd' | 'cassette' | 'digital';

/**
 * One album in the recent listening log. Dates are ISO date strings
 * (YYYY-MM-DD), not Date objects, so the output is trivially serializable and
 * free of timezone surprises.
 *
 * An entry is an album, not a play. Multiple yaml rows for the same album
 * aggregate into one of these before enrichment ever runs.
 */
export interface ListeningEntry {
  // Identity, always present.
  title: string;
  artist: string;
  /** From the most recent play that aggregated into this entry. */
  format: ListeningFormat;

  // When and how much.
  /** ISO date (YYYY-MM-DD). The max across the rows that aggregated here. */
  playedAt: string;
  /** How many rows aggregated into this entry. Private rows never count. */
  playCount: number;

  // Apple Music enrichment, when a catalog match was found.
  appleMusicAlbumId?: string;
  /** Canonical music.apple.com deep link. */
  appleMusicUrl?: string;
  /**
   * Artwork resolved to a concrete, directly usable URL. Apple returns a
   * template containing literal `{w}x{h}` placeholders; the size substituted
   * here comes from the `artworkSize` option, and width/height report it.
   */
  artwork?: { url: string; width?: number; height?: number };

  // Discogs enrichment, when a release was matched or explicitly named.
  discogsReleaseId?: number;

  /** Free-form origin, written by hand. For example "Music Millennium used bin". */
  source?: string;
}

/**
 * The wrapped result returned by getListeningLog. Wrapping the entries array
 * lets the package surface freshness signals and soft warnings (catalog misses,
 * fallback events, malformed rows) instead of throwing them away.
 */
export interface ListeningLogResult {
  /** Albums sorted by playedAt, most recent first. */
  entries: ListeningEntry[];
  /** ISO date of the most recent play across all entries. Useful for staleness UI. */
  lastEntryDate?: string;
  /** Soft failures and notable events from the build. */
  warnings: string[];
}

/**
 * One row of `listening.yaml`, after parsing and validation but before
 * aggregation. A row is a single play, which is why `private` lives here and
 * not on ListeningEntry: you hide a play, not an album.
 */
export interface RawListeningRow {
  title: string;
  artist: string;
  format: ListeningFormat;
  /** ISO date (YYYY-MM-DD). */
  playedAt: string;
  appleMusicAlbumId?: string;
  discogsReleaseId?: number;
  source?: string;
  /**
   * Excluded from aggregation entirely. The row stays in the source file so
   * builds remain deterministic; it simply never reaches the aggregator.
   *
   * If an album has other, non-private rows, it still emits, computed from
   * those rows alone. If every row for an album is private, the album does
   * not appear in the output at all.
   */
  private?: boolean;
}

/**
 * An album after aggregation, before enrichment. Carries the merged identity
 * and play data, plus whichever catalog IDs the source rows supplied.
 */
export interface AggregatedAlbum {
  title: string;
  artist: string;
  format: ListeningFormat;
  playedAt: string;
  playCount: number;
  appleMusicAlbumId?: string;
  discogsReleaseId?: number;
  source?: string;
}

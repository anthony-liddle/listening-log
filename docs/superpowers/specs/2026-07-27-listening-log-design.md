# listening-log: Implementation Design

Date: 2026-07-27

Derived from the handoff brief and the vault sources of truth
(`Projects/listening-log/decisions.md`, `specs.md`, `followups.md`). Where this
document adds detail, it is filling a gap the vault left open, not overriding it.
Every such addition is listed under "Additions" below.

## Purpose

A library-only TypeScript package that reads a hand-maintained `listening.yaml`,
aggregates plays into albums, enriches each album against the Apple Music catalog
with Discogs as a fallback, and returns a typed array of recent listening.

Third package in the Lately page composition, sibling to `letterboxd-rss` and
`library-reads`. Depends on `apple-music-developer-token` for JWT signing.

## Module Layout

One module per job, mirroring `library-reads`. The `@/` path alias is configured
in three places (tsconfig `paths`, tsdown `alias`, vitest `resolve.alias`), the
same trio `apple-music-developer-token` uses.

| Module | Responsibility |
| --- | --- |
| `src/types.ts` | Public types. No runtime code. |
| `src/parse.ts` | Text (YAML or JSON) to `RawListeningRow[]` plus warnings. |
| `src/aggregate.ts` | Rows to albums: private drop, match key, merge rules. |
| `src/apple-music.ts` | Catalog lookup by ID, catalog search by title and artist. |
| `src/discogs.ts` | Release fetch by ID, release search. |
| `src/enrich.ts` | The cascade, the cache, distilled data. |
| `src/orchestrator.ts` | `getListeningLog`, the top-level pipeline. |
| `src/index.ts` | Barrel. Exports the orchestrator plus composable pieces. |

## Pipeline Order

```
resolve input
  -> parse rows
  -> drop private rows
  -> aggregate into albums
  -> enrich (Apple Music, then Discogs)
  -> sort by playedAt descending
  -> clamp to limit
```

Private rows drop **before** aggregation. This is the one place the pipeline
deliberately departs from `library-reads`, which filters private entries late
(after enrichment). Here, a private row must never reach the aggregator: if it
did, `playCount` would count plays that are meant to be invisible, and the
merged fields (`format`, `source`, and the two IDs) could be resolved from a row
that should not exist.

Consequences, both specified in the vault and both tested:

- An album with a mix of private and non-private rows still emits, computed from
  the non-private rows only.
- An album whose rows are all private does not emit at all.

## Match Key And Aggregation

Match key is normalized title plus normalized artist. Normalization is trim then
lowercase, nothing more. Format is not part of the key.

Per-field rules when rows aggregate:

| Field | Rule |
| --- | --- |
| `title`, `artist` | Kept; they matched by definition. |
| `format` | Last-played wins. |
| `playedAt` | Max across aggregated rows. |
| `playCount` | Count of aggregated rows. |
| `source`, `appleMusicAlbumId`, `discogsReleaseId` | First non-null wins; on conflict, prefer the last-played row's value. |

**Same-day tiebreak.** `playedAt` is date-granularity, so "last-played wins" is
undefined whenever two rows for one album share a date. That is the common case,
not the exotic one: playing a record and then streaming it the same evening. The
later row in the source file wins. Source-file order is stable, so builds stay
deterministic.

## Enrichment Cascade

Per unique album, after aggregation. Apple Music and Discogs are therefore called
once per album, never once per play.

1. `appleMusicAlbumId` present: catalog lookup by ID.
2. Otherwise: catalog search by title and artist.
3. Apple Music missed and `discogs` is configured: Discogs search.
4. `discogsReleaseId` present: independent Discogs fetch, even when Apple Music
   already matched. This is what makes pressing-level provenance possible.
5. Everything failed: push a warning, still emit the entry from source data.

## Apple Music Endpoints

Verified against Apple's documentation rather than recalled:

- By ID: `GET https://api.music.apple.com/v1/catalog/{storefront}/albums/{id}`
- Search: `GET https://api.music.apple.com/v1/catalog/{storefront}/search`
  with `term`, `types=albums`, and `limit` (max 25).

Both authorize with the developer token as `Authorization: Bearer <token>`.

## Cache

Three-lever shape, matching `library-reads`: `false | string | { path, maxAgeDays?, bust? }`,
default `maxAgeDays` 180. Distilled data, never raw responses. Git-tracked JSON,
written atomically (temp file, then rename).

The yaml source is never cached. It is the source.

Key namespaces:

| Key | Cascade step |
| --- | --- |
| `am:id:{albumId}` | Lookup by ID. |
| `am:q:{hash}` | Search by title and artist. |
| `dg:id:{releaseId}` | Discogs fetch by ID. |
| `dg:q:{hash}` | Discogs search. |

`{hash}` is a 16-character sha256 prefix of `normalizedTitle|normalizedArtist`,
the same construction `library-reads` uses for its title-author keys.

## Additions

Gaps the brief and vault left open. Each is an addition, not a conflict.

1. **`storefront?: string`, default `'us'`.** Every catalog endpoint takes a
   storefront in its path. No source specified one.
2. **Search-hit cache keys.** `specs.md` writes `am:{appleMusicAlbumId}`, but
   cascade step 2 is a search and has no ID before the lookup resolves. The
   namespace is extended as tabled above.
3. **Artwork is cached as a template and resolved on output.** Apple returns an
   artwork `url` containing literal `{w}x{h}` placeholders; dropped into an
   `<img src>` unmodified it does not load. Caching the template rather than a
   resolved URL keeps `artworkSize` a live lever instead of freezing the first
   build's choice into the cache file. `artworkSize?: number`, default 500.
   `artwork.width` and `artwork.height` report the resolved size.
4. **`limit` clamps at 50 and warns when it clamps.** Silent truncation reads to
   a caller as "you got everything."
5. **`fetchImpl` and `rateLimitMs` are exposed.** Not a style choice: "no live
   network calls in CI" requires the injection seam.
6. **Same-day tiebreak**, described above.
7. **No `includePrivate` option.** `library-reads` has one, but private here is
   pre-aggregation row exclusion rather than post-hoc entry filtering. An opt-in
   would have to answer whether an included private play bumps `playCount`, which
   nothing in the spec contemplates.

## Testing

Vitest. Every HTTP call goes through an injected fake fetch, so CI never reaches
the network.

Coverage beyond the happy paths, per the handoff brief's Done list:

- Multiple rows for one album aggregate via the normalized key.
- Format is not in the match key: vinyl and digital rows for one album aggregate
  into a single entry.
- Same-day, differing formats: the later row in the file supplies the format.
- Mixed private and non-private rows: the album emits from the non-private rows.
- All rows private: the album does not emit.
- Unquoted `playedAt: 2026-05-28` parses as a string, not a `Date`. Locked with a
  test because the whole date validator depends on it.
- Cache: enrichment is cached, the yaml source is not.

## Publishing

Mirrors the siblings: tsdown build, ESM only, `publint` plus `attw` in the
pre-publish gauntlet, CI workflow as the branch-protection check, release
workflow publishing via OIDC trusted publishing.

Before release, the packed tarball is installed into a fresh directory and
`getListeningLog` is called for real with an injected fetch. `apple-music-developer-token`
shipped a bug that survived every test because the tests never exercised the
installed artifact. This package has no CLI, so the analogous failure modes are
the exports map, the `files` array, the `.js`-versus-`.mjs` extension question,
and whether `apple-music-developer-token` resolves from a clean install.

## Stop Point

Ready for v0.1.0. The first publish and the trusted-publisher setup are the
maintainer's, not this build's.

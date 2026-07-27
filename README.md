# listening-log

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%3E%3D22-339933.svg)](https://nodejs.org/)

Read a hand-maintained `listening.yaml` into a typed array of recent albums,
enriched against the Apple Music catalog with Discogs as a fallback.

Library only, no CLI. Third piece of a "Lately" page, sibling to
[`letterboxd-rss`](https://github.com/anthony-liddle/letterboxd-rss) and
[`library-reads`](https://github.com/anthony-liddle/library-reads).

## What this is not

Not a comprehensive listening history. Not a Year in Review. Not a scrobbler,
and not a Last.fm client. The unit is albums, the surface is small, and the
source is a file you edit by hand. The framing is "what have I been into
lately," logged deliberately rather than captured passively.

## Install

```sh
pnpm add listening-log
```

## Use

```ts
import { getListeningLog } from 'listening-log';

const { entries, warnings, lastEntryDate } = await getListeningLog({
  listeningYaml: { path: './content/listening.yaml' },
  appleMusic: {
    keyId: process.env.APPLE_MUSIC_KEY_ID!,
    teamId: process.env.APPLE_MUSIC_TEAM_ID!,
    privateKeyBase64: process.env.APPLE_MUSIC_PRIVATE_KEY_BASE64!,
  },
  discogs: { userToken: process.env.DISCOGS_USER_TOKEN! },
  cache: './content/listening-cache.json',
  limit: 5,
  userAgent: 'my-site/1.0 (me@example.com)',
});
```

Every entry looks like this:

```ts
{
  title: 'Kid A',
  artist: 'Radiohead',
  format: 'vinyl',
  playedAt: '2026-05-28',
  playCount: 3,
  appleMusicAlbumId: '1109714933',
  appleMusicUrl: 'https://music.apple.com/us/album/kid-a/1109714933',
  artwork: { url: 'https://.../500x500bb.jpg', width: 500, height: 500 },
  discogsReleaseId: 384821,
  source: 'Music Millennium used bin',
}
```

## The source file

One row per play. Four required fields, everything else optional.

```yaml
- title: 'Kid A'
  artist: 'Radiohead'
  format: vinyl
  playedAt: 2026-05-28

- title: 'Damaged'
  artist: 'Black Flag'
  format: cassette
  playedAt: 2026-05-28
  appleMusicAlbumId: '1234567890'
  discogsReleaseId: 384821
  source: 'Music Millennium used bin'
  private: true
```

`format` is required rather than optional, and the reason is practical: Apple
Music's catalog coverage is uneven for cassette-era small-label releases, so
when the Discogs fallback runs it uses the format to look for the pressing you
actually played.

JSON works too. The parser is chosen from the file extension for `{ path }`, or
from an explicit `format` for `{ content }`.

## Architecture

### One source, parsed not fetched

The package's job starts at "parse this string." How the string arrives is
yours, so the input is fetcher-agnostic:

```ts
listeningYaml: { path: './listening.yaml' }
listeningYaml: { content: yamlString, format: 'yaml' }
listeningYaml: { fetch: async () => downloadIt() }
```

### The album is the unit, so plays aggregate first

Rows sharing a normalized title and artist collapse into one entry before any
network call happens. Playing an album five times this week is one entry with
`playCount: 5`, not five entries, and it costs one catalog lookup rather than
five.

Normalization is trim plus lowercase, nothing more. "Kid A" and
"Kid A (Remastered)" stay separate; guessing which parenthetical suffixes mean
"same album" is a rabbit hole with no bottom, and staying consistent as you log
is cheaper.

Format is not part of the match key. Play a record and then stream it, and those
are one album, with the format taken from the more recent play. When two plays
share a date, the row written later in the file wins.

### Private is per play, and drops before aggregation

A row marked `private: true` never reaches the aggregator. If an album has other
rows, it still appears, computed from those alone. If every row for an album is
private, the album does not appear at all. Rows stay in the file either way, so
builds stay deterministic.

The ordering matters more than it looks. Filtering private rows *after*
aggregation would still yield the right set of albums, and would quietly get the
fields wrong: a private late-night play could supply an album's format and bump
its play count.

### Enrichment cascade

Per album, once:

1. `appleMusicAlbumId` on the row: catalog lookup by ID.
2. Otherwise: catalog search by title and artist.
3. Apple Music missed and Discogs is configured: Discogs search.
4. `discogsReleaseId` on the row: Discogs fetch, even when Apple Music matched.
   This is what makes pressing-level provenance possible, since Apple Music has
   no way to say *which* pressing.
5. Nothing matched: a warning, and the entry still emits from what you logged.

Nothing here throws for data reasons. A catalog having a bad afternoon should
cost you a cover image, not a site build.

### Cache

```ts
cache: false                                       // off
cache: './listening-cache.json'                    // path
cache: { path, maxAgeDays: 180, bust: ['am:id:1'] } // full control
```

Enrichment only. The yaml is never cached, because the yaml is the source.
Distilled data rather than raw responses, git-tracked, written atomically, and
namespaced by `am:id:`, `am:q:`, `dg:id:`, and `dg:q:` so one file stays
readable when you are working out why an album got the wrong cover.

Artwork is cached as Apple's raw template and resolved on output, so changing
`artworkSize` takes effect on the next build instead of waiting for a bust.

## Developer tokens, not user tokens

Apple Music has two credentials, and the difference is the reason this package
is shaped the way it is.

A **developer token** is an ES256 JWT you sign yourself from a `.p8` key. It
authorizes the catalog endpoints under `/v1/catalog/...`: album metadata,
artwork, canonical links. It is signed offline, it has a documented six-month
maximum lifetime, and nothing about it needs a browser. That is what this
package uses, via
[`apple-music-developer-token`](https://github.com/anthony-liddle/apple-music-developer-token).

A **music user token** authorizes `/v1/me/...`, which is where recently-played
actually lives. Getting one requires MusicKit JS running in a browser with a
user signing in. It has no documented refresh, no published lifetime, and it
expires silently. Those endpoints exist for apps with active users; a personal
site built once and served statically is not that, so wiring a page to a
credential that dies without warning trades a hand-edited file for a recurring
re-authentication chore.

So this package routes around the wall rather than through it. The log is
manual, and the catalog fills in the rest.

## Options

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `listeningYaml` | `{ path } \| { content, format? } \| { fetch }` | required | The source. |
| `appleMusic` | `{ developerToken }` or `{ keyId, teamId, privateKeyBase64 }` | required | Raw credentials sign internally. |
| `discogs` | `{ userToken }` | none | Without it, the Discogs steps never run. |
| `userAgent` | `string` | required | Required at the type level; Discogs asks callers to identify themselves. |
| `cache` | `false \| string \| { path, maxAgeDays?, bust? }` | off | `maxAgeDays` defaults to 180. |
| `limit` | `number` | `50` | Never exceeds `MAX_LIMIT` (50), whether you pass a limit or not. A warning says so when it clamps. |
| `storefront` | `string` | `'us'` | ISO 3166 alpha-2. |
| `artworkSize` | `number` | `500` | Pixel size for the resolved artwork URL. |
| `rateLimitMs` | `number` | `1000` | One shared budget across both services. |
| `fetchImpl` | `typeof fetch` | `globalThis.fetch` | Injection seam for tests. |

`userAgent` is required rather than optional on purpose. Making it a type error
to omit means nobody accidentally ships anonymous outbound requests to a service
that asks to know who is calling.

## Composable pieces

The pipeline stages are exported individually for callers who want one without
the rest:

```ts
import {
  parseListeningLog,  // text -> validated rows
  aggregateRows,      // rows -> albums
  enrichAlbum,        // album -> enriched entry
  lookupAlbumById,
  searchAlbum,
  getRelease,
  searchRelease,
  resolveArtworkUrl,
  hashAlbumKey,
} from 'listening-log';
```

## Warnings, not exceptions

`getListeningLog` returns `warnings: string[]` and throws only for programmer
errors. A malformed row, an unreachable catalog, a corrupt cache file: each
degrades to a warning and a slightly emptier result. Log them in your build if
you want to know when a cover goes missing.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm check
pnpm build
pnpm smoke     # install the packed tarball and exercise it for real
```

Tests never touch the network; every HTTP call goes through an injected fetch.

## License

MIT (c) Anthony Liddle

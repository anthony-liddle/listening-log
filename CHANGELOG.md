# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

First release.

### Added

- `getListeningLog`, which reads a hand-maintained `listening.yaml` and returns
  recent albums enriched against the Apple Music catalog.
- Fetcher-agnostic input: `{ path }`, `{ content }`, or `{ fetch }`, in YAML or
  JSON.
- Play aggregation by normalized title and artist, running before enrichment so
  each album costs one catalog lookup no matter how often it was played.
- Per-play `private` rows, excluded before aggregation.
- Enrichment cascade: Apple Music by ID, then Apple Music search, then Discogs
  search, plus an independent Discogs fetch whenever a row names a release ID.
- Apple Music credentials in two shapes: a pre-signed developer token, or raw
  credentials signed internally via `apple-music-developer-token`.
- Enrichment cache with the three-lever shape `false | string | { path,
  maxAgeDays, bust }`, namespaced `am:`/`dg:` and written atomically.
- Artwork resolution from Apple's `{w}x{h}` template, at a configurable
  `artworkSize`.
- Composable exports for each pipeline stage.

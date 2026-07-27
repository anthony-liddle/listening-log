---
name: Bug report
about: Something does not behave the way the README says it should
title: '[BUG] '
labels: bug
---

## What happened

<!-- Include any warnings from the returned `warnings` array; they usually say
     more than the entries do. -->

## What you expected

## Reproducing it

The smallest `listening.yaml` rows that show the problem:

```yaml
- title: ''
  artist: ''
  format: vinyl
  playedAt: 2026-05-28
```

The options you passed (redact tokens):

```ts
await getListeningLog({
  // ...
});
```

## Environment

- `listening-log` version:
- Node version:
- Cache: on or off? If on, does it still happen with a busted or deleted cache?

## Anything else

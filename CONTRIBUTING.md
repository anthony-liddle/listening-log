# Contributing

Thanks for taking a look. This is a small, opinionated package, so the most
useful contributions are bug reports with a reproducible case and focused fixes.

## Setup

Requires Node 22 or newer and pnpm.

```sh
pnpm install
pnpm test
```

## The loop

```sh
pnpm test:watch   # tests, watching
pnpm typecheck    # tsc --noEmit
pnpm check        # biome lint and format check
pnpm format       # biome, writing fixes
pnpm build        # tsdown
pnpm smoke        # install the packed tarball and exercise it for real
```

Before opening a pull request, `pnpm check && pnpm typecheck && pnpm test &&
pnpm build` should all pass. CI runs exactly that, plus `publint`, `attw`, and
the smoke check.

## Tests

Test first. Write the failing test, watch it fail for the reason you expect,
then make it pass.

Tests must never reach the network. Every HTTP call goes through the injected
`fetchImpl` seam, and CI has no credentials. If a change makes something hard to
test without the network, that is usually a signal the seam is in the wrong
place rather than a reason to skip the test.

## Code style

Biome handles formatting and linting; do not hand-format around it.

Two conventions it cannot enforce:

- **No em dashes**, anywhere: code, comments, docs, commit messages. Use commas,
  semicolons, parentheses, or restructure the sentence.
- **Comments explain why, not what.** The code already says what it does. A
  comment earns its place by recording a decision, a constraint, or a trap.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <subject>`.

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`,
`build`, `ci`, `perf`, `revert`.

Branches are named `type/kebab-case-description`, for example
`fix/cassette-format-bias`.

## Pull requests

Keep them focused. Describe what changed and why, and note anything you
deliberately left out of scope. If a change alters the public API or the shape
of the cache file, say so explicitly, since both are things consumers depend on.

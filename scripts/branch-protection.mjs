#!/usr/bin/env node
/**
 * Apply this repository's intended branch protection to `main`, idempotently.
 *
 * This script is the source of truth for what branch protection on `main` is
 * supposed to look like. It reads the live state, prints a plain-text diff of
 * what it would change, asks before writing, and then verifies the write.
 * Running it twice in a row is a no-op the second time.
 *
 * The intended state, which matches the solo-maintainer posture documented in
 * PUBLISHING.md:
 *
 *   - Require a pull request before merging:            on
 *   - Required approving reviews:                       0
 *       (a solo maintainer cannot approve their own PR, so any higher number
 *       deadlocks every pull request)
 *   - Require review from code owners:                  off
 *   - Require status checks to pass:                    on
 *   - Require branches to be up to date before merging: on  (strict)
 *   - Required status check contexts:                   ["verify"]
 *       (the job name in .github/workflows/ci.yml)
 *   - Enforce for administrators:                       off
 *       (so the maintainer can still merge during a genuine emergency, and
 *       so running this script can never lock anyone out)
 *   - Allow force pushes:                               off
 *   - Allow deletions:                                  off
 *
 * Two things worth knowing before you edit this:
 *
 * 1. `PUT .../protection` replaces the WHOLE protection object. Any setting not
 *    named in the payload reverts to GitHub's default. The settings this script
 *    deliberately omits (required_linear_history, block_creations, lock_branch,
 *    required_conversation_resolution) are all off today, so omitting them is a
 *    no-op. If you ever want one of them on, add it here or the next run will
 *    turn it back off.
 *    Required signatures live on a separate endpoint and are not touched.
 *
 * 2. GitHub accepts `required_status_checks.contexts` (strings) but reads back
 *    `checks` (objects carrying an `app_id`). Comparison therefore normalizes
 *    to sorted context strings and ignores `app_id`; comparing the raw objects
 *    would report a phantom diff on every run and break idempotency.
 *
 * Usage:
 *   node scripts/branch-protection.mjs [--dry-run] [--yes] [--help]
 *   pnpm setup:branch-protection
 *
 * Requires the `gh` CLI, installed and authenticated. Installing it is not this
 * script's job; it fails fast with a pointer if `gh` is missing.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { createInterface } from 'node:readline';

const BRANCH = 'main';

/** The intended state, flattened to the shape `normalize()` produces. */
const INTENDED = {
  require_pull_request_reviews: true,
  'required_pull_request_reviews.required_approving_review_count': 0,
  'required_pull_request_reviews.require_code_owner_reviews': false,
  'required_pull_request_reviews.dismiss_stale_reviews': false,
  'required_pull_request_reviews.require_last_push_approval': false,
  require_status_checks: true,
  'required_status_checks.strict': true,
  'required_status_checks.contexts': ['verify'],
  enforce_admins: false,
  allow_force_pushes: false,
  allow_deletions: false,
};

const USAGE = `Apply this repository's intended branch protection to ${BRANCH}.

Usage:
  node scripts/branch-protection.mjs [options]

Options:
  --dry-run   Print the diff and the payload, then exit without writing.
  --yes       Skip the confirmation prompt. For CI or scripted use.
  --help      Print this message.

Reads the live protection state, prints one line per field it would change,
asks before writing, then verifies. Running it twice does nothing the second
time. The intended state is documented in the comment block at the top of
this file.`;

/**
 * Run a command and capture its result. Never throws; callers inspect `status`.
 * @param {string[]} args arguments to `gh`
 * @param {string} [input] optional stdin content
 */
function gh(args, input) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    failedToStart: result.error !== undefined,
  };
}

/** Print a message to stderr and exit non-zero. */
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** @param {string[]} argv */
function parseFlags(argv) {
  const flags = { dryRun: false, yes: false, help: false };
  for (const arg of argv) {
    if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--yes') {
      flags.yes = true;
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else {
      fail(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  return flags;
}

/** Confirm `gh` is installed and authenticated, or exit with a pointer to the fix. */
function requireGh() {
  const version = gh(['--version']);
  if (version.failedToStart || version.status !== 0) {
    fail('The `gh` CLI is required but was not found. Install it from https://cli.github.com');
  }
  const auth = gh(['auth', 'status']);
  if (auth.status !== 0) {
    fail(`The \`gh\` CLI is not authenticated. Run \`gh auth login\`.\n${auth.stderr.trim()}`);
  }
}

/**
 * Read `owner` and `repo` from the origin remote, accepting both the HTTPS and
 * SSH forms. Anything that is not a GitHub remote is an error, not a guess.
 */
function getRepo() {
  const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail('Could not read `remote.origin.url`. Is this a git repository with an origin remote?');
  }
  const url = (result.stdout ?? '').trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (match === null) {
    fail(`origin is not a GitHub remote: ${url}`);
  }
  return { owner: match[1], repo: match[2] };
}

/**
 * Fetch the live protection object. A branch with no protection at all answers
 * 404, which is an empty current state rather than a failure.
 */
function readCurrentProtection(owner, repo) {
  const result = gh(['api', `/repos/${owner}/${repo}/branches/${BRANCH}/protection`]);
  if (result.status !== 0) {
    if (result.stderr.includes('Branch not protected') || result.stderr.includes('HTTP 404')) {
      return {};
    }
    fail(`Failed to read branch protection:\n${result.stderr.trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`Branch protection response was not valid JSON:\n${result.stdout.slice(0, 500)}`);
  }
}

/**
 * Flatten a live protection object into the same shape as INTENDED.
 *
 * Two normalizations matter. The GET response wraps several booleans as
 * `{ enabled: bool }` while the PUT body takes bare booleans, and status checks
 * read back as `checks` objects with an `app_id` while they are written as
 * `contexts` strings. Both sides of the comparison go through this function so
 * they cannot disagree.
 */
function normalize(protection) {
  const reviews = protection.required_pull_request_reviews;
  const checks = protection.required_status_checks;
  const contexts = checks
    ? (checks.contexts ?? checks.checks?.map((check) => check.context) ?? [])
    : [];
  return {
    require_pull_request_reviews: reviews !== undefined,
    'required_pull_request_reviews.required_approving_review_count':
      reviews?.required_approving_review_count ?? 0,
    'required_pull_request_reviews.require_code_owner_reviews':
      reviews?.require_code_owner_reviews ?? false,
    'required_pull_request_reviews.dismiss_stale_reviews': reviews?.dismiss_stale_reviews ?? false,
    'required_pull_request_reviews.require_last_push_approval':
      reviews?.require_last_push_approval ?? false,
    require_status_checks: checks !== undefined,
    'required_status_checks.strict': checks?.strict ?? false,
    'required_status_checks.contexts': [...contexts].sort(),
    enforce_admins: protection.enforce_admins?.enabled ?? false,
    allow_force_pushes: protection.allow_force_pushes?.enabled ?? false,
    allow_deletions: protection.allow_deletions?.enabled ?? false,
  };
}

/** Render a value for the diff line. Arrays render as compact JSON. */
function show(value) {
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

/**
 * Compare a normalized current state against INTENDED, field by field.
 * @returns {{ field: string, current: string, intended: string }[]}
 */
function computeDiff(current) {
  const changes = [];
  for (const [field, intendedValue] of Object.entries(INTENDED)) {
    const currentValue = current[field];
    const same = Array.isArray(intendedValue)
      ? JSON.stringify([...intendedValue].sort()) === JSON.stringify(currentValue)
      : currentValue === intendedValue;
    if (!same) {
      changes.push({ field, current: show(currentValue), intended: show(intendedValue) });
    }
  }
  return changes;
}

/**
 * Build the PUT body. `restrictions` is nullable but required, so it is sent
 * explicitly as null rather than omitted.
 */
function buildPayload() {
  return {
    required_status_checks: {
      strict: INTENDED['required_status_checks.strict'],
      contexts: INTENDED['required_status_checks.contexts'],
    },
    enforce_admins: INTENDED.enforce_admins,
    required_pull_request_reviews: {
      dismiss_stale_reviews: INTENDED['required_pull_request_reviews.dismiss_stale_reviews'],
      require_code_owner_reviews:
        INTENDED['required_pull_request_reviews.require_code_owner_reviews'],
      required_approving_review_count:
        INTENDED['required_pull_request_reviews.required_approving_review_count'],
      require_last_push_approval:
        INTENDED['required_pull_request_reviews.require_last_push_approval'],
    },
    restrictions: null,
    allow_force_pushes: INTENDED.allow_force_pushes,
    allow_deletions: INTENDED.allow_deletions,
  };
}

function applyProtection(owner, repo, payload) {
  const result = gh(
    [
      'api',
      '--method',
      'PUT',
      `/repos/${owner}/${repo}/branches/${BRANCH}/protection`,
      '--input',
      '-',
    ],
    JSON.stringify(payload),
  );
  if (result.status !== 0) {
    fail(`Failed to apply branch protection:\n${result.stderr.trim()}`);
  }
}

/** Ask a yes-or-no question on stdin. Anything but y or yes is a no. */
function confirm(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(['y', 'yes'].includes(answer.trim().toLowerCase()));
    });
  });
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  requireGh();
  const { owner, repo } = getRepo();
  const current = normalize(readCurrentProtection(owner, repo));
  const changes = computeDiff(current);

  if (changes.length === 0) {
    process.stdout.write('Branch protection is already at intended state.\n');
    return;
  }

  process.stdout.write(`Branch protection changes for ${owner}/${repo}#${BRANCH}:\n`);
  for (const change of changes) {
    process.stdout.write(`  ${change.field}: ${change.current} -> ${change.intended}\n`);
  }

  const payload = buildPayload();
  if (flags.dryRun) {
    process.stdout.write(
      `\nPayload (dry run, nothing written):\n${JSON.stringify(payload, null, 2)}\n`,
    );
    return;
  }

  if (!flags.yes) {
    const ok = await confirm(`\nApply these changes to ${owner}/${repo}#${BRANCH}? [y/N] `);
    if (!ok) {
      process.stdout.write('No changes made.\n');
      return;
    }
  }

  applyProtection(owner, repo, payload);

  // Read back rather than trusting the write, using the same normalization so
  // a mismatch here means a real disagreement and not a formatting artifact.
  const remaining = computeDiff(normalize(readCurrentProtection(owner, repo)));
  if (remaining.length > 0) {
    const lines = remaining.map((c) => `  ${c.field}: ${c.current} (wanted ${c.intended})`);
    fail(`Branch protection was written but does not match intended state:\n${lines.join('\n')}`);
  }
  process.stdout.write('Branch protection applied.\n');
}

main().catch((error) => {
  fail(`Unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
});

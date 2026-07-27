#!/usr/bin/env node
/**
 * Install the packed tarball into a clean directory and actually use it.
 *
 * This exists because `apple-music-developer-token` shipped a bug that every
 * test passed straight over: the tests exercised the source, never the
 * installed artifact, and the failure only appeared once the package was
 * resolved the way a consumer resolves it.
 *
 * That package's bug was a main-module guard behind a .bin symlink. This one
 * has no CLI, so the equivalent risks are different and are what this script
 * targets:
 *
 *   - the exports map pointing somewhere the built files are not
 *   - the `files` array omitting something dist needs
 *   - .js versus .mjs extensions disagreeing with "type": "module"
 *   - `apple-music-developer-token` failing to resolve from a clean install
 *
 * So this does not merely import the package. It calls getListeningLog through
 * both credential paths, with a fake fetch, and asserts on real entries.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const workspace = mkdtempSync(join(tmpdir(), 'listening-log-smoke-'));
let failed = false;

/** Run a command in a directory, surfacing output only when it fails. */
function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function step(name) {
  console.log(`\n  ${name}`);
}

try {
  step('Packing the tarball');
  const packDir = mkdtempSync(join(tmpdir(), 'listening-log-pack-'));
  run('npm', ['pack', '--pack-destination', packDir], root);
  const tarball = readdirSync(packDir).find((file) => file.endsWith('.tgz'));
  assert.ok(tarball, 'npm pack produced no tarball');
  console.log(`    ${tarball}`);

  step('Installing it into a clean directory');
  // A bare package.json with no relationship to the repo, so nothing resolves
  // by accident through the workspace's own node_modules.
  mkdirSync(join(workspace, 'app'), { recursive: true });
  const app = join(workspace, 'app');
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'smoke-consumer', private: true, type: 'module' }, null, 2),
  );
  run('npm', ['install', '--no-audit', '--no-fund', join(packDir, tarball)], app);

  step('Importing the package by name, the way a consumer would');
  const entryPoint = join(app, 'node_modules', 'listening-log', 'dist', 'index.js');
  const api = await import(pathToFileURL(entryPoint).href);
  for (const name of ['getListeningLog', 'parseListeningLog', 'aggregateRows', 'MAX_LIMIT']) {
    assert.ok(name in api, `the installed package does not export ${name}`);
  }

  const listeningYaml = `- title: "Kid A"
  artist: "Radiohead"
  format: vinyl
  playedAt: 2026-05-28
- title: "Kid A"
  artist: "radiohead"
  format: digital
  playedAt: 2026-05-29
- title: "Damaged"
  artist: "Black Flag"
  format: cassette
  playedAt: 2026-05-27
  private: true
`;

  /** A fetch that answers the catalog search with one album and nothing else. */
  const fakeFetch = async (url) => {
    if (String(url).includes('/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: {
            albums: {
              data: [
                {
                  id: '1109714933',
                  attributes: {
                    name: 'Kid A',
                    artistName: 'Radiohead',
                    url: 'https://music.apple.com/us/album/kid-a/1109714933',
                    artwork: { url: 'https://art.test/{w}x{h}bb.jpg', width: 3000, height: 3000 },
                  },
                },
              ],
            },
          },
        }),
      };
    }
    return { ok: false, status: 404 };
  };

  step('Calling getListeningLog with a pre-signed token');
  const preSigned = await api.getListeningLog({
    listeningYaml: { content: listeningYaml },
    appleMusic: { developerToken: 'pre-signed' },
    userAgent: 'listening-log-smoke/0.0.0',
    cache: false,
    rateLimitMs: 0,
    fetchImpl: fakeFetch,
  });

  assert.equal(preSigned.entries.length, 1, 'expected the private album to be excluded');
  const [entry] = preSigned.entries;
  assert.equal(entry.title, 'Kid A');
  assert.equal(entry.playCount, 2, 'expected the two Kid A rows to aggregate');
  assert.equal(entry.format, 'digital', 'expected format from the most recent play');
  assert.equal(entry.playedAt, '2026-05-29');
  assert.equal(entry.appleMusicAlbumId, '1109714933');
  assert.equal(
    entry.artwork.url,
    'https://art.test/500x500bb.jpg',
    'artwork template was not resolved to a usable URL',
  );
  assert.equal(preSigned.lastEntryDate, '2026-05-29');
  console.log(`    ${entry.artist} - ${entry.title} (${entry.format}, played ${entry.playCount}x)`);

  step('Calling getListeningLog with raw credentials, exercising the signing dependency');
  // A real P-256 key, so apple-music-developer-token genuinely signs rather
  // than failing in a way a stub would hide. This is the step that proves the
  // dependency resolved from the clean install.
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  let sawBearer;
  const signed = await api.getListeningLog({
    listeningYaml: { content: listeningYaml },
    appleMusic: {
      keyId: 'ABCDE12345',
      teamId: 'FGHIJ67890',
      privateKeyBase64: Buffer.from(privateKey).toString('base64'),
    },
    userAgent: 'listening-log-smoke/0.0.0',
    cache: false,
    rateLimitMs: 0,
    fetchImpl: async (url, init) => {
      sawBearer = init?.headers?.Authorization;
      return fakeFetch(url);
    },
  });

  assert.equal(signed.entries.length, 1);
  assert.ok(sawBearer?.startsWith('Bearer '), 'no bearer credential reached the catalog request');
  const jwt = sawBearer.slice('Bearer '.length);
  assert.equal(jwt.split('.').length, 3, 'the signed token is not a well-formed JWT');
  console.log(`    signed a ${jwt.length}-character token and sent it as a bearer credential`);

  step('Writing and re-reading a cache file');
  const cachePath = join(app, 'cache.json');
  await api.getListeningLog({
    listeningYaml: { content: listeningYaml },
    appleMusic: { developerToken: 'pre-signed' },
    userAgent: 'listening-log-smoke/0.0.0',
    cache: cachePath,
    rateLimitMs: 0,
    fetchImpl: fakeFetch,
  });

  let requests = 0;
  const warm = await api.getListeningLog({
    listeningYaml: { content: listeningYaml },
    appleMusic: { developerToken: 'pre-signed' },
    userAgent: 'listening-log-smoke/0.0.0',
    cache: cachePath,
    rateLimitMs: 0,
    fetchImpl: async (url) => {
      requests += 1;
      return fakeFetch(url);
    },
  });

  assert.equal(requests, 0, 'a warm cache still hit the network');
  assert.equal(warm.entries[0].appleMusicAlbumId, '1109714933');
  console.log('    warm cache served the album with zero requests');

  console.log('\n  Smoke check passed.\n');
} catch (error) {
  failed = true;
  console.error('\n  Smoke check FAILED\n');
  console.error(error);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);

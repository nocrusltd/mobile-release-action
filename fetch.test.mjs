import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepare, Refused, signed } from './fetch.mjs';

const TOOL = Buffer.from('#!/bin/sh\necho tool\n');
const SUM = createHash('sha256').update(TOOL).digest('hex');
// A release key for the tests, and what the real one signs: the build's
// name, version and SHA-256.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
const OS = { darwin: 'darwin', linux: 'linux' }[process.platform];
const ARCH = { arm64: 'arm64', x64: 'amd64' }[process.arch];
const NAME = `mobile-release-v1-${OS}-${ARCH}`;
const sig = ({ name = NAME, version = '1.2.3', sum = SUM, key = privateKey } = {}) =>
  edSign(null, Buffer.from(`nocrus-mobile-release-v1\n${name}\n${version}\n${sum}\n`), key).toString('base64');

const ENV = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://gh.test/token?x=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'rt' };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A stand-in for GitHub's token endpoint, the licensing service and the
// download host. `grant` is the service's answer; calls are recorded.
function world({ grant, download = () => new Response(TOOL) }) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://gh.test/')) return json(200, { value: 'id-token' });
    if (String(url).endsWith('/ci/v1/grant')) return grant();
    if (String(url) === 'https://dl.test/tool') return download();
    throw new Error(`unexpected request to ${url}`);
  };
  return { calls, fetchFn };
}

const tool = (over = {}) => ({ version: '1.2.3', filename: NAME, sha256: SUM, signature: sig(), url: 'https://dl.test/tool', ...over });
const ok = () => json(200, { licence_file: 'LICENCE', tool: tool() });
const args = async (w, extra = {}) => ({
  env: ENV, dir: await mkdtemp(join(tmpdir(), 'nmr-')), platform: 'ios', licenceKey: 'KEY',
  baseUrl: 'https://lic.test', fetchFn: w.fetchFn, log: () => {}, publicKeyHex: PUB, ...extra,
});

test('a granted run gets the licence file and the tool', async () => {
  const w = world({ grant: ok });
  const a = await args(w);
  const out = await prepare(a);
  assert.equal(await readFile(out.licenceFile, 'utf8'), 'LICENCE');
  assert.deepEqual(await readFile(out.tool), TOOL);
  assert.equal((await stat(out.tool)).mode & 0o777, 0o700);
  assert.equal(out.offline, false);

  const token = w.calls[0];
  assert.match(token.url, /audience=https%3A%2F%2Flicensing\.nocrus\.co\.uk$/);
  const grant = w.calls[1];
  assert.equal(grant.init.headers.authorization, 'Bearer id-token');
  const body = JSON.parse(grant.init.body);
  assert.equal(body.licence_key, 'KEY');
  assert.equal(body.platform, 'ios');
  assert.equal(body.tool_major, 1);
});

test('a cached tool with the right checksum is not downloaded again', async () => {
  const w = world({ grant: ok });
  const a = await args(w);
  await prepare(a);
  const before = w.calls.filter((c) => c.url === 'https://dl.test/tool').length;
  await prepare(a);
  assert.equal(w.calls.filter((c) => c.url === 'https://dl.test/tool').length, before);
});

test('a tool that does not match its checksum is not installed', async () => {
  const w = world({ grant: ok, download: () => new Response('something else') });
  const a = await args(w);
  await assert.rejects(prepare(a), /does not match its checksum/);
  await assert.rejects(stat(join(a.dir, 'mobile-release')));
});

test('a refusal is final, even with a cache', async () => {
  const good = world({ grant: ok });
  const a = await args(good);
  await prepare(a);
  const w = world({ grant: () => json(403, { error: { code: 'LICENCE_EXPIRED', message: 'This licence expired on 1 January 2027.' } }) });
  await assert.rejects(prepare({ ...a, fetchFn: w.fetchFn }), (err) => {
    assert.ok(err instanceof Refused);
    assert.match(err.message, /expired on 1 January 2027\. \(LICENCE_EXPIRED\)/);
    return true;
  });
});

test('an unreachable service falls back to the cache', async () => {
  const good = world({ grant: ok });
  const a = await args(good);
  await prepare(a);
  for (const grant of [() => { throw new Error('connect ETIMEDOUT'); }, () => new Response('bad gateway', { status: 502 })]) {
    const w = world({ grant });
    const out = await prepare({ ...a, fetchFn: w.fetchFn });
    assert.equal(out.offline, true);
  }
});

// The cache is not trusted: with the service down, a tool that is not the
// build the release key signed is not handed back to be run.
test('an unreachable service does not fall back to a cached tool the release key did not sign', async () => {
  const down = () => world({ grant: () => { throw new Error('connect ETIMEDOUT'); } });
  const other = generateKeyPairSync('ed25519').privateKey;
  const EVIL = Buffer.from('#!/bin/sh\necho evil\n');
  const evilSum = createHash('sha256').update(EVIL).digest('hex');
  const cases = {
    'the tool was replaced': async (dir) => writeFile(join(dir, 'mobile-release'), EVIL, { mode: 0o700 }),
    'the tool and its record were replaced, signed by another key': async (dir) => {
      await writeFile(join(dir, 'mobile-release'), EVIL, { mode: 0o700 });
      await writeFile(join(dir, 'mobile-release.sig.json'), JSON.stringify({ version: '1.2.3', signature: sig({ sum: evilSum, key: other }) }));
    },
    'the record is missing, as in a cache an older action saved': async (dir) => rm(join(dir, 'mobile-release.sig.json')),
    'the record is not JSON': async (dir) => writeFile(join(dir, 'mobile-release.sig.json'), 'null'),
    'the record names another version': async (dir) => writeFile(join(dir, 'mobile-release.sig.json'), JSON.stringify({ version: '1.2.4', signature: sig() })),
    'the record names another major': async (dir) => writeFile(join(dir, 'mobile-release.sig.json'), JSON.stringify({ version: '2.0.0', signature: sig({ name: NAME.replace('-v1-', '-v2-'), version: '2.0.0' }) })),
  };
  for (const [name, tamper] of Object.entries(cases)) {
    const a = await args(world({ grant: ok }));
    await prepare(a);
    // untouched, the cache is accepted: the refusals below are the tampering
    assert.equal((await prepare({ ...a, fetchFn: down().fetchFn })).offline, true, name);
    await tamper(a.dir);
    await assert.rejects(prepare({ ...a, fetchFn: down().fetchFn }), /could not be checked against the Nocrus release key/, name);
  }
});

test('an unreachable service with no cache fails', async () => {
  const w = world({ grant: () => { throw new Error('connect ETIMEDOUT'); } });
  await assert.rejects(prepare(await args(w)), /no cached licence/);
});

test('a job without id-token permission is told how to fix it', async () => {
  const w = world({ grant: ok });
  await assert.rejects(prepare(await args(w, { env: {} })), /id-token: write/);
});

test('a missing licence key is refused before any request', async () => {
  const w = world({ grant: ok });
  await assert.rejects(prepare(await args(w, { licenceKey: '' })), /licence-key/);
  assert.equal(w.calls.length, 0);
});

test('the licence key is never logged', async () => {
  const lines = [];
  const w = world({ grant: ok });
  await prepare(await args(w, { licenceKey: 'SECRET-KEY-VALUE', log: (l) => lines.push(l) }));
  assert.ok(!lines.join('\n').includes('SECRET-KEY-VALUE'));
});

test('an answer without a licence file is not half-used', async () => {
  const w = world({ grant: () => json(200, { tool: tool() }) });
  const a = await args(w);
  await assert.rejects(prepare(a), /does not understand/);
  await assert.rejects(stat(join(a.dir, 'licence.lic')));
});

// Whatever the licensing service says, a build runs only if the release key
// signed that name, version and checksum. Each case is a grant that is right
// in every other way; none may leave a tool or a licence file behind, and
// none may be downloaded.
test('a tool the release key did not sign is not downloaded or installed', async () => {
  const other = generateKeyPairSync('ed25519').privateKey;
  const evil = Buffer.from('#!/bin/sh\necho evil\n');
  const evilSum = createHash('sha256').update(evil).digest('hex');
  const cases = {
    'no signature': tool({ signature: undefined }),
    'signed by another key': tool({ signature: sig({ key: other }) }),
    'another binary, with its matching checksum': tool({ sha256: evilSum }),
    'the signature of another version': tool({ version: '1.2.4' }),
    'a signed build for another platform': tool({ signature: sig({ name: 'mobile-release-v1-plan9-mips' }) }),
    'a signed build of another major': tool({ version: '2.0.0', signature: sig({ name: 'mobile-release-v2-' + OS + '-' + ARCH, version: '2.0.0' }) }),
    'not base64': tool({ signature: '!!!' }),
    'a version that is not a version': tool({ version: '1.2.3\nx', signature: sig({ version: '1.2.3\nx' }) }),
  };
  for (const [name, t] of Object.entries(cases)) {
    const w = world({ grant: () => json(200, { licence_file: 'LICENCE', tool: t }), download: () => new Response(evil) });
    const a = await args(w);
    await assert.rejects(prepare(a), /not signed by Nocrus/, name);
    await assert.rejects(stat(join(a.dir, 'mobile-release')), undefined, name);
    await assert.rejects(stat(join(a.dir, 'licence.lic')), undefined, name);
    assert.equal(w.calls.filter((c) => c.url === 'https://dl.test/tool').length, 0, `${name}: downloaded`);
  }
});

// The same bytes packaging/signtool signs: a fixed vector, so the two
// repositories cannot drift apart unnoticed. Key: seed 0x11 repeated.
test('the signed statement matches the release tooling', () => {
  assert.equal(
    signed({
      filename: 'mobile-release-v1-linux-amd64',
      version: '1.2.3',
      sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      signature: 'yR9eBQwqAJSPQzSXuhSOMpFdCwFvxIVGrycAh+tMx+pM8Cy7k3lZA0JN5lSC7l6zFXRxIiqGy66iBouRjW8sCw==',
      publicKeyHex: 'd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737',
    }),
    true,
  );
});

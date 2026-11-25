import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepare, Refused } from './fetch.mjs';

const TOOL = Buffer.from('#!/bin/sh\necho tool\n');
const SUM = createHash('sha256').update(TOOL).digest('hex');
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

const ok = () => json(200, { licence_file: 'LICENCE', tool: { version: '1.2.3', sha256: SUM, url: 'https://dl.test/tool' } });
const args = async (w, extra = {}) => ({
  env: ENV, dir: await mkdtemp(join(tmpdir(), 'nmr-')), platform: 'ios', licenceKey: 'KEY',
  baseUrl: 'https://lic.test', fetchFn: w.fetchFn, log: () => {}, ...extra,
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
  const w = world({ grant: () => json(200, { tool: { sha256: SUM, url: 'https://dl.test/tool' } }) });
  const a = await args(w);
  await assert.rejects(prepare(a), /does not understand/);
  await assert.rejects(stat(join(a.dir, 'licence.lic')));
});

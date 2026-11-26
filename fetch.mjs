// Gets this run a licence and the release tool.
//
// The run proves which GitHub organisation it belongs to with an ID token
// GitHub signs for it, and presents the licence key. The licensing service
// answers with a signed licence file, valid for a few days, and where to
// download the tool. Both are kept in the tool directory, which the action
// caches between runs: if the licensing service cannot be reached, a run with
// a licence file that is still valid carries on with what the cache holds,
// provided the cached tool is still one the release key signed.
//
// Node built-ins only: this file runs as checked out, with no install step.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const AUDIENCE = 'https://licensing.nocrus.co.uk';
// The command-line interface this version of the action drives. The service
// offers the newest tool with this major version.
const TOOL_MAJOR = 1;

// The public half of the key release builds of the tool are signed with
// (nocrusltd/mobile-release, packaging/release-key.pub). The private half
// signs at release time and is held nowhere a download passes through.
// This is the one thing this action trusts about the tool: the licensing
// service, the licence server and its storage only relay a build, and a
// build none of them could have signed is refused here.
const RELEASE_PUBLIC_KEY_HEX = '3d829d0d5ebf9517a82eea041b3976fb6417c713bb20758332a2290572103ed7';

export class Refused extends Error {}

// True when signature is the release key's signature over the statement
// "this file name, at this version, has this SHA-256". The text must match
// packaging/signtool in the tool's repository byte for byte.
export function signed({ filename, version, sha256, signature, publicKeyHex }) {
  try {
    const key = createPublicKey({
      // an Ed25519 public key in SubjectPublicKeyInfo form: a fixed prefix and the 32 bytes
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    const statement = Buffer.from(`nocrus-mobile-release-v1\n${filename}\n${version}\n${sha256}\n`);
    return verify(null, statement, key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

const OS = { darwin: 'darwin', linux: 'linux' };
const ARCH = { arm64: 'arm64', x64: 'amd64' };

async function idToken(env, fetchFn) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) {
    throw new Refused(
      'This job cannot request a GitHub ID token. Add to the job:\n  permissions:\n    id-token: write\n    contents: read',
    );
  }
  const res = await fetchFn(`${url}&audience=${encodeURIComponent(AUDIENCE)}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} to the ID token request`);
  const body = await res.json();
  if (!body.value) throw new Error('GitHub returned no ID token');
  return body.value;
}

async function sha256(path) {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return null;
  }
}

// The name a build for this runner is signed under. The name and the major
// version are ours, never taken from an answer or from the cache, so a signed
// build for another platform or major cannot be passed off here.
const buildName = (os, arch) => `mobile-release-v${TOOL_MAJOR}-${os}-${arch}`;
const VERSION = new RegExp(`^${TOOL_MAJOR}\\.\\d+\\.\\d+$`);

// True when the tool in the cache is, byte for byte, a build the release key
// signed for this runner. The cache is storage like any other: whatever can
// write to it could put a different executable there. The version, checksum
// and signature saved beside the tool are not trusted either; they only have
// to add up to a statement the release key signed about the file on disk.
async function cachedToolSigned({ tool, receipt, os, arch, publicKeyHex }) {
  let saved;
  try {
    saved = JSON.parse(await readFile(receipt, 'utf8'));
  } catch {
    return false;
  }
  const sum = await sha256(tool);
  const version = String(saved?.version ?? '');
  return (
    sum !== null &&
    VERSION.test(version) &&
    signed({ filename: buildName(os, arch), version, sha256: sum, signature: String(saved?.signature ?? ''), publicKeyHex })
  );
}

// Returns { tool, licenceFile, offline }: the paths to run with.
export async function prepare({ env, dir, platform, licenceKey, baseUrl, fetchFn = fetch, log = console.log, publicKeyHex = RELEASE_PUBLIC_KEY_HEX }) {
  const os = OS[process.platform];
  const arch = ARCH[process.arch];
  if (!os || !arch) throw new Refused(`No release tool is published for ${process.platform}/${process.arch}.`);
  if (!licenceKey) {
    throw new Refused('No licence key. Pass it to the action:\n  with:\n    licence-key: ${{ secrets.NOCRUS_LICENCE_KEY }}');
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tool = join(dir, 'mobile-release');
  const licenceFile = join(dir, 'licence.lic');
  const receipt = join(dir, 'mobile-release.sig.json');

  const token = await idToken(env, fetchFn);

  let res;
  let grant;
  try {
    res = await fetchFn(`${baseUrl}/ci/v1/grant`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ licence_key: licenceKey, platform, os, arch, tool_major: TOOL_MAJOR }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status >= 500) throw new Error(`status ${res.status}`);
    grant = await res.json();
  } catch (err) {
    // Unreachable or failing, as opposed to an answer of "no": carry on with
    // a cached licence file if there is one. The tool checks the file's
    // signature and expiry itself, so a stale cache cannot extend a licence.
    // The tool is checked here, against the release key, before it is run.
    if ((await sha256(tool)) && (await sha256(licenceFile))) {
      if (!(await cachedToolSigned({ tool, receipt, os, arch, publicKeyHex }))) {
        throw new Error(`The licensing service could not be reached (${err.message}) and the release tool in this runner's cache could not be checked against the Nocrus release key, so it was not run. Re-run the job when the service is reachable; if it persists, contact Nocrus support.`);
      }
      log(`::warning::The licensing service could not be reached (${err.message}). Continuing with the cached licence file, which the tool will check.`);
      return { tool, licenceFile, offline: true };
    }
    throw new Error(`The licensing service could not be reached (${err.message}) and this runner has no cached licence to fall back on. Re-run the job; if it persists, contact Nocrus support.`);
  }
  if (!res.ok) {
    // An answer of "no" is final: never fall back to the cache.
    const e = grant?.error ?? {};
    throw new Refused(`${e.message ?? `The licensing service answered ${res.status}.`}${e.code ? ` (${e.code})` : ''}`);
  }
  if (typeof grant.licence_file !== 'string' || !/^[0-9a-f]{64}$/.test(grant.tool?.sha256 ?? '') || !grant.tool?.url) {
    throw new Error('The licensing service sent an answer this version of the action does not understand. Update the action.');
  }

  // Before anything is written or downloaded: the build on offer must be one
  // the release key signed, under the name this runner asked for and at a
  // version this action drives.
  const version = String(grant.tool.version ?? '');
  const signature = String(grant.tool.signature ?? '');
  if (
    !VERSION.test(version) ||
    !signed({ filename: buildName(os, arch), version, sha256: grant.tool.sha256, signature, publicKeyHex })
  ) {
    throw new Error('The release tool on offer is not signed by Nocrus. Nothing was downloaded or run. Re-run the job; if it persists, contact Nocrus support and do not work around this.');
  }

  await writeFile(licenceFile, grant.licence_file, { mode: 0o600 });

  if ((await sha256(tool)) !== grant.tool.sha256) {
    const dl = await fetchFn(grant.tool.url, { signal: AbortSignal.timeout(300_000) });
    if (!dl.ok) throw new Error(`Downloading the release tool answered ${dl.status}.`);
    const bytes = Buffer.from(await dl.arrayBuffer());
    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== grant.tool.sha256) {
      throw new Error('The downloaded release tool does not match its checksum. Nothing was run. Re-run the job; if it persists, contact Nocrus support.');
    }
    // Written beside its final name and moved into place, so an interrupted
    // download never leaves a half-written executable in the cache.
    const tmp = `${tool}.download`;
    await writeFile(tmp, bytes, { mode: 0o700 });
    await rename(tmp, tool);
    log(`Release tool ${grant.tool.version} downloaded.`);
  } else {
    log(`Release tool ${grant.tool.version} (cached).`);
  }
  await chmod(tool, 0o700);
  // What a later run needs to check this tool again without the service.
  await writeFile(receipt, JSON.stringify({ version, signature }), { mode: 0o600 });
  return { tool, licenceFile, offline: false };
}

async function main() {
  const env = process.env;
  try {
    const out = await prepare({
      env,
      dir: env.NOCRUS_TOOL_DIR,
      platform: env.INPUT_PLATFORM,
      licenceKey: env.INPUT_LICENCE_KEY,
      baseUrl: (env.INPUT_LICENSING_URL || AUDIENCE).replace(/\/+$/, ''),
    });
    appendFileSync(env.GITHUB_OUTPUT, `tool=${out.tool}\nlicence-file=${out.licenceFile}\n`);
  } catch (err) {
    // One annotation, no stack: the message is written for the person
    // reading the job log.
    console.log(`::error title=Nocrus Mobile Release::${String(err.message).replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

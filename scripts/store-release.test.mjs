import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { chromeRelease, configuration as chromeConfiguration } from './chrome-store.mjs';
import { firefoxRelease, authorization, releaseProof, configuration as firefoxConfiguration } from './firefox-store.mjs';
import { cliMode, digest, ReleaseError, requestJson, root, storeIds, verifiedArchive, verifiedSource } from './release-utils.mjs';

const version = '2.8.0';
const archive = Buffer.from('verified extension bytes');
const source = Buffer.from('verified source bytes');
const chromeConfig = { publisher: 'publisher-id', oauth: { client_id: 'client', client_secret: 'private-client', refresh_token: 'private-refresh' } };
const firefoxConfig = { issuer: 'issuer', secret: 'private-amo' };
const revision = (state, number = version) => ({ state, distributionChannels: [{ crxVersion: number }] });
const chromeResponse = fields => ({ itemId: storeIds.chrome, name: `publishers/${chromeConfig.publisher}/items/${storeIds.chrome}`, ...fields });
const amoVersion = fields => ({ id: 123, version, channel: 'listed', file: { status: 'unreviewed', hash: 'sha256:changed-by-signing' }, source: 'private-source-url', approval_notes: releaseProof(archive, source), ...fields });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });

function sequence(items) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, ...init });
    const next = items.shift();
    assert.notEqual(next, undefined, `Unexpected request ${init.method} ${url}`);
    return typeof next === 'function' ? next(url, init) : response(next);
  };
  return { fetcher, calls, done: () => assert.equal(items.length, 0) };
}

test('CLI requires an explicit single safe mode', () => {
  assert.equal(cliMode(['--dry-run']), '--dry-run');
  for (const args of [[], ['--submit', '--dry-run'], ['--force'], ['--submit', 'arbitrary.zip']]) assert.throws(() => cliMode(args), ReleaseError);
});

test('credential validation reports names, without echoing input or secrets', () => {
  for (const env of [{}, { CWS_PUBLISHER_ID: '../other' }, { CWS_PUBLISHER_ID: 'valid', CWS_SERVICE_ACCOUNT_JSON: '{private-token' }, { CWS_PUBLISHER_ID: 'valid', CWS_SERVICE_ACCOUNT_JSON: JSON.stringify({ private_key: 'private-token' }) }]) {
    assert.throws(() => chromeConfiguration(env), error => error instanceof ReleaseError && !error.message.includes('private-token'));
  }
  assert.equal(chromeConfiguration({ CWS_PUBLISHER_ID: 'valid', CWS_CLIENT_ID: 'id', CWS_CLIENT_SECRET: 'secret', CWS_REFRESH_TOKEN: 'refresh' }).oauth.refresh_token, 'refresh');
  assert.throws(() => firefoxConfiguration({ AMO_JWT_ISSUER: 'issuer' }), /AMO_JWT_SECRET/);
});

test('network errors, redirects, and invalid JSON do not expose raw secret responses', async () => {
  for (const fetcher of [async () => { throw new Error('private-token'); }, async () => response({ secret: 'private-token' }, 403), async () => new Response('private-token')]) {
    await assert.rejects(requestJson(fetcher, 'https://example.invalid', {}, 'Store'), error => error instanceof ReleaseError && !error.message.includes('private-token'));
  }
  await requestJson(async (_url, init) => { assert.equal(init.redirect, 'error'); assert.ok(init.signal); return response({}); }, 'https://example.invalid', {}, 'Store');
  assert.equal(await requestJson(async () => response({}, 404), 'https://example.invalid', {}, 'Store', { allow404: true }), null);
});

test('Chrome OAuth and read-only status perform no upload or publish', async () => {
  const mock = sequence([{ access_token: 'private-access' }, chromeResponse({ publishedItemRevisionStatus: revision('PUBLISHED', '2.7.3') })]);
  const result = await chromeRelease({ config: chromeConfig, version, statusOnly: true, fetcher: mock.fetcher });
  assert.equal(result.publishedState, 'PUBLISHED');
  assert.deepEqual(result.publishedVersions, ['2.7.3']);
  assert.equal(mock.calls[0].body.get('grant_type'), 'refresh_token');
  assert.equal(mock.calls[1].method, 'GET');
  assert.equal(mock.calls[1].headers.Authorization, 'Bearer private-access');
  assert.ok(!JSON.stringify(result).includes('private-access'));
  mock.done();
});

test('Chrome service-account JWT is scoped, expiring, and signed', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credentials = { type: 'service_account', client_email: 'release@example.invalid', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const mock = sequence([(url, init) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    const [header, payload, signature] = init.body.get('assertion').split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/chromewebstore');
    assert.equal(claims.aud, url);
    assert.equal(claims.exp - claims.iat, 3600);
    assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')));
    return response({ access_token: 'private-access' });
  }, chromeResponse({})]);
  await chromeRelease({ config: { publisher: chromeConfig.publisher, credentials }, version, statusOnly: true, fetcher: mock.fetcher });
  mock.done();
});

test('Chrome upload waits for success, requests review, and confirms the release version', async () => {
  const mock = sequence([{ access_token: 'token' }, chromeResponse({}), chromeResponse({ uploadState: 'UPLOAD_IN_PROGRESS' }), chromeResponse({ lastAsyncUploadState: 'SUCCEEDED' }), chromeResponse({ state: 'PENDING_REVIEW' }), chromeResponse({ submittedItemRevisionStatus: revision('PENDING_REVIEW') })]);
  const waits = [];
  const result = await chromeRelease({ config: chromeConfig, version, archive, fetcher: mock.fetcher, wait: async ms => waits.push(ms) });
  assert.equal(result.state, 'PENDING_REVIEW');
  assert.equal(result.alreadySubmitted, false);
  assert.deepEqual(waits, [10000]);
  assert.ok(mock.calls[2].url.includes('/upload/v2/'));
  assert.equal(mock.calls[2].body, archive);
  assert.deepEqual(JSON.parse(mock.calls[4].body), { publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true });
  mock.done();
});

test('Chrome retry preserves an already submitted matching version', async () => {
  const mock = sequence([{ access_token: 'token' }, chromeResponse({ submittedItemRevisionStatus: revision('PENDING_REVIEW') })]);
  assert.equal((await chromeRelease({ config: chromeConfig, version, archive, fetcher: mock.fetcher })).alreadySubmitted, true);
  mock.done();
});

test('Chrome refuses another pending version, policy warnings, and identity mismatch before upload', async () => {
  for (const status of [chromeResponse({ submittedItemRevisionStatus: revision('PENDING_REVIEW', '2.7.4') }), chromeResponse({ warned: true }), chromeResponse({ takenDown: true }), { itemId: 'different-item' }]) {
    const mock = sequence([{ access_token: 'token' }, status]);
    await assert.rejects(chromeRelease({ config: chromeConfig, version, archive, fetcher: mock.fetcher }), ReleaseError);
    assert.equal(mock.calls.length, 2); mock.done();
  }
});

test('Chrome failed upload never calls publish', async () => {
  const mock = sequence([{ access_token: 'token' }, chromeResponse({}), chromeResponse({ uploadState: 'FAILED' })]);
  await assert.rejects(chromeRelease({ config: chromeConfig, version, archive, fetcher: mock.fetcher }), /upload failed/);
  mock.done();
});

test('Chrome rejects uploaded version mismatch and unconfirmed submission', async () => {
  for (const tail of [[chromeResponse({ uploadState: 'SUCCEEDED', crxVersion: '9.0.0' })], [chromeResponse({ uploadState: 'SUCCEEDED' }), chromeResponse({ state: 'PENDING_REVIEW' }), chromeResponse({ submittedItemRevisionStatus: revision('PENDING_REVIEW', '2.7.3') })]]) {
    const mock = sequence([{ access_token: 'token' }, chromeResponse({}), ...tail]);
    await assert.rejects(chromeRelease({ config: chromeConfig, version, archive, fetcher: mock.fetcher }), ReleaseError); mock.done();
  }
});

test('AMO JWT is signed and short-lived', () => {
  const [header, payload, signature] = authorization(firefoxConfig, 123456).slice(4).split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.deepEqual({ iss: claims.iss, iat: claims.iat, exp: claims.exp }, { iss: 'issuer', iat: 123456, exp: 123516 });
  assert.equal(signature, createHmac('sha256', firefoxConfig.secret).update(`${header}.${payload}`).digest('base64url'));
  assert.notEqual(authorization(firefoxConfig, 123456), authorization(firefoxConfig, 123456));
});

test('AMO status checks identity and never uploads', async () => {
  const mock = sequence([{ guid: storeIds.firefox }, amoVersion({ file: { status: 'public' } })]);
  const result = await firefoxRelease({ config: firefoxConfig, version, statusOnly: true, fetcher: mock.fetcher });
  assert.equal(result.state, 'public'); assert.equal(result.reviewerSourceAttached, true);
  assert.ok(mock.calls.every(call => call.method === 'GET')); mock.done();
});

test('AMO creates a listed version with reviewer source and release digests in the same request', async () => {
  const uuid = '12345678123412341234123456789abc';
  const uploaded = { uuid, channel: 'listed', version, processed: true, valid: true, submitted: false };
  const mock = sequence([{ guid: storeIds.firefox }, () => response({}, 404), { ...uploaded, processed: false }, uploaded, (_url, init) => {
    assert.ok(init.body instanceof FormData);
    assert.equal(init.body.get('upload'), uuid);
    assert.equal(init.body.get('license'), 'GPL-3.0-only');
    assert.equal(init.body.get('source').size, source.length);
    assert.ok(init.body.get('approval_notes').includes(releaseProof(archive, source)));
    return response(amoVersion());
  }, amoVersion(), amoVersion()]);
  const waits = [];
  const result = await firefoxRelease({ config: firefoxConfig, version, archive, source, notes: 'User release notes', approvalNotes: 'Reviewer build notes', fetcher: mock.fetcher, wait: async ms => waits.push(ms) });
  assert.equal(result.channel, 'listed'); assert.equal(result.state, 'unreviewed'); assert.equal(result.reviewerSourceAttached, true);
  assert.deepEqual(waits, [10000]);
  assert.equal(mock.calls[2].body.get('channel'), 'listed');
  assert.equal(mock.calls[2].body.get('upload').size, archive.length);
  assert.deepEqual(JSON.parse(mock.calls[5].body).release_notes, { 'en-US': 'User release notes' });
  mock.done();
});

test('AMO supports canonical upload UUIDs and rejects malformed IDs before polling or submission', async () => {
  const uuid = '12345678-1234-1234-1234-123456789abc';
  const mock = sequence([{ guid: storeIds.firefox }, () => response({}, 404), { uuid, channel: 'listed', version, processed: true, valid: true, submitted: false }, amoVersion(), amoVersion()]);
  assert.equal((await firefoxRelease({ config: firefoxConfig, version, archive, source, fetcher: mock.fetcher })).state, 'unreviewed');
  assert.equal(mock.calls[3].body.get('upload'), uuid);
  mock.done();
  for (const invalid of ['-'.repeat(36), '../other-upload', 'g'.repeat(32), '12345678123412341234123456789abc/']) {
    const rejected = sequence([{ guid: storeIds.firefox }, () => response({}, 404), { uuid: invalid }]);
    await assert.rejects(firefoxRelease({ config: firefoxConfig, version, archive, source, fetcher: rejected.fetcher }), /invalid upload identity/);
    rejected.done();
  }
});

test('AMO retries recognize the exact release after signing changes XPI hash', async () => {
  const mock = sequence([{ guid: storeIds.firefox }, amoVersion({ file: { status: 'public', hash: 'sha256:signed-by-mozilla' } }), amoVersion({ file: { status: 'public' } })]);
  const result = await firefoxRelease({ config: firefoxConfig, version, archive, source, fetcher: mock.fetcher });
  assert.equal(result.alreadySubmitted, true); assert.equal(result.state, 'public');
  assert.ok(mock.calls.every(call => call.method === 'GET')); mock.done();
});

test('AMO retry repairs missing source only for a proven matching release', async () => {
  const mock = sequence([{ guid: storeIds.firefox }, amoVersion({ source: null }), (_url, init) => { assert.equal(init.method, 'PATCH'); assert.equal(init.body.get('source').size, source.length); return response(amoVersion()); }, amoVersion()]);
  const result = await firefoxRelease({ config: firefoxConfig, version, archive, source, fetcher: mock.fetcher });
  assert.equal(result.reviewerSourceAttached, true); mock.done();
});

test('AMO refuses mismatched release/source digests, rejected versions, and wrong channel', async () => {
  for (const current of [amoVersion({ approval_notes: '' }), amoVersion({ approval_notes: releaseProof(archive, Buffer.from('other sources')) }), amoVersion({ channel: 'unlisted' }), amoVersion({ file: { status: 'disabled' } }), amoVersion({ is_disabled: true })]) {
    const mock = sequence([{ guid: storeIds.firefox }, current]);
    await assert.rejects(firefoxRelease({ config: firefoxConfig, version, archive, source, fetcher: mock.fetcher }), ReleaseError);
    assert.ok(mock.calls.every(call => call.method === 'GET')); mock.done();
  }
});

test('AMO invalid upload is never converted into a submitted version', async () => {
  const mock = sequence([{ guid: storeIds.firefox }, () => response({}, 404), { uuid: '12345678-1234-1234-1234-123456789abc', processed: true, valid: false, version, channel: 'listed' }]);
  await assert.rejects(firefoxRelease({ config: firefoxConfig, version, archive, source, fetcher: mock.fetcher }), /validation failed/); mock.done();
});

test('AMO fails if reviewer source attachment is not confirmed', async () => {
  const mock = sequence([{ guid: storeIds.firefox }, () => response({}, 404), { uuid: '12345678-1234-1234-1234-123456789abc', processed: true, valid: true, version, channel: 'listed' }, amoVersion({ source: null })]);
  await assert.rejects(firefoxRelease({ config: firefoxConfig, version, archive, source, fetcher: mock.fetcher }), /source confirmation/); mock.done();
});

async function fixture(t, files, filename = 'release.zip') {
  const parent = resolve(root, '.release-local'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, 'test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contents = resolve(directory, 'contents'); await mkdir(contents);
  for (const [file, data] of Object.entries(files)) {
    const path = resolve(contents, file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, data);
  }
  const path = resolve(directory, filename);
  execFileSync('zip', ['-X', '-qr', path, '.'], { cwd: contents });
  const { readFile } = await import('node:fs/promises');
  const bytes = await readFile(path);
  const checksums = resolve(directory, 'SHA256SUMS'); await writeFile(checksums, `${digest(bytes)}  ${filename}\n`);
  return { path, checksums, bytes };
}

test('workflow submission tools use the tagged checkout for release metadata', async t => {
  const parent = resolve(root, '.release-local'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, 'tagged-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const target of ['URLAlchemist_chrome', 'URLAlchemist_Firefox']) {
    await mkdir(resolve(directory, target, 'public'), { recursive: true });
    await writeFile(resolve(directory, target, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    await writeFile(resolve(directory, target, 'public/manifest.json'), JSON.stringify({ version: '1.2.3', browser_specific_settings: { gecko: { id: storeIds.firefox } } }));
  }
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', "import { metadata } from './scripts/release-utils.mjs'; console.log(JSON.stringify(await metadata()));"], { cwd: root, env: { ...process.env, STORE_RELEASE_ROOT: directory }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), { version: '1.2.3', tag: 'v1.2.3' });
});

test('archive verification rejects a changed digest, wrong version, and missing root manifest', async t => {
  const valid = await fixture(t, { 'manifest.json': JSON.stringify({ version, manifest_version: 3 }) });
  assert.deepEqual(await verifiedArchive(valid.path, version, 'chrome', valid.checksums), valid.bytes);
  await assert.rejects(verifiedArchive(valid.path, '1.0.0', 'chrome', valid.checksums), /version/);
  await writeFile(valid.checksums, `${'0'.repeat(64)}  release.zip\n`);
  await assert.rejects(verifiedArchive(valid.path, version, 'chrome', valid.checksums), /checksum/);
  const nested = await fixture(t, { 'nested/manifest.json': JSON.stringify({ version, manifest_version: 3 }) });
  await assert.rejects(verifiedArchive(nested.path, version, 'chrome', nested.checksums), /root/);
});

test('Firefox archive verification requires the published add-on GUID', async t => {
  const valid = await fixture(t, { 'manifest.json': JSON.stringify({ version, manifest_version: 3, browser_specific_settings: { gecko: { id: storeIds.firefox } } }) });
  assert.deepEqual(await verifiedArchive(valid.path, version, 'firefox', valid.checksums), valid.bytes);
  const wrong = await fixture(t, { 'manifest.json': JSON.stringify({ version, manifest_version: 3, browser_specific_settings: { gecko: { id: 'other@example.invalid' } } }) });
  await assert.rejects(verifiedArchive(wrong.path, version, 'firefox', wrong.checksums), /add-on ID/);
});

test('reviewer source must contain reproducible inputs and exclude private/generated files', async t => {
  const files = Object.fromEntries(['package-lock.json', 'REVIEWER_NOTES.md', 'reviewer-build.sh', 'RELEASE_BUILD_TIME.txt', 'src/options/App.tsx'].map(file => [`URLAlchemist_Firefox/${file}`, 'source']));
  const valid = await fixture(t, files); assert.deepEqual(await verifiedSource(valid.path, valid.checksums), valid.bytes);
  for (const forbidden of ['.env', '.env.production', 'node_modules/dependency.js', 'private.pem', 'dist 2.zip']) {
    const invalid = await fixture(t, { ...files, [`URLAlchemist_Firefox/${forbidden}`]: 'private' });
    await assert.rejects(verifiedSource(invalid.path, invalid.checksums), /private|generated/);
  }
  const missing = await fixture(t, { 'URLAlchemist_Firefox/src/options/App.tsx': 'source' });
  await assert.rejects(verifiedSource(missing.path, missing.checksums), /missing/);
});

test('both real source packagers exclude nested uploads, environment files, and keys', async t => {
  const parent = resolve(root, '.release-local'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, 'packager-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const target of ['URLAlchemist_chrome', 'URLAlchemist_Firefox']) {
    const project = resolve(directory, target); await mkdir(resolve(project, 'src'), { recursive: true });
    await writeFile(resolve(project, 'package.json'), JSON.stringify({ version }));
    await writeFile(resolve(project, 'src/entry.ts'), 'export const source = true;');
    for (const name of ['.env', '.env.local', 'private.pem', 'private.key', 'dist 2.zip', 'old.xpi', 'old.crx', 'old.tar.gz']) await writeFile(resolve(project, name), 'private');
    await copyFile(resolve(root, target, 'reviewer-source-package.sh'), resolve(project, 'reviewer-source-package.sh'));
    execFileSync('bash', [resolve(project, 'reviewer-source-package.sh')], { cwd: project, env: { ...process.env, URL_ALCHEMIST_BUILD_TIME: '2026-10-09T00:00:00.000Z' } });
    const browser = target.endsWith('chrome') ? 'Chrome' : 'Firefox';
    const packagePath = resolve(directory, `URLAlchemist_${target.endsWith('chrome') ? 'chrome' : 'Firefox'}_artifacts/URLAlchemist_${browser}_source.zip`);
    const entries = execFileSync('unzip', ['-Z1', packagePath], { encoding: 'utf8' }).split('\n');
    assert.ok(entries.includes(`${target}/src/entry.ts`));
    assert.ok(entries.includes(`${target}/RELEASE_BUILD_TIME.txt`));
    assert.ok(!entries.some(file => /(?:\.env|private|dist 2|old\.)/.test(file)));
    assert.equal(execFileSync('unzip', ['-p', packagePath, `${target}/RELEASE_BUILD_TIME.txt`], { encoding: 'utf8' }).trim(), '2026-10-09T00:00:00.000Z');
  }
});

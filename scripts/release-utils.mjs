import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const storeIds = Object.freeze({
  chrome: 'ijonigkmhlokmdhcjcjinhpionfnjdeo',
  firefox: 'url-alchemist@gnaservicesinc.com',
});
export class ReleaseError extends Error {}
export const fail = message => { throw new ReleaseError(message); };
export const digest = data => createHash('sha256').update(data).digest('hex');
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export const isMain = url => process.argv[1] && url === pathToFileURL(resolve(process.argv[1])).href;
const execute = promisify(execFile);

export async function readJson(path, label = basename(path)) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { fail(`Cannot read valid JSON from ${label}`); }
}

export async function metadata() {
  const files = ['URLAlchemist_chrome/package.json', 'URLAlchemist_chrome/public/manifest.json',
    'URLAlchemist_Firefox/package.json', 'URLAlchemist_Firefox/public/manifest.json'];
  const documents = await Promise.all(files.map(file => readJson(resolve(root, file))));
  const version = documents[0].version;
  if (!/^\d+\.\d+\.\d+$/.test(version || '') || !documents.every(item => item.version === version)) {
    fail('Chrome and Firefox package/manifest versions must match');
  }
  if (documents[3].browser_specific_settings?.gecko?.id !== storeIds.firefox) fail('Firefox add-on ID differs from the release identity');
  return { version, tag: `v${version}` };
}

export function cliMode(args = process.argv.slice(2)) {
  const modes = ['--submit', '--status', '--preflight', '--dry-run'];
  if (args.length !== 1 || !modes.includes(args[0])) fail(`Choose exactly one of ${modes.join(', ')}`);
  return args[0];
}

export async function requestJson(fetcher, url, init, label, { allow404 = false } = {}) {
  let response;
  try { response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(120000) }); }
  catch { fail(`${label} request failed or timed out; check the store dashboard before retrying`); }
  if (allow404 && response.status === 404) return null;
  if (!response.ok) fail(`${label} failed (HTTP ${response.status}); check credentials, store metadata, and the dashboard`);
  try { return await response.json(); }
  catch { fail(`${label} returned invalid JSON; check the dashboard before retrying`); }
}

export async function verifiedArchive(path, version, browser, checksumsPath) {
  let archive, lines;
  try {
    archive = await readFile(path);
    lines = (await readFile(checksumsPath, 'utf8')).split('\n');
  } catch { fail(`Missing release archive or checksums for ${browser}; run npm run build first`); }
  const filename = basename(path);
  const matches = lines.filter(line => /^[a-f0-9]{64}  [^/\\]+$/.test(line) && line.slice(66) === filename);
  if (matches.length !== 1 || digest(archive) !== matches[0].slice(0, 64)) fail(`${browser} archive checksum differs from the release manifest`);
  let manifest;
  try {
    const result = await execute('unzip', ['-p', path, 'manifest.json'], { maxBuffer: 1024 * 1024 });
    manifest = JSON.parse(result.stdout);
  } catch { fail(`${browser} release archive must contain manifest.json at its root`); }
  if (manifest.version !== version || manifest.manifest_version !== 3) fail(`${browser} archive version or manifest format differs from the release`);
  if (browser === 'firefox' && manifest.browser_specific_settings?.gecko?.id !== storeIds.firefox) fail('Firefox release archive has a different add-on ID');
  return archive;
}

export async function verifiedSource(path, checksumsPath) {
  let archive, lines, entries;
  try {
    archive = await readFile(path);
    lines = (await readFile(checksumsPath, 'utf8')).split('\n');
    entries = (await execute('unzip', ['-Z1', path], { maxBuffer: 8 * 1024 * 1024 })).stdout.split('\n');
  } catch { fail('Missing Firefox reviewer source ZIP or checksum manifest'); }
  const matches = lines.filter(line => /^[a-f0-9]{64}  [^/\\]+$/.test(line) && line.slice(66) === basename(path));
  if (matches.length !== 1 || digest(archive) !== matches[0].slice(0, 64)) fail('Firefox reviewer source checksum differs from the release manifest');
  for (const file of ['package-lock.json', 'REVIEWER_NOTES.md', 'reviewer-build.sh', 'RELEASE_BUILD_TIME.txt', 'src/options/App.tsx']) {
    if (!entries.includes(`URLAlchemist_Firefox/${file}`)) fail(`Firefox reviewer source ZIP is missing ${file}`);
  }
  if (entries.some(file => /(^|\/)(node_modules|dist|\.git|\.release-local|\.DS_Store|\.env(?:\..*)?)(\/|$)/.test(file) || /\.(?:pem|key|zip|xpi|crx|tar\.gz)$/.test(file) || file.startsWith('/') || file.split('/').includes('..'))) fail('Firefox reviewer source ZIP includes generated, private, or unsafe files');
  return archive;
}

export function report(result) { console.log(JSON.stringify(result)); }
export function reportFailure(error) {
  // Only our own sanitized errors are printed. Native errors, HTTP bodies, and
  // parsed credential errors can contain secrets and must never reach CI logs.
  console.error(error instanceof ReleaseError ? error.message : 'Release operation failed; check configuration and the store dashboard');
  process.exitCode = 1;
}

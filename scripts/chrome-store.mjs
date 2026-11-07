// Chrome Web Store V2; credentials and raw authentication/API responses are never logged.
import { createSign } from 'node:crypto';
import { resolve } from 'node:path';
import { cliMode, fail, isMain, metadata, pause, report, reportFailure, requestJson, root, storeIds, verifiedArchive } from './release-utils.mjs';

const origin = 'https://chromewebstore.googleapis.com';
const scope = 'https://www.googleapis.com/auth/chromewebstore';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const acceptedStates = new Set(['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS', 'STAGED']);

export function configuration(env = process.env) {
  const publisher = env.CWS_PUBLISHER_ID;
  if (!/^[A-Za-z0-9_-]+$/.test(publisher || '')) fail('Set Actions variable CWS_PUBLISHER_ID for the URL Alchemist publisher');
  if (env.CWS_SERVICE_ACCOUNT_JSON) {
    let credentials;
    try { credentials = JSON.parse(env.CWS_SERVICE_ACCOUNT_JSON); }
    catch { fail('CWS_SERVICE_ACCOUNT_JSON must contain valid service-account JSON'); }
    if (credentials?.type !== 'service_account' || typeof credentials.client_email !== 'string' || !credentials.client_email || typeof credentials.private_key !== 'string' || !credentials.private_key) fail('CWS_SERVICE_ACCOUNT_JSON must contain service_account type, client_email, and private_key');
    return { publisher, credentials };
  }
  if (!env.CWS_CLIENT_ID || !env.CWS_CLIENT_SECRET || !env.CWS_REFRESH_TOKEN) {
    fail('Set Actions secret CWS_SERVICE_ACCOUNT_JSON, or all of CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN');
  }
  return { publisher, oauth: { client_id: env.CWS_CLIENT_ID, client_secret: env.CWS_CLIENT_SECRET, refresh_token: env.CWS_REFRESH_TOKEN } };
}

async function accessToken(config, fetcher) {
  let body;
  if (config.credentials) {
    const now = Math.floor(Date.now() / 1000);
    const jwt = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: config.credentials.client_email, scope,
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
    let signature;
    try { const signer = createSign('RSA-SHA256'); signer.update(jwt); signer.end(); signature = signer.sign(config.credentials.private_key, 'base64url'); }
    catch { fail('CWS_SERVICE_ACCOUNT_JSON private_key cannot sign the authentication request'); }
    body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${jwt}.${signature}` });
  } else {
    body = new URLSearchParams({ grant_type: 'refresh_token', ...config.oauth });
  }
  const response = await requestJson(fetcher, 'https://oauth2.googleapis.com/token', { method: 'POST', body }, 'Google authentication');
  if (typeof response.access_token !== 'string' || !response.access_token) fail('Google authentication returned no access token');
  return response.access_token;
}

const versions = revision => revision?.distributionChannels?.map(item => item.crxVersion) || [];
const includesVersion = (revision, version) => versions(revision).includes(version);

export async function chromeRelease({ config, version, archive, statusOnly = false, fetcher = fetch, wait = pause }) {
  if (!/^[A-Za-z0-9_-]+$/.test(config.publisher || '') || !/^\d+\.\d+\.\d+$/.test(version || '')) fail('Invalid Chrome release configuration');
  const token = await accessToken(config, fetcher);
  const name = `publishers/${config.publisher}/items/${storeIds.chrome}`;
  const request = async (url, method = 'GET', body, type) => {
    const value = await requestJson(fetcher, url, { method, body, headers: { Authorization: `Bearer ${token}`, ...(type ? { 'Content-Type': type } : {}) } }, 'Chrome Web Store');
    if (value.itemId !== storeIds.chrome || (value.name && value.name !== name)) fail('Chrome Web Store returned a different extension identity');
    return value;
  };
  const status = await request(`${origin}/v2/${name}:fetchStatus`);
  const summary = {
    store: 'chrome', itemId: storeIds.chrome, version,
    publishedState: status.publishedItemRevisionStatus?.state || null,
    publishedVersions: versions(status.publishedItemRevisionStatus),
    submittedState: status.submittedItemRevisionStatus?.state || null,
    submittedVersions: versions(status.submittedItemRevisionStatus),
  };
  if (statusOnly) return summary;
  if (status.takenDown || status.warned) fail('Chrome listing has a policy warning or takedown; resolve it in the Developer Dashboard before submitting');
  for (const revision of [status.publishedItemRevisionStatus, status.submittedItemRevisionStatus]) {
    if (includesVersion(revision, version) && acceptedStates.has(revision.state)) return { ...summary, state: revision.state, alreadySubmitted: true };
  }
  if (['PENDING_REVIEW', 'STAGED'].includes(status.submittedItemRevisionStatus?.state)) fail('Another Chrome version is awaiting review or staged; inspect the Developer Dashboard before submitting this version');
  if (!archive?.length) fail('Chrome archive is empty');
  const upload = await request(`${origin}/upload/v2/${name}:upload`, 'POST', archive, 'application/zip');
  if (upload.crxVersion && upload.crxVersion !== version) fail('Chrome uploaded version differs from the release');
  let state = upload.uploadState;
  for (let attempt = 0; ['IN_PROGRESS', 'UPLOAD_IN_PROGRESS'].includes(state) && attempt < 60; attempt++) {
    await wait(10000);
    state = (await request(`${origin}/v2/${name}:fetchStatus`)).lastAsyncUploadState;
  }
  if (state !== 'SUCCEEDED') fail('Chrome upload failed or did not finish; this run did not submit it for review');
  const submitted = await request(`${origin}/v2/${name}:publish`, 'POST', JSON.stringify({ publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true }), 'application/json');
  if (!acceptedStates.has(submitted.state)) fail('Chrome returned an unexpected submission state; inspect the Developer Dashboard before retrying');
  const confirmation = await request(`${origin}/v2/${name}:fetchStatus`);
  if (![confirmation.submittedItemRevisionStatus, confirmation.publishedItemRevisionStatus].some(revision => includesVersion(revision, version) && acceptedStates.has(revision.state))) {
    fail('Chrome accepted the submission but version confirmation is pending; check the dashboard before retrying');
  }
  return { store: 'chrome', itemId: storeIds.chrome, version, state: submitted.state, alreadySubmitted: false };
}

if (isMain(import.meta.url)) {
  try {
    const mode = cliMode();
    const { version } = await metadata();
    const archiveDir = process.env.RELEASE_DIR ? resolve(process.env.RELEASE_DIR) : resolve(root, 'URLAlchemist_chrome_artifacts');
    const checksumName = process.env.RELEASE_DIR ? 'SHA256SUMS.txt' : 'SHA256SUMS';
    let archive;
    if (mode !== '--status') archive = await verifiedArchive(resolve(archiveDir, `URLAlchemist_Chrome_${version}.zip`), version, 'chrome', resolve(archiveDir, checksumName));
    if (mode === '--dry-run') report({ store: 'chrome', version, itemId: storeIds.chrome, archiveVerified: true, action: 'dry-run; no requests made' });
    else {
      const config = configuration();
      if (mode === '--preflight') report({ store: 'chrome', version, itemId: storeIds.chrome, archiveVerified: true, credentialsConfigured: true, action: 'preflight; no requests made' });
      else report(await chromeRelease({ config, version, archive, statusOnly: mode === '--status' }));
    }
  } catch (error) { reportFailure(error); }
}

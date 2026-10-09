// Submit a listed AMO update with reviewer source in the same version-create request.
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cliMode, digest, fail, isMain, metadata, pause, report, reportFailure, requestJson, root, storeIds, verifiedArchive, verifiedSource } from './release-utils.mjs';

const origin = 'https://addons.mozilla.org/api/v5';
export function configuration(env = process.env) {
  if (!env.AMO_JWT_ISSUER || !env.AMO_JWT_SECRET) fail('Set Actions secrets AMO_JWT_ISSUER and AMO_JWT_SECRET for the URL Alchemist AMO owner');
  return { issuer: env.AMO_JWT_ISSUER, secret: env.AMO_JWT_SECRET };
}

export function authorization(config, now = Math.floor(Date.now() / 1000)) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const message = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: config.issuer, jti: randomUUID(), iat: now, exp: now + 60 })}`;
  return `JWT ${message}.${createHmac('sha256', config.secret).update(message).digest('base64url')}`;
}

// AMO signs the XPI after upload, changing file.hash. Keep the original release
// and reviewer-source digests in private reviewer notes to identify safe retries.
export function releaseProof(archive, source) {
  return `URL Alchemist release archive SHA-256: ${digest(archive)}; URL Alchemist reviewer source SHA-256: ${digest(source)}`;
}

export function reviewerNotes(notes, proof) {
  // AMO limits approval_notes to 3000 characters. Full build/review notes stay
  // in the attached source ZIP; retain the entire retry proof in the API field.
  const reference = 'Complete instructions: URLAlchemist_Firefox/REVIEWER_NOTES.md in the attached source archive.';
  // FormData encodes text line endings as CRLF. Count that wire representation
  // before slicing so AMO sees the same length that we validate here.
  const normalized = notes.trim().replace(/\r\n|\r|\n/g, '\r\n');
  const budget = 3000 - reference.length - proof.length - 8;
  return `${reference}\r\n\r\n${normalized.slice(0, budget).trimEnd()}\r\n\r\n${proof}`;
}

export async function firefoxRelease({ config, version, archive, source, notes = '', approvalNotes = '', statusOnly = false, fetcher = fetch, wait = pause }) {
  if (!config.issuer || !config.secret || !/^\d+\.\d+\.\d+$/.test(version || '')) fail('Invalid Firefox release configuration');
  const addon = `${origin}/addons/addon/${encodeURIComponent(storeIds.firefox)}`;
  const request = (url, method = 'GET', body, type, options) => requestJson(fetcher, url,
    { method, body, headers: { Authorization: authorization(config), ...(type ? { 'Content-Type': type } : {}) } }, 'Firefox AMO', options);
  const identity = await request(`${addon}/`);
  if (identity.guid !== storeIds.firefox) fail('AMO returned a different add-on identity');
  let current = await request(`${addon}/versions/v${version}/`, 'GET', undefined, undefined, { allow404: true });
  if (statusOnly) return { store: 'firefox', guid: storeIds.firefox, version, versionId: current?.id || null, state: current?.file?.status || 'not-submitted', channel: current?.channel || null, reviewerSourceAttached: Boolean(current?.source) };
  if (!archive?.length || !source?.length) fail('Firefox release and reviewer source archives must not be empty');
  const proof = releaseProof(archive, source);
  const approvalSummary = reviewerNotes(approvalNotes, proof);
  if (notes.length > 3000) fail('Firefox release notes exceed the AMO 3000-character limit');
  const alreadySubmitted = Boolean(current);
  if (current) {
    if (!Number.isSafeInteger(current.id) || current.version !== version || current.channel !== 'listed' || !current.approval_notes?.includes(proof)) fail('Existing AMO version does not have matching release/source digests in reviewer notes; inspect AMO before retrying');
    if (!['unreviewed', 'public'].includes(current.file.status) || current.is_disabled) fail('Existing AMO version is disabled or rejected; inspect AMO before retrying');
    if (!current.source) {
      const form = new FormData(); form.set('source', new Blob([source], { type: 'application/zip' }), `URLAlchemist_Firefox_${version}_source.zip`);
      current = await request(`${addon}/versions/${current.id}/`, 'PATCH', form);
    }
  } else {
    const form = new FormData();
    form.set('upload', new Blob([archive], { type: 'application/x-xpinstall' }), `URLAlchemist_Firefox_${version}.xpi`);
    form.set('channel', 'listed');
    let upload = await request(`${origin}/addons/upload/`, 'POST', form);
    // AMO serializes UUIDField(format='hex') as 32 hexadecimal characters.
    // Accept canonical UUIDs too, while excluding arbitrary path characters.
    if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(upload.uuid || '')) fail('AMO returned an invalid upload identity');
    const uuid = upload.uuid;
    for (let attempt = 0; !upload.processed && attempt < 90; attempt++) {
      await wait(10000);
      upload = await request(`${origin}/addons/upload/${uuid}/`);
      if (upload.uuid !== uuid) fail('AMO returned a different upload identity');
    }
    if (!upload.processed || !upload.valid || upload.channel !== 'listed' || upload.version !== version || upload.submitted) fail('AMO upload validation failed or is incomplete; this run did not submit a new version');
    const create = new FormData();
    create.set('upload', uuid);
    create.set('source', new Blob([source], { type: 'application/zip' }), `URLAlchemist_Firefox_${version}_source.zip`);
    create.set('license', 'GPL-3.0-only');
    create.set('approval_notes', approvalSummary);
    current = await request(`${addon}/versions/`, 'POST', create);
  }
  if (!Number.isSafeInteger(current.id) || current.version !== version || current.channel !== 'listed' || !current.approval_notes?.includes(proof) || !current.source) {
    fail('AMO version or reviewer source confirmation differs from the release; inspect AMO before retrying');
  }
  if (notes || approvalNotes) {
    const update = { ...(notes ? { release_notes: { 'en-US': notes } } : {}), approval_notes: approvalSummary };
    await request(`${addon}/versions/${current.id}/`, 'PATCH', JSON.stringify(update), 'application/json');
  }
  const confirmation = await request(`${addon}/versions/${current.id}/`);
  if (confirmation.version !== version || confirmation.channel !== 'listed' || !confirmation.approval_notes?.includes(proof) || !confirmation.source || !['unreviewed', 'public'].includes(confirmation.file?.status) || confirmation.is_disabled) {
    fail('AMO submission confirmation is incomplete; inspect AMO before retrying');
  }
  return { store: 'firefox', guid: storeIds.firefox, version, versionId: confirmation.id, state: confirmation.file.status, channel: confirmation.channel, reviewerSourceAttached: true, alreadySubmitted };
}

if (isMain(import.meta.url)) {
  try {
    const mode = cliMode();
    const { version } = await metadata();
    const archiveDir = process.env.RELEASE_DIR ? resolve(process.env.RELEASE_DIR) : resolve(root, 'URLAlchemist_Firefox_artifacts');
    const checksums = resolve(archiveDir, process.env.RELEASE_DIR ? 'SHA256SUMS.txt' : 'SHA256SUMS');
    let archive, source;
    if (mode !== '--status') {
      archive = await verifiedArchive(resolve(archiveDir, `URLAlchemist_Firefox_${version}.xpi`), version, 'firefox', checksums);
      source = await verifiedSource(resolve(archiveDir, process.env.RELEASE_DIR ? `URLAlchemist_Firefox_${version}_source.zip` : 'URLAlchemist_Firefox_source.zip'), checksums);
    }
    if (mode === '--dry-run') report({ store: 'firefox', version, guid: storeIds.firefox, archiveVerified: true, reviewerSourceVerified: true, action: 'dry-run; no requests made' });
    else {
      const config = configuration();
      if (mode === '--preflight') report({ store: 'firefox', version, guid: storeIds.firefox, archiveVerified: true, reviewerSourceVerified: true, credentialsConfigured: true, action: 'preflight; no requests made' });
      else {
        const notes = mode === '--submit' ? await readFile(resolve(root, 'RELEASE_NOTES.md'), 'utf8') : '';
        const approvalNotes = mode === '--submit' ? await readFile(resolve(root, 'URLAlchemist_Firefox/REVIEWER_NOTES.md'), 'utf8') : '';
        report(await firefoxRelease({ config, version, archive, source, notes, approvalNotes, statusOnly: mode === '--status' }));
      }
    }
  } catch (error) { reportFailure(error); }
}

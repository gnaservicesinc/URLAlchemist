// Collect only verified build outputs; never include the checkout or credentials.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { digest, fail, isMain, metadata, report, reportFailure, root, verifiedArchive, verifiedSource } from './release-utils.mjs';

export async function packageRelease(output = resolve(root, '.release-local/release')) {
  const { version, tag } = await metadata();
  const destination = resolve(output);
  if (relative(root, destination).startsWith('..') || destination === root) fail('Release output must be in a subdirectory of the repository');
  const files = [];
  for (const browser of ['Chrome', 'Firefox']) {
    const directory = resolve(root, `URLAlchemist_${browser === 'Chrome' ? 'chrome' : 'Firefox'}_artifacts`);
    const checksums = resolve(directory, 'SHA256SUMS');
    const filename = `URLAlchemist_${browser}_${version}.${browser === 'Chrome' ? 'zip' : 'xpi'}`;
    await verifiedArchive(resolve(directory, filename), version, browser.toLowerCase(), checksums);
    if (browser === 'Firefox') await verifiedSource(resolve(directory, 'URLAlchemist_Firefox_source.zip'), checksums);
    const manifest = (await readFile(checksums, 'utf8')).trim().split('\n');
    for (const [source, target] of [
      [filename, filename],
      [`URLAlchemist_${browser}_source.zip`, `URLAlchemist_${browser}_${version}_source.zip`],
      [`URLAlchemist_${browser}_${version}_source.tar.gz`, `URLAlchemist_${browser}_${version}_source.tar.gz`],
    ]) {
      const path = resolve(directory, source);
      const data = await readFile(path);
      if (!manifest.includes(`${digest(data)}  ${source}`)) fail('Release source archive differs from its checksum manifest');
      files.push({ path, target, digest: digest(data) });
    }
  }
  await mkdir(destination, { recursive: true });
  for (const file of files) await copyFile(file.path, resolve(destination, file.target));
  await writeFile(resolve(destination, 'SHA256SUMS.txt'), `${files.map(file => `${file.digest}  ${file.target}`).join('\n')}\n`);
  return { version, tag, directory: destination, assets: files.map(file => file.target).concat('SHA256SUMS.txt') };
}

if (isMain(import.meta.url)) {
  try { report(await packageRelease()); }
  catch (error) { reportFailure(error); }
}

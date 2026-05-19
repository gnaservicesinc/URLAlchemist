import type { CompiledActionPackV2 } from './types';

function line(key: string, value: string | number | undefined): string | null {
  if (value === undefined || value === '') {
    return null;
  }

  return `${key}=${String(value).replace(/[\r\n]/g, ' ')}`;
}

export function createStarterVersionFile(pack: CompiledActionPackV2): string {
  return [
    line('URL_ALCHEMIST_ACTIONPACK_VERSION_FILE', 1),
    line('NAME', pack.manifest.name),
    line('VERSION', pack.manifest.version),
    line('AUTHOR', pack.manifest.metadata.author),
    line('URL_ALCHEMIST_VERSION', pack.builder.urlAlchemistVersion),
    line('BUILD_TIME_UTC', pack.builder.buildTimeUtc),
    line('BUILDER_URL_ALCHEMIST_UUID', pack.builder.builderUuid),
    line('DOWNLOAD', pack.manifest.metadata.downloadUrl),
    line('VERSION_FILE_SIGNATURE_URL', pack.manifest.metadata.versionFileSignatureUrl),
    line('PUBLIC_KEY_LOCATE_VALUE', pack.manifest.metadata.publicKeyLocateValue),
  ]
    .filter((entry): entry is string => entry !== null)
    .join('\n')
    .concat('\n');
}

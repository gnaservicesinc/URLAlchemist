import type { GlobalSettings } from '../types';
import type { ActionPackInstallMetadata, ActionPackSource, CompiledActionPackV2, TrustStatus } from './types';

export interface InstallMetadataDefaults {
  source: ActionPackSource;
  trustStatus?: TrustStatus;
  artifactChecksumHex?: string;
  bundledHashVerified?: boolean;
  loggingEnabled?: boolean;
  focusGuard?: ActionPackInstallMetadata['focusGuard'];
  contentBlocker?: ActionPackInstallMetadata['contentBlocker'];
  lockState?: ActionPackInstallMetadata['lockState'];
}

export function isActionPackLocked(pack: CompiledActionPackV2): boolean {
  return Boolean(pack.install?.lockState?.locked && pack.install.lockState.level > 0);
}

export function isContentBlockerActionPack(pack: CompiledActionPackV2): boolean {
  return Boolean(
    pack.manifest.metadata.workspaceType === 'content-blocker' ||
    pack.install?.contentBlocker ||
    pack.install?.source === 'content-blocker' ||
    pack.install?.source === 'focus-guard' ||
    pack.install?.focusGuard,
  );
}

export function defaultTrustForSource(source: ActionPackSource): TrustStatus {
  if (source === 'user-created' || source === 'bundled' || source === 'content-blocker' || source === 'focus-guard') {
    return 'trusted';
  }

  return 'review';
}

export function withInstallMetadata(
  pack: CompiledActionPackV2,
  settings: Pick<GlobalSettings, 'defaultActionPackLoggingEnabled'>,
  defaults: InstallMetadataDefaults,
): CompiledActionPackV2 {
  const now = Date.now();
  const existing = pack.install;
  const source = defaults.source ?? existing?.source ?? 'imported';
  const loggingEnabled = defaults.loggingEnabled ?? existing?.loggingEnabled ?? settings.defaultActionPackLoggingEnabled;

  return {
    ...pack,
    install: {
      source,
      trustStatus: defaults.trustStatus ?? existing?.trustStatus ?? defaultTrustForSource(source),
      loggingEnabled,
      installedAt: existing?.installedAt ?? now,
      artifactChecksumHex: defaults.artifactChecksumHex ?? existing?.artifactChecksumHex ?? pack.checksumHex,
      bundledHashVerified: defaults.bundledHashVerified ?? existing?.bundledHashVerified,
      userReview: existing?.userReview,
      lockState: defaults.lockState ?? existing?.lockState,
      focusGuard: defaults.focusGuard ?? existing?.focusGuard,
      contentBlocker: defaults.contentBlocker ?? existing?.contentBlocker,
    },
  };
}

export function migratedStoredInstallMetadata(pack: CompiledActionPackV2): CompiledActionPackV2 {
  if (pack.install) {
    return pack;
  }

  return {
    ...pack,
    install: {
      source: 'imported',
      trustStatus: pack.risk.highest === 'high' ? 'review' : 'trusted',
      loggingEnabled: true,
      installedAt: pack.builder.buildTimeUtc ? pack.builder.buildTimeUtc * 1000 : Date.now(),
      artifactChecksumHex: pack.checksumHex,
    },
  };
}

export function stripLocalInstallMetadata(pack: CompiledActionPackV2): CompiledActionPackV2 {
  const {
    checksumHex: _checksumHex,
    traceEnabledUntil: _traceEnabledUntil,
    install: _install,
    ...portable
  } = pack;

  return portable;
}

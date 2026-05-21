import type { CompiledActionPackV2 } from './types';

export interface BrowserCompatibilityReport {
  blockers: string[];
  warnings: string[];
}

function hasInstruction(pack: CompiledActionPackV2, ops: readonly string[]): boolean {
  return pack.vm.instructions.some((instruction) => ops.includes(instruction.op));
}

function writesDestination(pack: CompiledActionPackV2, destination: string): boolean {
  return pack.vm.instructions.some((instruction) => instruction.op === 'OUTPUT' && instruction.destination === destination);
}

export function getFirefoxActionPackCompatibility(pack: CompiledActionPackV2): BrowserCompatibilityReport {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (writesDestination(pack, 'clipboardBinary')) {
    warnings.push('Firefox desktop can attempt binary clipboard writes only when navigator.clipboard.write and ClipboardItem are available in the current context. Firefox for Android binary clipboard behavior is source-only/unverified.');
  }

  if (hasInstruction(pack, ['DISPLAY', 'OVERLAY_CONTROL', 'OVERLAY_DRAW'])) {
    warnings.push('Page overlays are supported by the Firefox desktop runtime. Firefox for Android behavior still needs device smoke testing before this pack should be labeled Android-ready.');
  }

  if (hasInstruction(pack, ['USER_INTERACTION'])) {
    warnings.push('Prompt and picker interactions depend on the active page content script; test this pack on Firefox desktop and Android before publishing it as cross-device supported.');
  }

  if (pack.triggerPlan.type === 'HOTKEY') {
    warnings.push('Hotkeys run through the content-script listener on normal pages. Browser-owned pages and Firefox for Android keyboard behavior may differ.');
  }

  if (pack.triggerPlan.type === 'INTERVAL') {
    warnings.push('Interval runs use Firefox alarms. Mobile background throttling may delay runs on Firefox for Android.');
  }

  if (pack.triggerPlan.type === 'CONDITIONAL') {
    warnings.push('Conditional runs use Firefox alarms and an embedded background-safe condition VM. Firefox for Android scheduling remains source-only/unverified.');
  }

  return {
    blockers,
    warnings: Array.from(new Set(warnings)),
  };
}

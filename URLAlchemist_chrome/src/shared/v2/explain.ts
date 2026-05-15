import type { CompiledActionPackV2, GraphVmInstruction } from './types';

function hostFromUrl(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return 'a remote site';
  }
}

export function explainRiskReason(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes('clipboard')) {
    return 'Can read from or write to your clipboard.';
  }
  if (lower.includes('remote host') || lower.includes('remote data') || lower.includes('remote request')) {
    return 'Can contact a website or receive data from the internet.';
  }
  if (lower.includes('page text') || lower.includes('raw page') || lower.includes('raw html')) {
    return 'Can read or change text from the page you are viewing.';
  }
  if (lower.includes('mutation')) {
    return 'Can change what is shown on the current page.';
  }
  if (lower.includes('file selection')) {
    return 'Can ask you to choose a file or enter a web address.';
  }
  if (lower.includes('game overlay') || lower.includes('keyboard') || lower.includes('mouse')) {
    return 'Can open a page overlay and capture keyboard or mouse input while that overlay is open.';
  }
  if (lower.includes('session storage')) {
    return 'Can save temporary values for later runs.';
  }
  if (lower.includes('overlay') || lower.includes('display')) {
    return 'Can show an overlay on top of the current page.';
  }
  return reason.replace(/\.$/, '.');
}

export function explainInstruction(instruction: GraphVmInstruction): string {
  switch (instruction.op) {
    case 'SOURCE':
      if (instruction.source === 'url') {
        return 'Reads the current page URL.';
      }
      if (instruction.source === 'clipboard') {
        return 'Reads text from your clipboard.';
      }
      if (instruction.source === 'pageText') {
        return 'Reads visible text from the current page.';
      }
      if (instruction.source === 'rawHtml') {
        return 'Reads the page HTML.';
      }
      if (instruction.source === 'selectedText') {
        return 'Reads the text you selected on the page.';
      }
      if (instruction.source === 'linkUrl') {
        return 'Reads the link you right-clicked.';
      }
      return `Reads ${instruction.source}.`;
    case 'OUTPUT':
      if (instruction.destination === 'url') {
        return 'Can navigate the tab to the final URL.';
      }
      if (instruction.destination === 'clipboard') {
        return 'Can write text to your clipboard.';
      }
      if (instruction.destination === 'pageText') {
        return 'Can replace visible page text.';
      }
      if (instruction.destination === 'domMutation') {
        return 'Can change what is shown on the page.';
      }
      return `Writes to ${instruction.destination}.`;
    case 'REGEX_TRANSFORM':
      return `Changes text using the pattern "${instruction.pattern}" and the ${instruction.action.toLowerCase()} action.`;
    case 'FETCH_GET':
      return instruction.fallbackUrl
        ? `Gets data from ${hostFromUrl(instruction.fallbackUrl)}.`
        : 'Gets data from a web address chosen while the pack runs.';
    case 'HTTP_REQUEST':
      return instruction.fallbackUrl
        ? `Sends a ${instruction.method} request to ${hostFromUrl(instruction.fallbackUrl)}.`
        : `Sends a ${instruction.method} request to a web address chosen while the pack runs.`;
    case 'SYSTEM_DATA':
      return 'Reads the current time or date from your browser.';
    case 'USER_INTERACTION':
      if (instruction.interaction === 'PICK_FILE_OR_URL') {
        return 'Asks you to choose a file or enter a web address.';
      }
      if (instruction.interaction === 'CONFIRM') {
        return 'Asks you to confirm before continuing.';
      }
      return 'Asks you for typed input.';
    case 'GET_ASSET':
      return instruction.fallbackUrl
        ? `Loads ${instruction.kind} media from ${hostFromUrl(instruction.fallbackUrl)}.`
        : `Loads ${instruction.kind} media from a web address chosen while the pack runs.`;
    case 'DISPLAY':
      if (instruction.displayType === 'arcade-game') {
        return `Opens the built-in Space Defender game overlay${instruction.captureKeyboard || instruction.captureMouse ? ' and captures controls while it is open' : ''}.`;
      }
      return `Shows a ${instruction.displayType} ${instruction.mode === 'OVERLAY' ? 'overlay on the page' : 'view'}.`;
    case 'COMPARE':
      return 'Checks whether a value matches a rule.';
    case 'MATH':
      return 'Performs a numeric calculation.';
    case 'CONVERT':
      return 'Converts data from one format to another.';
    case 'DECLARE':
      return `Creates a temporary value named ${instruction.name}.`;
    case 'SAVELOAD':
      if (instruction.mode === 'SAVE') {
        return 'Saves a temporary value for later runs.';
      }
      return 'Reads a previously saved temporary value.';
    case 'DICT_SET':
      return 'Adds a field to a small data record.';
    case 'LOOP':
      return `Repeats a step, capped at ${instruction.loopLimit} times.`;
    default:
      return 'Runs a compiled step.';
  }
}

export function summarizePackBehavior(pack: CompiledActionPackV2): string {
  const hasRemote = pack.vm.instructions.some((instruction) => instruction.op === 'FETCH_GET' || instruction.op === 'HTTP_REQUEST' || instruction.op === 'GET_ASSET');
  const hasClipboard = pack.requiredPermissions.some((permission) => permission.toLowerCase().includes('clipboard'));
  const hasGame = pack.vm.instructions.some((instruction) => instruction.op === 'DISPLAY' && instruction.displayType === 'arcade-game');
  const outputs = pack.vm.instructions.filter((instruction): instruction is Extract<GraphVmInstruction, { op: 'OUTPUT' }> => instruction.op === 'OUTPUT');

  if (hasGame) {
    return 'This pack opens a built-in game overlay. It can capture game controls only while the overlay is open.';
  }
  if (hasRemote && hasClipboard) {
    return 'This pack can use clipboard data and contact the internet. Review the steps before enabling it.';
  }
  if (hasRemote) {
    return 'This pack can contact the internet. Check the listed sites and what data is sent or received.';
  }
  if (hasClipboard) {
    return 'This pack can use your clipboard. Enable it only if that matches what you expect.';
  }
  if (outputs.some((output) => output.destination !== 'url')) {
    return 'This pack can change browser data outside the URL, such as page text or temporary storage.';
  }
  return 'This pack only uses standard URL workflow steps.';
}

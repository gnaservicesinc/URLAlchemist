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
  if (lower.includes('embedded media')) {
    return 'Can load bundled media included inside the Action Pack.';
  }
  if (lower.includes('remote media')) {
    return 'Can load displayable media from the internet.';
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
  if (lower.includes('overlay input') || lower.includes('keyboard') || lower.includes('mouse')) {
    return 'Can open a visible URL Alchemist overlay and process keyboard or mouse input while that overlay is open.';
  }
  if (lower.includes('interactive overlay')) {
    return 'Can start, stop, check, or draw into a visible URL Alchemist overlay.';
  }
  if (lower.includes('session storage') || lower.includes('shared state')) {
    return 'Can save temporary values for other handlers in the same session.';
  }
  if (lower.includes('logging')) {
    return 'Can write entries to this Action Pack\'s local log.';
  }
  if (lower.includes('overlay') || lower.includes('display')) {
    return 'Can show an overlay on top of the current page.';
  }
  return reason;
}

export function explainInstruction(instruction: GraphVmInstruction): string {
  switch (instruction.op) {
    case 'SOURCE':
      if (instruction.source === 'url') {
        return 'Reads the current page URL.';
      }
      if (instruction.source === 'triggered' || instruction.source === 'event') {
        return 'Reads details from the normal workspace Run event.';
      }
      if (instruction.source.startsWith('keyboard')) {
        return 'Reads a keyboard event from the active URL Alchemist overlay.';
      }
      if (instruction.source.startsWith('mouse')) {
        return 'Reads a mouse event from the active URL Alchemist overlay.';
      }
      if (instruction.source === 'tick' || instruction.source === 'deltaMs' || instruction.source === 'tickEvent') {
        return 'Reads a timing event from the active URL Alchemist overlay.';
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
      if (instruction.destination === 'clipboardBinary') {
        return 'Can write binary data (images, files) to your clipboard.';
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
      if (instruction.embedded) {
        return `Loads bundled ${instruction.kind} media from inside the Action Pack.`;
      }
      return instruction.fallbackUrl
        ? `Loads ${instruction.kind} media from ${hostFromUrl(instruction.fallbackUrl)}.`
        : `Loads ${instruction.kind} media from a web address chosen while the pack runs.`;
    case 'DISPLAY':
      if (instruction.displayType === 'input-capture') {
        return `Opens an overlay and records keyboard or mouse input${instruction.captureKeyboard || instruction.captureMouse ? ' while that overlay is open' : ''}.`;
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
    case 'CONSTANT':
      return 'Provides a configured literal value to the graph.';
    case 'SLEEP':
      return `Waits up to ${instruction.fallbackMs}ms before continuing.`;
    case 'SHARED_STATE':
      return `${instruction.mode === 'SET' ? 'Writes' : instruction.mode === 'DELETE' ? 'Clears' : 'Reads'} session-scoped shared state.`;
    case 'DICT_GET':
      return 'Reads one field from a dictionary value.';
    case 'LIST_OP':
      return `Runs the ${instruction.operation.toLowerCase().replaceAll('_', ' ')} list operation.`;
    case 'SELECT':
      return 'Chooses between two values from a boolean condition.';
    case 'RANDOM_INT':
      return `Generates a random integer from ${instruction.fallbackMin} to ${instruction.fallbackMax}.`;
    case 'SUBSTITUTE':
      return 'Builds text from a template using connected inputs and declared variables.';
    case 'LOG':
      return `Writes a ${instruction.severity} entry to this Action Pack's local log.`;
    case 'ABORT':
      return 'Can stop this Action Pack run when its condition is true.';
    case 'OVERLAY_CONTROL':
      return `${instruction.action === 'STATUS' ? 'Checks' : instruction.action.toLowerCase()} the visible URL Alchemist overlay session.`;
    case 'OVERLAY_DRAW':
      return 'Draws cells and text into the active URL Alchemist overlay.';
    default:
      return 'Runs a compiled step.';
  }
}

export function summarizePackBehavior(pack: CompiledActionPackV2): string {
  const hasRemote = pack.vm.instructions.some((instruction) => instruction.op === 'FETCH_GET' || instruction.op === 'HTTP_REQUEST' || (instruction.op === 'GET_ASSET' && !instruction.embedded));
  const hasEmbeddedMedia = pack.vm.instructions.some((instruction) => instruction.op === 'GET_ASSET' && instruction.embedded);
  const hasClipboard = pack.requiredPermissions.some((permission) => permission.toLowerCase().includes('clipboard'));
  const hasOverlayInput = pack.vm.instructions.some((instruction) => instruction.op === 'DISPLAY' && instruction.displayType === 'input-capture');
  const hasInteractiveOverlay = pack.vm.instructions.some((instruction) => instruction.op === 'OVERLAY_CONTROL' || instruction.op === 'OVERLAY_DRAW');
  const outputs = pack.vm.instructions.filter((instruction): instruction is Extract<GraphVmInstruction, { op: 'OUTPUT' }> => instruction.op === 'OUTPUT');
  const activeHandlers = Object.entries(pack.vm.eventHandlers ?? {})
    .filter(([, instructions]) => (instructions?.length ?? 0) > 0)
    .map(([handler]) => handler)
    .filter((handler) => handler !== 'trigger');

  if (hasInteractiveOverlay) {
    return activeHandlers.length > 0
      ? `This pack can use a visible URL Alchemist overlay and respond to ${activeHandlers.join(', ')} events only while that overlay is active.`
      : 'This pack can start, stop, check, or draw into a visible URL Alchemist overlay.';
  }
  if (hasOverlayInput) {
    const captures = pack.vm.instructions
      .filter((instruction): instruction is Extract<GraphVmInstruction, { op: 'DISPLAY' }> => instruction.op === 'DISPLAY' && instruction.displayType === 'input-capture')
      .flatMap((instruction) => [
        instruction.captureKeyboard ? 'keyboard' : '',
        instruction.captureMouse ? 'mouse' : '',
      ])
      .filter(Boolean);
    return captures.length > 0
      ? `This pack opens an overlay that can capture ${Array.from(new Set(captures)).join(' and ')} input only while the overlay is open.`
      : 'This pack opens a visible input overlay without keyboard or mouse capture enabled.';
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
  if (hasEmbeddedMedia) {
    return 'This pack can load bundled media included inside the Action Pack.';
  }
  if (outputs.some((output) => output.destination !== 'url')) {
    return 'This pack can change browser data outside the URL, such as page text or temporary storage.';
  }
  return 'This pack only uses standard URL workflow steps.';
}

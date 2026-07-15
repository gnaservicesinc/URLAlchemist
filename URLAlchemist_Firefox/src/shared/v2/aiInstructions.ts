export const AI_WORKSPACE_INSTRUCTIONS_MAX_CHARS = 16_384;

export const DEFAULT_AI_WORKSPACE_INSTRUCTIONS = [
  'URL Alchemist workspaces are editable source documents for browser workflows. Action Packs are compiled, distributable artifacts rather than editable source.',
  'A workspace is a typed directed graph: blocks are nodes, and edges connect named output ports to compatible named input ports. Use only the workspace types, triggers, block kinds, ports, and settings supplied in the machine-readable schema and block catalog.',
  'Preserve the existing workspace intent unless the request asks to replace it. Prefer the smallest clear graph, connect required inputs, and avoid disconnected or redundant blocks.',
  'Treat clipboard access, page or source reads, network access, page mutation, local-file navigation, and high-risk outputs as opt-in behavior. Include them only when the user explicitly requests them, and keep their risk visible in the draft.',
].join('\n\n');

export function normalizeAiWorkspaceInstructions(value: string): string {
  return value.slice(0, AI_WORKSPACE_INSTRUCTIONS_MAX_CHARS);
}

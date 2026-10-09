import { getBlockDefinition } from '../shared/v2/blockRegistry';
import type { ContentBlockerSurfaceId, WorkspaceFileV2, WorkspaceNodeV2 } from '../shared/v2/types';

export interface ValidationNodeTarget {
  nodeId: string;
  surfaceId?: ContentBlockerSurfaceId;
}

/** Keep validation navigation within the graph surface that contains the block. */
export function findValidationNodeTargets(workspace: WorkspaceFileV2, message: string): ValidationNodeTarget[] {
  const normalized = message.toLowerCase();
  const namedSurface = workspace.surfaces?.find((surface) => normalized.startsWith(`${surface.label.toLowerCase()}:`) || normalized.startsWith(`${surface.label.toLowerCase()} requires `));
  const candidates: Array<ValidationNodeTarget & { node: WorkspaceNodeV2 }> = namedSurface
    ? []
    : workspace.nodes.map((node) => ({ nodeId: node.id, node }));
  for (const surface of workspace.surfaces ?? []) {
    if (!namedSurface || namedSurface.id === surface.id) {
      candidates.push(...surface.nodes.map((node) => ({ nodeId: node.id, surfaceId: surface.id, node })));
    }
  }
  const nodeMessage = namedSurface && normalized.startsWith(`${namedSurface.label.toLowerCase()}:`)
    ? normalized.slice(namedSurface.label.length + 1).trimStart()
    : normalized;
  const title = (node: WorkspaceNodeV2): string => (node.settings.label?.trim() || getBlockDefinition(node.type).label).toLowerCase();
  // Compiler messages normally begin with the authored block title. Prefer that
  // exact prefix so a renamed block does not focus unrelated blocks of its type.
  const namedTargets = candidates.filter(({ node }) => nodeMessage.startsWith(`${title(node)}:`) || nodeMessage.startsWith(`${title(node)} requires `));
  const matchesName = (name: string): boolean => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(nodeMessage);
  };
  const targets = namedTargets.length > 0 ? namedTargets : candidates.filter(({ node }) => matchesName(title(node)) || matchesName(getBlockDefinition(node.type).label.toLowerCase()) || matchesName(node.type.toLowerCase()));
  return targets.map(({ nodeId, surfaceId }) => surfaceId ? { nodeId, surfaceId } : { nodeId });
}

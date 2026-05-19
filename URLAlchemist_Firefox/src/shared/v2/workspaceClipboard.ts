import { createEdge, createWorkspaceNode } from './workspace';
import type { WorkspaceEdgeV2, WorkspaceFileV2, WorkspaceNodeV2 } from './types';

export interface WorkspaceBlockClipboard {
  nodes: WorkspaceNodeV2[];
  edges: WorkspaceEdgeV2[];
}

export interface PasteWorkspaceBlocksResult {
  workspace: WorkspaceFileV2;
  pastedNodeIds: string[];
}

export function createWorkspaceBlockClipboard(
  workspace: WorkspaceFileV2,
  selectedNodeIds: Set<string>,
): WorkspaceBlockClipboard {
  const nodes = workspace.nodes.filter((node) => selectedNodeIds.has(node.id));
  const copiedIds = new Set(nodes.map((node) => node.id));
  const edges = workspace.edges.filter((edge) => copiedIds.has(edge.source) && copiedIds.has(edge.target));

  return {
    nodes: structuredClone(nodes),
    edges: structuredClone(edges),
  };
}

export function pasteWorkspaceBlockClipboard(
  workspace: WorkspaceFileV2,
  clipboard: WorkspaceBlockClipboard,
  offset: WorkspaceNodeV2['position'] = { x: 48, y: 48 },
): PasteWorkspaceBlocksResult {
  if (clipboard.nodes.length === 0) {
    return { workspace, pastedNodeIds: [] };
  }

  const idMap = new Map<string, string>();
  const pastedNodes = clipboard.nodes.map((node) => {
    const pasted = createWorkspaceNode(
      node.type,
      {
        x: node.position.x + offset.x,
        y: node.position.y + offset.y,
      },
      structuredClone(node.settings),
    );
    idMap.set(node.id, pasted.id);
    return pasted;
  });
  const pastedEdges = clipboard.edges.flatMap((edge) => {
    const source = idMap.get(edge.source);
    const target = idMap.get(edge.target);
    if (!source || !target) {
      return [];
    }

    return [createEdge(source, edge.sourceHandle, target, edge.targetHandle)];
  });

  return {
    workspace: {
      ...workspace,
      metadata: { ...workspace.metadata, updated_at: Date.now() },
      nodes: [...workspace.nodes, ...pastedNodes],
      edges: [...workspace.edges, ...pastedEdges],
    },
    pastedNodeIds: pastedNodes.map((node) => node.id),
  };
}

import { createEdge, createWorkspaceNode } from './workspace';
import type { WorkspaceEdgeV2, WorkspaceFileV2, WorkspaceLogicalFlowGroup, WorkspaceNodeV2 } from './types';

export interface WorkspaceBlockClipboard {
  nodes: WorkspaceNodeV2[];
  edges: WorkspaceEdgeV2[];
  logicalFlows?: WorkspaceLogicalFlowGroup[];
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
  const edges = workspace.edges.filter((edge) => {
    const targetNode = nodes.find((node) => node.id === edge.target);
    return copiedIds.has(edge.source) && copiedIds.has(edge.target) && !(targetNode?.type === 'LogicalFlow' && edge.targetHandle === 'condition');
  });
  const logicalFlows = (workspace.logicalFlows ?? []).filter((group) => copiedIds.has(group.conditionNodeId) && copiedIds.has(group.controlNodeId));

  return {
    nodes: structuredClone(nodes),
    edges: structuredClone(edges),
    logicalFlows: logicalFlows.length > 0 ? structuredClone(logicalFlows) : undefined,
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
  const flowIdMap = new Map((clipboard.logicalFlows ?? []).map((group) => [group.id, crypto.randomUUID()]));
  const pastedNodes = clipboard.nodes.map((node) => {
    const nextSettings = structuredClone(node.settings);
    if (nextSettings.logicalFlowGroupId && flowIdMap.has(nextSettings.logicalFlowGroupId)) {
      nextSettings.logicalFlowGroupId = flowIdMap.get(nextSettings.logicalFlowGroupId);
    }
    const pasted = createWorkspaceNode(
      node.type,
      {
        x: node.position.x + offset.x,
        y: node.position.y + offset.y,
      },
      nextSettings,
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

  const pastedLogicalFlows = (clipboard.logicalFlows ?? []).flatMap((group) => {
    const conditionNodeId = idMap.get(group.conditionNodeId);
    const controlNodeId = idMap.get(group.controlNodeId);
    const id = flowIdMap.get(group.id);
    if (!id || !conditionNodeId || !controlNodeId) {
      return [];
    }
    return [{
      ...group,
      id,
      conditionNodeId,
      controlNodeId,
    }];
  });

  return {
    workspace: {
      ...workspace,
      metadata: { ...workspace.metadata, updated_at: Date.now() },
      nodes: [...workspace.nodes, ...pastedNodes],
      edges: [...workspace.edges, ...pastedEdges],
      logicalFlows: pastedLogicalFlows.length > 0 ? [...(workspace.logicalFlows ?? []), ...pastedLogicalFlows] : workspace.logicalFlows,
    },
    pastedNodeIds: pastedNodes.map((node) => node.id),
  };
}

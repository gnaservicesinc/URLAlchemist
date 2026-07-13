import { createWorkspaceNode } from '../shared/v2/workspace';
import type {
  WorkspaceEdgeV2,
  WorkspaceFileV2,
  WorkspaceLogicalFlowGroup,
  WorkspaceNodeV2,
} from '../shared/v2/types';

export const LOGICAL_FLOW_LAYOUT = {
  expandedNodeWidth: 272,
  collapsedNodeWidth: 216,
  expandedNodeHeight: 184,
  collapsedNodeHeight: 76,
  coreGap: 32,
  coreToBranchGap: 56,
  branchStepGap: 56,
  laneGap: 24,
  horizontalPadding: 24,
  trailingPadding: 32,
  headerHeight: 38,
  contentTopPadding: 12,
  bottomPadding: 24,
  emptyRegionWidth: 336,
  emptyRegionHeight: 112,
} as const;

export interface NodeMeasurement {
  readonly width?: number;
  readonly height?: number;
}

export type NodeMeasurements = ReadonlyMap<string, NodeMeasurement>;

export interface LogicalFlowBranchMembership {
  readonly trueExclusiveNodeIds: ReadonlySet<string>;
  readonly falseExclusiveNodeIds: ReadonlySet<string>;
  readonly sharedNodeIds: ReadonlySet<string>;
}

export interface LogicalFlowBranchRegion {
  readonly id: string;
  readonly groupId: string;
  readonly branch: 'true' | 'false';
  readonly depth: number;
  readonly nodeIds: ReadonlySet<string>;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
}

interface ConnectionOwner {
  readonly branch: 'true' | 'false';
  readonly group: WorkspaceLogicalFlowGroup;
}

const EMPTY_MEASUREMENTS: NodeMeasurements = new Map<string, NodeMeasurement>();

function isLogicalFlowGroup(value: unknown): value is WorkspaceLogicalFlowGroup {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<WorkspaceLogicalFlowGroup>;
  return typeof candidate.id === 'string'
    && typeof candidate.conditionNodeId === 'string'
    && typeof candidate.controlNodeId === 'string';
}

function logicalFlowGroups(workspace: WorkspaceFileV2): WorkspaceLogicalFlowGroup[] {
  return Array.isArray(workspace.logicalFlows)
    ? workspace.logicalFlows.filter(isLogicalFlowGroup)
    : [];
}

function safeDepth(group: WorkspaceLogicalFlowGroup): number {
  return Number.isFinite(group.depth) ? Math.max(0, Math.trunc(group.depth)) : 0;
}

function positiveMeasurement(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nodeDimensions(node: WorkspaceNodeV2, measurements: NodeMeasurements): { width: number; height: number } {
  const measurement = measurements.get(node.id);
  const collapsed = Boolean(node.settings.collapsed);
  return {
    width: positiveMeasurement(
      measurement?.width,
      collapsed ? LOGICAL_FLOW_LAYOUT.collapsedNodeWidth : LOGICAL_FLOW_LAYOUT.expandedNodeWidth,
    ),
    height: positiveMeasurement(
      measurement?.height,
      collapsed ? LOGICAL_FLOW_LAYOUT.collapsedNodeHeight : LOGICAL_FLOW_LAYOUT.expandedNodeHeight,
    ),
  };
}

function safeCoordinate(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function nodeBounds(node: WorkspaceNodeV2, measurements: NodeMeasurements): Bounds {
  const { width, height } = nodeDimensions(node, measurements);
  const minX = safeCoordinate(node.position.x);
  const minY = safeCoordinate(node.position.y);
  return {
    minX,
    minY,
    maxX: minX + width,
    maxY: minY + height,
    width,
    height,
  };
}

function combineBounds(bounds: readonly Bounds[]): Bounds | null {
  if (bounds.length === 0) {
    return null;
  }

  const minX = Math.min(...bounds.map((entry) => entry.minX));
  const minY = Math.min(...bounds.map((entry) => entry.minY));
  const maxX = Math.max(...bounds.map((entry) => entry.maxX));
  const maxY = Math.max(...bounds.map((entry) => entry.maxY));
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function boundsForNodeIds(
  workspace: WorkspaceFileV2,
  nodeIds: ReadonlySet<string>,
  measurements: NodeMeasurements,
): Bounds | null {
  return combineBounds(
    workspace.nodes
      .filter((node) => nodeIds.has(node.id))
      .map((node) => nodeBounds(node, measurements)),
  );
}

function coreBounds(
  workspace: WorkspaceFileV2,
  group: WorkspaceLogicalFlowGroup,
  measurements: NodeMeasurements,
): Bounds | null {
  const condition = workspace.nodes.find((node) => node.id === group.conditionNodeId);
  const control = workspace.nodes.find((node) => node.id === group.controlNodeId);
  if (!condition || !control || condition.id === control.id) {
    return null;
  }
  return combineBounds([nodeBounds(condition, measurements), nodeBounds(control, measurements)]);
}

function outgoingEdgesBySource(workspace: WorkspaceFileV2): ReadonlyMap<string, readonly WorkspaceEdgeV2[]> {
  const outgoing = new Map<string, WorkspaceEdgeV2[]>();
  workspace.edges.forEach((edge) => {
    const edges = outgoing.get(edge.source);
    if (edges) {
      edges.push(edge);
    } else {
      outgoing.set(edge.source, [edge]);
    }
  });
  return outgoing;
}

function reachableNodeIds(
  workspace: WorkspaceFileV2,
  startingNodeIds: readonly string[],
  stopNodeIds: ReadonlySet<string>,
): Set<string> {
  const knownNodeIds = new Set(workspace.nodes.map((node) => node.id));
  const outgoing = outgoingEdgesBySource(workspace);
  const visited = new Set<string>();
  const reachable = new Set<string>();
  const queue = [...startingNodeIds];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (!knownNodeIds.has(current) || stopNodeIds.has(current)) {
      continue;
    }

    reachable.add(current);
    (outgoing.get(current) ?? []).forEach((edge) => {
      if (!visited.has(edge.target)) {
        queue.push(edge.target);
      }
    });
  }

  return reachable;
}

function branchReachableNodeIds(
  workspace: WorkspaceFileV2,
  group: WorkspaceLogicalFlowGroup,
  sourceHandle: 'trueValue' | 'falseValue',
): Set<string> {
  const knownNodeIds = new Set(workspace.nodes.map((node) => node.id));
  if (
    group.conditionNodeId === group.controlNodeId
    || !knownNodeIds.has(group.conditionNodeId)
    || !knownNodeIds.has(group.controlNodeId)
  ) {
    return new Set<string>();
  }

  const startingNodeIds = workspace.edges
    .filter((edge) => edge.source === group.controlNodeId && edge.sourceHandle === sourceHandle)
    .map((edge) => edge.target);
  return reachableNodeIds(
    workspace,
    startingNodeIds,
    new Set([group.conditionNodeId, group.controlNodeId]),
  );
}

function downstreamSubtreeNodeIds(
  workspace: WorkspaceFileV2,
  targetNodeId: string,
  stopNodeIds: ReadonlySet<string>,
): Set<string> {
  return reachableNodeIds(workspace, [targetNodeId], stopNodeIds);
}

export function directLogicalFlowGroupForNode(
  workspace: WorkspaceFileV2,
  nodeId: string,
): WorkspaceLogicalFlowGroup | null {
  if (!workspace.nodes.some((node) => node.id === nodeId)) {
    return null;
  }
  return logicalFlowGroups(workspace).find(
    (group) => group.conditionNodeId === nodeId || group.controlNodeId === nodeId,
  ) ?? null;
}

export function logicalFlowBranchMembership(
  workspace: WorkspaceFileV2,
  group: WorkspaceLogicalFlowGroup,
): LogicalFlowBranchMembership {
  const trueReachable = branchReachableNodeIds(workspace, group, 'trueValue');
  const falseReachable = branchReachableNodeIds(workspace, group, 'falseValue');
  const sharedNodeIds = new Set(
    [...trueReachable].filter((nodeId) => falseReachable.has(nodeId)),
  );
  const trueExclusiveNodeIds = new Set(
    [...trueReachable].filter((nodeId) => !sharedNodeIds.has(nodeId)),
  );
  const falseExclusiveNodeIds = new Set(
    [...falseReachable].filter((nodeId) => !sharedNodeIds.has(nodeId)),
  );

  return {
    trueExclusiveNodeIds,
    falseExclusiveNodeIds,
    sharedNodeIds,
  };
}

export function logicalFlowUnitNodeIds(
  workspace: WorkspaceFileV2,
  group: WorkspaceLogicalFlowGroup,
): Set<string> {
  const knownNodeIds = new Set(workspace.nodes.map((node) => node.id));
  const membership = logicalFlowBranchMembership(workspace, group);
  const nodeIds = new Set<string>();
  if (knownNodeIds.has(group.conditionNodeId)) {
    nodeIds.add(group.conditionNodeId);
  }
  if (knownNodeIds.has(group.controlNodeId)) {
    nodeIds.add(group.controlNodeId);
  }
  membership.trueExclusiveNodeIds.forEach((nodeId) => nodeIds.add(nodeId));
  membership.falseExclusiveNodeIds.forEach((nodeId) => nodeIds.add(nodeId));
  membership.sharedNodeIds.forEach((nodeId) => nodeIds.add(nodeId));
  return nodeIds;
}

export function logicalFlowGroupForMember(
  workspace: WorkspaceFileV2,
  nodeId: string,
): WorkspaceLogicalFlowGroup | null {
  const direct = directLogicalFlowGroupForNode(workspace, nodeId);
  if (direct) {
    return direct;
  }

  return logicalFlowGroups(workspace)
    .map((group, index) => ({ group, index }))
    .filter(({ group }) => logicalFlowUnitNodeIds(workspace, group).has(nodeId))
    .sort((left, right) => safeDepth(right.group) - safeDepth(left.group) || left.index - right.index)[0]?.group ?? null;
}

export function buildLogicalFlowUnit(workspace: WorkspaceFileV2, x: number, y: number): WorkspaceFileV2 {
  const groupId = crypto.randomUUID();
  const maxDepth = logicalFlowGroups(workspace).reduce(
    (max, group) => Math.max(max, safeDepth(group)),
    -1,
  );
  const condition = createWorkspaceNode('Logical', { x, y }, {
    label: 'Logic',
    locked: false,
    logicalFlowGroupId: groupId,
    logicalFlowRole: 'condition',
  });
  const control = createWorkspaceNode('LogicalFlow', {
    x: x + LOGICAL_FLOW_LAYOUT.expandedNodeWidth + LOGICAL_FLOW_LAYOUT.coreGap,
    y,
  }, {
    label: 'Logical Flow',
    locked: false,
    logicalFlowGroupId: groupId,
    logicalFlowRole: 'control',
  });
  const group: WorkspaceLogicalFlowGroup = {
    id: groupId,
    conditionNodeId: condition.id,
    controlNodeId: control.id,
    depth: maxDepth + 1,
    locked: false,
  };

  return {
    ...workspace,
    metadata: { ...workspace.metadata, updated_at: Date.now() },
    nodes: [...workspace.nodes, condition, control],
    logicalFlows: [...logicalFlowGroups(workspace), group],
  };
}

function translateNodeIds(
  workspace: WorkspaceFileV2,
  nodeIds: ReadonlySet<string>,
  deltaX: number,
  deltaY: number,
): WorkspaceFileV2 {
  if (nodeIds.size === 0 || (deltaX === 0 && deltaY === 0)) {
    return workspace;
  }

  let changed = false;
  const nodes = workspace.nodes.map((node) => {
    if (!nodeIds.has(node.id)) {
      return node;
    }
    const position = {
      x: safeCoordinate(node.position.x) + deltaX,
      y: safeCoordinate(node.position.y) + deltaY,
    };
    if (position.x === node.position.x && position.y === node.position.y) {
      return node;
    }
    changed = true;
    return { ...node, position };
  });

  return changed ? { ...workspace, nodes } : workspace;
}

function placeNode(
  workspace: WorkspaceFileV2,
  nodeId: string,
  x: number,
  y: number,
): WorkspaceFileV2 {
  const node = workspace.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    return workspace;
  }
  return translateNodeIds(
    workspace,
    new Set([nodeId]),
    x - safeCoordinate(node.position.x),
    y - safeCoordinate(node.position.y),
  );
}

function regionWidth(bounds: Bounds | null, regionX: number): number {
  if (!bounds) {
    return LOGICAL_FLOW_LAYOUT.emptyRegionWidth;
  }
  return Math.max(
    LOGICAL_FLOW_LAYOUT.emptyRegionWidth,
    bounds.maxX - regionX + LOGICAL_FLOW_LAYOUT.trailingPadding,
  );
}

function regionHeight(bounds: Bounds | null, regionY: number): number {
  if (!bounds) {
    return LOGICAL_FLOW_LAYOUT.emptyRegionHeight;
  }
  return Math.max(
    LOGICAL_FLOW_LAYOUT.emptyRegionHeight,
    bounds.maxY - regionY + LOGICAL_FLOW_LAYOUT.bottomPadding,
  );
}

function normalizeLogicalFlowGroup(
  workspace: WorkspaceFileV2,
  group: WorkspaceLogicalFlowGroup,
  measurements: NodeMeasurements,
): WorkspaceFileV2 {
  const condition = workspace.nodes.find((node) => node.id === group.conditionNodeId);
  const control = workspace.nodes.find((node) => node.id === group.controlNodeId);
  if (!condition || !control || condition.id === control.id) {
    return workspace;
  }

  const conditionBounds = nodeBounds(condition, measurements);
  let normalized = placeNode(
    workspace,
    control.id,
    conditionBounds.maxX + LOGICAL_FLOW_LAYOUT.coreGap,
    conditionBounds.minY,
  );
  const normalizedCoreBounds = coreBounds(normalized, group, measurements);
  if (!normalizedCoreBounds) {
    return normalized;
  }

  const membership = logicalFlowBranchMembership(normalized, group);
  const regionX = normalizedCoreBounds.maxX + LOGICAL_FLOW_LAYOUT.coreToBranchGap;
  const trueRegionY = normalizedCoreBounds.minY;
  const branchNodeX = regionX + LOGICAL_FLOW_LAYOUT.horizontalPadding;
  const branchNodeTopOffset = LOGICAL_FLOW_LAYOUT.headerHeight + LOGICAL_FLOW_LAYOUT.contentTopPadding;

  const trueBounds = boundsForNodeIds(normalized, membership.trueExclusiveNodeIds, measurements);
  if (trueBounds) {
    normalized = translateNodeIds(
      normalized,
      membership.trueExclusiveNodeIds,
      branchNodeX - trueBounds.minX,
      trueRegionY + branchNodeTopOffset - trueBounds.minY,
    );
  }
  const positionedTrueBounds = boundsForNodeIds(normalized, membership.trueExclusiveNodeIds, measurements);
  const trueRegionWidth = regionWidth(positionedTrueBounds, regionX);
  const trueRegionHeight = regionHeight(positionedTrueBounds, trueRegionY);

  const falseRegionY = trueRegionY + trueRegionHeight + LOGICAL_FLOW_LAYOUT.laneGap;
  const falseBounds = boundsForNodeIds(normalized, membership.falseExclusiveNodeIds, measurements);
  if (falseBounds) {
    normalized = translateNodeIds(
      normalized,
      membership.falseExclusiveNodeIds,
      branchNodeX - falseBounds.minX,
      falseRegionY + branchNodeTopOffset - falseBounds.minY,
    );
  }
  const positionedFalseBounds = boundsForNodeIds(normalized, membership.falseExclusiveNodeIds, measurements);
  const falseRegionWidth = regionWidth(positionedFalseBounds, regionX);
  const falseRegionHeight = regionHeight(positionedFalseBounds, falseRegionY);

  const sharedBounds = boundsForNodeIds(normalized, membership.sharedNodeIds, measurements);
  if (sharedBounds) {
    const totalLaneHeight = trueRegionHeight + LOGICAL_FLOW_LAYOUT.laneGap + falseRegionHeight;
    const sharedX = regionX
      + Math.max(trueRegionWidth, falseRegionWidth)
      + LOGICAL_FLOW_LAYOUT.coreToBranchGap;
    const sharedY = trueRegionY + Math.max(0, (totalLaneHeight - sharedBounds.height) / 2);
    normalized = translateNodeIds(
      normalized,
      membership.sharedNodeIds,
      sharedX - sharedBounds.minX,
      sharedY - sharedBounds.minY,
    );
  }

  return normalized;
}

function positionsChanged(before: readonly WorkspaceNodeV2[], after: readonly WorkspaceNodeV2[]): boolean {
  if (before.length !== after.length) {
    return true;
  }
  const beforePositions = new Map(before.map((node) => [node.id, node.position]));
  return after.some((node) => {
    const position = beforePositions.get(node.id);
    return !position || position.x !== node.position.x || position.y !== node.position.y;
  });
}

function normalizeSelectedLogicalFlowGroups(
  workspace: WorkspaceFileV2,
  measurements: NodeMeasurements,
  selectedGroupIds?: ReadonlySet<string>,
  includeLocked = false,
): WorkspaceFileV2 {
  const groups = logicalFlowGroups(workspace)
    .map((group, index) => ({ group, index }))
    .filter(({ group }) => (!selectedGroupIds || selectedGroupIds.has(group.id)) && (includeLocked || !group.locked))
    .sort((left, right) => safeDepth(right.group) - safeDepth(left.group) || left.index - right.index);

  let normalized = workspace;
  const seenGroupIds = new Set<string>();
  groups.forEach(({ group }) => {
    if (seenGroupIds.has(group.id)) {
      return;
    }
    seenGroupIds.add(group.id);
    normalized = normalizeLogicalFlowGroup(normalized, group, measurements);
  });

  if (!positionsChanged(workspace.nodes, normalized.nodes)) {
    return workspace;
  }
  return {
    ...normalized,
    metadata: { ...normalized.metadata, updated_at: Date.now() },
  };
}

export function normalizeLogicalFlowGroups(
  workspace: WorkspaceFileV2,
  measurements: NodeMeasurements = EMPTY_MEASUREMENTS,
): WorkspaceFileV2 {
  return normalizeSelectedLogicalFlowGroups(workspace, measurements);
}

function connectionOwner(
  workspace: WorkspaceFileV2,
  edge: WorkspaceEdgeV2,
): ConnectionOwner | null {
  const groups = logicalFlowGroups(workspace);
  const directControlGroup = groups.find((group) => group.controlNodeId === edge.source);
  if (directControlGroup && (edge.sourceHandle === 'trueValue' || edge.sourceHandle === 'falseValue')) {
    return {
      branch: edge.sourceHandle === 'trueValue' ? 'true' : 'false',
      group: directControlGroup,
    };
  }

  const candidates: Array<ConnectionOwner & { index: number }> = [];
  groups.forEach((group, index) => {
    const membership = logicalFlowBranchMembership(workspace, group);
    if (membership.trueExclusiveNodeIds.has(edge.source)) {
      candidates.push({ branch: 'true', group, index });
    } else if (membership.falseExclusiveNodeIds.has(edge.source)) {
      candidates.push({ branch: 'false', group, index });
    }
  });
  candidates.sort(
    (left, right) => safeDepth(right.group) - safeDepth(left.group) || left.index - right.index,
  );
  const owner = candidates[0];
  return owner ? { branch: owner.branch, group: owner.group } : null;
}

function directBranchAnchor(
  workspace: WorkspaceFileV2,
  group: WorkspaceLogicalFlowGroup,
  branch: 'true' | 'false',
  target: WorkspaceNodeV2,
  measurements: NodeMeasurements,
): { x: number; y: number } | null {
  const condition = workspace.nodes.find((node) => node.id === group.conditionNodeId);
  const control = workspace.nodes.find((node) => node.id === group.controlNodeId);
  if (!condition || !control || condition.id === control.id) {
    return null;
  }

  const conditionRect = nodeBounds(condition, measurements);
  const controlDimensions = nodeDimensions(control, measurements);
  const coreRight = Math.max(
    conditionRect.maxX,
    conditionRect.maxX + LOGICAL_FLOW_LAYOUT.coreGap + controlDimensions.width,
  );
  const trueRegionY = conditionRect.minY;
  const falseRegionY = trueRegionY
    + LOGICAL_FLOW_LAYOUT.emptyRegionHeight
    + LOGICAL_FLOW_LAYOUT.laneGap;
  const targetDimensions = nodeDimensions(target, measurements);
  const branchY = (branch === 'true' ? trueRegionY : falseRegionY)
    + LOGICAL_FLOW_LAYOUT.headerHeight
    + LOGICAL_FLOW_LAYOUT.contentTopPadding;

  return {
    x: coreRight + LOGICAL_FLOW_LAYOUT.coreToBranchGap + LOGICAL_FLOW_LAYOUT.horizontalPadding,
    y: branchY + Math.max(0, (LOGICAL_FLOW_LAYOUT.emptyRegionHeight
      - LOGICAL_FLOW_LAYOUT.headerHeight
      - LOGICAL_FLOW_LAYOUT.contentTopPadding
      - LOGICAL_FLOW_LAYOUT.bottomPadding
      - targetDimensions.height) / 2),
  };
}

export function layoutLogicalFlowConnection(
  previousWorkspace: WorkspaceFileV2,
  nextWorkspace: WorkspaceFileV2,
  edge: WorkspaceEdgeV2,
  measurements: NodeMeasurements = EMPTY_MEASUREMENTS,
): WorkspaceFileV2 {
  const owner = connectionOwner(previousWorkspace, edge);
  const target = nextWorkspace.nodes.find((node) => node.id === edge.target);
  const source = nextWorkspace.nodes.find((node) => node.id === edge.source);
  if (!owner || !target || !source) {
    return nextWorkspace;
  }

  const previousUnitNodeIds = logicalFlowUnitNodeIds(previousWorkspace, owner.group);
  const previousMembership = logicalFlowBranchMembership(previousWorkspace, owner.group);
  const targetAlreadyInOwnerBranch = owner.branch === 'true'
    ? previousMembership.trueExclusiveNodeIds.has(target.id)
    : previousMembership.falseExclusiveNodeIds.has(target.id);
  if (targetAlreadyInOwnerBranch) {
    return nextWorkspace;
  }

  const subtreeWorkspace = previousWorkspace.nodes.some((node) => node.id === target.id)
    ? previousWorkspace
    : nextWorkspace;
  const movingNodeIds = downstreamSubtreeNodeIds(
    subtreeWorkspace,
    target.id,
    new Set([...previousUnitNodeIds, source.id]),
  );
  movingNodeIds.add(target.id);

  let anchor: { x: number; y: number } | null;
  if (source.id === owner.group.controlNodeId) {
    anchor = directBranchAnchor(nextWorkspace, owner.group, owner.branch, target, measurements);
  } else {
    const sourceRect = nodeBounds(source, measurements);
    const targetDimensions = nodeDimensions(target, measurements);
    anchor = {
      x: sourceRect.maxX + LOGICAL_FLOW_LAYOUT.branchStepGap,
      y: sourceRect.minY + (sourceRect.height - targetDimensions.height) / 2,
    };
  }
  if (!anchor) {
    return nextWorkspace;
  }

  const positioned = translateNodeIds(
    nextWorkspace,
    movingNodeIds,
    anchor.x - safeCoordinate(target.position.x),
    anchor.y - safeCoordinate(target.position.y),
  );
  return normalizeSelectedLogicalFlowGroups(
    positioned,
    measurements,
    new Set([owner.group.id]),
    true,
  );
}

export function logicalFlowBranchRegions(
  workspace: WorkspaceFileV2,
  measurements: NodeMeasurements = EMPTY_MEASUREMENTS,
): LogicalFlowBranchRegion[] {
  return logicalFlowGroups(workspace).flatMap((group) => {
    const groupCoreBounds = coreBounds(workspace, group, measurements);
    if (!groupCoreBounds) {
      return [];
    }

    const membership = logicalFlowBranchMembership(workspace, group);
    const regionX = groupCoreBounds.maxX + LOGICAL_FLOW_LAYOUT.coreToBranchGap;
    const trueRegionY = groupCoreBounds.minY;
    const trueBounds = boundsForNodeIds(workspace, membership.trueExclusiveNodeIds, measurements);
    const trueHeight = regionHeight(trueBounds, trueRegionY);
    const falseRegionY = trueRegionY + trueHeight + LOGICAL_FLOW_LAYOUT.laneGap;
    const falseBounds = boundsForNodeIds(workspace, membership.falseExclusiveNodeIds, measurements);

    return [
      {
        id: `logical-flow-${group.id}-true`,
        groupId: group.id,
        branch: 'true' as const,
        depth: safeDepth(group),
        nodeIds: new Set(membership.trueExclusiveNodeIds),
        x: regionX,
        y: trueRegionY,
        width: regionWidth(trueBounds, regionX),
        height: trueHeight,
      },
      {
        id: `logical-flow-${group.id}-false`,
        groupId: group.id,
        branch: 'false' as const,
        depth: safeDepth(group),
        nodeIds: new Set(membership.falseExclusiveNodeIds),
        x: regionX,
        y: falseRegionY,
        width: regionWidth(falseBounds, regionX),
        height: regionHeight(falseBounds, falseRegionY),
      },
    ];
  });
}

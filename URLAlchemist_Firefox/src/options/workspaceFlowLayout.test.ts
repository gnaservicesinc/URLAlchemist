import { describe, expect, it } from 'vitest';

import { createDefaultWorkspace, createWorkspaceNode } from '../shared/v2/workspace';
import type {
  BlockKind,
  WorkspaceBlockSettings,
  WorkspaceEdgeV2,
  WorkspaceFileV2,
  WorkspaceLogicalFlowGroup,
  WorkspaceNodeV2,
} from '../shared/v2/types';
import {
  LOGICAL_FLOW_LAYOUT,
  buildLogicalFlowUnit,
  directLogicalFlowGroupForNode,
  layoutLogicalFlowConnection,
  logicalFlowBranchMembership,
  logicalFlowBranchRegions,
  logicalFlowGroupForMember,
  logicalFlowUnitNodeIds,
  normalizeLogicalFlowGroups,
  type LogicalFlowBranchRegion,
  type NodeMeasurements,
} from './workspaceFlowLayout';

function node(
  kind: BlockKind,
  id: string,
  x: number,
  y: number,
  settings: WorkspaceBlockSettings = {},
): WorkspaceNodeV2 {
  return {
    ...createWorkspaceNode(kind, { x, y }, settings),
    id,
  };
}

function edge(
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle = 'input',
): WorkspaceEdgeV2 {
  return {
    id: `${source}:${sourceHandle}:${target}:${targetHandle}`,
    source,
    sourceHandle,
    target,
    targetHandle,
  };
}

function group(
  id: string,
  conditionNodeId: string,
  controlNodeId: string,
  depth = 0,
): WorkspaceLogicalFlowGroup {
  return { id, conditionNodeId, controlNodeId, depth, locked: false };
}

function workspace(
  nodes: WorkspaceNodeV2[],
  edges: WorkspaceEdgeV2[],
  logicalFlows: WorkspaceLogicalFlowGroup[],
): WorkspaceFileV2 {
  return {
    ...createDefaultWorkspace(),
    nodes,
    edges,
    logicalFlows,
  };
}

function measurements(entries: Array<[string, number, number]>): NodeMeasurements {
  return new Map(entries.map(([id, width, height]) => [id, { width, height }]));
}

function regionFor(
  regions: readonly LogicalFlowBranchRegion[],
  branch: 'true' | 'false',
): LogicalFlowBranchRegion {
  const region = regions.find((candidate) => candidate.branch === branch);
  expect(region).toBeDefined();
  return region!;
}

function expectNodeContained(
  workspaceValue: WorkspaceFileV2,
  nodeId: string,
  region: LogicalFlowBranchRegion,
  nodeMeasurements: NodeMeasurements,
): void {
  const current = workspaceValue.nodes.find((candidate) => candidate.id === nodeId);
  expect(current).toBeDefined();
  const size = nodeMeasurements.get(nodeId);
  expect(size?.width).toBeTypeOf('number');
  expect(size?.height).toBeTypeOf('number');
  expect(current!.position.x).toBeGreaterThanOrEqual(region.x);
  expect(current!.position.y).toBeGreaterThanOrEqual(region.y);
  expect(current!.position.x + size!.width!).toBeLessThanOrEqual(region.x + region.width);
  expect(current!.position.y + size!.height!).toBeLessThanOrEqual(region.y + region.height);
}

describe('workspaceFlowLayout', () => {
  it('creates compact, non-overlapping empty branch regions to the right of a side-by-side core', () => {
    const condition = node('Logical', 'condition', 80, 90);
    const control = node('LogicalFlow', 'control', 80, 420);
    const flow = group('flow', condition.id, control.id);
    const sizes = measurements([
      [condition.id, 232, 120],
      [control.id, 248, 104],
    ]);
    const normalized = normalizeLogicalFlowGroups(workspace([condition, control], [], [flow]), sizes);
    const normalizedCondition = normalized.nodes.find((candidate) => candidate.id === condition.id)!;
    const normalizedControl = normalized.nodes.find((candidate) => candidate.id === control.id)!;
    const regions = logicalFlowBranchRegions(normalized, sizes);
    const trueRegion = regionFor(regions, 'true');
    const falseRegion = regionFor(regions, 'false');

    expect(normalizedControl.position.x).toBe(
      normalizedCondition.position.x + 232 + LOGICAL_FLOW_LAYOUT.coreGap,
    );
    expect(normalizedControl.position.y).toBe(normalizedCondition.position.y);
    expect(trueRegion.x).toBeGreaterThan(normalizedControl.position.x + 248);
    expect(trueRegion.width).toBe(LOGICAL_FLOW_LAYOUT.emptyRegionWidth);
    expect(trueRegion.height).toBe(LOGICAL_FLOW_LAYOUT.emptyRegionHeight);
    expect(falseRegion.y).toBeGreaterThanOrEqual(trueRegion.y + trueRegion.height + LOGICAL_FLOW_LAYOUT.laneGap);
  });

  it('uses actual measurements to contain branch subtrees without changing their internal offsets', () => {
    const condition = node('Logical', 'condition', 20, 40);
    const control = node('LogicalFlow', 'control', 20, 350);
    const trueStart = node('TextTransform', 'true-start', -900, -300);
    const trueChild = node('Convert', 'true-child', -440, -205);
    const falseStart = node('Constant', 'false-start', 15, 5);
    const flow = group('flow', condition.id, control.id);
    const graph = workspace(
      [condition, control, trueStart, trueChild, falseStart],
      [
        edge(control.id, 'trueValue', trueStart.id),
        edge(trueStart.id, 'result', trueChild.id),
        edge(control.id, 'falseValue', falseStart.id),
      ],
      [flow],
    );
    const sizes = measurements([
      [condition.id, 241, 108],
      [control.id, 219, 132],
      [trueStart.id, 301, 175],
      [trueChild.id, 190, 90],
      [falseStart.id, 257, 260],
    ]);
    const originalOffset = {
      x: trueChild.position.x - trueStart.position.x,
      y: trueChild.position.y - trueStart.position.y,
    };
    const normalized = normalizeLogicalFlowGroups(graph, sizes);
    const normalizedTrueStart = normalized.nodes.find((candidate) => candidate.id === trueStart.id)!;
    const normalizedTrueChild = normalized.nodes.find((candidate) => candidate.id === trueChild.id)!;
    const regions = logicalFlowBranchRegions(normalized, sizes);
    const trueRegion = regionFor(regions, 'true');
    const falseRegion = regionFor(regions, 'false');

    expectNodeContained(normalized, trueStart.id, trueRegion, sizes);
    expectNodeContained(normalized, trueChild.id, trueRegion, sizes);
    expectNodeContained(normalized, falseStart.id, falseRegion, sizes);
    expect(normalizedTrueChild.position.x - normalizedTrueStart.position.x).toBe(originalOffset.x);
    expect(normalizedTrueChild.position.y - normalizedTrueStart.position.y).toBe(originalOffset.y);
    expect(falseRegion.y).toBeGreaterThanOrEqual(trueRegion.y + trueRegion.height + LOGICAL_FLOW_LAYOUT.laneGap);
  });

  it('auto-positions an arbitrarily placed adopted target with its existing downstream subtree', () => {
    const condition = node('Logical', 'condition', 100, 100);
    const control = node('LogicalFlow', 'control', 410, 100);
    const target = node('TextTransform', 'target', -1200, 900);
    const child = node('Convert', 'child', -820, 1030);
    const flow = group('flow', condition.id, control.id);
    const subtreeEdge = edge(target.id, 'result', child.id);
    const previous = normalizeLogicalFlowGroups(
      workspace([condition, control, target, child], [subtreeEdge], [flow]),
    );
    const adoptedEdge = edge(control.id, 'trueValue', target.id);
    const next = { ...previous, edges: [...previous.edges, adoptedEdge] };
    const originalOffset = {
      x: child.position.x - target.position.x,
      y: child.position.y - target.position.y,
    };
    const laidOut = layoutLogicalFlowConnection(previous, next, adoptedEdge);
    const laidOutTarget = laidOut.nodes.find((candidate) => candidate.id === target.id)!;
    const laidOutChild = laidOut.nodes.find((candidate) => candidate.id === child.id)!;
    const trueRegion = regionFor(logicalFlowBranchRegions(laidOut), 'true');

    expect(laidOutTarget.position.x).toBeGreaterThan(laidOut.nodes.find((candidate) => candidate.id === control.id)!.position.x);
    expect(trueRegion.nodeIds.has(target.id)).toBe(true);
    expect(trueRegion.nodeIds.has(child.id)).toBe(true);
    expect(laidOutChild.position.x - laidOutTarget.position.x).toBe(originalOffset.x);
    expect(laidOutChild.position.y - laidOutTarget.position.y).toBe(originalOffset.y);
  });

  it('expands a normalized branch when a subsequent connection extends its source tree', () => {
    const condition = node('Logical', 'condition', 0, 0);
    const control = node('LogicalFlow', 'control', 304, 0);
    const first = node('TextTransform', 'first', 700, 50);
    const nextTarget = node('Convert', 'next-target', -700, -700);
    const falseStart = node('Constant', 'false-start', 700, 240);
    const flow = group('flow', condition.id, control.id);
    const previous = normalizeLogicalFlowGroups(workspace(
      [condition, control, first, nextTarget, falseStart],
      [
        edge(control.id, 'trueValue', first.id),
        edge(control.id, 'falseValue', falseStart.id),
      ],
      [flow],
    ));
    const beforeTrueRegion = regionFor(logicalFlowBranchRegions(previous), 'true');
    const extensionEdge = edge(first.id, 'result', nextTarget.id);
    const next = { ...previous, edges: [...previous.edges, extensionEdge] };
    const laidOut = layoutLogicalFlowConnection(previous, next, extensionEdge);
    const afterRegions = logicalFlowBranchRegions(laidOut);
    const afterTrueRegion = regionFor(afterRegions, 'true');
    const afterFalseRegion = regionFor(afterRegions, 'false');
    const laidOutFirst = laidOut.nodes.find((candidate) => candidate.id === first.id)!;
    const laidOutTarget = laidOut.nodes.find((candidate) => candidate.id === nextTarget.id)!;

    expect(afterTrueRegion.width).toBeGreaterThan(beforeTrueRegion.width);
    expect(laidOutTarget.position.x).toBeGreaterThan(
      laidOutFirst.position.x + LOGICAL_FLOW_LAYOUT.expandedNodeWidth,
    );
    expect(afterFalseRegion.y).toBeGreaterThanOrEqual(
      afterTrueRegion.y + afterTrueRegion.height + LOGICAL_FLOW_LAYOUT.laneGap,
    );
  });

  it('repositions an existing member when its input is rewired to the opposite branch', () => {
    const condition = node('Logical', 'condition', 40, 40);
    const control = node('LogicalFlow', 'control', 344, 40);
    const target = node('TextTransform', 'target', 760, 260);
    const flow = group('flow', condition.id, control.id);
    const falseEdge = edge(control.id, 'falseValue', target.id);
    const previous = normalizeLogicalFlowGroups(workspace(
      [condition, control, target],
      [falseEdge],
      [flow],
    ));
    const previousFalseRegion = regionFor(logicalFlowBranchRegions(previous), 'false');
    const trueEdge = edge(control.id, 'trueValue', target.id);
    const next = { ...previous, edges: [trueEdge] };
    const laidOut = layoutLogicalFlowConnection(previous, next, trueEdge);
    const membership = logicalFlowBranchMembership(laidOut, flow);
    const laidOutTarget = laidOut.nodes.find((candidate) => candidate.id === target.id)!;
    const trueRegion = regionFor(logicalFlowBranchRegions(laidOut), 'true');

    expect(membership.trueExclusiveNodeIds.has(target.id)).toBe(true);
    expect(membership.falseExclusiveNodeIds.has(target.id)).toBe(false);
    expect(laidOutTarget.position.y).toBeLessThan(previousFalseRegion.y);
    expect(laidOutTarget.position.y).toBeGreaterThanOrEqual(trueRegion.y);
    expect(laidOutTarget.position.y).toBeLessThan(trueRegion.y + trueRegion.height);
  });

  it('does not automatically normalize a locked composite outside an explicit connection', () => {
    const condition = node('Logical', 'condition', 20, 40, { locked: true });
    const control = node('LogicalFlow', 'control', 20, 420, { locked: true });
    const lockedFlow = { ...group('locked-flow', condition.id, control.id), locked: true };
    const graph = workspace([condition, control], [], [lockedFlow]);

    expect(normalizeLogicalFlowGroups(graph)).toBe(graph);
  });

  it('classifies shared merges separately and keeps them outside both branch regions', () => {
    const condition = node('Logical', 'condition', 0, 0);
    const control = node('LogicalFlow', 'control', 304, 0);
    const trueStart = node('TextTransform', 'true-start', 700, 0);
    const falseStart = node('TextTransform', 'false-start', 700, 300);
    const merge = node('Convert', 'merge', 980, 150);
    const afterMerge = node('DataFlowOut', 'after-merge', 1260, 150);
    const flow = group('flow', condition.id, control.id);
    const graph = workspace(
      [condition, control, trueStart, falseStart, merge, afterMerge],
      [
        edge(control.id, 'trueValue', trueStart.id),
        edge(control.id, 'falseValue', falseStart.id),
        edge(trueStart.id, 'result', merge.id),
        edge(falseStart.id, 'result', merge.id),
        edge(merge.id, 'result', afterMerge.id),
      ],
      [flow],
    );
    const membership = logicalFlowBranchMembership(graph, flow);

    expect([...membership.trueExclusiveNodeIds]).toEqual([trueStart.id]);
    expect([...membership.falseExclusiveNodeIds]).toEqual([falseStart.id]);
    expect(membership.sharedNodeIds).toEqual(new Set([merge.id, afterMerge.id]));

    const normalized = normalizeLogicalFlowGroups(graph);
    const regions = logicalFlowBranchRegions(normalized);
    const branchRight = Math.max(...regions.map((region) => region.x + region.width));
    const normalizedMerge = normalized.nodes.find((candidate) => candidate.id === merge.id)!;

    expect(regions.every((region) => !region.nodeIds.has(merge.id) && !region.nodeIds.has(afterMerge.id))).toBe(true);
    expect(normalizedMerge.position.x).toBeGreaterThanOrEqual(
      branchRight + LOGICAL_FLOW_LAYOUT.coreToBranchGap,
    );
    expect(logicalFlowUnitNodeIds(normalized, flow)).toEqual(
      new Set([condition.id, control.id, trueStart.id, falseStart.id, merge.id, afterMerge.id]),
    );
  });

  it('is cycle-safe and ignores malformed logical-flow metadata during normalization', () => {
    const condition = node('Logical', 'condition', 0, 0);
    const control = node('LogicalFlow', 'control', 0, 250);
    const trueStart = node('TextTransform', 'true-start', 500, 0);
    const falseStart = node('Convert', 'false-start', 500, 250);
    const valid = group('valid', condition.id, control.id);
    const malformed = {
      id: 'malformed',
      conditionNodeId: 'missing-condition',
      controlNodeId: 'missing-control',
      depth: Number.NaN,
    } as WorkspaceLogicalFlowGroup;
    const graph = {
      ...workspace(
        [condition, control, trueStart, falseStart],
        [
          edge(control.id, 'trueValue', trueStart.id),
          edge(control.id, 'falseValue', falseStart.id),
          edge(trueStart.id, 'result', falseStart.id),
          edge(falseStart.id, 'result', trueStart.id),
          edge(falseStart.id, 'result', 'missing-node', 'missing-input'),
        ],
        [valid, malformed],
      ),
      logicalFlows: [valid, malformed, null] as unknown as WorkspaceLogicalFlowGroup[],
    };

    const membership = logicalFlowBranchMembership(graph, valid);
    expect(membership.sharedNodeIds).toEqual(new Set([trueStart.id, falseStart.id]));
    const normalized = normalizeLogicalFlowGroups(graph);
    expect(logicalFlowBranchRegions(normalized)).toHaveLength(2);
    normalized.nodes.forEach((candidate) => {
      expect(Number.isFinite(candidate.position.x)).toBe(true);
      expect(Number.isFinite(candidate.position.y)).toBe(true);
    });
  });

  it('prefers direct core ownership, then the deepest downstream logical-flow membership', () => {
    const outerCondition = node('Logical', 'outer-condition', 0, 0);
    const outerControl = node('LogicalFlow', 'outer-control', 300, 0);
    const outerMember = node('TextTransform', 'outer-member', 650, 0);
    const innerCondition = node('Logical', 'inner-condition', 930, 0);
    const innerControl = node('LogicalFlow', 'inner-control', 1230, 0);
    const innerMember = node('Convert', 'inner-member', 1550, 0);
    const outer = group('outer', outerCondition.id, outerControl.id, 0);
    const inner = group('inner', innerCondition.id, innerControl.id, 2);
    const graph = workspace(
      [outerCondition, outerControl, outerMember, innerCondition, innerControl, innerMember],
      [
        edge(outerControl.id, 'trueValue', outerMember.id),
        edge(outerMember.id, 'result', innerCondition.id),
        edge(innerCondition.id, 'result', innerControl.id, 'condition'),
        edge(innerControl.id, 'trueValue', innerMember.id),
      ],
      [outer, inner],
    );

    expect(directLogicalFlowGroupForNode(graph, innerCondition.id)?.id).toBe(inner.id);
    expect(directLogicalFlowGroupForNode(graph, innerMember.id)).toBeNull();
    expect(logicalFlowGroupForMember(graph, outerMember.id)?.id).toBe(outer.id);
    expect(logicalFlowGroupForMember(graph, innerCondition.id)?.id).toBe(inner.id);
    expect(logicalFlowGroupForMember(graph, innerMember.id)?.id).toBe(inner.id);
  });

  it('builds the Logic and Logical Flow core side-by-side without adding layout-only schema fields', () => {
    const base = { ...createDefaultWorkspace(), nodes: [], edges: [], logicalFlows: undefined };
    const built = buildLogicalFlowUnit(base, 140, 220);
    const builtGroup = built.logicalFlows?.[0];
    expect(builtGroup).toBeDefined();
    const condition = built.nodes.find((candidate) => candidate.id === builtGroup!.conditionNodeId)!;
    const control = built.nodes.find((candidate) => candidate.id === builtGroup!.controlNodeId)!;

    expect(condition.position).toEqual({ x: 140, y: 220 });
    expect(control.position).toEqual({
      x: 140 + LOGICAL_FLOW_LAYOUT.expandedNodeWidth + LOGICAL_FLOW_LAYOUT.coreGap,
      y: 220,
    });
    expect(condition.position.x + LOGICAL_FLOW_LAYOUT.expandedNodeWidth).toBeLessThan(control.position.x);
    expect(Object.keys(condition).sort()).toEqual(['id', 'position', 'settings', 'type', 'typeId']);
    expect(built.kind).toBe(base.kind);
    expect(built.schemaVersion).toBe(base.schemaVersion);
  });
});

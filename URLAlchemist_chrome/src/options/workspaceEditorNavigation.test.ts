import { describe, expect, it } from 'vitest';
import { createDefaultContentBlockerWorkspace, createDefaultWorkspace, createWorkspaceNode } from '../shared/v2/workspace';
import { compileWorkspace } from '../shared/v2/compiler';
import { findValidationNodeTargets } from './workspaceEditorNavigation';

describe('workspace validation navigation', () => {
  it('finds a renamed block without matching every empty label', () => {
    const workspace = createDefaultWorkspace();
    const node = createWorkspaceNode('RegExpression', { x: 0, y: 0 }, { label: 'Clean campaign tags' });
    workspace.nodes.push(node);
    expect(findValidationNodeTargets(workspace, 'Clean campaign tags needs an input.')).toEqual([{ nodeId: node.id }]);
    expect(findValidationNodeTargets(workspace, 'Workspace name is required.')).toEqual([]);
  });

  it('locates errors on a content blocker surface so focus can reveal the correct canvas', () => {
    const workspace = createDefaultContentBlockerWorkspace();
    const surface = workspace.surfaces!.find((candidate) => candidate.id === 'challenge')!;
    const node = createWorkspaceNode('ChallengeTyper', { x: 0, y: 0 }, { label: 'Type confirmation' });
    surface.nodes.push(node);
    expect(findValidationNodeTargets(workspace, 'Type confirmation needs a phrase.')).toEqual([{ nodeId: node.id, surfaceId: 'challenge' }]);
  });

  it('prefers the named block over other blocks whose type appears in its error', () => {
    const workspace = createDefaultWorkspace();
    const first = createWorkspaceNode('RegExpression', { x: 0, y: 0 }, { label: 'Clean campaign tags' });
    const second = createWorkspaceNode('RegExpression', { x: 0, y: 0 }, { label: 'Fix host' });
    workspace.nodes.push(first, second);
    expect(findValidationNodeTargets(workspace, 'Clean campaign tags: Reg Expression cannot run in a conditional Run check.')).toEqual([{ nodeId: first.id }]);
  });

  it('keeps compiler errors on their named surface when blocks have the same title', () => {
    const workspace = createDefaultContentBlockerWorkspace();
    const pageLoad = workspace.surfaces!.find((surface) => surface.id === 'page-load')!;
    const recurring = workspace.surfaces!.find((surface) => surface.id === 'recurring')!;
    pageLoad.nodes.push(createWorkspaceNode('RegExpression', { x: 0, y: 0 }, { label: 'Clean URL', pattern: '[' }));
    const node = createWorkspaceNode('RegExpression', { x: 0, y: 0 }, { label: 'Clean URL', pattern: '[' });
    recurring.nodes.push(node);
    const error = compileWorkspace(workspace).validation.errors.find((entry) => entry.startsWith('Recurring Check: Clean URL:'));
    expect(error).toBeDefined();
    expect(findValidationNodeTargets(workspace, error!)).toEqual([{ nodeId: node.id, surfaceId: 'recurring' }]);
  });

  it('matches block names as literal words, including punctuation', () => {
    const workspace = createDefaultWorkspace();
    const node = createWorkspaceNode('SaveStringToLog', { x: 0, y: 0 }, { label: 'URL [clean]' });
    workspace.nodes.push(node);
    expect(findValidationNodeTargets(workspace, 'Only one connection can feed URL [clean].Message.')).toEqual([{ nodeId: node.id }]);
    node.settings.label = 'Log';
    expect(findValidationNodeTargets(workspace, 'Dialog settings are required.')).toEqual([]);
  });
});

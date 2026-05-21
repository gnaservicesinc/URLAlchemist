import type { GraphDataType, WorkspaceBlockSettings, WorkspaceNodeV2 } from './types';

export type VariableReferenceKind = 'named' | 'numeric';
export type VariableNumericMode = 'forbidden' | 'substitution' | 'regex';

export interface VariableReference {
  token: string;
  name: string;
  kind: VariableReferenceKind;
  index: number;
  end: number;
  numericIndex?: number;
}

export interface VariableFieldSpec {
  setting: keyof WorkspaceBlockSettings;
  label: string;
  expectedType: GraphDataType;
  inputHandle?: string;
  numericMode: VariableNumericMode;
}

export const BUILT_IN_VARIABLE_TYPES: Readonly<Record<string, GraphDataType>> = {
  $mouse_x: 'number',
  $mouse_y: 'number',
};

export function normalizeVariableName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.startsWith('$') || trimmed.startsWith('_')) {
    return trimmed;
  }

  return `$${trimmed}`;
}

export function validateVariableName(name: string): string | null {
  const trimmed = name.trim();
  const normalized = normalizeVariableName(trimmed);
  if (!normalized) {
    return 'variable name is required.';
  }

  if (/^\$?\d+$/.test(trimmed) || /^\$\d+/.test(normalized)) {
    return 'variable names like $1 are reserved for substitution connector inputs.';
  }

  if (!/^(_[A-Za-z][A-Za-z0-9_]*|\$[A-Za-z_][A-Za-z0-9_]*|[A-Za-z][A-Za-z0-9_]*)$/.test(trimmed)) {
    return 'variable names can use letters, numbers, and underscores, and may start with $ or _.';
  }

  return null;
}

export function extractVariableReferences(value: string): VariableReference[] {
  const references: VariableReference[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '$' || value[index - 1] === '\\') {
      continue;
    }

    const rest = value.slice(index + 1);
    const numeric = /^(\d+)/.exec(rest);
    if (numeric) {
      const token = `$${numeric[1]}`;
      references.push({
        token,
        name: numeric[1],
        kind: 'numeric',
        index,
        end: index + token.length,
        numericIndex: Number.parseInt(numeric[1], 10),
      });
      index += numeric[1].length;
      continue;
    }

    const named = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
    if (named) {
      const token = `$${named[1]}`;
      references.push({
        token,
        name: named[1],
        kind: 'named',
        index,
        end: index + token.length,
      });
      index += named[1].length;
    }
  }

  return references;
}

export function hasActiveVariableReference(value: string): boolean {
  return extractVariableReferences(value).length > 0;
}

export function renderEscapedVariableText(value: string): string {
  return value.replace(/\\\$/g, '$');
}

export function resolveVariableText(
  value: string,
  options: {
    resolveNamed: (token: string) => string;
    resolveNumeric?: (index: number, token: string) => string | undefined;
  },
): string {
  const references = extractVariableReferences(value);
  if (references.length === 0) {
    return renderEscapedVariableText(value);
  }

  let output = '';
  let cursor = 0;
  references.forEach((reference) => {
    output += renderEscapedVariableText(value.slice(cursor, reference.index));
    if (reference.kind === 'numeric') {
      output += options.resolveNumeric?.(reference.numericIndex ?? 0, reference.token) ?? reference.token;
    } else {
      output += options.resolveNamed(reference.token);
    }
    cursor = reference.end;
  });
  output += renderEscapedVariableText(value.slice(cursor));
  return output;
}

function stringSetting(settings: WorkspaceBlockSettings, setting: keyof WorkspaceBlockSettings): string {
  const value = settings[setting];
  return typeof value === 'string' ? value : '';
}

function literalDataType(node: WorkspaceNodeV2, fallback: GraphDataType): GraphDataType {
  return node.settings.literalDataType ?? fallback;
}

export function getVariableFieldSpecs(node: WorkspaceNodeV2): VariableFieldSpec[] {
  switch (node.type) {
    case 'RegExpression':
      return [{
        setting: 'payload',
        label: 'Payload',
        expectedType: 'string',
        inputHandle: 'payload',
        numericMode: node.settings.payloadVars ? 'regex' : 'forbidden',
      }];
    case 'PromptText':
    case 'PromptNumber':
    case 'Confirm':
    case 'PickFileOrUrl':
      return [{
        setting: 'promptMessage',
        label: 'Prompt message',
        expectedType: 'string',
        inputHandle: 'message',
        numericMode: 'forbidden',
      }];
    case 'ShowMessage':
      return [
        {
          setting: 'promptTitle',
          label: 'Title',
          expectedType: 'string',
          inputHandle: 'title',
          numericMode: 'forbidden',
        },
        {
          setting: 'promptMessage',
          label: 'Message',
          expectedType: 'string',
          inputHandle: 'message',
          numericMode: 'forbidden',
        },
      ];
    case 'OverlayInput':
      return [{
        setting: 'promptMessage',
        label: 'Overlay message',
        expectedType: 'string',
        inputHandle: 'message',
        numericMode: 'forbidden',
      }];
    case 'OverlayControl': {
      const specs: VariableFieldSpec[] = [
        {
          setting: 'overlayText',
          label: 'Overlay message',
          expectedType: 'string',
          inputHandle: 'message',
          numericMode: 'forbidden',
        },
        {
          setting: 'promptMessage',
          label: 'Overlay message',
          expectedType: 'string',
          inputHandle: 'message',
          numericMode: 'forbidden',
        },
      ];
      return specs.filter((spec) => stringSetting(node.settings, spec.setting).trim() !== '');
    }
    case 'SaveStringToLog':
      return [{
        setting: 'literalValue',
        label: 'Message',
        expectedType: 'string',
        inputHandle: 'message',
        numericMode: 'forbidden',
      }];
    case 'Abort':
      return [{
        setting: 'abortMessage',
        label: 'Abort message',
        expectedType: 'string',
        numericMode: 'forbidden',
      }];
    case 'Substitution':
      return [{
        setting: 'substitutionTemplate',
        label: 'String pattern',
        expectedType: 'string',
        numericMode: 'substitution',
      }];
    case 'TextSplitJoin':
      return [{
        setting: 'splitJoinSeparator',
        label: 'Separator',
        expectedType: 'string',
        numericMode: 'forbidden',
      }];
    case 'UrlQuery':
      return [
        {
          setting: 'urlQueryKey',
          label: 'Query key',
          expectedType: 'string',
          inputHandle: 'key',
          numericMode: 'forbidden',
        },
        {
          setting: 'urlQueryValue',
          label: 'Query value',
          expectedType: 'string',
          inputHandle: 'value',
          numericMode: 'forbidden',
        },
        {
          setting: 'urlQueryParams',
          label: 'Allowed parameters',
          expectedType: 'string',
          numericMode: 'forbidden',
        },
      ];
    case 'DictOperation':
      return [{
        setting: 'dictKey',
        label: 'Key',
        expectedType: 'string',
        inputHandle: 'key',
        numericMode: 'forbidden',
      }];
    case 'SharedState':
      return [{
        setting: 'selectFalseValue',
        label: node.settings.sharedStateMode === 'SET' ? 'Value' : 'Default when missing',
        expectedType: literalDataType(node, 'Any'),
        inputHandle: node.settings.sharedStateMode === 'SET' ? 'value' : undefined,
        numericMode: 'forbidden',
      }];
    case 'Logical':
      return [{
        setting: 'compareValue',
        label: 'Compare value',
        expectedType: 'number',
        numericMode: 'forbidden',
      }];
    case 'Math':
      return [
        {
          setting: 'literalValue',
          label: 'A value',
          expectedType: 'number',
          inputHandle: 'left',
          numericMode: 'forbidden',
        },
        {
          setting: 'compareValue',
          label: 'B value',
          expectedType: 'number',
          inputHandle: 'right',
          numericMode: 'forbidden',
        },
      ];
    case 'ConditionSelect':
      return [
        {
          setting: 'selectTrueValue',
          label: 'True value',
          expectedType: literalDataType(node, 'Any'),
          inputHandle: 'trueValue',
          numericMode: 'forbidden',
        },
        {
          setting: 'selectFalseValue',
          label: 'False value',
          expectedType: literalDataType(node, 'Any'),
          inputHandle: 'falseValue',
          numericMode: 'forbidden',
        },
      ];
    default:
      return [];
  }
}

export function variableDrivenInputHandles(node: WorkspaceNodeV2): Set<string> {
  const handles = new Set<string>();
  getVariableFieldSpecs(node).forEach((spec) => {
    if (!spec.inputHandle) {
      return;
    }

    const value = stringSetting(node.settings, spec.setting);
    if (hasActiveVariableReference(value)) {
      handles.add(spec.inputHandle);
    }
  });
  return handles;
}

export function variableTypeMatches(actual: GraphDataType, expected: GraphDataType): boolean {
  if (actual === expected) {
    return true;
  }

  return (
    (actual === 'number' || actual === 'floatingPoint') &&
    (expected === 'number' || expected === 'floatingPoint')
  );
}

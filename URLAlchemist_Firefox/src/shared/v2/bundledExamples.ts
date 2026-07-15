import bundledRecipeCatalog from './bundledWorkspaceRecipes.json';
import { compileWorkspace } from './compiler';
import { materializeWorkspaceRecipe, parseWorkspaceRecipe } from './workspaceRecipe';
import type {
  CompiledActionPackV2,
  RiskLevel,
  WorkspaceCompatibilityMetadata,
  WorkspaceFileV2,
} from './types';
import type { WorkspaceRecipeV1 } from './workspaceRecipe';

export const BUNDLED_EXAMPLE_BUILD_TIME_UTC = 1_778_755_200;
export const BUNDLED_EXAMPLE_BUILDER_UUID = '11111111-1111-4111-8111-111111111111';
export const BUNDLED_EXAMPLE_CREATED_AT = BUNDLED_EXAMPLE_BUILD_TIME_UTC * 1000;
export const BUNDLED_EXAMPLE_CHROME_VERSION = '2.7.1';
export const BUNDLED_EXAMPLE_FIREFOX_VERSION = '2.7.1';
export const BUNDLED_EXAMPLE_FIREFOX_ANDROID_VERSION = '142.0';

const BUNDLED_EXAMPLE_COMPATIBILITY: WorkspaceCompatibilityMetadata = {
  chrome: {
    version: BUNDLED_EXAMPLE_CHROME_VERSION,
    status: 'supported',
  },
  firefox: {
    version: BUNDLED_EXAMPLE_FIREFOX_VERSION,
    status: 'supported',
  },
  firefoxAndroid: {
    version: BUNDLED_EXAMPLE_FIREFOX_ANDROID_VERSION,
    status: 'source-only',
  },
};

export type BundledExampleCategory =
  | 'URL cleanup'
  | 'Search'
  | 'Storage'
  | 'Remote data'
  | 'Page tools'
  | 'Interactive'
  | 'Wellness'
  | 'Custom';

export interface BundledActionPackExample {
  id: string;
  name: string;
  slug: string;
  description: string;
  category: BundledExampleCategory;
  collection: 'bundled' | 'examples';
  trigger: string;
  risk: RiskLevel;
  features: string[];
  workspacePath: string;
  actionPackPath?: string;
  kind?: 'action-pack' | 'custom-block-source';
}

interface BundledRecipeDefinition {
  example: BundledActionPackExample;
  recipe: WorkspaceRecipeV1;
}

const CATEGORY_VALUES = new Set<BundledExampleCategory>([
  'URL cleanup',
  'Search',
  'Storage',
  'Remote data',
  'Page tools',
  'Interactive',
  'Wellness',
  'Custom',
]);
const COLLECTION_VALUES = new Set(['bundled', 'examples']);
const RISK_VALUES = new Set<RiskLevel>(['safe', 'extended', 'high']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label}.${key} must be a non-empty string.`);
  }
  return value.trim();
}

function parseBundledRecipeDefinitions(): BundledRecipeDefinition[] {
  const catalog = recordValue(bundledRecipeCatalog, 'Bundled workspace recipe catalog');
  if (catalog.kind !== 'url-alchemist.bundled-workspace-recipes.v1' || !Array.isArray(catalog.entries)) {
    throw new Error('Bundled workspace recipe catalog has an invalid kind or entries list.');
  }

  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();
  return catalog.entries.map((candidate, index) => {
    const label = `Bundled workspace recipe ${index + 1}`;
    const record = recordValue(candidate, label);
    const id = requiredString(record, 'id', label).toLowerCase();
    const slug = requiredString(record, 'slug', label);
    const category = requiredString(record, 'category', label) as BundledExampleCategory;
    const collection = requiredString(record, 'collection', label) as BundledActionPackExample['collection'];
    const risk = requiredString(record, 'risk', label) as RiskLevel;
    const features = record.features;
    if (!UUID_PATTERN.test(id) || !SLUG_PATTERN.test(slug)) {
      throw new Error(`${label} has an invalid id or slug.`);
    }
    if (seenIds.has(id) || seenSlugs.has(slug)) {
      throw new Error(`${label} repeats an id or slug.`);
    }
    if (!CATEGORY_VALUES.has(category) || !COLLECTION_VALUES.has(collection) || !RISK_VALUES.has(risk)) {
      throw new Error(`${label} has invalid category, collection, or risk metadata.`);
    }
    if (!Array.isArray(features) || features.length === 0 || features.some((feature) => typeof feature !== 'string' || !feature.trim())) {
      throw new Error(`${label}.features must contain non-empty strings.`);
    }

    const recipe = parseWorkspaceRecipe(record.recipe);
    const customBlockSource = recipe.workspaceType === 'custom-block';
    seenIds.add(id);
    seenSlugs.add(slug);
    return {
      recipe,
      example: {
        id,
        name: recipe.name,
        slug,
        description: recipe.description,
        category,
        collection,
        trigger: customBlockSource ? 'CUSTOM_BLOCK' : recipe.trigger.type,
        risk,
        features: features.map((feature) => (feature as string).trim()),
        workspacePath: `bundled-actionpacks/workspaces/${slug}.workspace`,
        actionPackPath: customBlockSource ? undefined : `bundled-actionpacks/action-packs/${slug}.actionpack`,
        kind: customBlockSource ? 'custom-block-source' : 'action-pack',
      },
    };
  });
}

const BUNDLED_RECIPE_DEFINITIONS = parseBundledRecipeDefinitions();

export const BUNDLED_ACTION_PACK_EXAMPLES: BundledActionPackExample[] = BUNDLED_RECIPE_DEFINITIONS.map(
  ({ example }) => example,
);

export const BUNDLED_WORKSPACE_RECIPES: WorkspaceRecipeV1[] = BUNDLED_RECIPE_DEFINITIONS.map(
  ({ recipe }) => recipe,
);

export function createBundledExampleWorkspaces(): WorkspaceFileV2[] {
  return BUNDLED_RECIPE_DEFINITIONS.map(({ example, recipe }) => materializeWorkspaceRecipe(recipe, {
    id: example.id,
    author: 'URL Alchemist',
    version: 1,
    createdAt: BUNDLED_EXAMPLE_CREATED_AT,
    updatedAt: BUNDLED_EXAMPLE_CREATED_AT,
    compatibility: BUNDLED_EXAMPLE_COMPATIBILITY,
    nodeIdPrefix: example.slug,
  }));
}

export function createBundledExampleActionPacks(): CompiledActionPackV2[] {
  const workspaces = createBundledExampleWorkspaces();
  const expectedRiskById = new Map(BUNDLED_ACTION_PACK_EXAMPLES.map((example) => [example.id, example.risk]));
  return workspaces.filter((workspace) => workspace.workspaceType !== 'custom-block').map((workspace) => {
    const compiled = compileWorkspace(workspace, {
      builderUuid: BUNDLED_EXAMPLE_BUILDER_UUID,
      buildTimeUtc: BUNDLED_EXAMPLE_BUILD_TIME_UTC,
      conditionWorkspaces: workspaces,
    });

    if (!compiled.ok || !compiled.pack) {
      throw new Error(`${workspace.metadata.name} did not compile: ${compiled.validation.errors.join('; ')}`);
    }

    const expectedRisk = expectedRiskById.get(workspace.metadata.id);
    if (expectedRisk !== compiled.pack.risk.highest) {
      throw new Error(`${workspace.metadata.name} expected ${expectedRisk} risk but compiled as ${compiled.pack.risk.highest}.`);
    }
    return compiled.pack;
  });
}

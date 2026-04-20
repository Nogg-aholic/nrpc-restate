import {
  type BindRestateOptions,
  type BindRestateResult,
  type RestateBindable,
  type RestateComponentKind,
  type RestateEndpointLike,
  type RestateRegistry,
} from './types.js';

interface NormalizedItem<TDefinition> {
  definition: TDefinition;
  kind: RestateComponentKind | 'unknown';
  name: string;
}

const DEFAULT_COMPONENT_NAME = 'anonymous';

function resolveName(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  if ('name' in value) {
    const name = (value as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim().length > 0) {
      return name;
    }
  }

  return undefined;
}

function normalizeItem<TDefinition>(item: RestateBindable<TDefinition>): NormalizedItem<TDefinition> {
  const kind = item.kind ?? 'unknown';
  const name = item.name ?? resolveName(item.definition) ?? DEFAULT_COMPONENT_NAME;

  return {
    definition: item.definition,
    kind,
    name,
  };
}

function duplicateKey(kind: string, name: string): string {
  return `${kind}:${name}`;
}

function bindItems<TDefinition>(
  endpoint: RestateEndpointLike<TDefinition>,
  items: RestateBindable<TDefinition>[],
  options: BindRestateOptions = {},
): BindRestateResult<TDefinition> {
  const throwOnDuplicate = options.throwOnDuplicate ?? true;
  const dedupeByName = options.dedupeByName ?? true;

  const seen = new Set<string>();
  const bound: BindRestateResult<TDefinition>['bound'] = [];
  const skipped: BindRestateResult<TDefinition>['skipped'] = [];

  for (const item of items) {
    const normalized = normalizeItem(item);
    const key = duplicateKey(normalized.kind, normalized.name);
    const isDuplicate = dedupeByName && seen.has(key);

    if (isDuplicate) {
      const duplicateItem = {
        definition: normalized.definition,
        kind: normalized.kind,
        name: normalized.name,
        duplicate: true,
      };

      if (throwOnDuplicate) {
        throw new Error(`Duplicate Restate component registration: ${key}`);
      }

      skipped.push(duplicateItem);
      continue;
    }

    endpoint.bind(normalized.definition);
    seen.add(key);
    bound.push({
      definition: normalized.definition,
      kind: normalized.kind,
      name: normalized.name,
      duplicate: false,
    });
  }

  return { bound, skipped };
}

export function defineRestateComponent<TDefinition>(
  definition: TDefinition,
  options: { kind?: RestateComponentKind; name?: string } = {},
): RestateBindable<TDefinition> {
  return {
    definition,
    kind: options.kind,
    name: options.name,
  };
}

export function bindRestateComponents<TDefinition>(
  endpoint: RestateEndpointLike<TDefinition>,
  components: Iterable<RestateBindable<TDefinition> | TDefinition>,
  options: BindRestateOptions = {},
): BindRestateResult<TDefinition> {
  const items: RestateBindable<TDefinition>[] = [];

  for (const component of components) {
    if (
      typeof component === 'object' &&
      component !== null &&
      'definition' in (component as Record<string, unknown>)
    ) {
      items.push(component as RestateBindable<TDefinition>);
    } else {
      items.push({ definition: component as TDefinition });
    }
  }

  return bindItems(endpoint, items, options);
}

export function createRestateRegistry<TDefinition = unknown>(): RestateRegistry<TDefinition> {
  const items: RestateBindable<TDefinition>[] = [];

  return {
    register(item): void {
      items.push(item);
    },

    registerDefinition(definition, kind, name): void {
      items.push({ definition, kind, name });
    },

    list(): RestateBindable<TDefinition>[] {
      return [...items];
    },

    clear(): void {
      items.length = 0;
    },

    bindTo(endpoint, options = {}): BindRestateResult<TDefinition> {
      return bindItems(endpoint, items, options);
    },
  };
}

const globalRegistry = createRestateRegistry<unknown>();

export function registerRestateComponent<TDefinition>(
  component: RestateBindable<TDefinition> | TDefinition,
  options: { kind?: RestateComponentKind; name?: string } = {},
): void {
  if (
    typeof component === 'object' &&
    component !== null &&
    'definition' in (component as Record<string, unknown>)
  ) {
    globalRegistry.register(component as RestateBindable<unknown>);
    return;
  }

  globalRegistry.registerDefinition(component as unknown, options.kind, options.name);
}

export function listRegisteredRestateComponents(): RestateBindable<unknown>[] {
  return globalRegistry.list();
}

export function clearRegisteredRestateComponents(): void {
  globalRegistry.clear();
}

export function bindRegisteredRestateComponents<TDefinition>(
  endpoint: RestateEndpointLike<TDefinition>,
  options: BindRestateOptions = {},
): BindRestateResult<TDefinition> {
  return bindRestateComponents(
    endpoint,
    globalRegistry.list() as RestateBindable<TDefinition>[],
    options,
  );
}

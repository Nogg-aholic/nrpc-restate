export type RestateComponentKind = 'service' | 'object' | 'workflow';

export interface RestateEndpointLike<TDefinition = unknown> {
  bind(definition: TDefinition): RestateEndpointLike<TDefinition>;
}

export interface RestateBindable<TDefinition = unknown> {
  kind?: RestateComponentKind;
  name?: string;
  definition: TDefinition;
}

export interface BindRestateOptions {
  throwOnDuplicate?: boolean;
  dedupeByName?: boolean;
}

export interface BoundRestateItem<TDefinition = unknown> {
  definition: TDefinition;
  kind: RestateComponentKind | 'unknown';
  name: string;
  duplicate: boolean;
}

export interface BindRestateResult<TDefinition = unknown> {
  bound: BoundRestateItem<TDefinition>[];
  skipped: BoundRestateItem<TDefinition>[];
}

export interface RestateRegistry<TDefinition = unknown> {
  register(item: RestateBindable<TDefinition>): void;
  registerDefinition(definition: TDefinition, kind?: RestateComponentKind, name?: string): void;
  list(): RestateBindable<TDefinition>[];
  clear(): void;
  bindTo(endpoint: RestateEndpointLike<TDefinition>, options?: BindRestateOptions): BindRestateResult<TDefinition>;
}

import { defineRestateComponent, registerRestateComponent } from './registry.js';
import type { RestateBindable, RestateComponentKind } from './types.js';
import { serde } from '@restatedev/restate-sdk';
import type { GeneratedCodecShape } from '@nogg-aholic/nrpc/generated-codec-runtime';

export type RpcSurface = Record<string, unknown>;

export type RpcSurfaceMethod = {
  path: string[];
  handlerName: string;
  fn: (input?: unknown) => unknown | Promise<unknown>;
};

export type HandlerNameStrategy =
  | 'doubleUnderscore'
  | 'dot'
  | 'slash'
  | ((path: string[]) => string);

export interface RpcSurfaceScanOptions {
  handlerNameStrategy?: HandlerNameStrategy;
  methodFilter?: (path: string[], fn: (input?: unknown) => unknown | Promise<unknown>) => boolean;
}

export type RpcSurfaceInputContext = {
  path: string[];
  restateContext: unknown;
  input: unknown;
};

export type RpcSurfaceBackendHeaders = Record<string, string>;

export type RpcSurfaceBackendHeadersProvider =
  | RpcSurfaceBackendHeaders
  | ((context: RpcSurfaceInputContext) => RpcSurfaceBackendHeaders | undefined);

export type RpcSurfaceBackendHeadersTarget = 'auto' | 'headers' | 'input.headers';

export function createPayloadApiKeyAuthorizationValue(
  collectionSlug: string,
  apiKey: string,
): string {
  const slug = collectionSlug.trim();
  const key = apiKey.trim();

  if (!slug) {
    throw new Error('Payload collection slug is required for API key auth.');
  }

  if (!key) {
    throw new Error('Payload API key is required.');
  }

  return `${slug} API-Key ${key}`;
}

export function createPayloadApiKeyHeaders(
  collectionSlug: string,
  apiKey: string,
): RpcSurfaceBackendHeaders {
  return {
    authorization: createPayloadApiKeyAuthorizationValue(collectionSlug, apiKey),
  };
}

export interface RestateServiceDefinitionLike {
  name: string;
  handlers: Record<string, (ctx: unknown, input?: unknown) => Promise<unknown>>;
}

export interface RpcSurfaceMethodDocs {
  summary?: string;
  description?: string;
  returnsDescription?: string;
  tags?: string[];
  params?: Record<string, string>;
}

export interface RpcSurfaceToRestateOptions extends RpcSurfaceScanOptions {
  name: string;
  prepareInput?: (context: RpcSurfaceInputContext) => unknown;
  backendRequestHeaders?: RpcSurfaceBackendHeadersProvider;
  backendRequestHeadersTarget?: RpcSurfaceBackendHeadersTarget;
  rpcMethodShapeResolver?: (methodName: string) => { args: GeneratedCodecShape; result: GeneratedCodecShape } | undefined;
  rpcMethodDocsResolver?: (methodName: string) => RpcSurfaceMethodDocs | undefined;
  restateHandlerFactory?: (
    options: {
      input?: { contentType?: string; jsonSchema?: object; serialize(value: unknown): Uint8Array; deserialize(data: Uint8Array): unknown };
      output?: { contentType?: string; jsonSchema?: object; serialize(value: unknown): Uint8Array; deserialize(data: Uint8Array): unknown };
      description?: string;
      metadata?: Record<string, string>;
    },
    fn: (...args: any[]) => Promise<unknown>,
  ) => (...args: any[]) => Promise<unknown>;
}

export interface RegisterRpcSurfaceAsRestateServiceOptions
  extends RpcSurfaceToRestateOptions {
  kind?: RestateComponentKind;
  componentName?: string;
  restateServiceFactory?: (definition: RestateServiceDefinitionLike) => unknown;
}

const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toHandlerName(path: string[], strategy: HandlerNameStrategy = 'doubleUnderscore'): string {
  if (typeof strategy === 'function') {
    return strategy(path);
  }

  switch (strategy) {
    case 'dot':
      return path.join('.');
    case 'slash':
      return path.join('/');
    case 'doubleUnderscore':
    default:
      return path.join('__');
  }
}

function createRestateCompatibleHandler(
  path: string[],
  fn: (input?: unknown) => unknown | Promise<unknown>,
  options: RpcSurfaceToRestateOptions,
  methodName: string,
): (ctx: unknown, input?: unknown) => Promise<unknown> {
  const baseHandler = async (ctx: unknown, input?: unknown) => {
    const preparedInput = prepareRpcMethodInput({
      path,
      restateContext: ctx,
      input,
    }, options);

    // nRPC methods typically take zero or one input argument.
    if (fn.length === 0) {
      return await fn();
    }

    return await fn(preparedInput);
  };

  const shape = options.rpcMethodShapeResolver?.(methodName);
  const methodDocs = options.rpcMethodDocsResolver?.(methodName);
  const description = combineMethodDescription(methodDocs);
  const metadata = buildMethodMetadata(methodName, methodDocs);
  const handlerFactory = options.restateHandlerFactory;
  if (!shape || !handlerFactory) {
    return baseHandler;
  }

  const inputSerde = createJsonSerdeFromArgsShape(shape.args);
  const outputSerde = createJsonSerdeFromShape(shape.result);
  return handlerFactory(
    {
      ...(inputSerde ? { input: inputSerde } : {}),
      ...(outputSerde ? { output: outputSerde } : {}),
      ...(description ? { description } : {}),
      ...(metadata ? { metadata } : {}),
    },
    baseHandler,
  );
}

function combineMethodDescription(docs?: RpcSurfaceMethodDocs): string | undefined {
  if (!docs) {
    return undefined;
  }

  const summary = docs.summary?.trim();
  const description = docs.description?.trim();

  if (summary && description) {
    return `${summary}\n\n${description}`;
  }

  return summary || description;
}

function buildMethodMetadata(methodName: string, docs?: RpcSurfaceMethodDocs): Record<string, string> | undefined {
  const metadata: Record<string, string> = {
    'nrpc.method': methodName,
  };

  if (docs?.tags?.length) {
    metadata['nrpc.tags'] = docs.tags.join(',');
  }

  if (docs?.returnsDescription?.trim()) {
    metadata['nrpc.returnsDescription'] = docs.returnsDescription.trim();
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function createJsonSerdeFromArgsShape(shape: GeneratedCodecShape): ReturnType<typeof createJsonSerdeFromShape> | undefined {
  if (shape.kind !== 'tuple') {
    return createJsonSerdeFromShape(shape);
  }

  if (shape.elements.length === 0) {
    return serde.empty as unknown as ReturnType<typeof createJsonSerdeFromShape>;
  }

  return createJsonSerdeFromShape(shape.elements[0] ?? { kind: 'unknown' });
}

function createJsonSerdeFromShape(shape: GeneratedCodecShape): {
  contentType?: string;
  jsonSchema?: object;
  serialize(value: unknown): Uint8Array;
  deserialize(data: Uint8Array): unknown;
} {
  const schema = generatedCodecShapeToJsonSchema(shape);
  return serde.json.schema<unknown>(schema) as unknown as {
    contentType?: string;
    jsonSchema?: object;
    serialize(value: unknown): Uint8Array;
    deserialize(data: Uint8Array): unknown;
  };
}

function generatedCodecShapeToJsonSchema(shape: GeneratedCodecShape): object {
  switch (shape.kind) {
    case 'primitive':
      if (shape.primitive === 'number') return { type: 'number' };
      if (shape.primitive === 'boolean') return { type: 'boolean' };
      return { type: 'string' };
    case 'bigint':
      return { type: 'string' };
    case 'unknown':
      return {};
    case 'null':
      return { type: 'null' };
    case 'literal':
      return { const: shape.value };
    case 'undefined':
      return {};
    case 'optional':
      return { anyOf: [generatedCodecShapeToJsonSchema(shape.inner), { type: 'null' }] };
    case 'date':
      return shape.policy === 'epoch-ms'
        ? { type: 'number' }
        : { type: 'string', format: 'date-time' };
    case 'map':
      return { type: 'object', additionalProperties: true };
    case 'record':
      return { type: 'object', additionalProperties: generatedCodecShapeToJsonSchema(shape.value) };
    case 'set':
      return { type: 'array', items: generatedCodecShapeToJsonSchema(shape.element) };
    case 'union':
      return { anyOf: shape.variants.map((variant) => generatedCodecShapeToJsonSchema(variant)) };
    case 'discriminated-union':
      return {
        oneOf: shape.variants.map((variant) => generatedCodecShapeToJsonSchema(variant.shape)),
      };
    case 'typed-array':
      return { type: 'array', items: { type: 'number' } };
    case 'array':
      return { type: 'array', items: generatedCodecShapeToJsonSchema(shape.element) };
    case 'tuple':
      return {
        type: 'array',
        prefixItems: shape.elements.map((element) => generatedCodecShapeToJsonSchema(element)),
        minItems: shape.elements.length,
        maxItems: shape.elements.length,
      };
    case 'object': {
      const properties: Record<string, object> = {};
      const required: string[] = [];
      for (const property of shape.properties) {
        const description = (property as { description?: string }).description;
        const propertySchema = generatedCodecShapeToJsonSchema(property.shape) as Record<string, unknown>;
        if (description && !propertySchema.description) {
          propertySchema.description = description;
        }
        properties[property.name] = propertySchema;
        if (property.shape.kind !== 'optional') {
          required.push(property.name);
        }
      }
      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      };
    }
    default:
      return {};
  }
}

function mergeHeaderRecords(
  existing: unknown,
  incoming: RpcSurfaceBackendHeaders,
): Record<string, string> {
  const merged: Record<string, string> = {};

  if (isObjectRecord(existing)) {
    for (const [key, value] of Object.entries(existing)) {
      if (typeof value === 'string') {
        merged[key] = value;
      }
    }
  }

  for (const [key, value] of Object.entries(incoming)) {
    merged[key] = value;
  }

  return merged;
}

function withTopLevelHeaders(
  input: unknown,
  headers: RpcSurfaceBackendHeaders,
): unknown {
  if (!isObjectRecord(input)) {
    return { headers };
  }

  return {
    ...input,
    headers: mergeHeaderRecords((input as { headers?: unknown }).headers, headers),
  };
}

function withNestedInputHeaders(
  input: unknown,
  headers: RpcSurfaceBackendHeaders,
): unknown {
  if (!isObjectRecord(input) || !isObjectRecord((input as { input?: unknown }).input)) {
    return withTopLevelHeaders(input, headers);
  }

  const nestedInput = (input as { input: Record<string, unknown> }).input;
  return {
    ...input,
    input: {
      ...nestedInput,
      headers: mergeHeaderRecords((nestedInput as { headers?: unknown }).headers, headers),
    },
  };
}

function resolveBackendHeaders(
  context: RpcSurfaceInputContext,
  provider: RpcSurfaceBackendHeadersProvider | undefined,
): RpcSurfaceBackendHeaders | undefined {
  if (!provider) {
    return undefined;
  }

  if (typeof provider === 'function') {
    return provider(context);
  }

  return provider;
}

function injectBackendHeaders(
  context: RpcSurfaceInputContext,
  options: RpcSurfaceToRestateOptions,
): unknown {
  const backendHeaders = resolveBackendHeaders(context, options.backendRequestHeaders);
  if (!backendHeaders || Object.keys(backendHeaders).length === 0) {
    return context.input;
  }

  const target = options.backendRequestHeadersTarget ?? 'auto';
  if (target === 'headers') {
    return withTopLevelHeaders(context.input, backendHeaders);
  }

  if (target === 'input.headers') {
    return withNestedInputHeaders(context.input, backendHeaders);
  }

  const input = context.input;
  if (isObjectRecord(input) && isObjectRecord((input as { input?: unknown }).input)) {
    return withNestedInputHeaders(input, backendHeaders);
  }

  return withTopLevelHeaders(input, backendHeaders);
}

function prepareRpcMethodInput(
  context: RpcSurfaceInputContext,
  options: RpcSurfaceToRestateOptions,
): unknown {
  const withHeaders = injectBackendHeaders(context, options);
  if (!options.prepareInput) {
    return withHeaders;
  }

  return options.prepareInput({
    path: context.path,
    restateContext: context.restateContext,
    input: withHeaders,
  });
}

export function discoverRpcSurfaceMethods(
  surface: RpcSurface,
  options: RpcSurfaceScanOptions = {},
): RpcSurfaceMethod[] {
  const handlerNameStrategy = options.handlerNameStrategy ?? 'doubleUnderscore';
  const methodFilter = options.methodFilter;
  const methods: RpcSurfaceMethod[] = [];

  const walk = (node: Record<string, unknown>, path: string[]): void => {
    for (const [key, value] of Object.entries(node)) {
      if (RESERVED_KEYS.has(key)) {
        continue;
      }

      const nextPath = [...path, key];

      if (typeof value === 'function') {
        const fn = value as (input?: unknown) => unknown | Promise<unknown>;

        if (!methodFilter || methodFilter(nextPath, fn)) {
          methods.push({
            path: nextPath,
            handlerName: toHandlerName(nextPath, handlerNameStrategy),
            fn,
          });
        }

        continue;
      }

      if (isObjectRecord(value)) {
        walk(value, nextPath);
      }
    }
  };

  walk(surface, []);
  return methods;
}

export function createRestateServiceDefinitionFromRpcSurface(
  surface: RpcSurface,
  options: RpcSurfaceToRestateOptions,
): RestateServiceDefinitionLike {
  const methods = discoverRpcSurfaceMethods(surface, options);

  const handlers: RestateServiceDefinitionLike['handlers'] = {};
  for (const method of methods) {
    handlers[method.handlerName] = createRestateCompatibleHandler(
      method.path,
      method.fn,
      options,
      method.path.join('.'),
    );
  }

  return {
    name: options.name,
    handlers,
  };
}

export function registerRpcSurfaceAsRestateService(
  surface: RpcSurface,
  options: RegisterRpcSurfaceAsRestateServiceOptions,
): RestateBindable<unknown> {
  const baseDefinition = createRestateServiceDefinitionFromRpcSurface(surface, options);
  const definition = options.restateServiceFactory
    ? options.restateServiceFactory(baseDefinition)
    : baseDefinition;

  const component = defineRestateComponent(definition, {
    kind: options.kind ?? 'service',
    name: options.componentName ?? options.name,
  });

  registerRestateComponent(component);
  return component;
}

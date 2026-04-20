# nRPC Restate Kit

`@nogg-aholic/nrpc-restate` provides lightweight registration helpers for Restate components.

It is designed for codebases where each module can register itself and a central bootstrap can bind everything to a Restate endpoint.

## Install

With Bun:

```bash
bun add @nogg-aholic/nrpc-restate @restatedev/restate-sdk
```

With npm:

```bash
npm install @nogg-aholic/nrpc-restate @restatedev/restate-sdk
```

## Quick Start

```ts
import * as restate from '@restatedev/restate-sdk';
import {
  bindRegisteredRestateComponents,
  defineRestateComponent,
  registerRestateComponent,
} from '@nogg-aholic/nrpc-restate';

const greeter = restate.service({
  name: 'greeter',
  handlers: {
    greet: async () => 'hello',
  },
});

const billingWorkflow = restate.workflow({
  name: 'billing',
  handlers: {
    run: async () => 'ok',
  },
});

registerRestateComponent(defineRestateComponent(greeter, { kind: 'service' }));
registerRestateComponent(defineRestateComponent(billingWorkflow, { kind: 'workflow' }));

const endpoint = restate.endpoint();
bindRegisteredRestateComponents(endpoint);
```

## One-Line nRPC Surface Registration

If your service already exposes a nested nRPC object (for example from `createAuthRpcService()`),
you can expose the full surface to Restate in one line:

```ts
registerRpcSurfaceAsRestateService(createAuthRpcService(), {
  name: 'antigravity-auth',
  restateServiceFactory: restate.service,
});
```

This scans all nested functions and binds them as Restate handlers.

Default handler naming joins path segments with `__`:

- `health.status` -> `health__status`
- `accounts.activeCredential` -> `accounts__activeCredential`

You can change naming with `handlerNameStrategy: 'dot' | 'slash' | (path) => string`.

### Self-Hosted Backend Auth Headers

If Restate handlers call a backend protected by PayloadCMS auth, inject headers centrally:

```ts
registerRpcSurfaceAsRestateService(createAuthRpcService(), {
  name: 'antigravity-auth',
  restateServiceFactory: restate.service,
  backendRequestHeaders: createPayloadApiKeyHeaders(
    'users',
    process.env.PAYLOADCMS_API_KEY ?? '',
  ),
  backendRequestHeadersTarget: 'auto',
});
```

Payload API-key auth format is:

- `Authorization: <collectionSlug> API-Key <apiKey>`

For example:

- `Authorization: users API-Key <apiKey>`

If you are logged into Payload in a browser, local-jwt session cookies may also authenticate
requests. Prefer explicit API-key headers for backend-to-backend calls.

`backendRequestHeadersTarget` options:

- `auto` (default): writes to `input.headers` when present, otherwise `headers`
- `headers`: always writes to top-level `headers`
- `input.headers`: always writes to nested `input.headers`

For dynamic per-method behavior, use a function:

```ts
backendRequestHeaders: ({ path }) =>
  path[0] === 'proxy'
    ? createPayloadApiKeyHeaders('users', process.env.PAYLOADCMS_API_KEY ?? '')
    : undefined,
```

## APIs

- `defineRestateComponent(definition, { kind?, name? })`
- `registerRestateComponent(component, { kind?, name? })`
- `listRegisteredRestateComponents()`
- `clearRegisteredRestateComponents()`
- `bindRegisteredRestateComponents(endpoint, options?)`
- `bindRestateComponents(endpoint, components, options?)`
- `createRestateRegistry()`
- `discoverRpcSurfaceMethods(surface, options?)`
- `createRestateServiceDefinitionFromRpcSurface(surface, options)`
- `registerRpcSurfaceAsRestateService(surface, options)`

## Duplicate Handling

By default duplicate component registration is rejected by `kind:name` and throws.

Use bind options to change behavior:

```ts
bindRegisteredRestateComponents(endpoint, {
  throwOnDuplicate: false,
  dedupeByName: true,
});
```

When duplicates are skipped, the return value includes both `bound` and `skipped` entries.

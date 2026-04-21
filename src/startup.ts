import { listRegisteredRestateComponents } from './registry.js';

export type RestateEndpointHandlerFactory = (options: {
  services: any[];
}) => (request: Request, ...extraArgs: unknown[]) => Promise<Response>;

export interface StartRegisteredRestateDeploymentOptions {
  createEndpointHandler: RestateEndpointHandlerFactory;
  serviceName?: string;
  servicePort?: number;
  restateIngressPath?: string;
  restateAdminBaseUrl?: string;
  restateDeploymentUri?: string;
  autoRegister?: boolean;
  forceReRegister?: boolean;
  deploymentRetryIntervalFactor?: number;
  deploymentMaxRetryAttempts?: number;
  enabled?: boolean;
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}

export interface StartRegisteredRestateDeploymentResult {
  started: boolean;
  serviceCount: number;
  ingressPath?: string;
  handleRequest?: (request: Request) => Promise<Response | undefined>;
  reason?: string;
}

const startedDeployments = new Set<string>();

type DeploymentServiceInfo = {
  name?: string;
};

type DeploymentInfo = {
  id?: string;
  services?: DeploymentServiceInfo[];
};

type RegisterDeploymentPayload = {
  uri: string;
  force: boolean;
  use_http_11: boolean;
  retry_policy?: {
    initial_interval?: string;
    factor?: number;
    max_interval?: string;
    max_attempts?: number;
  };
};

function parseEnabled(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  return !['0', 'false', 'no', 'off'].includes(normalized);
}

function normalizeUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }

  return raw.replace(/\/+$/g, '');
}

function normalizePath(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const normalized = withLeadingSlash.replace(/\/+$/g, '');
  return normalized.length === 0 ? '/' : normalized;
}

function rewriteRequestPath(request: Request, ingressPath: string): Request {
  if (ingressPath === '/') {
    return request;
  }

  const url = new URL(request.url);
  const suffix = url.pathname.slice(ingressPath.length);
  url.pathname = suffix.length > 0 ? suffix : '/';
  return new Request(url.toString(), request);
}

function createPayloadApiKeyAuthHeader(env: Record<string, string | undefined>): string | undefined {
  const collection = env.PAYLOADCMS_AUTH_COLLECTION?.trim() || 'users';
  const apiKey = env.PAYLOADCMS_API_KEY?.trim();
  if (!apiKey) {
    return undefined;
  }

  return `${collection} API-Key ${apiKey}`;
}

function readBodyText(response: Response): Promise<string> {
  return response
    .text()
    .then((text) => text.trim())
    .catch(() => '');
}

function extractDeployments(payload: unknown): DeploymentInfo[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const record = payload as Record<string, unknown>;
  const deployments = record.deployments;
  if (!Array.isArray(deployments)) {
    return [];
  }

  return deployments.filter((item) => !!item && typeof item === 'object') as DeploymentInfo[];
}

function deploymentContainsAnyService(
  deployment: DeploymentInfo,
  serviceNames: string[],
): boolean {
  const deploymentServices = Array.isArray(deployment.services) ? deployment.services : [];
  const serviceSet = new Set(serviceNames);

  return deploymentServices.some((service) => {
    const name = typeof service?.name === 'string' ? service.name : undefined;
    return !!name && serviceSet.has(name);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function ensureRegisteredDeployment(options: {
  adminBaseUrl: string;
  deploymentUri: string;
  serviceNames: string[];
  forceReRegister?: boolean;
  deploymentRetryIntervalFactor?: number;
  deploymentMaxRetryAttempts?: number;
  authHeader?: string;
  log?: (message: string) => void;
}): Promise<void> {
  const listUrl = `${options.adminBaseUrl}/deployments`;
  const requestHeaders: Record<string, string> = {
    'content-type': 'application/json',
  };

  if (options.authHeader) {
    requestHeaders.authorization = options.authHeader;
  }

  const listResponse = await fetch(listUrl, {
    method: 'GET',
    headers: requestHeaders,
  });

  if (!listResponse.ok) {
    const body = await readBodyText(listResponse);
    throw new Error(`GET /deployments failed (${listResponse.status}) ${body}`.trim());
  }

  const listJson = (await listResponse.json().catch(() => ({}))) as unknown;
  const deployments = extractDeployments(listJson);
  const existing = deployments.find((deployment) =>
    deploymentContainsAnyService(deployment, options.serviceNames),
  );

  if (existing) {
    if (options.forceReRegister && existing.id) {
      const deleteResponse = await fetch(`${listUrl}/${existing.id}`, {
        method: 'DELETE',
        headers: requestHeaders,
      });

      if (!deleteResponse.ok) {
        const body = await readBodyText(deleteResponse);
        throw new Error(`DELETE /deployments/${existing.id} failed (${deleteResponse.status}) ${body}`.trim());
      }

      options.log?.(
        `[nrpc-restate] Deployment unregistered (id=${existing.id}) for services: ${options.serviceNames.join(', ')}`,
      );
    } else {
    options.log?.(
      `[nrpc-restate] Deployment already registered (id=${existing.id ?? 'unknown'}) for services: ${options.serviceNames.join(', ')}`,
    );
    return;
    }
  }

  const registerPayload: RegisterDeploymentPayload = {
    uri: options.deploymentUri,
    force: !!options.forceReRegister,
    use_http_11: true,
  };

  if (
    typeof options.deploymentRetryIntervalFactor === 'number'
    || typeof options.deploymentMaxRetryAttempts === 'number'
  ) {
    registerPayload.retry_policy = {
      initial_interval: '1s',
      factor: options.deploymentRetryIntervalFactor,
      max_interval: '1s',
      max_attempts: options.deploymentMaxRetryAttempts,
    };
  }

  const registerResponse = await fetch(listUrl, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(registerPayload),
  });

  if (!registerResponse.ok) {
    const body = await readBodyText(registerResponse);
    throw new Error(`POST /deployments failed (${registerResponse.status}) ${body}`.trim());
  }

  const registerJson = (await registerResponse.json().catch(() => ({}))) as Record<string, unknown>;
  const id = typeof registerJson.id === 'string' ? registerJson.id : 'unknown';
  options.log?.(
    `[nrpc-restate] Deployment registered successfully (id=${id}) for uri=${options.deploymentUri}`,
  );
}

function startAutoRegistration(options: {
  adminBaseUrl: string;
  deploymentUri: string;
  serviceNames: string[];
  forceReRegister?: boolean;
  deploymentRetryIntervalFactor?: number;
  deploymentMaxRetryAttempts?: number;
  authHeader?: string;
  log?: (message: string) => void;
}): void {
  void (async () => {
    const retryDelays = [500, 1000, 2000, 4000];

    for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
      try {
        await ensureRegisteredDeployment(options);
        return;
      } catch (error) {
        const isLast = attempt === retryDelays.length - 1;
        options.log?.(
          `[nrpc-restate] Deployment registration attempt ${attempt + 1} failed: ${String(error)}`,
        );

        if (isLast) {
          return;
        }

        await delay(retryDelays[attempt]);
      }
    }
  })();
}

export function startRegisteredRestateDeployment(
  options: StartRegisteredRestateDeploymentOptions,
): StartRegisteredRestateDeploymentResult {
  const env = options.env ?? process.env;
  const components = listRegisteredRestateComponents();
  const services = components.map((component) => component.definition);
  const componentNames = components
    .map((component) => (typeof component.name === 'string' ? component.name.trim() : ''))
    .filter((name) => name.length > 0);

  if (services.length === 0) {
    return { started: false, serviceCount: 0, reason: 'no-registered-components' };
  }

  const enabled = options.enabled ?? parseEnabled(env.RESTATE_DEPLOYMENT_ENABLED, true);
  if (!enabled) {
    return { started: false, serviceCount: services.length, reason: 'disabled' };
  }

  const ingressPath = normalizePath(
    options.restateIngressPath ?? env.RESTATE_INGRESS_PATH,
    '/restate/ingress',
  );
  const deploymentUri = normalizeUrl(options.restateDeploymentUri ?? env.RESTATE_DEPLOYMENT_URI)
    ?? (typeof options.servicePort === 'number' && options.servicePort > 0
      ? `http://127.0.0.1:${String(options.servicePort)}${ingressPath}`
      : undefined);
  const adminBaseUrl = normalizeUrl(
    options.restateAdminBaseUrl ?? env.RESTATE_ADMIN_BASE_URL ?? env.RESTATE_ADMIN_URL,
  );
  const autoRegister = options.autoRegister ?? parseEnabled(env.RESTATE_AUTO_REGISTER, true);
  const authHeader = createPayloadApiKeyAuthHeader(env);

  const serviceName = options.serviceName?.trim() || 'service';
  const deploymentKey = `${serviceName}:${ingressPath}`;
  if (startedDeployments.has(deploymentKey)) {
    return {
      started: false,
      serviceCount: services.length,
      ingressPath,
      reason: 'already-started',
    };
  }

  startedDeployments.add(deploymentKey);

  const endpointHandler = options.createEndpointHandler({ services: services as any[] });

  const handleRequest = async (request: Request): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(ingressPath)) {
      return undefined;
    }

    return endpointHandler(rewriteRequestPath(request, ingressPath));
  };

  options.log?.(
    `[nrpc-restate] Restate deployment mounted for ${serviceName} at ${ingressPath} (${services.length} component${services.length === 1 ? '' : 's'})`,
  );

  if (!autoRegister) {
    options.log?.('[nrpc-restate] Deployment auto-registration disabled by RESTATE_AUTO_REGISTER.');
  } else if (!adminBaseUrl) {
    options.log?.('[nrpc-restate] Deployment auto-registration skipped: RESTATE_ADMIN_BASE_URL is missing.');
  } else if (!deploymentUri) {
    options.log?.('[nrpc-restate] Deployment auto-registration skipped: unable to resolve deployment uri.');
  } else if (componentNames.length === 0) {
    options.log?.('[nrpc-restate] Deployment auto-registration skipped: no named components discovered.');
  } else {
    options.log?.(
      `[nrpc-restate] Attempting deployment registration via ${adminBaseUrl}/deployments for uri=${deploymentUri}`,
    );
    startAutoRegistration({
      adminBaseUrl,
      deploymentUri,
      serviceNames: componentNames,
      forceReRegister: options.forceReRegister,
      deploymentRetryIntervalFactor: options.deploymentRetryIntervalFactor,
      deploymentMaxRetryAttempts: options.deploymentMaxRetryAttempts,
      authHeader,
      log: options.log,
    });
  }

  return {
    started: true,
    serviceCount: services.length,
    ingressPath,
    handleRequest,
  };
}
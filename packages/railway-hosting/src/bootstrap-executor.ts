import type {
  RailwayBootstrapHandoffOutput,
  RailwayBootstrapLifecycleExecutor,
} from "./bootstrap-lifecycle";
import { RailwayBootstrapHandoffFetchError } from "./bootstrap-lifecycle";
import {
  RailwayGraphqlReconcileExecutor,
  RailwayReconcileExecutorError,
  type RailwayGraphqlReconcileExecutorOptions,
} from "./reconcile-executor";

const MAX_HANDOFF_BYTES = 64 * 1024;

export interface RailwayBootstrapFetchOptions {
  readonly fetch?: typeof fetch | undefined;
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  readonly attempts?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
}

function validOutput(value: unknown): value is RailwayBootstrapHandoffOutput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = [
    "logto-workbench-app-id",
    "logto-tui-app-id",
    "logto-tui-loopback-app-id",
    "logto-desktop-app-id",
    "logto-mobile-app-id",
    "logto-mobile-web-app-id",
    "logto-m2m-app-id",
    "logto-m2m-app-secret",
    "logto-resource",
  ] as const;
  return Object.keys(record).length === keys.length
    && keys.every((key) => typeof record[key] === "string" && record[key].length > 0);
}

/** Concrete transient-job adapter over the same qualified GraphQL primitive set. */
export class RailwayGraphqlBootstrapExecutor implements RailwayBootstrapLifecycleExecutor {
  readonly #resources: RailwayGraphqlReconcileExecutor;
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #attempts: number;
  readonly #requestTimeoutMs: number;

  constructor(
    options: RailwayGraphqlReconcileExecutorOptions & RailwayBootstrapFetchOptions,
  ) {
    this.#resources = new RailwayGraphqlReconcileExecutor(options);
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#attempts = options.attempts ?? 30;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.#attempts) || this.#attempts < 1 || this.#attempts > 120
      || !Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 100 || this.#requestTimeoutMs > 30_000) {
      throw new RailwayReconcileExecutorError();
    }
  }

  inventoryServices = (input: { readonly projectId: string }) => this.#resources.listServices(input);
  createService = (input: { readonly projectId: string; readonly environmentId: string; readonly name: "nautilo-bootstrap" }) => this.#resources.createService(input);
  applyServiceVariables = (input: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string; readonly variables: Readonly<Record<string, string>> }) => this.#resources.upsertVariables(input);
  inventoryDeployments = async (input: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string }) => {
    const latest = await this.#resources.getLatestDeployment(input);
    return latest === null ? [] : [latest];
  };
  observeDeployment = (input: { readonly deploymentId: string }) => this.#resources.getDeployment(input);
  deleteService = (input: { readonly serviceId: string; readonly environmentId: string }) => this.#resources.deleteService(input);
  listDomains = (input: { readonly projectId: string; readonly environmentId: string; readonly serviceId: string }) => this.#resources.listDomains(input);
  createDomain = (input: { readonly serviceId: string; readonly environmentId: string; readonly targetPort: number }) => this.#resources.createDomain(input);

  async startDeployment(input: {
    readonly projectId: string;
    readonly environmentId: string;
    readonly serviceId: string;
    readonly image: string;
    readonly variables: Readonly<Record<string, string>>;
  }) {
    // Railway resolves cross-service reference variables into the deployment
    // snapshot. Attach and observe the immutable source first, then re-apply
    // the request-memory variables before explicitly creating the deployment.
    // `serviceConnect` combines source attachment and deployment creation and
    // can race reference resolution on a freshly created transient service.
    await this.#resources.updateServiceSource(input);
    await this.#resources.upsertVariables({
      projectId: input.projectId,
      environmentId: input.environmentId,
      serviceId: input.serviceId,
      variables: input.variables,
    });
    return this.#resources.createDeployment(input);
  }

  async fetchHandoff(input: { readonly origin: string; readonly token: string }): Promise<RailwayBootstrapHandoffOutput> {
    let origin: URL;
    try {
      origin = new URL(input.origin);
    } catch {
      throw new RailwayBootstrapHandoffFetchError("client-rejected");
    }
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/"
      || origin.search || origin.hash || input.token.length < 32) {
      throw new RailwayBootstrapHandoffFetchError("client-rejected");
    }
    const url = new URL("/handoff", origin);
    for (let attempt = 0; attempt < this.#attempts; attempt += 1) {
      try {
        const response = await this.#fetch(url, {
          headers: { authorization: `Bearer ${input.token}`, accept: "application/json" },
          signal: AbortSignal.timeout(this.#requestTimeoutMs),
          redirect: "error",
        });
        if (response.ok) {
          const length = Number(response.headers.get("content-length") ?? "0");
          if (length > MAX_HANDOFF_BYTES) throw new RailwayBootstrapHandoffFetchError("response-invalid");
          const body = await response.text();
          if (Buffer.byteLength(body) > MAX_HANDOFF_BYTES) throw new RailwayBootstrapHandoffFetchError("response-invalid");
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            throw new RailwayBootstrapHandoffFetchError("response-invalid");
          }
          if (!validOutput(parsed)) throw new RailwayBootstrapHandoffFetchError("response-invalid");
          return parsed;
        }
        if (response.status === 401 || response.status === 403) {
          throw new RailwayBootstrapHandoffFetchError("authorization-rejected");
        }
        if (response.status >= 400 && response.status < 500
          && ![404, 408, 425, 429].includes(response.status)) {
          throw new RailwayBootstrapHandoffFetchError("client-rejected");
        }
      } catch (error) {
        if (error instanceof RailwayBootstrapHandoffFetchError) throw error;
      }
      if (attempt + 1 < this.#attempts) await this.#sleep(Math.min(250 * 2 ** attempt, 2_000));
    }
    throw new RailwayBootstrapHandoffFetchError("transient-exhausted");
  }
}

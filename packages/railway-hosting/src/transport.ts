import {
  RAILWAY_GRAPHQL_ENDPOINT,
  type RailwayFetch,
  type RailwayGraphqlVariables,
  type RailwayOperation,
  type RailwayOperationData,
  type RailwayOperationVariables,
  type RailwayResponseMetadata,
  type RailwayTransportFailure,
  type RailwayTransportOptions,
  type RailwayTransportResult,
} from "./types";

interface GraphqlEnvelope<Data> {
  readonly data?: Data | null | undefined;
  readonly errors?: readonly unknown[] | undefined;
}

function isGraphqlEnvelope<Data>(value: unknown): value is GraphqlEnvelope<Data> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if (!Object.hasOwn(value, "errors")) {
    return true;
  }
  return Array.isArray((value as { readonly errors?: unknown }).errors);
}

function positiveInteger(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header)) {
    return undefined;
  }

  const value = Number.parseInt(header, 10);
  return Number.isSafeInteger(value) ? value : undefined;
}

function retryAfterMilliseconds(header: string | null): number | undefined {
  if (header === null) {
    return undefined;
  }

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const timestamp = Date.parse(header);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
}

function metadata(response: Response): RailwayResponseMetadata {
  return {
    httpStatus: response.status,
    rateLimit: {
      limit: positiveInteger(response.headers.get("x-ratelimit-limit")),
      remaining: positiveInteger(response.headers.get("x-ratelimit-remaining")),
      resetAt: response.headers.get("x-ratelimit-reset") ?? undefined,
      retryAfterMs: retryAfterMilliseconds(response.headers.get("retry-after")),
    },
  };
}

function httpFailure(operation: string, response: Response): RailwayTransportFailure {
  const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
  const common = {
    operation,
    httpStatus: response.status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };

  if (response.status === 401) {
    return { kind: "authentication-required", ...common };
  }
  if (response.status === 403) {
    return { kind: "permission-denied", ...common };
  }
  if (response.status === 429) {
    return { kind: "rate-limited", ...common };
  }
  return { kind: "http-failure", ...common };
}

/**
 * Fetch-only Railway GraphQL client. There is intentionally no logging hook:
 * request headers, OAuth tokens, variable maps, and raw response payloads have
 * no observability escape hatch from this boundary.
 */
export class RailwayGraphqlTransport {
  readonly #accessToken: string;
  readonly #fetch: RailwayFetch;
  readonly #endpoint: string;

  constructor(options: RailwayTransportOptions) {
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? fetch;
    this.#endpoint = options.endpoint ?? RAILWAY_GRAPHQL_ENDPOINT;
  }

  async execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
    operation: Operation,
    variables: RailwayOperationVariables<Operation>,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: operation.document, variables }),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch {
      return {
        outcome: "failure",
        failure: { kind: "network-failure", operation: operation.name },
      };
    }

    const responseMetadata = metadata(response);
    if (!response.ok) {
      return {
        outcome: "failure",
        failure: httpFailure(operation.name, response),
        metadata: responseMetadata,
      };
    }

    let rawPayload: unknown;
    try {
      rawPayload = await response.json();
    } catch {
      return {
        outcome: "failure",
        failure: { kind: "invalid-response", operation: operation.name, httpStatus: response.status },
        metadata: responseMetadata,
      };
    }

    if (!isGraphqlEnvelope<RailwayOperationData<Operation>>(rawPayload)) {
      return {
        outcome: "failure",
        failure: { kind: "invalid-response", operation: operation.name, httpStatus: response.status },
        metadata: responseMetadata,
      };
    }
    const payload = rawPayload;

    const errorCount = payload.errors?.length ?? 0;
    if (errorCount > 0) {
      const failure: RailwayTransportFailure = {
        kind: "graphql-error",
        operation: operation.name,
        httpStatus: response.status,
        graphql: { kind: "graphql-error", count: errorCount },
      };
      if (payload.data !== undefined && payload.data !== null) {
        return { outcome: "partial", data: payload.data, failure, metadata: responseMetadata };
      }
      return { outcome: "failure", failure, metadata: responseMetadata };
    }

    if (payload.data === undefined || payload.data === null) {
      return {
        outcome: "failure",
        failure: { kind: "invalid-response", operation: operation.name, httpStatus: response.status },
        metadata: responseMetadata,
      };
    }

    return { outcome: "success", data: payload.data, metadata: responseMetadata };
  }
}

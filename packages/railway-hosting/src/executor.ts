import { spawn } from "node:child_process";

import { RailwayGraphqlTransport } from "./transport";
import type {
  RailwayFetch,
  RailwayGraphqlVariables,
  RailwayOperation,
  RailwayOperationData,
  RailwayOperationVariables,
  RailwayTransportResult,
} from "./types";

/**
 * The one transport shape consumed by Railway planning and reconciliation.
 * Implementations must execute only the pinned operation passed to them.
 */
export interface RailwayExecutorTransport {
  execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
    operation: Operation,
    variables: RailwayOperationVariables<Operation>,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>>;
}

/**
 * Direct bearer GraphQL is always the first execution path. Fallbacks are
 * deliberately separate injected transports so their authority is not mixed
 * into receipts, plans, operation variables, or this public result shape.
 */
export interface RailwayExecutorOptions {
  readonly direct: RailwayExecutorTransport;
  readonly fallbacks?: readonly RailwayExecutorTransport[] | undefined;
}

/**
 * Executes pinned Railway GraphQL operations with direct bearer authority by
 * default. Only an authorization failure on a query may enter configured
 * fallbacks. A mutation is never retried across authority boundaries: its
 * first request may have reached Railway even when the response was not
 * received. Rate limits and arbitrary transport failures do not trigger an
 * automatic second Railway request.
 */
export class RailwayExecutor implements RailwayExecutorTransport {
  readonly #direct: RailwayExecutorTransport;
  readonly #fallbacks: readonly RailwayExecutorTransport[];

  constructor(options: RailwayExecutorOptions) {
    this.#direct = options.direct;
    this.#fallbacks = options.fallbacks ?? [];
  }

  async execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
    operation: Operation,
    variables: RailwayOperationVariables<Operation>,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
    let result = await this.#direct.execute(operation, variables, options);

    if (
      operation.isMutation
      || result.outcome !== "failure"
      || (result.failure.kind !== "authentication-required" && result.failure.kind !== "permission-denied")
    ) {
      return result;
    }

    for (const fallback of this.#fallbacks) {
      result = await fallback.execute(operation, variables, options);
      if (result.outcome !== "failure") {
        return result;
      }
    }

    return result;
  }
}

export interface RailwayDirectExecutorOptions {
  /** OAuth access token held only by the direct GraphQL transport in memory. */
  readonly accessToken: string;
  readonly fetch?: RailwayFetch | undefined;
  readonly endpoint?: string | undefined;
}

/**
 * Creates the production order: direct bearer GraphQL first, then an optional
 * authenticated Railway CLI session, then an optional explicitly injected
 * break-glass token. The CLI transports never consult a linked project.
 */
export interface CreateRailwayExecutorOptions extends RailwayDirectExecutorOptions {
  readonly cliFallback?: RailwayCliExecutorOptions | undefined;
  readonly explicitTokenFallback?: RailwayExplicitTokenCliExecutorOptions | undefined;
}

export function createRailwayExecutor(options: CreateRailwayExecutorOptions): RailwayExecutor {
  const fallbacks: RailwayExecutorTransport[] = [];
  if (options.cliFallback !== undefined) {
    fallbacks.push(new RailwayCliGraphqlExecutor(options.cliFallback));
  }
  if (options.explicitTokenFallback !== undefined) {
    fallbacks.push(new RailwayCliGraphqlExecutor(options.explicitTokenFallback));
  }

  return new RailwayExecutor({
    direct: new RailwayGraphqlTransport({
      accessToken: options.accessToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    }),
    fallbacks,
  });
}

/** A runner receives the only CLI invocation shape this package permits. */
export interface RailwayCliInvocation {
  readonly binary: string;
  /** Never contains an OAuth, API, project, or provider token. */
  readonly args: readonly string[];
  /** JSON variables are sent over the child stdin pipe, never an argv flag. */
  readonly stdin: string;
  /** Private child environment overlay; values are never surfaced by this API. */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined;
  /** Cancellation is used only to bound the child process lifetime. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * This intentionally exposes only successful stdout. stderr, exit status, and
 * spawn errors can contain provider-controlled prose, so callers cannot parse
 * or persist them.
 */
export interface RailwayCliRunner {
  run(input: RailwayCliInvocation): Promise<
    | { readonly outcome: "success"; readonly stdout: string }
    | { readonly outcome: "failure" }
  >;
}

export interface RailwayCliExecutorOptions {
  readonly binary?: string | undefined;
  readonly runner?: RailwayCliRunner | undefined;
  readonly versionProbe?: RailwayCliVersionProbe | undefined;
  readonly versionPolicy?: RailwayCliVersionQualificationPolicy | undefined;
  /** Bounds each version probe and pinned GraphQL CLI invocation independently. */
  readonly timeoutMs?: number | undefined;
}

/** The Railway CLI release qualified against the pinned D488 GraphQL documents. */
export const RAILWAY_CLI_QUALIFIED_VERSION = "5.30.4";

export interface RailwayCliVersionProbe {
  probe(input: { readonly binary: string; readonly signal: AbortSignal }): Promise<string | undefined>;
}

/** A custom policy must be deliberately injected to accept another CLI release. */
export interface RailwayCliVersionQualificationPolicy {
  accepts(version: string): boolean;
}

/** A source that hands an opaque token directly to an executor's private memory. */
export interface RailwayExplicitTokenSource {
  readToken(): Promise<string | undefined>;
}

/** Railway documents these two mutually-exclusive non-interactive token variables. */
export type RailwayExplicitTokenEnvironment = "RAILWAY_API_TOKEN" | "RAILWAY_TOKEN";

export interface RailwayExplicitTokenCliExecutorOptions extends RailwayCliExecutorOptions {
  readonly tokenSource: RailwayExplicitTokenSource;
  readonly tokenEnvironment?: RailwayExplicitTokenEnvironment | undefined;
}

const RAILWAY_CLI_BINARY = "railway";
const MAX_RAILWAY_CLI_STDOUT_BYTES = 1_048_576;
const MAX_EXPLICIT_TOKEN_BYTES = 16_384;
const DEFAULT_RAILWAY_CLI_TIMEOUT_MS = 15_000;

function cliMetadata() {
  return { httpStatus: 200, rateLimit: {} };
}

function cliFailure<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
  operation: Operation,
): RailwayTransportResult<RailwayOperationData<Operation>> {
  // A non-zero CLI invocation has no safe, documented structured failure body.
  // Reuse the existing transport's opaque network-failure category rather than
  // parsing CLI prose or retaining stderr.
  return {
    outcome: "failure",
    failure: { kind: "network-failure", operation: operation.name },
  };
}

interface GraphqlEnvelope<Data> {
  readonly data?: Data | null | undefined;
  readonly errors?: readonly unknown[] | undefined;
}

function isGraphqlEnvelope<Data>(value: unknown): value is GraphqlEnvelope<Data> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return !Object.hasOwn(value, "errors") || Array.isArray((value as { readonly errors?: unknown }).errors);
}

function parseCliGraphqlResult<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
  operation: Operation,
  stdout: string,
): RailwayTransportResult<RailwayOperationData<Operation>> {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return {
      outcome: "failure",
      failure: { kind: "invalid-response", operation: operation.name, httpStatus: 200 },
      metadata: cliMetadata(),
    };
  }

  if (!isGraphqlEnvelope<RailwayOperationData<Operation>>(payload)) {
    return {
      outcome: "failure",
      failure: { kind: "invalid-response", operation: operation.name, httpStatus: 200 },
      metadata: cliMetadata(),
    };
  }

  const errorCount = payload.errors?.length ?? 0;
  if (errorCount > 0) {
    const failure = {
      kind: "graphql-error" as const,
      operation: operation.name,
      httpStatus: 200,
      graphql: { kind: "graphql-error" as const, count: errorCount },
    };
    if (payload.data !== undefined && payload.data !== null) {
      return { outcome: "partial", data: payload.data, failure, metadata: cliMetadata() };
    }
    return { outcome: "failure", failure, metadata: cliMetadata() };
  }

  if (payload.data === undefined || payload.data === null) {
    return {
      outcome: "failure",
      failure: { kind: "invalid-response", operation: operation.name, httpStatus: 200 },
      metadata: cliMetadata(),
    };
  }

  return { outcome: "success", data: payload.data, metadata: cliMetadata() };
}

function childEnvironment(
  overlay: Readonly<Record<string, string | undefined>> | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  if (overlay === undefined) return environment;

  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) {
      delete environment[key];
    } else {
      environment[key] = value;
    }
  }
  return environment;
}

/**
 * The production runner intentionally exposes no shell, command expansion,
 * stderr, or arbitrary Railway command surface. Its only callers issue either
 * the exact documented `railway --version` qualification probe or the fixed
 * `railway api` layout supplied by RailwayCliGraphqlExecutor.
 */
export const railwayCliRunner: RailwayCliRunner = {
  run(input) {
    return new Promise((resolve) => {
      let settled = false;
      let stdoutBytes = 0;
      const stdoutChunks: Uint8Array[] = [];
      let removeAbortListener: (() => void) | undefined;
      const finish = (result: { readonly outcome: "success"; readonly stdout: string } | { readonly outcome: "failure" }) => {
        if (settled) return;
        settled = true;
        removeAbortListener?.();
        resolve(result);
      };

      if (input.signal?.aborted) {
        finish({ outcome: "failure" });
        return;
      }

      let child;
      try {
        child = spawn(input.binary, input.args, {
          env: childEnvironment(input.environment),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          stdio: ["pipe", "pipe", "ignore"],
        });
      } catch {
        finish({ outcome: "failure" });
        return;
      }

      if (input.signal !== undefined) {
        const abort = () => {
          // AbortController asks Node to terminate the child. SIGKILL closes
          // the remaining hang window if a CLI subprocess ignores SIGTERM.
          child.kill("SIGKILL");
          finish({ outcome: "failure" });
        };
        input.signal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => input.signal?.removeEventListener("abort", abort);
      }

      child.once("error", () => finish({ outcome: "failure" }));
      child.stdout.on("data", (chunk: Uint8Array) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_RAILWAY_CLI_STDOUT_BYTES) {
          child.kill("SIGKILL");
          finish({ outcome: "failure" });
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.once("close", (code) => {
        if (code !== 0 || stdoutBytes > MAX_RAILWAY_CLI_STDOUT_BYTES) {
          finish({ outcome: "failure" });
          return;
        }
        try {
          const stdoutBytesView = new Uint8Array(stdoutBytes);
          let offset = 0;
          for (const chunk of stdoutChunks) {
            stdoutBytesView.set(chunk, offset);
            offset += chunk.byteLength;
          }
          finish({ outcome: "success", stdout: new TextDecoder("utf-8", { fatal: true }).decode(stdoutBytesView) });
        } catch {
          finish({ outcome: "failure" });
        }
      });
      child.stdin.once("error", () => finish({ outcome: "failure" }));
      child.stdin.end(input.stdin);
    });
  },
};

/**
 * `railway --version` is a documented, fixed-format CLI capability check.
 * This is intentionally exact matching, not parsing a human status message.
 */
export const railwayCliVersionProbe: RailwayCliVersionProbe = {
  async probe(input) {
    const result = await railwayCliRunner.run({
      binary: input.binary,
      args: ["--version"],
      stdin: "",
      signal: input.signal,
    });
    if (result.outcome !== "success") return undefined;
    const match = /^railway ([0-9]+\.[0-9]+\.[0-9]+)\r?\n?$/.exec(result.stdout);
    return match?.[1];
  },
};

export const railwayCliVersionQualification: RailwayCliVersionQualificationPolicy = {
  accepts(version) {
    return version === RAILWAY_CLI_QUALIFIED_VERSION;
  },
};

function isExplicitToken(value: string): boolean {
  return value.length > 0 && [...value].every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint > 0x20 && codePoint !== 0x7f;
  });
}

/**
 * Reads one opaque token from an injected stdin-like byte stream. It accepts a
 * single optional terminal newline and rejects extra records, whitespace, or
 * malformed UTF-8. The token is never returned from an execution result.
 */
export function createRailwayStdinTokenSource(
  stdin: AsyncIterable<Uint8Array | string>,
): RailwayExplicitTokenSource {
  let consumed = false;

  return {
    async readToken(): Promise<string | undefined> {
      if (consumed) return undefined;
      consumed = true;

      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for await (const chunk of stdin) {
          const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
          length += bytes.byteLength;
          if (length > MAX_EXPLICIT_TOKEN_BYTES) return undefined;
          chunks.push(bytes);
        }

        const all = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          all.set(chunk, offset);
          offset += chunk.byteLength;
        }
        let token = new TextDecoder("utf-8", { fatal: true }).decode(all);
        if (token.endsWith("\r\n")) {
          token = token.slice(0, -2);
        } else if (token.endsWith("\n")) {
          token = token.slice(0, -1);
        }
        return isExplicitToken(token) ? token : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Narrow adapter for the documented `railway api` JSON interface. The pinned
 * operation document is positional because stdin is reserved for JSON
 * variables (`--variables @-`); no linked project, general CLI command, or
 * human-readable output is consulted.
 */
export class RailwayCliGraphqlExecutor implements RailwayExecutorTransport {
  readonly #binary: string;
  readonly #runner: RailwayCliRunner;
  readonly #tokenSource: RailwayExplicitTokenSource | undefined;
  readonly #tokenEnvironment: RailwayExplicitTokenEnvironment;
  readonly #versionProbe: RailwayCliVersionProbe;
  readonly #versionPolicy: RailwayCliVersionQualificationPolicy;
  readonly #timeoutMs: number;
  #tokenRead = false;
  #token: string | undefined;

  constructor(options: RailwayCliExecutorOptions | RailwayExplicitTokenCliExecutorOptions = {}) {
    this.#binary = options.binary ?? RAILWAY_CLI_BINARY;
    this.#runner = options.runner ?? railwayCliRunner;
    this.#tokenSource = "tokenSource" in options ? options.tokenSource : undefined;
    this.#tokenEnvironment = "tokenEnvironment" in options && options.tokenEnvironment !== undefined
      ? options.tokenEnvironment
      : "RAILWAY_API_TOKEN";
    this.#versionProbe = options.versionProbe ?? railwayCliVersionProbe;
    this.#versionPolicy = options.versionPolicy ?? railwayCliVersionQualification;
    this.#timeoutMs = validTimeout(options.timeoutMs) ? options.timeoutMs : DEFAULT_RAILWAY_CLI_TIMEOUT_MS;
  }

  async execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
    operation: Operation,
    variables: RailwayOperationVariables<Operation>,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
    let stdin: string;
    try {
      stdin = JSON.stringify(variables);
    } catch {
      return cliFailure(operation);
    }

    const version = await this.#bounded((signal) => this.#versionProbe.probe({ binary: this.#binary, signal }), options?.signal);
    if (version === undefined || !this.#versionPolicy.accepts(version)) return cliFailure(operation);

    const environment = await this.#explicitTokenEnvironment();
    if (environment === null) return cliFailure(operation);

    const result = await this.#bounded((signal) => this.#runner.run({
        binary: this.#binary,
        args: [
          "api",
          operation.document,
          "--operation-name",
          operation.name,
          "--variables",
          "@-",
          "--compact",
          "--allow-errors",
        ],
        stdin,
        ...(environment === undefined ? {} : { environment }),
        signal,
      }), options?.signal);
    if (result === undefined) return cliFailure(operation);

    return result.outcome === "success"
      ? parseCliGraphqlResult(operation, result.stdout)
      : cliFailure(operation);
  }

  async #explicitTokenEnvironment(): Promise<Readonly<Record<string, string | undefined>> | undefined | null> {
    if (this.#tokenSource === undefined) return undefined;

    if (!this.#tokenRead) {
      this.#tokenRead = true;
      try {
        this.#token = await this.#tokenSource.readToken();
      } catch {
        this.#token = undefined;
      }
    }
    if (this.#token === undefined) return null;

    return {
      RAILWAY_API_TOKEN: this.#tokenEnvironment === "RAILWAY_API_TOKEN" ? this.#token : undefined,
      RAILWAY_TOKEN: this.#tokenEnvironment === "RAILWAY_TOKEN" ? this.#token : undefined,
    };
  }

  async #bounded<Result>(operation: (signal: AbortSignal) => Promise<Result>, external?: AbortSignal): Promise<Result | undefined> {
    const controller = new AbortController();
    if (external?.aborted) return undefined;
    const abort = () => controller.abort();
    external?.addEventListener("abort", abort, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<undefined>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(undefined);
      }, this.#timeoutMs);
    });

    try {
      return await Promise.race([operation(controller.signal).catch(() => undefined), timedOut]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      external?.removeEventListener("abort", abort);
    }
  }
}

function validTimeout(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

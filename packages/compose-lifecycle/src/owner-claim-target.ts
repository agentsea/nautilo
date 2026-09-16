const OWNER_CLAIM_SCHEMA_VERSION = 1 as const;
const MAX_RESPONSE_BYTES = 16 * 1024;

export type OwnerClaimControllerFailure =
  | "unreachable"
  | "timeout"
  | "authorization-rejected"
  | "contract-rejected"
  | "invalid-response"
  | "ambiguous-write";

export class OwnerClaimControllerError extends Error {
  constructor(readonly failure: OwnerClaimControllerFailure) {
    super(failure);
    this.name = "OwnerClaimControllerError";
  }
}

export type OwnerClaimState = "awaiting-owner" | "claim-active" | "owner-bound";
export interface OwnerClaimTargetStatus {
  readonly schemaVersion: typeof OWNER_CLAIM_SCHEMA_VERSION;
  readonly state: OwnerClaimState;
}
export interface OwnerClaimTarget {
  status(input: { readonly targetUrl: string }): Promise<OwnerClaimTargetStatus>;
  install(input: {
    readonly targetUrl: string;
    readonly authorization:
      | { readonly kind: "bearer"; readonly token: string }
      | { readonly kind: "trusted-loopback" };
    readonly claimHash: string;
    readonly expiresAt: string;
  }): Promise<OwnerClaimTargetStatus>;
}

export interface OwnerClaimTargetTransportPolicy {
  readonly validateTargetUrl: (value: string) => URL;
  readonly timeoutMs?: number;
}
export interface CreateOwnerClaimTargetOptions {
  readonly transport: OwnerClaimTargetTransportPolicy;
  readonly fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export function createOwnerClaimTarget(options: CreateOwnerClaimTargetOptions): OwnerClaimTarget {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.transport.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Owner claim timeout is invalid");
  return {
    async status(input) {
      const target = options.transport.validateTargetUrl(input.targetUrl);
      let response: Response;
      try {
        response = await fetchImpl(new URL("/api/setup/owner-claim/status", target), {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new OwnerClaimControllerError(timeoutFailure(error) ? "timeout" : "unreachable");
      }
      if (!response.ok) throw readFailure(response);
      return parseStatus(await bodyJson(response));
    },
    async install(input) {
      const target = options.transport.validateTargetUrl(input.targetUrl);
      assertInstallTarget(target, input.authorization);
      const expiresAt = new Date(input.expiresAt);
      if (
        !/^[a-f0-9]{64}$/.test(input.claimHash) ||
        !Number.isFinite(expiresAt.valueOf()) ||
        expiresAt.toISOString() !== input.expiresAt ||
        (input.authorization.kind === "bearer" && input.authorization.token.length < 32)
      ) {
        throw new Error("Owner claim installation is invalid");
      }
      let response: Response;
      try {
        response = await fetchImpl(new URL("/api/setup/owner-claim", target), {
          method: "PUT",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            ...(input.authorization.kind === "bearer"
              ? { Authorization: `Bearer ${input.authorization.token}` }
              : {}),
          },
          body: JSON.stringify({
            schemaVersion: OWNER_CLAIM_SCHEMA_VERSION,
            claimHash: input.claimHash,
            expiresAt: input.expiresAt,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new OwnerClaimControllerError("ambiguous-write");
      }
      if (!response.ok) throw writeFailure(response);
      return parseStatus(await bodyJson(response));
    },
  };
}

function assertInstallTarget(
  target: URL,
  authorization: { readonly kind: "bearer"; readonly token: string } | { readonly kind: "trusted-loopback" },
): void {
  const loopback =
    target.protocol === "http:" &&
    (target.hostname === "127.0.0.1" || target.hostname === "localhost" || target.hostname === "[::1]");
  if (authorization.kind === "trusted-loopback" && !loopback) {
    throw new Error("Trusted owner claim installation requires an exact HTTP loopback target");
  }
  if (authorization.kind === "bearer" && target.protocol !== "https:" && !loopback) {
    throw new Error("Bearer owner claim installation requires HTTPS or exact HTTP loopback");
  }
}

function timeoutFailure(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "TimeoutError") ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

function readFailure(response: Response): OwnerClaimControllerError {
  return new OwnerClaimControllerError(
    response.status === 401 || response.status === 403
      ? "authorization-rejected"
      : response.status >= 400 && response.status < 500
        ? "contract-rejected"
        : "unreachable",
  );
}

function writeFailure(response: Response): OwnerClaimControllerError {
  return new OwnerClaimControllerError(
    response.status === 401 || response.status === 403
      ? "authorization-rejected"
      : response.status >= 400 && response.status < 500
        ? "contract-rejected"
        : "ambiguous-write",
  );
}

function parseStatus(value: unknown): OwnerClaimTargetStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OwnerClaimControllerError("invalid-response");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !== ["schemaVersion", "state"].join("\0") ||
    record["schemaVersion"] !== OWNER_CLAIM_SCHEMA_VERSION ||
    !["awaiting-owner", "claim-active", "owner-bound"].includes(String(record["state"]))
  ) {
    throw new OwnerClaimControllerError("invalid-response");
  }
  return record as unknown as OwnerClaimTargetStatus;
}

async function bodyJson(response: Response): Promise<unknown> {
  let body: string;
  try {
    body = await response.text();
  } catch {
    throw new OwnerClaimControllerError("invalid-response");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    throw new OwnerClaimControllerError("invalid-response");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new OwnerClaimControllerError("invalid-response");
  }
}

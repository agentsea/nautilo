import type {
  ConnectionProxyResponse,
  ConnectionProxyRequest,
  ToolConnectionRequirement,
} from "@nautilo/types";
import type { ToolContext } from "@nautilo/catalog";

const STRIPPED_PROXY_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

export interface BuildConnectionProxyRequestInput {
  readonly requirement: ToolConnectionRequirement;
  readonly url: string;
  readonly method?: ConnectionProxyRequest["method"] | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
}

export interface BuiltConnectionProxyRequest {
  readonly service: string;
  readonly request: ConnectionProxyRequest;
}

export interface ConnectionProxyDispatchContext {
  readonly actorId?: string | null | undefined;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly memoryAccessEnvelope?: {
    readonly agentId?: string | undefined;
    readonly readableNamespaces?: readonly string[] | undefined;
    readonly writableNamespaces?: readonly string[] | undefined;
  } | null | undefined;
}

export function connectionProxyContextFromToolContext(
  context?: ToolContext,
): ConnectionProxyDispatchContext {
  const meta = context?.["securityAuditClientMeta"] as
    | { ip?: string; userAgent?: string }
    | null
    | undefined;
  return {
    actorId: typeof context?.["auditActorId"] === "string" ? context["auditActorId"] : null,
    ip: typeof meta?.ip === "string" ? meta.ip : "internal",
    userAgent: typeof meta?.userAgent === "string" ? meta.userAgent : undefined,
    memoryAccessEnvelope: context?.["memoryAccessEnvelope"] as ConnectionProxyDispatchContext["memoryAccessEnvelope"],
  };
}

export interface ConnectionProxyDispatchInput extends BuiltConnectionProxyRequest {
  readonly context?: ConnectionProxyDispatchContext | undefined;
}

export type ConnectionProxyDispatcher = (
  input: ConnectionProxyDispatchInput,
) => Promise<ConnectionProxyResponse>;

let activeConnectionProxyDispatcher: ConnectionProxyDispatcher | null = null;

export function setConnectionProxyDispatcher(
  dispatcher: ConnectionProxyDispatcher | null,
): void {
  activeConnectionProxyDispatcher = dispatcher;
}

export function getConnectionProxyDispatcher(): ConnectionProxyDispatcher | null {
  return activeConnectionProxyDispatcher;
}

export async function dispatchConnectionProxyRequest(
  input: ConnectionProxyDispatchInput,
): Promise<ConnectionProxyResponse> {
  if (!activeConnectionProxyDispatcher) {
    throw new Error("Connection proxy dispatcher is not configured");
  }
  return activeConnectionProxyDispatcher(input);
}

function cleanProxyHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const normalized = key.toLowerCase();
    if (
      STRIPPED_PROXY_HEADER_NAMES.has(normalized) ||
      normalized.startsWith("x-nautilo-connection")
    ) {
      continue;
    }
    cleaned[key] = value;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

/**
 * Builds the model-safe request envelope for the server-owned Connection proxy.
 * It carries only metadata and caller payload; the raw Connection value is
 * resolved server-side after session/scope validation.
 */
export function buildConnectionProxyRequest(
  input: BuildConnectionProxyRequestInput,
): BuiltConnectionProxyRequest {
  const { requirement } = input;
  if (requirement.category !== "user") {
    throw new Error("Connection proxy requests require a user-scoped Connection");
  }
  return {
    service: requirement.service,
    request: {
      field: requirement.field,
      url: input.url,
      method: input.method,
      category: "user",
      authShape: requirement.authShape,
      headers: cleanProxyHeaders(input.headers),
      body: input.body,
    },
  };
}

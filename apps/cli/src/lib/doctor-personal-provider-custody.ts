import type { CliSessionV1Payload } from "@nautilo/api-client";
import { z } from "zod";
import {
  requireSessionForActiveProfile,
} from "./cli-session.ts";
import {
  sessionTargetBindingFor,
} from "./authenticated-admin-client.ts";
import {
  buildAuthHeaders,
  transportFetch,
  type ResolvedServer,
} from "./profile-aware-server.ts";

const custodyErrorCodeSchema = z.enum([
  "custody_missing",
  "custody_invalid",
  "custody_unavailable",
  "custody_key_mismatch",
  "credential_invalid",
  "credential_authentication_failed",
]);

const custodyStatusSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    recordsExist: z.boolean(),
    keyId: z.uuid(),
  }).strict(),
  z.object({
    status: z.literal("degraded"),
    recordsExist: z.literal(true),
    keyId: z.uuid(),
    code: z.literal("credential_reenrollment_required"),
  }).strict(),
  z.object({
    status: z.literal("unavailable"),
    recordsExist: z.boolean().nullable(),
    keyId: z.uuid().optional(),
    code: custodyErrorCodeSchema,
  }).strict(),
]);

type CustodyStatus = z.infer<typeof custodyStatusSchema>;

export type PersonalProviderCustodyDoctorResult =
  | CustodyStatus
  | Readonly<{
      status: "denied" | "unreachable" | "invalid_response" | "redirect_rejected" | "target_mismatch";
    }>;

type CustodyFetch = (
  transport: ResolvedServer,
  path: string,
  init: RequestInit,
) => Promise<Response>;

export interface PersonalProviderCustodyDoctorDependencies {
  readonly fetch?: CustodyFetch;
  readonly loadSession?: () => Promise<CliSessionV1Payload>;
  readonly resolveTargetBinding?: typeof sessionTargetBindingFor;
}

export class PersonalProviderCustodyTargetMismatchError extends Error {
  constructor() {
    super("The saved session belongs to a different server target.");
    this.name = "PersonalProviderCustodyTargetMismatchError";
  }
}

function isLoopbackHttp(transport: ResolvedServer): boolean {
  if (transport.unixSocketPath !== undefined) return true;
  try {
    const url = new URL(transport.baseUrl);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

/**
 * Load the canonical Human session only when the endpoint cannot rely on its
 * existing loopback/Unix-socket operator authority. The persisted target must
 * match exactly before its bearer can be sent.
 */
export async function resolvePersonalProviderCustodyBearer(
  transport: ResolvedServer,
  dependencies: PersonalProviderCustodyDoctorDependencies = {},
): Promise<string | undefined> {
  if (isLoopbackHttp(transport)) return undefined;

  const loadSession = dependencies.loadSession ?? requireSessionForActiveProfile;
  const resolveTargetBinding = dependencies.resolveTargetBinding ?? sessionTargetBindingFor;
  const session = await loadSession();
  let selectedBinding: Awaited<ReturnType<typeof sessionTargetBindingFor>>;
  try {
    selectedBinding = await resolveTargetBinding(transport);
  } catch {
    throw new PersonalProviderCustodyTargetMismatchError();
  }
  if (
    session.targetBinding?.kind !== selectedBinding.kind
    || session.targetBinding.value !== selectedBinding.value
  ) {
    throw new PersonalProviderCustodyTargetMismatchError();
  }
  return session.accessToken;
}

/** Read-only, content-free custody inspection over the canonical CLI transport. */
export async function inspectPersonalProviderCustody(
  transport: ResolvedServer,
  sessionBearer?: string,
  dependencies: PersonalProviderCustodyDoctorDependencies = {},
): Promise<PersonalProviderCustodyDoctorResult> {
  const fetchImpl = dependencies.fetch ?? transportFetch;
  let response: Response;
  try {
    response = await fetchImpl(
      transport,
      "/api/health/personal-provider-custody",
      {
        method: "GET",
        headers: buildAuthHeaders(transport, sessionBearer),
        redirect: "manual",
      },
    );
  } catch {
    return { status: "unreachable" };
  }

  if (response.status === 401 || response.status === 403) return { status: "denied" };
  if (response.status >= 300 && response.status < 400) return { status: "redirect_rejected" };
  if (!response.ok) return { status: "unreachable" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "invalid_response" };
  }
  const parsed = custodyStatusSchema.safeParse(body);
  return parsed.success ? parsed.data : { status: "invalid_response" };
}

function recordsLabel(recordsExist: boolean | null | undefined): "present" | "none" | "unknown" {
  if (recordsExist === true) return "present";
  if (recordsExist === false) return "none";
  return "unknown";
}

/** Fixed strings only: server bodies and thrown error messages never enter output. */
export function formatPersonalProviderCustodyDoctorResult(
  result: PersonalProviderCustodyDoctorResult,
): readonly string[] {
  if (result.status === "ready") {
    return [
      `doctor personal-provider-custody: status=ready records=${recordsLabel(result.recordsExist)} keyId=${result.keyId}`,
      result.recordsExist
        ? "Stored personal provider credentials are readable with the configured custody key."
        : "Custody is ready; no personal provider credentials are stored.",
    ];
  }
  if (result.status === "degraded") {
    return [
      `doctor personal-provider-custody: status=degraded records=present keyId=${result.keyId} code=${result.code}`,
      "Re-enroll the affected personal provider credentials before they are used again.",
    ];
  }
  if (result.status === "unavailable") {
    return [
      `doctor personal-provider-custody: status=unavailable records=${recordsLabel(result.recordsExist)}${result.keyId ? ` keyId=${result.keyId}` : ""} code=${result.code}`,
      result.code === "custody_key_mismatch"
        ? "Restore the matching custody material or re-enroll personal provider credentials through the supported recovery workflow."
        : "Inspect the server custody configuration and supported backup or restore workflow before retrying.",
    ];
  }
  const guidance: Record<typeof result.status, string> = {
    denied: "Sign in as an owner for the selected profile, or run the check on the server host.",
    unreachable: "Verify the selected server or profile transport and retry.",
    invalid_response: "Verify that the selected server version supports this custody diagnostic and retry.",
    redirect_rejected: "Select the server's canonical origin or profile and retry; authenticated redirects are not followed.",
    target_mismatch: "Select the profile that owns the saved session, or sign in to the selected server and retry.",
  };
  return [
    `doctor personal-provider-custody: status=${result.status} records=unknown`,
    guidance[result.status],
  ];
}

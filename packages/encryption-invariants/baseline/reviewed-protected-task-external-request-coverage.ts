import type { EncryptionCoverageEntry } from "../src/model";

const REVIEW = "packages/encryption-invariants/tests/integration/reviewed-protected-task-external-request-coverage.test.ts";
const ROUTE_EVIDENCE = [
  REVIEW,
  "packages/server/tests/unit/protected-task-external-request-routes.test.ts",
  "packages/server/tests/unit/protected-task-external-requests.test.ts",
  "packages/server/tests/unit/protected-task-external-request-authority.test.ts",
  "packages/api-client/tests/unit/protected-task-external-request-schemas.test.ts",
] as const;
const common = {
  surface: "wire" as const,
  owner: "packages/server",
  readers: ["packages/api-client", "apps/workbench"],
  writers: ["packages/server", "packages/api-client"],
  retention: "Private no-store HTTP operation only. The process-local provider request and response capability expire with the original execution grant, abort, device/session invalidation or shutdown; no durable request, ordinary transcript or plaintext broadcast is created.",
  testEvidence: ROUTE_EVIDENCE,
};

export const REVIEWED_PROTECTED_TASK_EXTERNAL_REQUEST_COVERAGE:
  readonly EncryptionCoverageEntry[] = [
    {
      ...common,
      id: "wire.protected-task-external-request.list",
      locator: "http:request_response:POST /api/tasks/external-requests",
      classification: "bounded_metadata",
      migrationState: "not_applicable",
      metadataAllowlist: ["clientActionSessionId", "authorizationDeviceId", "status", "requests[].requestId", "requests[].taskId", "requests[].taskRunId", "requests[].jobId", "requests[].roomId", "requests[].ownerId", "requests[].state"],
      plaintextReason: "Closed live-request coordinates and availability only, after current requester, Human, device, client session, execution and Namespace inspection. Provider questions, tool arguments and responses are absent.",
    },
    {
      ...common,
      id: "wire.protected-task-external-request.plan",
      locator: "http:request_response:POST /api/tasks/external-requests/plan",
      classification: "bounded_metadata",
      migrationState: "not_applicable",
      metadataAllowlist: ["clientActionSessionId", "authorizationDeviceId", "requestId", "status", "challengeId", "roomId", "deadlineAt", "requestDeadlineAt", "authorizationPlanBytesBase64url", "recipientPublicKeyBase64url"],
      plaintextReason: "Closed coordinates, deadlines, a public decrypt-only Domain authorization plan and ephemeral recipient public key. These are public challenge metadata, not provider request content or private key material; the challenge is bound to the current device/session and original execution deadline.",
    },
    ...["read", "respond"].map(action => ({
      ...common,
      id: `wire.protected-task-external-request.${action}`,
      locator: `http:request_response:POST /api/tasks/external-requests/${action}`,
      classification: "protected" as const,
      migrationState: "ciphertext_reading" as const,
      keyFamily: "namespace_ai" as const,
      bridgeRepository: "packages/lattice-bridge/src/server/delivery/postgres-domain-key-authority.ts",
      retention: `${common.retention} Read returns sensitive provider question/tool data only after the signed device challenge opens current Domain custody. Respond carries sensitive Human answers or approval data through a one-use capability bound to that read and its exact snapshot; consumption precedes any await and current invocation, claim and provider authority are rechecked. Payloads are transient plaintext at the authorized endpoints, not metadata or persisted ciphertext.`,
      negativeTestEvidence: ROUTE_EVIDENCE,
    })),
    {
      ...common,
      id: "wire.protected-task-external-request.changed",
      locator: "ws:server_to_client:task.external_request.changed",
      classification: "bounded_metadata",
      migrationState: "not_applicable",
      readers: ["apps/workbench"],
      writers: ["packages/server"],
      retention: "Owner-only realtime availability hint; no provider request or response payload is broadcast.",
      metadataAllowlist: ["type", "ownerId", "requestId", "taskId", "taskRunId", "jobId", "roomId", "state"],
      plaintextReason: "Only closed request/Task/Run/Job/Room/owner identifiers and available/unavailable state. The WebSocket publisher routes to the exact owner or nobody, never the Room audience; private content requires the signed read route.",
      testEvidence: [REVIEW, "packages/server/tests/unit/task-external-request-audience.test.ts", ...ROUTE_EVIDENCE.slice(1)],
    },
  ];

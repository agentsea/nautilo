import type { DtoDeclaration } from "../src/node/dto-inventory";
import type { EncryptionCoverageEntry } from "../src/model";

const storage = "packages/db/src/queries/chatgpt-registrations.ts";
const custody = "packages/server/src/lib/chatgpt-plan/session-store.ts";
const routes = "packages/server/src/routes/chatgpt-plan.ts";
const evidence = ["packages/server/tests/unit/chatgpt-plan/session-store.test.ts", "packages/server/tests/unit/chatgpt-plan/routes.test.ts"];
const metadata = ["id", "user_id", "client_id", "server_instance_id", "host_id", "authority_revision", "token_generation", "selected", "state", "created_at", "updated_at"];

/** Server custody is intentionally operator readable; it is not namespace E2EE. */
export const REVIEWED_CHATGPT_PLAN_COVERAGE: readonly EncryptionCoverageEntry[] = [
  ...["public.chatgpt_registrations", "public.chatgpt_registrations.envelope", "public.chatgpt_registrations.identity_envelope"].map(locator => ({
    id: `chatgpt-plan.${locator}`, surface: "db" as const, locator, owner: "packages/server",
    readers: [storage, custody], writers: [storage, custody], migrationState: "not_applicable" as const,
    retention: "Tokens are cleared on disconnect or uncertain refresh. Registration identity remains for explicit reconnect; Human deletion cascades all rows.",
    testEvidence: evidence, classification: "operator_secret" as const,
    secretStoreLocation: "Authenticated personal-provider custody envelopes in chatgpt_registrations; the operator-held custody key remains outside this table.",
    backupProcedure: "Back up database and operator custody according to the existing personal-provider procedure. QA clone rebind strips registrations. Cross-instance reuse is rejected; same-instance restore qualification remains required before release.",
    excludedFromAgentGrants: true as const,
  })),
  ...metadata.map(field => ({
    id: `chatgpt-plan.metadata.${field}`, surface: "db" as const, locator: `public.chatgpt_registrations.${field}`, owner: "packages/server",
    readers: [storage, custody], writers: [storage, custody], migrationState: "not_applicable" as const,
    retention: "Retained with the Human-owned registration until Human deletion.", testEvidence: evidence,
    classification: "bounded_metadata" as const, metadataAllowlist: metadata,
    plaintextReason: "Identifiers, revision counters, lifecycle state and timestamps support ownership and refresh fencing. Subject/email and all OAuth tokens are encrypted separately; the public OAuth client ID is not a client secret.",
  })),
  ...["GET /api/account/chatgpt", "POST /api/account/chatgpt/sign-in", "GET /api/account/chatgpt/sign-in/:id", "DELETE /api/account/chatgpt/sign-in/:id", "PUT /api/account/chatgpt/selection", "GET /api/account/chatgpt/:id/models", "POST /api/account/chatgpt/:id/disconnect"].map((route, index) => ({
    id: `chatgpt-plan.http.${index + 1}`, surface: "wire" as const, locator: `http:request_response:${route}`, owner: "packages/server",
    readers: [routes, "apps/workbench/src/pages/settings/sections/chatgpt-plan-section.tsx"], writers: [routes], migrationState: "not_applicable" as const,
    retention: "No route request/response logging; sign-in results expire and the UI releases its authorization URL after completion or cancellation.",
    testEvidence: evidence, classification: "operator_secret" as const,
    secretStoreLocation: "Authenticated account-management transport. Authorization URL includes ephemeral state and PKCE challenge, never verifier or tokens. Account label is disclosed only to the authenticated owning Human.",
    backupProcedure: "No authorization attempt or HTTP response is included in backups; persisted credentials follow the separate custody envelope procedure.",
    excludedFromAgentGrants: true as const,
  })),
];

/** Exact account DTO shapes; no OAuth bearer or refresh token crosses this surface. */
export const CHATGPT_PLAN_DTO_DECLARATIONS: readonly DtoDeclaration[] = [
  {
    "observationId": "wire.http.request.response.delete.api.account.chatgpt.sign.in.id.a1tsec",
    "locator": "http:request_response:DELETE /api/account/chatgpt/sign-in/:id",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:void",
      "response.body:{ok:boolean}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.account.chatgpt.id.models.1s9wl3o",
    "locator": "http:request_response:GET /api/account/chatgpt/:id/models",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:void",
      "response.body:{models:{id:string;name:string}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.account.chatgpt.rcp8pp",
    "locator": "http:request_response:GET /api/account/chatgpt",
    "structuralSignatures": [
      "response.body:void",
      "response.body:{accounts:{id:string;label:string;registrationLabel:string;revision:number;selected:boolean;state:\"connected\"|\"disconnected\"|\"reconnect_required\"}[];canEnroll:boolean;enabled:boolean}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.account.chatgpt.sign.in.id.1jkvy9d",
    "locator": "http:request_response:GET /api/account/chatgpt/sign-in/:id",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:void",
      "response.body:{code:\"authorization_denied\"|\"authorization_expired\"|\"authorization_invalid\"|\"credential_conflict\"|\"credential_unavailable\"|\"identity_invalid\"|\"model_unavailable\"|\"plan_permission_missing\"|\"provider_unavailable\"|\"reconnect_required\"|\"registration_incomplete\"|\"token_response_invalid\";status:\"failed\"}|{status:\"cancelled\"}|{status:\"connected\"}|{status:\"pending\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.account.chatgpt.id.disconnect.c3dycy",
    "locator": "http:request_response:POST /api/account/chatgpt/:id/disconnect",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:void",
      "response.body:{remoteRevocationConfirmed:boolean}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.account.chatgpt.sign.in.yolgjr",
    "locator": "http:request_response:POST /api/account/chatgpt/sign-in",
    "structuralSignatures": [
      "response.body:void",
      "response.body:{attemptId:`${string}-${string}-${string}-${string}-${string}`;authorizationUrl:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.put.api.account.chatgpt.selection.1h7aisv",
    "locator": "http:request_response:PUT /api/account/chatgpt/selection",
    "structuralSignatures": [
      "response.body:void",
      "response.body:{ok:true}"
    ],
    "arbitraryPayloads": []
  }
];

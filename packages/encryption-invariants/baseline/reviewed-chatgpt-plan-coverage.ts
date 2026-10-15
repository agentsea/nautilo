import type { SourceAlarmReview } from "../src/node/source-alarm-review";
import type { SourceDeclaration } from "../src/node/source-inventory";
import type { DtoDeclaration } from "../src/node/dto-inventory";
import type { EncryptionCoverageEntry } from "../src/model";

const storage = "packages/db/src/queries/chatgpt-registrations.ts";
const custody = "packages/server/src/lib/chatgpt-plan/session-store.ts";
const routes = "packages/server/src/routes/chatgpt-plan.ts";
const evidence = ["packages/server/tests/unit/chatgpt-plan/session-store.test.ts", "packages/server/tests/unit/chatgpt-plan/routes.test.ts"];
const metadata = ["id", "user_id", "client_id", "server_instance_id", "host_id", "authority_revision", "token_generation", "selected", "state", "created_at", "updated_at"];

/** Server custody is intentionally operator readable; it is not namespace E2EE. */
export const REVIEWED_CHATGPT_PLAN_COVERAGE: readonly EncryptionCoverageEntry[] = [
  { id: "chatgpt-plan.portable-custody", surface: "file", owner: "packages/server",
    locator: "packages/server/src/maintenance/portable-recovery-job.ts#restorePersonalProviderCustody",
    readers: ["packages/server/src/maintenance/portable-recovery-job.ts", "packages/operator-secrets/src/personal-provider-custody.ts"],
    writers: ["packages/server/src/maintenance/portable-recovery-job.ts"], migrationState: "not_applicable",
    retention: "Operator custody persists in instance configuration until explicit operator rotation or instance removal; the temporary file is atomically renamed and directory-synced.",
    testEvidence: ["packages/server/tests/unit/portable-recovery-job.test.ts"], classification: "operator_secret", excludedFromAgentGrants: true,
    secretStoreLocation: "The recovered operator custody key is plaintext in config/instance.env under the operator instance root (directory mode 0700, file mode 0600). This is operator-readable key custody, not Human-content encryption or an agent-readable artifact. Injected, existing and bundled custody must match before installation.",
    backupProcedure: "Portable recovery authenticates the encrypted bundle before inspecting custody or mutating the target. Matching custody is required for both personal API keys and subscription envelopes; subscription rotating tokens are cleared before runtime restart.",
  },
  { id: "chatgpt-plan.restore-fence", surface: "db", owner: "packages/operator-secrets",
    locator: "bin/nautilo-dev/src/lib/docker-db.ts#restoreFromGzip:raw_sql:unresolved:unresolved.dynamic_sql:1",
    readers: ["bin/nautilo-dev/src/lib/docker-db.ts"], writers: ["packages/operator-secrets/src/personal-provider-backup.ts"],
    migrationState: "not_applicable", retention: "Renewable credentials are removed on restore; identity and selection remain until Human deletion.",
    testEvidence: ["packages/db/tests/integration/chatgpt-plan.integration.test.ts", "deploy/compose-driver/tests/unit/restore-bundle.test.ts"],
    classification: "bounded_metadata", metadataAllowlist: ["state", "token_generation", "updated_at", "envelope=NULL"],
    plaintextReason: "The imported immutable CHATGPT_RESTORE_FENCE_SQL clears the token envelope and writes only the fixed reconnect_required state, incremented generation and current timestamp. It has no caller SQL input and leaves the authenticated identity envelope unchanged. PostgreSQL fixtures verify idempotence, selection and identity retention.",
  },
  ...["packages/server/src/lib/chatgpt-plan/runtime.ts#listChatGPTModels", "packages/server/src/lib/chatgpt-plan/oauth.ts#ChatGPTOAuth"].map((locator, index) => ({
    id: `chatgpt-plan.processor.${index + 1}`, surface: "processor" as const, locator, owner: "packages/server",
    readers: ["packages/server/src/lib/chatgpt-plan/runtime.ts", "packages/server/src/lib/chatgpt-plan/oauth.ts"],
    writers: [custody], migrationState: "not_applicable" as const, retention: "Requests and provider bodies stay in request memory; only authenticated custody envelopes persist tokens and verified identity.",
    testEvidence: [...evidence, "packages/server/tests/unit/chatgpt-plan/oauth.test.ts", "packages/server/tests/unit/chatgpt-plan/models.test.ts"],
    classification: "operator_secret" as const, excludedFromAgentGrants: true as const,
    secretStoreLocation: "Server custody sends bearer tokens only to the fixed OpenAI HTTPS resource and OAuth grants only to its fixed issuer; redirects are refused. Models responses expose only eligible catalog IDs and names, and OAuth errors expose only closed codes.",
    backupProcedure: "Transient requests are not backed up. Token and registration persistence uses the separately declared encrypted custody table.",
  })),
  ...["public.chatgpt_registrations", "public.chatgpt_registrations.envelope", "public.chatgpt_registrations.identity_envelope"].map(locator => ({
    id: `chatgpt-plan.${locator}`, surface: "db" as const, locator, owner: "packages/server",
    readers: [storage, custody], writers: [storage, custody], migrationState: "not_applicable" as const,
    retention: "Tokens are cleared on disconnect or uncertain refresh. Registration identity remains for explicit reconnect; Human deletion cascades all rows.",
    testEvidence: evidence, classification: "operator_secret" as const,
    secretStoreLocation: "Authenticated personal-provider custody envelopes in chatgpt_registrations; the operator-held custody key remains outside this table.",
    backupProcedure: "Back up database and operator custody according to the existing personal-provider procedure. QA clone rebind strips registrations. Cross-instance reuse is rejected. Restore clears renewable tokens before runtime restart and requires explicit reconnect while preserving identity and selection.",
    excludedFromAgentGrants: true as const,
  })),
  ...metadata.map(field => ({
    id: `chatgpt-plan.metadata.${field}`, surface: "db" as const, locator: `public.chatgpt_registrations.${field}`, owner: "packages/server",
    readers: [storage, custody], writers: [storage, custody], migrationState: "not_applicable" as const,
    retention: "Retained with the Human-owned registration until Human deletion.", testEvidence: evidence,
    classification: "bounded_metadata" as const, metadataAllowlist: metadata,
    plaintextReason: "Identifiers, revision counters, lifecycle state and timestamps support ownership and refresh fencing. Subject/email and all OAuth tokens are encrypted separately; the public OAuth client ID is not a client secret.",
  })),
  ...["GET /api/account/chatgpt", "POST /api/account/chatgpt/sign-in", "GET /api/account/chatgpt/sign-in/:id", "DELETE /api/account/chatgpt/sign-in/:id", "PUT /api/account/chatgpt/selection", "GET /api/account/chatgpt/:id/models", "POST /api/account/chatgpt/:id/disconnect", "POST /api/account/chatgpt/sign-in/:id/complete"].map((route, index) => ({
    id: `chatgpt-plan.http.${index + 1}`, surface: "wire" as const, locator: `http:request_response:${route}`, owner: "packages/server",
    readers: [routes, "apps/workbench/src/pages/settings/sections/chatgpt-plan-section.tsx"], writers: [routes], migrationState: "not_applicable" as const,
    retention: "No route request/response logging; sign-in results expire and the UI releases its authorization URL after completion or cancellation.",
    testEvidence: evidence, classification: "operator_secret" as const,
    secretStoreLocation: "Authenticated account-management transport. Authorization URL includes ephemeral state and PKCE challenge, never verifier or tokens. Desktop completion carries only a single-use loopback code in the authenticated request body; the Server verifies PKCE and retains all tokens. Account label is disclosed only to the authenticated owning Human.",
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
      "response.body:{accounts:{id:string;label:string;pendingRegistration:boolean;registrationLabel:string;requiresReplacement:boolean;revision:number;selected:boolean;state:\"connected\"|\"disconnected\"|\"reconnect_required\"}[];canEnroll:boolean;canEnrollWithDesktop:boolean;enabled:boolean}"
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
    "observationId": "wire.http.request.response.post.api.account.chatgpt.sign.in.id.complete.elcjn7",
    "locator": "http:request_response:POST /api/account/chatgpt/sign-in/:id/complete",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:void",
      "response.body:{code:\"authorization_denied\"|\"authorization_expired\"|\"authorization_invalid\"|\"credential_conflict\"|\"credential_unavailable\"|\"identity_invalid\"|\"model_unavailable\"|\"plan_permission_missing\"|\"provider_unavailable\"|\"reconnect_required\"|\"registration_incomplete\"|\"token_response_invalid\";status:\"failed\"}|{status:\"connected\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.account.chatgpt.sign.in.yolgjr",
    "locator": "http:request_response:POST /api/account/chatgpt/sign-in",
    "structuralSignatures": [
      "response.body:void",
      "response.body:{attemptId:string;authorizationUrl:string}"
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

export const CHATGPT_PLAN_SOURCE_DECLARATIONS: readonly SourceDeclaration[] = [
  { id: "source.file.chatgpt-portable-custody", surface: "file", role: "store",
    locator: "packages/server/src/maintenance/portable-recovery-job.ts#restorePersonalProviderCustody",
    evidence: [{ path: "packages/server/src/maintenance/portable-recovery-job.ts", symbols: ["restorePersonalProviderCustody", "canonicalCustody(current) !== recovered", "await fs.writeFile(next", "await fs.rename(next, target)", "await fs.syncDirectory(configRoot)"] }] },
  { id: "source.processor.chatgpt-model-discovery", surface: "processor", role: "processor",
    locator: "packages/server/src/lib/chatgpt-plan/runtime.ts#listChatGPTModels",
    evidence: [{ path: "packages/server/src/lib/chatgpt-plan/runtime.ts", symbols: ["listChatGPTModels", 'redirect: "error"', "chatGPTSessionStore.accessToken"] }] },
  { id: "source.processor.chatgpt-oauth", surface: "processor", role: "processor",
    locator: "packages/server/src/lib/chatgpt-plan/oauth.ts#ChatGPTOAuth",
    evidence: [{ path: "packages/server/src/lib/chatgpt-plan/oauth.ts", symbols: ["ChatGPTOAuth", 'redirect: "error"', "jwtVerify", "parseChatGPTCallback"] }] },
];
export const CHATGPT_PLAN_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  { locator: "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:fdc33a22c73a3493:1", owner: "packages/server",
    closure: "declaration", declarationId: "source.file.chatgpt-portable-custody",
    reason: "The write installs the recovered operator custody secret in a mode-0600 temporary file under a mode-0700 operator configuration directory. Bundle authentication and matching custody checks precede installation. The declared operator-secret boundary explicitly permits operator readability; it does not classify the key as harmless metadata or claim end-to-end encryption. Portable recovery tests reject malformed or mismatched custody before target mutation." },
  { locator: "packages/server/src/maintenance/portable-recovery-job.ts#filesystem_write:8e6cfffeb0550793:1", owner: "packages/server",
    closure: "reviewed_exclusion", exclusionId: "exclusion.chatgpt-portable-custody-promotion",
    reason: "This atomic rename promotes exactly the temporary custody file written by the declared source.file.chatgpt-portable-custody store to instance.env in the same operator directory. It creates no separate payload or storage boundary. The file contains a plaintext operator secret, retains mode 0600, and is directory-synced; its secret classification and matching-custody tests are owned by that declaration." },
  { locator: "packages/agent/src/providers/chatgpt-plan.ts#network_processor:dc87062d04299fb3:1", owner: "packages/agent",
    closure: "declaration", declarationId: "source.processor.chat-model-factory",
    reason: "This redirect-refusing fetch implements the existing model-factory plaintext provider boundary. Explicit Human subscription admission supplies the token; the fixed OpenAI HTTPS endpoint receives the conversation and namespaced tools with store=false. This does not assert operator-blind or provider-blind inference. Adapter tests cover request destinations, terminal failures and tool replay." },
  { locator: "packages/agent/src/providers/chatgpt-plan.ts#network_processor:dfc7423d86ed3c61:1", owner: "packages/agent",
    closure: "reviewed_exclusion", exclusionId: "exclusion.chatgpt-model-constructor",
    reason: "The ChatOpenAI constructor creates the configured model wrapper and performs no network I/O itself. Its later Responses requests use the fetch call immediately above, already mapped to source.processor.chat-model-factory. This excludes a duplicate constructor alarm, not the plaintext conversation or bearer disclosure; actual SDK transport fixtures exercise that declared provider boundary." },
  { locator: "packages/server/src/lib/chatgpt-plan/runtime.ts#network_processor:9bd2a5da52a2db6f:1", owner: "packages/server",
    closure: "declaration", declarationId: "source.processor.chatgpt-model-discovery",
    reason: "This GET sends only the selected Human registration bearer to the fixed OpenAI models endpoint, refuses redirects, filters the response to executable catalog metadata and never forwards raw provider bodies or credentials to clients." },
  { locator: "packages/db/scripts/finalize-chatgpt-registrations.ts#filesystem_write:575096643882f240:1", owner: "packages/db",
    closure: "reviewed_exclusion", exclusionId: "exclusion.chatgpt-migration-grants",
    reason: "This build-time filesystem write appends static REVOKE and GRANT SQL to a generated migration. It reads no runtime database or operator configuration and writes no Human data, tokens, account identifiers or secrets. It preserves the existing migration text and makes the new table inaccessible to agent and crypto roles." },
];

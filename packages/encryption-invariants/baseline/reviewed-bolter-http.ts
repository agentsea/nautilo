import type { DtoDeclaration } from "../src/node/dto-inventory";
import type { AuthorizedPlaintextCoverageEntry } from "../src/model";
import { REVIEWED_CI_DTO_REPLACEMENTS } from "./reviewed-ci-dto";

/** Exact closed owner-facing contracts; provider labels and reviewed text are not content-free metadata. */
export const BOLTER_HTTP_PREDECESSOR_DECLARATIONS: readonly DtoDeclaration[] = [
  {
    "observationId": "wire.http.request.response.delete.api.bolter.connections.id.oh8s0r",
    "locator": "http:request_response:DELETE /api/bolter/connections/:id",
    "structuralSignatures": [
      "response.body:{canCreateRoom:boolean;device:{label:string;relayId:string};displayName:string;id:string;identity?:{label:string;providerAgentId:string};reason?:\"authentication_required\"|\"authority_changed\"|\"conflict\"|\"delivery_uncertain\"|\"desktop_offline\"|\"desktop_required\"|\"desktop_selection_required\"|\"identity_selection_required\"|\"identity_unconfirmed\"|\"invalid_request\"|\"mode_unsupported\"|\"not_found\"|\"operation_cancelled\"|\"qualification_required\"|\"receiver_unavailable\"|\"runtime_unavailable\"|\"unsupported_content\";receiver:\"listening\"|\"running\"|\"starting\"|\"stopped\";revision:number;status:\"auth_pending\"|\"connected\"|\"needs_auth\"|\"offline\"|\"paused\"|\"qualification_required\"|\"revoked\"}",
      "response.body:{code:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.bolter.bindings.id.deliveries.9obqry",
    "locator": "http:request_response:GET /api/bolter/bindings/:id/deliveries",
    "structuralSignatures": [
      "response.body:{code:string}",
      "response.body:{deliveries:{createdAt:string;messageId:number;outboxId:string;requestId:string;state:\"cancelled\"|\"pending\"|\"published\"|\"publishing\"|\"uncertain\"}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.bolter.connections.1ek2xr8",
    "locator": "http:request_response:GET /api/bolter/connections",
    "structuralSignatures": [
      "response.body:{availability:{reason?:\"authentication_required\"|\"authority_changed\"|\"conflict\"|\"delivery_uncertain\"|\"desktop_offline\"|\"desktop_required\"|\"desktop_selection_required\"|\"identity_selection_required\"|\"identity_unconfirmed\"|\"invalid_request\"|\"mode_unsupported\"|\"not_found\"|\"operation_cancelled\"|\"qualification_required\"|\"receiver_unavailable\"|\"runtime_unavailable\"|\"unsupported_content\";state:\"available\"|\"desktop_required\"|\"mode_unsupported\"|\"qualification_required\"};connections:{canCreateRoom:boolean;device:{label:string;relayId:string};displayName:string;id:string;identity?:{label:string;providerAgentId:string};reason?:\"authentication_required\"|\"authority_changed\"|\"conflict\"|\"delivery_uncertain\"|\"desktop_offline\"|\"desktop_required\"|\"desktop_selection_required\"|\"identity_selection_required\"|\"identity_unconfirmed\"|\"invalid_request\"|\"mode_unsupported\"|\"not_found\"|\"operation_cancelled\"|\"qualification_required\"|\"receiver_unavailable\"|\"runtime_unavailable\"|\"unsupported_content\";receiver:\"listening\"|\"running\"|\"starting\"|\"stopped\";revision:number;status:\"auth_pending\"|\"connected\"|\"needs_auth\"|\"offline\"|\"paused\"|\"qualification_required\"|\"revoked\"}[];desktops:{label:string;relayId:string}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.bolter.connections.id.conversations.4vc2cr",
    "locator": "http:request_response:GET /api/bolter/connections/:id/conversations",
    "structuralSignatures": [
      "response.body:{code:string}",
      "response.body:{conversations:{chatId:string;id:string;label:string;threadRootId?:string}[];reason?:\"authentication_required\"|\"authority_changed\"|\"conflict\"|\"delivery_uncertain\"|\"desktop_offline\"|\"desktop_required\"|\"desktop_selection_required\"|\"identity_selection_required\"|\"identity_unconfirmed\"|\"invalid_request\"|\"mode_unsupported\"|\"not_found\"|\"operation_cancelled\"|\"qualification_required\"|\"receiver_unavailable\"|\"runtime_unavailable\"|\"unsupported_content\";status:\"available\"|\"unavailable\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.bolter.connections.id.rooms.1nqkanb",
    "locator": "http:request_response:GET /api/bolter/connections/:id/rooms",
    "structuralSignatures": [
      "response.body:{code:string}",
      "response.body:{links:{agentId:string;canManage:boolean;canSend:boolean;chatId:string;connectionId:string;conversationLabel:string;delivery:{pending:number;uncertain:number};id:string;identityLabel:string;outboundPolicy:\"causal_replies_and_reviewed_messages\";providerAgentId:string;reason?:\"authentication_required\"|\"authority_changed\"|\"conflict\"|\"delivery_uncertain\"|\"desktop_offline\"|\"desktop_required\"|\"desktop_selection_required\"|\"identity_selection_required\"|\"identity_unconfirmed\"|\"invalid_request\"|\"mode_unsupported\"|\"not_found\"|\"operation_cancelled\"|\"qualification_required\"|\"receiver_unavailable\"|\"runtime_unavailable\"|\"unsupported_content\";receiver:\"listening\"|\"running\"|\"starting\"|\"stopped\";revision:number;roomId:string;roomName:string;status:\"active\"|\"paused\"|\"revoked\";threadRootId?:string}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.bolter.operations.id.k0t4td",
    "locator": "http:request_response:GET /api/bolter/operations/:id",
    "structuralSignatures": [
      "response.body:{auth?:{code:string;url:string};connection?:{canCreateRoom:boolean;device:{label:string;relayId:string};displayName:string;id:string;identity?:{label:string;providerAgentId:string};reason?:\"authentication_required\"|\"authority_changed\"|\"conflict\"|\"delivery_uncertain\"|\"desktop_offline\"|\"desktop_required\"|\"desktop_selection_required\"|\"identity_selection_required\"|\"identity_unconfirmed\"|\"invalid_request\"|\"mode_unsupported\"|\"not_found\"|\"operation_cancelled\"|\"qualification_required\"|\"receiver_unavailable\"|\"runtime_unavailable\"|\"unsupported_content\";receiver:\"listening\"|\"running\"|\"starting\"|\"stopped\";revision:number;status:\"auth_pending\"|\"connected\"|\"needs_auth\"|\"offline\"|\"paused\"|\"qualification_required\"|\"revoked\"};operationId:string;reason?:\"authentication_required\"|\"authority_changed\"|\"conflict\"|\"delivery_uncertain\"|\"desktop_offline\"|\"desktop_required\"|\"desktop_selection_required\"|\"identity_selection_required\"|\"identity_unconfirmed\"|\"invalid_request\"|\"mode_unsupported\"|\"not_found\"|\"operation_cancelled\"|\"qualification_required\"|\"receiver_unavailable\"|\"runtime_unavailable\"|\"unsupported_content\";status:\"auth_pending\"|\"completed\"|\"pending\"|\"unavailable\"}",
      "response.body:{code:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.bolter.rooms.roomid.nqswwm",
    "locator": "http:request_response:GET /api/bolter/rooms/:roomId",
    "structuralSignatures": [
      "response.body:{code:string}",
      "response.body:{link:{agentId:string;canManage:boolean;canSend:boolean;chatId:string;connectionId:string;conversationLabel:string;delivery:{pending:number;uncertain:number};id:string;identityLabel:string;outboundPolicy:\"causal_replies_and_reviewed_messages\";providerAgentId:string;reason?:\"authentication_required\"|\"authority_changed\"|\"conflict\"|\"delivery_uncertain\"|\"desktop_offline\"|\"desktop_required\"|\"desktop_selection_required\"|\"identity_selection_required\"|\"identity_unconfirmed\"|\"invalid_request\"|\"mode_unsupported\"|\"not_found\"|\"operation_cancelled\"|\"qualification_required\"|\"receiver_unavailable\"|\"runtime_unavailable\"|\"unsupported_content\";receiver:\"listening\"|\"running\"|\"starting\"|\"stopped\";revision:number;roomId:string;roomName:string;status:\"active\"|\"paused\"|\"revoked\";threadRootId?:string}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.patch.api.bolter.bindings.id.fb0bdz",
    "locator": "http:request_response:PATCH /api/bolter/bindings/:id",
    "structuralSignatures": [
      "response.body:{agentId:string;canManage:boolean;canSend:boolean;chatId:string;connectionId:string;conversationLabel:string;delivery:{pending:number;uncertain:number};id:string;identityLabel:string;outboundPolicy:\"causal_replies_and_reviewed_messages\";providerAgentId:string;reason?:\"authentication_required\"|\"authority_changed\"|\"conflict\"|\"delivery_uncertain\"|\"desktop_offline\"|\"desktop_required\"|\"desktop_selection_required\"|\"identity_selection_required\"|\"identity_unconfirmed\"|\"invalid_request\"|\"mode_unsupported\"|\"not_found\"|\"operation_cancelled\"|\"qualification_required\"|\"receiver_unavailable\"|\"runtime_unavailable\"|\"unsupported_content\";receiver:\"listening\"|\"running\"|\"starting\"|\"stopped\";revision:number;roomId:string;roomName:string;status:\"active\"|\"paused\"|\"revoked\";threadRootId?:string}",
      "response.body:{code:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.patch.api.bolter.connections.id.3na752",
    "locator": "http:request_response:PATCH /api/bolter/connections/:id",
    "structuralSignatures": [
      "response.body:{canCreateRoom:boolean;device:{label:string;relayId:string};displayName:string;id:string;identity?:{label:string;providerAgentId:string};reason?:\"authentication_required\"|\"authority_changed\"|\"conflict\"|\"delivery_uncertain\"|\"desktop_offline\"|\"desktop_required\"|\"desktop_selection_required\"|\"identity_selection_required\"|\"identity_unconfirmed\"|\"invalid_request\"|\"mode_unsupported\"|\"not_found\"|\"operation_cancelled\"|\"qualification_required\"|\"receiver_unavailable\"|\"runtime_unavailable\"|\"unsupported_content\";receiver:\"listening\"|\"running\"|\"starting\"|\"stopped\";revision:number;status:\"auth_pending\"|\"connected\"|\"needs_auth\"|\"offline\"|\"paused\"|\"qualification_required\"|\"revoked\"}",
      "response.body:{code:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.bolter.bindings.id.messages.zyaqu8",
    "locator": "http:request_response:POST /api/bolter/bindings/:id/messages",
    "structuralSignatures": [
      "response.body:{code:string}",
      "response.body:{messageId:number;outboxId:string;state:\"cancelled\"|\"pending\"|\"published\"|\"publishing\"|\"uncertain\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.bolter.connections.connect.1oj9o03",
    "locator": "http:request_response:POST /api/bolter/connections/connect",
    "structuralSignatures": [
      "response.body:{auth?:{code:string;url:string};connection?:{canCreateRoom:boolean;device:{label:string;relayId:string};displayName:string;id:string;identity?:{label:string;providerAgentId:string};reason?:\"authentication_required\"|\"authority_changed\"|\"conflict\"|\"delivery_uncertain\"|\"desktop_offline\"|\"desktop_required\"|\"desktop_selection_required\"|\"identity_selection_required\"|\"identity_unconfirmed\"|\"invalid_request\"|\"mode_unsupported\"|\"not_found\"|\"operation_cancelled\"|\"qualification_required\"|\"receiver_unavailable\"|\"runtime_unavailable\"|\"unsupported_content\";receiver:\"listening\"|\"running\"|\"starting\"|\"stopped\";revision:number;status:\"auth_pending\"|\"connected\"|\"needs_auth\"|\"offline\"|\"paused\"|\"qualification_required\"|\"revoked\"};operationId:string;reason?:\"authentication_required\"|\"authority_changed\"|\"conflict\"|\"delivery_uncertain\"|\"desktop_offline\"|\"desktop_required\"|\"desktop_selection_required\"|\"identity_selection_required\"|\"identity_unconfirmed\"|\"invalid_request\"|\"mode_unsupported\"|\"not_found\"|\"operation_cancelled\"|\"qualification_required\"|\"receiver_unavailable\"|\"runtime_unavailable\"|\"unsupported_content\";status:\"auth_pending\"|\"completed\"|\"pending\"|\"unavailable\"}",
      "response.body:{code:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.bolter.connections.id.check.3yr04p",
    "locator": "http:request_response:POST /api/bolter/connections/:id/check",
    "structuralSignatures": [
      "response.body:{canCreateRoom:boolean;device:{label:string;relayId:string};displayName:string;id:string;identity?:{label:string;providerAgentId:string};reason?:\"authentication_required\"|\"authority_changed\"|\"conflict\"|\"delivery_uncertain\"|\"desktop_offline\"|\"desktop_required\"|\"desktop_selection_required\"|\"identity_selection_required\"|\"identity_unconfirmed\"|\"invalid_request\"|\"mode_unsupported\"|\"not_found\"|\"operation_cancelled\"|\"qualification_required\"|\"receiver_unavailable\"|\"runtime_unavailable\"|\"unsupported_content\";receiver:\"listening\"|\"running\"|\"starting\"|\"stopped\";revision:number;status:\"auth_pending\"|\"connected\"|\"needs_auth\"|\"offline\"|\"paused\"|\"qualification_required\"|\"revoked\"}",
      "response.body:{code:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.bolter.connections.id.rooms.1qdke9l",
    "locator": "http:request_response:POST /api/bolter/connections/:id/rooms",
    "structuralSignatures": [
      "response.body:{code:string}",
      "response.body:{link:{agentId:string;canManage:boolean;canSend:boolean;chatId:string;connectionId:string;conversationLabel:string;delivery:{pending:number;uncertain:number};id:string;identityLabel:string;outboundPolicy:\"causal_replies_and_reviewed_messages\";providerAgentId:string;reason?:\"authentication_required\"|\"authority_changed\"|\"conflict\"|\"delivery_uncertain\"|\"desktop_offline\"|\"desktop_required\"|\"desktop_selection_required\"|\"identity_selection_required\"|\"identity_unconfirmed\"|\"invalid_request\"|\"mode_unsupported\"|\"not_found\"|\"operation_cancelled\"|\"qualification_required\"|\"receiver_unavailable\"|\"runtime_unavailable\"|\"unsupported_content\";receiver:\"listening\"|\"running\"|\"starting\"|\"stopped\";revision:number;roomId:string;roomName:string;status:\"active\"|\"paused\"|\"revoked\";threadRootId?:string};roomId:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.bolter.operations.id.cancel.fitn0i",
    "locator": "http:request_response:POST /api/bolter/operations/:id/cancel",
    "structuralSignatures": [
      "response.body:{auth?:{code:string;url:string};connection?:{canCreateRoom:boolean;device:{label:string;relayId:string};displayName:string;id:string;identity?:{label:string;providerAgentId:string};reason?:\"authentication_required\"|\"authority_changed\"|\"conflict\"|\"delivery_uncertain\"|\"desktop_offline\"|\"desktop_required\"|\"desktop_selection_required\"|\"identity_selection_required\"|\"identity_unconfirmed\"|\"invalid_request\"|\"mode_unsupported\"|\"not_found\"|\"operation_cancelled\"|\"qualification_required\"|\"receiver_unavailable\"|\"runtime_unavailable\"|\"unsupported_content\";receiver:\"listening\"|\"running\"|\"starting\"|\"stopped\";revision:number;status:\"auth_pending\"|\"connected\"|\"needs_auth\"|\"offline\"|\"paused\"|\"qualification_required\"|\"revoked\"};operationId:string;reason?:\"authentication_required\"|\"authority_changed\"|\"conflict\"|\"delivery_uncertain\"|\"desktop_offline\"|\"desktop_required\"|\"desktop_selection_required\"|\"identity_selection_required\"|\"identity_unconfirmed\"|\"invalid_request\"|\"mode_unsupported\"|\"not_found\"|\"operation_cancelled\"|\"qualification_required\"|\"receiver_unavailable\"|\"runtime_unavailable\"|\"unsupported_content\";status:\"auth_pending\"|\"completed\"|\"pending\"|\"unavailable\"}",
      "response.body:{code:string}"
    ],
    "arbitraryPayloads": []
  }
];

const reviewedCiBolterDeclarations = new Map<string, DtoDeclaration>(
  REVIEWED_CI_DTO_REPLACEMENTS.map((entry) => [entry.locator, entry.declaration]),
);

/** Current static contracts; the aggregate baseline applies the same declarations through its guarded predecessor layer. */
export const BOLTER_HTTP_DECLARATIONS: readonly DtoDeclaration[] =
  BOLTER_HTTP_PREDECESSOR_DECLARATIONS.map((declaration) =>
    reviewedCiBolterDeclarations.get(declaration.locator) ?? declaration);

export const BOLTER_HTTP_COVERAGE: readonly AuthorizedPlaintextCoverageEntry[] = BOLTER_HTTP_DECLARATIONS.map(dto => ({
  id: dto.observationId, surface: "wire", locator: dto.locator, owner: "packages/server",
  readers: ["packages/api-client/src/client.ts"], writers: ["packages/server/src/routes/bolter.ts"],
  migrationState: "not_applicable", classification: "authorized_plaintext", mode: "plaintext_only", transientOnly: true,
  modeGate: "The canonical controller rejects protected-mode connection creation, room creation and reviewed sends. Status, pause and revocation remain available without hydrating protected messages. This classification is not a protected-mode disclosure grant.",
  recipientAuthority: "Authenticated Human owner checks precede connection and operation projections; the binding sponsor receives the explicit link summary. Strict shared request schemas reject extra authority fields. Auth links and codes are transient provider sign-in display data, not stored provider credentials. Exact reviewed text enters one canonical message with an immutable sharing grant.",
  cleanupContract: "HTTP and browser state retain transient labels, sign-in links and reviewed text; UI account and room generation fences reject stale responses. The adapter adds no HTTP body archive or diagnostics. Canonical transcript storage is classified separately. Heap zeroization, browser extension isolation and provider erasure are not claimed.",
  retention: "Transient HTTP and renderer buffers. The reviewed text endpoint intentionally creates a separately classified canonical message; operation display data is not a credential archive.",
  releaseImpact: "blocks_whole_product_claim",
  testEvidence: ["packages/encryption-invariants/tests/integration/bolter-http.test.ts", "packages/server/tests/unit/bolter-routes.test.ts", "packages/api-client/tests/unit/bolter.test.ts", "apps/workbench/src/components/bolter-ui.test.tsx"],
  noRetentionTestEvidence: ["packages/server/tests/unit/bolter-routes.test.ts", "packages/api-client/tests/unit/bolter.test.ts", "apps/workbench/src/components/bolter-ui.test.tsx"],
}));

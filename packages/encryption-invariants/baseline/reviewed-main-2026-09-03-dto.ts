import type { DtoDeclaration } from "../src/node/dto-inventory";

export const SUPERSEDED_MAIN_2026_09_03_DTO_LOCATORS = new Set<string>([
  "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AcceptProposalBridgeSuccess",
  "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeOptions",
  "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeRequest",
  "http:produced_arbitrary:packages/types/src/api.ts#ApplyAcceptedLiveProposalResponse",
  "http:request_response:DELETE /api/rooms/:id/members/:actorId",
  "http:request_response:GET /api/admin/encryption-transition",
  "http:request_response:GET /api/auth/whoami",
  "http:request_response:GET /api/costs",
  "http:request_response:GET /api/encryption-transition/policy",
  "http:request_response:GET /api/health/keys",
  "http:request_response:GET /api/integrations/google/status",
  "http:request_response:GET /api/security/audit-log",
  "http:request_response:GET /api/setup/research-provider",
  "http:request_response:GET /api/tasks/pending-attention",
  "http:request_response:POST /api/admin/encryption-transition",
  "http:request_response:POST /api/apps/:appId/live-session/apply-accepted",
  "http:request_response:POST /api/health/keys/validate",
  "http:request_response:POST /api/protected/devices/additional/:operationId/activate",
  "http:request_response:POST /api/protected/devices/additional/:operationId/grant-sync-page",
  "http:request_response:POST /api/protected/devices/additional/grant-sync-pending",
  "http:request_response:POST /api/rooms/:id/members",
  "http:request_response:PUT /api/setup/research-provider"
]);

export const REVIEWED_MAIN_2026_09_03_DTO_DECLARATIONS:
  readonly DtoDeclaration[] = [
  {
    "observationId": "wire.app.bridge.app.to.host.arbitrary.apps.workbench.src.apps.app.bridge.ts.appliveproposalacknowledgement.1gsdgbs",
    "locator": "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppLiveProposalAcknowledgement",
    "structuralSignatures": [
      "declaration.payload:{documentVersion:unknown;proposalId:string;type:\"nautilo.app.live-proposal.ack\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "documentVersion",
        "schema": "LiveDocumentVersionV1"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.app.to.host.arbitrary.apps.workbench.src.apps.app.bridge.ts.appsessioninvalidateproposalrequest.bm7my8",
    "locator": "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppSessionInvalidateProposalRequest",
    "structuralSignatures": [
      "declaration.payload:{documentVersion:unknown;op:\"invalidateProposal\";proposalId:string;proposalSessionToken:string;reason:\"human_changed\"|\"no_effective_change\"|\"remote_changed\"|\"session_closed\"|\"stale_version\";requestId:string;type:\"nautilo.app.session.req\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "documentVersion",
        "schema": "LiveDocumentVersionV1"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.app.to.host.arbitrary.apps.workbench.src.apps.app.bridge.ts.appsessionresolveproposalrequest.3y236j",
    "locator": "app_bridge:app_to_host_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppSessionResolveProposalRequest",
    "structuralSignatures": [
      "declaration.payload:{documentVersion:unknown;op:\"resolveProposal\";outcome:\"accepted\"|\"rejected\";proposalId:string;requestId:string;type:\"nautilo.app.session.req\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "documentVersion",
        "schema": "LiveDocumentVersionV1"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.live.proposal.ack.1fbdd0h",
    "locator": "app_bridge:app_to_host:nautilo.app.live-proposal.ack",
    "structuralSignatures": [
      "frame.payload:{documentVersion:unknown;proposalId:string;type:\"nautilo.app.live-proposal.ack\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "documentVersion",
        "schema": "LiveDocumentVersionV1"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.session.req.invalidateproposal.18l7a37",
    "locator": "app_bridge:app_to_host:nautilo.app.session.req#invalidateProposal",
    "structuralSignatures": [
      "frame.payload:{documentVersion:unknown;op:\"invalidateProposal\";proposalId:string;proposalSessionToken:string;reason:\"human_changed\"|\"no_effective_change\"|\"remote_changed\"|\"session_closed\"|\"stale_version\";requestId:string;type:\"nautilo.app.session.req\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "documentVersion",
        "schema": "LiveDocumentVersionV1"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.app.to.host.nautilo.app.session.req.resolveproposal.1yaly3u",
    "locator": "app_bridge:app_to_host:nautilo.app.session.req#resolveProposal",
    "structuralSignatures": [
      "frame.payload:{documentVersion:unknown;op:\"resolveProposal\";outcome:\"accepted\"|\"rejected\";proposalId:string;requestId:string;type:\"nautilo.app.session.req\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "documentVersion",
        "schema": "LiveDocumentVersionV1"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.host.to.app.arbitrary.apps.workbench.src.apps.app.bridge.ts.acceptproposalbridgesuccess.msrnsb",
    "locator": "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AcceptProposalBridgeSuccess",
    "structuralSignatures": [
      "declaration.payload:{ok:true;value:{contentSha256:string;documentVersion:unresolved<LiveDocumentVersion>;localRevisionRef?:string;ok:true}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "value.documentVersion",
        "debtId": "debt.wire.arbitrary.prezs"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.host.to.app.arbitrary.apps.workbench.src.apps.app.bridge.ts.appbridgeoptions.ojsugv",
    "locator": "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeOptions",
    "structuralSignatures": [
      "declaration.payload:{appId:string;documentSession?:{documentReadGeneration?:number;documentReadPromise?:unresolved<Promise>;documentTargetKey?:string;envelope:null|{baseRevision:null|number;baseSha256:null|string;content:string;localIdentity?:{canonicalPath:string;kind:\"local_file\";relayId:string};mimeType:string;path:string}};draft?:{appId:string;createActionId:null|string;roomId?:string;suggestedName:string};getLiveSession?:() => { sessionToken: string; sessionId: string; documentVersion: LiveDocumentVersion; } | null;iframe:unresolved<HTMLIFrameElement>;materialize?:(content: string, mimeType: string) => Promise<ArtifactTarget>;onContextUpdate?:(context: ActiveMiniAppContext) => void;onDocumentVersion?:(documentVersion: LiveDocumentVersion) => void | Promise<void>;onHumanEditUpdate?:(update: AppHumanEditUpdate) => void;onLiveProposalAccepted?:(result: ApplyAcceptedLiveProposalResponse) => void;onLiveProposalAcknowledged?:(input: { proposalId: string; documentVersion: LiveDocumentVersion; }) => void;target?:unresolved<OpenFileTarget>;viewerKey?:null|string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "documentSession.documentReadPromise",
        "debtId": "debt.wire.arbitrary.1pjbi6v"
      },
      {
        "path": "iframe",
        "debtId": "debt.wire.arbitrary.e8lqi4"
      },
      {
        "path": "target",
        "debtId": "debt.wire.arbitrary.1mgxsot"
      }
    ]
  },
  {
    "observationId": "wire.app.bridge.host.to.app.arbitrary.apps.workbench.src.apps.app.bridge.ts.appbridgerequest.xxmqpw",
    "locator": "app_bridge:host_to_app_arbitrary:apps/workbench/src/apps/app-bridge.ts#AppBridgeRequest",
    "structuralSignatures": [
      "declaration.payload:{acceptedContent:string;acceptedOperationIndexes:unknown;documentVersion:unknown;op:\"acceptProposal\";proposalId:string;requestId:string;type:\"nautilo.app.session.req\"}|{baseRevision?:null|number;baseSha256?:null|string;op:\"write\";requestId:string;type:\"nautilo.app.document.req\";value:unknown}|{documentVersion:unknown;op:\"invalidateProposal\";proposalId:string;proposalSessionToken:string;reason:\"human_changed\"|\"no_effective_change\"|\"remote_changed\"|\"session_closed\"|\"stale_version\";requestId:string;type:\"nautilo.app.session.req\"}|{documentVersion:unknown;op:\"resolveProposal\";outcome:\"accepted\"|\"rejected\";proposalId:string;requestId:string;type:\"nautilo.app.session.req\"}|{documentVersion:unknown;proposalId:string;type:\"nautilo.app.live-proposal.ack\"}|{key:string;op:\"get\";requestId:string;type:\"nautilo.app.state.req\"}|{key:string;op:\"set\";requestId:string;type:\"nautilo.app.state.req\";value:unknown}|{key:unresolved<AppPreferenceKey>;op:\"get\";requestId:string;type:\"nautilo.app.preferences.req\"}|{key:unresolved<AppPreferenceKey>;op:\"set\";requestId:string;type:\"nautilo.app.preferences.req\";value:unknown}|{key:unresolved<AppPreferenceKey>;type:\"nautilo.app.preferences.subscribe\"}|{op:\"read\"|\"stat\";requestId:string;type:\"nautilo.app.document.req\"}|{summary:unknown;type:\"nautilo.app.context.update\"}|{type:\"nautilo.app.human-edit.update\";update:{draftPatch?:unresolved<AnchoredTextPatch>;state:\"clean\"|\"conflict\"|\"dirty\"|\"saving\"}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "acceptedOperationIndexes",
        "debtId": "debt.wire.arbitrary.rddovr"
      },
      {
        "path": "documentVersion",
        "debtId": "debt.wire.arbitrary.u5zte0"
      },
      {
        "path": "key",
        "schema": "AppPreferenceKey"
      },
      {
        "path": "summary",
        "debtId": "debt.wire.arbitrary.z2o3n7"
      },
      {
        "path": "update.draftPatch",
        "debtId": "debt.wire.arbitrary.z234jl"
      },
      {
        "path": "value",
        "debtId": "debt.wire.arbitrary.q5uskq"
      }
    ]
  },
  {
    "observationId": "wire.http.accepted.arbitrary.packages.types.src.api.ts.pendingliveproposalreview.hnzsf7",
    "locator": "http:accepted_arbitrary:packages/types/src/api.ts#PendingLiveProposalReview",
    "structuralSignatures": [
      "declaration.payload:{appId:string;documentVersion:{kind:\"artifact_revision\";revision:number}|{kind:\"local_sha\";sha256:string};operations:unknown[];proposalId:string;sessionId:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "operations[]",
        "schema": "PreflightedLiveReviewOperationV1"
      }
    ]
  },
  {
    "observationId": "wire.http.produced.arbitrary.packages.types.src.api.ts.listpendingliveproposalreviewsresponse.16rk29w",
    "locator": "http:produced_arbitrary:packages/types/src/api.ts#ListPendingLiveProposalReviewsResponse",
    "structuralSignatures": [
      "declaration.payload:{proposals:{appId:string;documentVersion:{kind:\"artifact_revision\";revision:number}|{kind:\"local_sha\";sha256:string};operations:unknown[];proposalId:string;sessionId:string}[]}"
    ],
    "arbitraryPayloads": [
      {
        "path": "proposals[].operations[]",
        "schema": "PreflightedLiveReviewOperationV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.delete.api.connected.apps.providerid.14pks5m",
    "locator": "http:request_response:DELETE /api/connected-apps/:providerId",
    "structuralSignatures": [
      "request.params:{providerId:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.delete.api.connected.apps.providerid.oauth.attemptid.fc5bit",
    "locator": "http:request_response:DELETE /api/connected-apps/:providerId/oauth/:attemptId",
    "structuralSignatures": [
      "request.params:{attemptId:string;providerId:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.delete.api.connected.web.accounts.id.1rv3qou",
    "locator": "http:request_response:DELETE /api/connected-web-accounts/:id",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:never",
      "response.body:{account:{createdAt:string;id:string;label:string;lastVerifiedAt?:string;origin:string;service:string;status:\"attention_needed\"|\"busy\"|\"connected\"|\"connecting\"|\"error\"|\"expired\"|\"provider_unavailable\"|\"revoked\";updatedAt:string};websiteSessionWarning:\"Disconnecting Nautilo does not sign you out of the website. Use the website's sign out other sessions control if needed.\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.delete.api.rooms.id.members.actorid.10ldqyu",
    "locator": "http:request_response:DELETE /api/rooms/:id/members/:actorId",
    "structuralSignatures": [
      "request.params:{actorId:string;id:string}",
      "request.query:{bypass?:string}",
      "response.body:{code:string}",
      "response.body:{error:string}",
      "response.body:{kind:\"agent\"|\"user\";ok:boolean;protectedEncryption:{accessRevision:number;namespaceId:string;status:string}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.admin.encryption.transition.h8ulxt",
    "locator": "http:request_response:GET /api/admin/encryption-transition",
    "structuralSignatures": [
      "response.body:unknown",
      "response.body:{coverageReadiness:{protected:string;registered:string;unexercised:string;unsupported:string};domainKeyAuthority:{authority:{aiDomainHeads:string;aiNamespaceBundleAdvances:string;aiNamespaceBundles:string;humanDomainHeads:string;humanNamespaceBundleAdvances:string;humanNamespaceBundles:string};catchUp:{acknowledged:string;delivered:string;expired:string;requested:string;stale:string;unrecoverable:string;waiting:string};scope:\"domain_key_v2\"};dtoVersion:2;historyReads:{eligible:string;fallback:string;outcomes:{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"failed\";reason:\"integrity_failure\"|\"parity_mismatch\"|\"publication_failure\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"pending\";reason:\"none\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"reconciling\";reason:\"response_lost\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"unavailable\";reason:\"client_crypto_preparation_failed\"|\"client_crypto_unavailable\"|\"client_custody_unavailable\"|\"client_observation_expired\"|\"current_read_authority_unavailable\"|\"live_shadow_lifecycle_unavailable\"|\"namespace_encryption_not_ready\"|\"retained_key_material_unavailable\"|\"signer_evidence_unavailable\"|\"stale_authority_product\"|\"unmigrated\"|\"unsupported_operation\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"verified\";reason:\"none\"}[];pagesAttempted:string;pagesPending:string;pending:string;percent?:number;scope:\"browser_room_history_shadow_reads\";selected:string;verified:string};humanPeerLive:{recipientReads:{attempted:string;fallback:string;percent?:number;verified:string};scope:\"browser_human_only_live_messages\";writes:{eligible:string;fallback:string;pending:string;percent?:number;published:string}};liveTurns:{completeRoundTrip:{eligible:string;percent?:number;verified:string};entities:{eligible:string;entity:\"final_agent_message\"|\"human_message\"|\"tool_call\"|\"tool_result\";percent?:number;verified:string}[];fallbacks:{count:string;reason:\"agent_authority_unavailable\"|\"cancelled\"|\"deadline_expired\"|\"device_unavailable\"|\"domain_unavailable\"|\"integrity_failure\"|\"namespace_unavailable\"|\"parity_mismatch\"|\"product_conflict\"|\"protected_unavailable\"|\"recipient_lost\"|\"reservation_unavailable\"|\"stale_authority\";stage:\"agent_input\"|\"assistant_message\"|\"assistant_stream\"|\"client_verification\"|\"durable_transcript\"|\"human_admission\"|\"plan\"|\"session_establishment\"|\"session_reuse\"|\"shutdown\"|\"tool_call\"|\"tool_result\"}[];pending:{oldestPendingAt?:string;turns:string};scope:\"live_new_browser_private_room_turns\";stages:{eligible:string;percent?:number;stage:\"agent_protected_input\"|\"agent_stream_frame_chain\"|\"assistant_tool_call_boundary\"|\"browser_durable_transcript_parity\"|\"browser_human_prepare\"|\"browser_stream_frame_chain\"|\"browser_terminal_acknowledgement\"|\"human_durable_mapping\"|\"server_human_open_parity\"|\"tool_result_boundary\"|\"transcript_durable_mappings\";verified:string}[]};metrics:{attemptOutcomes:{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"failed\";reason:\"integrity_failure\"|\"parity_mismatch\"|\"publication_failure\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"pending\";reason:\"none\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"reconciling\";reason:\"response_lost\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"unavailable\";reason:\"client_crypto_preparation_failed\"|\"client_crypto_unavailable\"|\"client_custody_unavailable\"|\"client_observation_expired\"|\"current_read_authority_unavailable\"|\"live_shadow_lifecycle_unavailable\"|\"namespace_encryption_not_ready\"|\"retained_key_material_unavailable\"|\"signer_evidence_unavailable\"|\"stale_authority_product\"|\"unmigrated\"|\"unsupported_operation\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"verified\";reason:\"none\"}[];attemptSuccess:{eligible:string;percent?:number;verified:string};family:\"artifact\"|\"memory\"|\"message\"|\"overall\"|\"record\";pendingLifecycle:{oldestPendingAt?:string;operations:string};storedCoverage:{percent?:number;total:string;verified:string};touchedCoverage:{percent?:number;total:string;verified:string}}[];observationPressure:{admissionCapacity:string;capacityRows:string;maximumRetentionMs:number;pendingAdmissions:string;retainedRows:string};policy:{mode:\"plaintext_only\"|\"shadow_encryption\";revision:number;shadowBehavior:\"fallback\"|\"strict\";shadowEncryptionStartedAt?:string;updatedAt:string};runtimeHealth:{boundaries:{actorClass:\"agent\"|\"background\"|\"conductor\"|\"human\"|\"tool\";boundaryId:string;family:string;lastObservedAt?:string;occurrenceCount:string;operation:string;reason:string;state?:\"failed\"|\"repairing\"|\"unexercised\"|\"unsupported\"|\"verified\"|\"waiting_for_authority\"}[];failed:string;lastObservedAt?:string;policyRevision:number;repairing:string;unexercised:string;unsupported:string;verified:string;waitingForAuthority:string};sharedAgentLive:{agentRecipientReads:{attempted:string;fallback:string;percent?:number;verified:string};authorization:{established:string;expired:string;reused:string;revoked:string;unavailable:string};conductor:{authorizationEstablished:string;authorizationReused:string;awaitingAuthorization:string;awaitingUser:string;currentInputVerified:string;deterministic:string;eligible:string;fallback:string;fallbackReasons:{count:string;reason:string}[];floorManager:string;historyNotRequested:string;historyUnavailable:string;historyVerified:string;notSelected:string;selected:string;selectedAgentExecutions:string;unavailable:string;verifiedAwaitingUser:string;verifiedSilent:string;verifiedWake:string};executions:{authorized:string;awaitingAuthorization:string;completed:string;failed:string;fallback:string;protectedInputs:string;running:string};outputStages:{assistantPublished:string;streamCompleted:string;streamStarted:string;toolPublished:string};planningFallbacks:{deviceUnavailable:string;namespaceUnavailable:string;recipientSyncRequired:string;unavailable:string};recipientCoverage:{plaintextOnlyHumans:string;protectedDevices:string;protectedHumans:string;totalHumans:string};recipientReads:{attempted:string;fallback:string;percent?:number;verified:string};resumes:{attempted:string;authorized:string;awaitingAuthorization:string;completed:string;failed:string;fallback:string;running:string};scope:\"browser_multi_human_single_agent_live_messages\";writes:{eligible:string;fallback:string;pending:string;percent?:number;published:string}}}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body",
        "schema": "EncryptionTransitionControlV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.auth.whoami.1qlua20",
    "locator": "http:request_response:GET /api/auth/whoami",
    "structuralSignatures": [
      "response.body:{capabilities:\"approve_destructive_actions\"|\"approve_spending\"|\"control_browser\"|\"control_desktop\"|\"control_home\"|\"create_invites\"|\"create_rooms\"|\"invoke_agents\"|\"manage_agents\"|\"manage_billing\"|\"manage_connection_providers\"|\"manage_groups\"|\"manage_members\"|\"manage_memories\"|\"manage_roles\"|\"manage_rooms\"|\"manage_server_operations\"|\"manage_server_security\"|\"manage_server_settings\"|\"manage_standing_approvals\"|\"manage_uncontained_host_commands\"|\"manage_workstation_profiles\"|\"moderate_content_reports\"|\"read_memories\"|\"read_server_settings\"|\"use_connections\"|\"use_google_workspace\"|\"use_image_generation\"|\"use_media_generation\"|\"use_project_content\"|\"use_project_execution\"|\"use_remote_hosts\"|\"use_research_tools\"|\"use_share_artifact\"|\"use_transcription\"|\"use_workstation\"|\"view_audit_log\"|\"write_artifacts\"[];displayName:string;externalId:string;features?:{office:{enabled:boolean}};groups:{id:string;label:string;roleSlug:string;type:string}[];handle:string;highestRole:string;instanceId:string;mustChangePassword:boolean;sessionActorId:string;sessionUserId:string;userIdentity:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.connected.apps.1tzbcuw",
    "locator": "http:request_response:GET /api/connected-apps",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.connected.apps.providerid.oauth.attemptid.4w1t8c",
    "locator": "http:request_response:GET /api/connected-apps/:providerId/oauth/:attemptId",
    "structuralSignatures": [
      "request.params:{attemptId:string;providerId:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.connected.apps.providerid.setup.1ixw44v",
    "locator": "http:request_response:GET /api/connected-apps/:providerId/setup",
    "structuralSignatures": [
      "request.params:{providerId:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.connected.apps.result.media.kwu5tp",
    "locator": "http:request_response:GET /api/connected-apps/result-media",
    "structuralSignatures": [
      "request.query:{ref:string;roomId:string}",
      "response.body:Readable"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.errored.cause",
        "schema": "NodeReadableInternalErrorV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.connected.web.accounts.id.r0ue5x",
    "locator": "http:request_response:GET /api/connected-web-accounts/:id",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:never",
      "response.body:{createdAt:string;id:string;label:string;lastVerifiedAt?:string;origin:string;service:string;status:\"attention_needed\"|\"busy\"|\"connected\"|\"connecting\"|\"error\"|\"expired\"|\"provider_unavailable\"|\"revoked\";updatedAt:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.connected.web.accounts.id.read.activity.1arvbdc",
    "locator": "http:request_response:GET /api/connected-web-accounts/:id/read-activity",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:never",
      "response.body:{accountId:string;canWatch:boolean;stage:\"browsing\"|\"finishing\"|\"planning\"|\"saving\"|\"starting\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.connected.web.accounts.kkzzqx",
    "locator": "http:request_response:GET /api/connected-web-accounts",
    "structuralSignatures": [
      "response.body:never",
      "response.body:{accounts:{createdAt:string;id:string;label:string;lastVerifiedAt?:string;origin:string;service:string;status:\"attention_needed\"|\"busy\"|\"connected\"|\"connecting\"|\"error\"|\"expired\"|\"provider_unavailable\"|\"revoked\";updatedAt:string}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.costs.vkk56s",
    "locator": "http:request_response:GET /api/costs",
    "structuralSignatures": [
      "request.query:{[key:string]:unknown}",
      "response.body:{byCallType:{callType:string;calls:number;totalCostUsd:number}[];byModel:{actualCostUsd:number;calls:number;displayName:string;estimatedCostUsd:number;hasActual:boolean;hasFallbackEstimate:boolean;inputTokens:number;model:string;outputTokens:number;provider:string;totalCostUsd:number}[];byProvider:{actualCostUsd:number;estimatedCostUsd:number;operation:string;operations:number;provider:string;totalCostUsd:number;unknownOperations:number}[];byUser:{actualCostUsd:number;calls:number;estimatedCostUsd:number;handle:string;label:string;name:string;providerOperations:number;totalCostUsd:number;totalTokens:number;unknownProviderOperations:number;userId:string}[];pricingVersion:string;providerCoverage:{accounted:{operation:string;provider:string}[];state:\"partial\";unavailable:string[]};providerPricingVersion:string;range:{key:string;since:string;until:string};timeSeries:{actualCostUsd:number;day:string;estimatedCostUsd:number;totalCostUsd:number}[];totals:{actualCostUsd:number;cachedInputTokens:number;calls:number;estimatedCostUsd:number;inputTokens:number;outputTokens:number;providerOperations:number;totalCostUsd:number;totalTokens:number;unknownProviderOperations:number}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.query",
        "debtId": "debt.wire.arbitrary.c21xww"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.encryption.transition.policy.1yuyn5w",
    "locator": "http:request_response:GET /api/encryption-transition/policy",
    "structuralSignatures": [
      "response.body:{canManage:boolean;coveragePreview:{protected:string;unexercised:string;unsupported:string};policy:{mode:\"plaintext_only\"|\"shadow_encryption\";revision:number;shadowBehavior:\"fallback\"|\"strict\";updatedAt:string};requiresCryptoDevice:boolean;responseVersion:1}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.health.keys.g9cqnd",
    "locator": "http:request_response:GET /api/health/keys",
    "structuralSignatures": [
      "response.body:{category:\"browser\"|\"conversion\"|\"llm\"|\"llm+embeddings\"|\"search\"|\"voice\";envVar:string;formatHint:string;hint:string;id:string;masked:string;name:string;purpose:string;required:boolean;signupUrl:string;status:\"invalid_format\"|\"invalid_key\"|\"missing\"|\"present\"|\"unreachable\"|\"verified\"}[]",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.integrations.google.status.7avg30",
    "locator": "http:request_response:GET /api/integrations/google/status",
    "structuralSignatures": [
      "response.body:{canManageProviderSetup:boolean;clientId?:string;configured:boolean;providerSetupStatus:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.security.audit.log.ef92mf",
    "locator": "http:request_response:GET /api/security/audit-log",
    "structuralSignatures": [
      "request.query:{actorId?:string;correlationId?:string;cursor?:string;kinds?:string;limit?:string;since?:string}",
      "response.body:{error:string}",
      "response.body:{events:{action:\"configure\"|\"remove\";actorId:string;clientId:string;ip:string;kind:\"google_oauth_client_config\";outcome:\"ok\";ts:string;userAgent:string}|{action:\"create\"|\"delete\"|\"disable\"|\"enable\"|\"update\";actorId:string;effectDigest?:string;ip:string;kind:\"mcp_server_config\";outcome:\"error\"|\"ok\";relayId?:string;serverName:string;ts:string;userAgent:string}|{action:\"delete\"|\"list\"|\"store\"|\"use\";actorId:string;connectionId?:string;errorKind?:string;field?:string;ip:string;kind:\"connection_vault_tool\";outcome:\"error\"|\"missing\"|\"ok\";service?:string;tool:string;ts:string;userAgent:string}|{action:string;actorId:string;errorKind?:string;ip:string;kind:\"memory.edit\";memoryId:string;namespaceId?:string;outcome:\"failure\"|\"success\";scopeId?:string;ts:string;userAgent:string}|{actorId:string;actorUserId:string;ip:string;kind:\"standing_approval_revoked\";label:string;roomId:string;route:\"DELETE /api/security/standing-approvals/:id\";ruleId:string;scope:\"room\"|\"server\";toolPattern:string;ts:string;userAgent:string}|{actorId:string;affectedPairingCount:number;correlationId:string;ip:string;kind:\"relay_pairing_lifecycle\";managementTarget:string;operation:\"group_revoke\"|\"historical_cleanup\";reason:\"confirmation_mismatch\"|\"not_found_or_foreign\"|\"revoked\"|\"store_error\";result:\"failed\"|\"not_found_or_foreign\"|\"stale\"|\"succeeded\";ts:string;userAgent:string;userId:string}|{actorId:string;after:{conductorModel:string;defaultChatModel:string;fallbackChain:string[];reflectionModel:string;stenographerModel:string};before:{conductorModel:string;defaultChatModel:string;fallbackChain:string[];reflectionModel:string;stenographerModel:string};changes?:{[key:string]:unknown};ip:string;kind:\"server_model_config_changed\";ts:string;userAgent:string}|{actorId:string;after:{mode:\"plaintext_only\"|\"shadow_encryption\";revision:number;shadowBehavior:\"fallback\"|\"strict\"};before:{mode:\"plaintext_only\"|\"shadow_encryption\";revision:number;shadowBehavior:\"fallback\"|\"strict\"};ip:string;kind:\"encryption_transition_policy_changed\";ts:string;userAgent:string}|{actorId:string;attemptedRoute:string;capability:string;ip:string;kind:\"capability_check_failed\";ts:string;userAgent:string}|{actorId:string;attemptedRoute:string;ip:string;kind:\"pin_check_failed\";pinOutcome:\"invalid\"|\"locked_out\";ts:string;userAgent:string}|{actorId:string;before:{mode:\"plaintext_only\"|\"shadow_encryption\";revision:number;shadowBehavior:\"fallback\"|\"strict\"};ip:string;kind:\"encryption_transition_policy_change_requested\";requested:{expectedRevision:number;mode:\"plaintext_only\"|\"shadow_encryption\";shadowBehavior:\"fallback\"|\"strict\"};ts:string;userAgent:string}|{actorId:string;byUserId:string;fromUserId:string;ip:string;kind:\"room_archived\";roomId:string;ts:string;userAgent:string}|{actorId:string;byUserId:string;ip:string;kind:\"room_unarchived\";roomId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail:boolean;ip:string;kind:\"agent_role_removed\";roleSlug:string;targetAgentId:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail:boolean;ip:string;kind:\"room_member_removed\";roomId:string;targetActorId:string;targetActorKind:\"agent\"|\"user\";ts:string;userAgent:string}|{actorId:string;bypassedRail?:boolean;groupId:string;groupType:string;ip:string;kind:\"group_member_removed\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail?:boolean;ip:string;kind:\"agent_role_added\";replacedFromGroupId:string;roleSlug:string;targetAgentId:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];groupId:string;groupType:string;ip:string;kind:\"rbac_shared_access_assigned\";memberCount:number;ownerUserId:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];groupId:string;groupType:string;ip:string;kind:\"rbac_shared_access_created\";memberCount:number;ownerUserId:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];ip:string;kind:\"rbac_role_capabilities_set\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];ip:string;kind:\"rbac_role_created\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilityRevision:number;denialCode?:string;desktopSessionId:string;ip:string;kind:\"workstation_session_activated\"|\"workstation_session_broadened\"|\"workstation_session_denied\"|\"workstation_session_disabled\"|\"workstation_session_invalidated\"|\"workstation_session_narrowed\"|\"workstation_session_switched\";outcome?:string;relayId:string;route?:string;serverBindingId:string;ts:string;userAgent:string;userId:string}|{actorId:string;capabilityRevision:number;desktopSessionId:string;executionClass:\"profile_bound_sandbox\"|\"real_workstation\"|\"typed_broker\";ip:string;kind:\"workstation_admission\";outcome:\"auto\"|\"none\";pairingGeneration:string;profileId:string;profileRevision:number;reason:\"auto_admitted\"|\"critical_or_elevation_command\"|\"no_active_session\"|\"no_admitted_plan\"|\"run_shell_required\"|\"typed_broker_not_wired\";relayId:string;serverBindingId:string;toolCallId:string;toolName:string;ts:string;userAgent:string;userId:string}|{actorId:string;capabilityRevision?:number;desktopSessionId?:string;ip:string;kind:\"uncontained_host_commands_activated\"|\"uncontained_host_commands_denied\"|\"uncontained_host_commands_disabled\"|\"uncontained_host_commands_dispatch_admitted\"|\"uncontained_host_commands_dispatch_denied\"|\"uncontained_host_commands_invalidated\"|\"uncontained_host_commands_status_invalidated\";reason?:string;relayId?:string;route?:string;serverBindingId?:string;ts:string;userAgent:string;userId:string}|{actorId:string;changes:{[key:string]:unknown};ip:string;kind:\"server_profile_changed\";ts:string;userAgent:string}|{actorId:string;changes:{[key:string]:unknown};ip:string;kind:\"server_research_provider_changed\";ts:string;userAgent:string}|{actorId:string;errorKind?:string;ip:string;kind:\"memory.delete\";memoryId:string;mode:\"archive\"|\"hard\";namespaceId?:string;outcome:\"failure\"|\"success\";scopeId?:string;ts:string;userAgent:string}|{actorId:string;fromOwnerUserId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_owner_transferred\";toOwnerUserId:string;ts:string;userAgent:string}|{actorId:string;fromUserId:string;ip:string;kind:\"room_ownership_transferred\";roomId:string;toUserId:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"group_member_added\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_created\";ownerUserId:string;roleSlugs:string[];ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_deleted\";ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_renamed\";label:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_roles_set\";roleSlugs:string[];ts:string;userAgent:string}|{actorId:string;handleHash:string;inviteKind:string;ip:string;kind:\"invite_bind_logto_user_succeeded\";logtoSub:string;targetGroupId?:string;targetRoomId?:string;tokenHash:string;ts:string;userAgent:string;userId:string}|{actorId:string;handleHash:string;ip:string;kind:\"logto_password_login_failed\";ts:string;userAgent:string;userId?:string}|{actorId:string;handleHash:string;ip:string;kind:\"logto_password_login_succeeded\";ts:string;userAgent:string;userId:string}|{actorId:string;handleHash:string;ip:string;kind:\"recovery_session_opened\";ts:string;userAgent:string}|{actorId:string;handleHash:string;ip:string;kind:\"recovery_session_rejected\";reason:\"logto_endpoint_missing\"|\"logto_unavailable\"|\"reject\"|\"unexpected_error\";ts:string;userAgent:string}|{actorId:string;handleHash?:string;inviteKind?:string;ip:string;kind:\"invite_bind_logto_user_failed\";logtoSub?:string;reason:string;targetGroupId?:string;targetRoomId?:string;tokenHash?:string;ts:string;userAgent:string}|{actorId:string;inviteId:string;inviteKind:string;ip:string;kind:\"invite_minted\";targetAgentId?:string;targetRoomId?:string;ts:string;userAgent:string}|{actorId:string;inviteId:string;ip:string;kind:\"invite_revoked\";ts:string;userAgent:string}|{actorId:string;inviteKind:string;ip:string;kind:\"invite_redeemed\";landingRoomId:string;newUserId:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"admin_password_reset_issued\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"approval_denied\"|\"approval_granted\";laneKey:string;network?:{host:string;port:number;reason:string;suggestedRule:{cidr?:string;host?:string;ports?:number[];suffix?:string;type:\"cidr\"|\"domain\"|\"wildcard\"}};route:\"POST /api/auth/approval-reply\";threadId:string;ts:string;userAgent:string;verb:\"always\"|\"deny\"|\"once\"|\"room\"}|{actorId:string;ip:string;kind:\"invite_complete_profile_failed\";reason:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"invite_redeem_cleanup_failed\";logtoSub:string;reason:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"invite_redeem_failed\";reason:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"logto_token_mint_failed\";logtoSub:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"pin_enrolled\";route:\"POST /api/auth/pin\";sessionUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"posture_changed\";next:{deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\"};prev:{deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\"};ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"rbac_role_deleted\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"rbac_role_renamed\";label:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"recovery_relay_code_unmatched\";ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"recovery_relay_read_denied\";reason:\"bad_request\"|\"not_found\";ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"resume_thread_auth_denied\";route:string;sessionUserId:string;threadId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_added\";roomId:string;roomRole:\"admin\"|\"member\";targetActorId:string;targetActorKind:\"agent\"|\"user\";targetAgentId?:string;targetUserId?:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_self_joined\";roomId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_self_left\";roomId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_deleted\";logtoRevoked:boolean;targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_disabled\";reason?:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_disabled_session_blocked\";route:string;sessionUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_enabled\";targetUserId:string;ts:string;userAgent:string}[];hasMore:boolean;nextCursor:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.events[].changes",
        "schema": "BoundedSecurityAuditChangesV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.setup.research.provider.nvb2u9",
    "locator": "http:request_response:GET /api/setup/research-provider",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{provider:string;tavilyConfigured?:boolean}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.setup.research.status.1i5q5lq",
    "locator": "http:request_response:GET /api/setup/research-status",
    "structuralSignatures": [
      "response.body:{desktopReaderAvailable:boolean;keylessSearchAvailable:boolean}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.tasks.pending.attention.113t48v",
    "locator": "http:request_response:GET /api/tasks/pending-attention",
    "structuralSignatures": [
      "response.body:{activity?:{appendResult?:boolean;appendResultSeparator?:\"\"|\"\\n\";args:{[key:string]:unknown};endedAt?:number;id:string;kind:\"command\"|\"file_change\"|\"status\"|\"tool\";name:string;result?:string;startedAt:number;status:\"completed\"|\"failed\"|\"running\"|\"waiting\"};detail:string;ownerId:string;taskId:string;taskRunId:string;type:\"task.progress\"}|{actor?:{agentId:string;kind:\"agent\"}|{humanId:string;kind:\"human\"};after?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};before?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};destinationBefore?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};mutation:\"move\";operationId:string;outcome:\"applied\"|\"rebased\";overwrite:true;path:{after?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};before?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};destinationBefore?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};kind:\"move\";overwrite:true};revisionGroupId:string;sequence:number;type:\"document.mutation.committed\"}|{actor?:{agentId:string;kind:\"agent\"}|{humanId:string;kind:\"human\"};after?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};before?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};editorSave?:{anchoredPatch?:{kind:\"anchored_text\";newString:string;oldString:string;replaceAll?:boolean;scope?:{from:number;to:number}};checkpoint:boolean;clientMutationId?:string;requestId?:string};mutation:\"update\";operationId:string;outcome:\"applied\"|\"rebased\";path:{after?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};before?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};kind:\"update\"};revisionGroupId:string;sequence:number;type:\"document.mutation.committed\";workspaceArtifactMetadata?:{afterMimeType:string;beforeMimeType:string}}|{actor?:{agentId:string;kind:\"agent\"}|{humanId:string;kind:\"human\"};after?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};before?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};mutation:\"move\";operationId:string;outcome:\"applied\"|\"rebased\";overwrite:false;path:{after?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};before?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};kind:\"move\";overwrite:false};revisionGroupId:string;sequence:number;type:\"document.mutation.committed\"}|{actor?:{agentId:string;kind:\"agent\"}|{humanId:string;kind:\"human\"};after?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};mutation:\"create\";operationId:string;outcome:\"applied\"|\"rebased\";path:{after?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};kind:\"create\"};revisionGroupId:string;sequence:number;type:\"document.mutation.committed\"}|{actor?:{agentId:string;kind:\"agent\"}|{humanId:string;kind:\"human\"};before?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};mutation:\"delete\";operationId:string;outcome:\"applied\"|\"rebased\";path:{before?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};kind:\"delete\"};revisionGroupId:string;sequence:number;type:\"document.mutation.committed\"}|{actorId:string;createdAt:string;emoji:string;laneKey:string;messageId:number;type:\"reaction.added\"}|{actorId:string;emoji:string;laneKey:string;messageId:number;type:\"reaction.removed\"}|{agentId:string;availableRevisions:number;latest:{createdAt:string;operation:string;pinned:boolean;redoEligible:boolean;revisionId:string;summary:string;turnId:string};path:string;type:\"revisions.state_changed\"}|{agentId?:string;final:boolean;index:number;lang?:string;roomId?:string;text:string;type:\"voice.sentence\";userId?:string}|{agentId?:string;language:string;type:\"voice.suggestion\";userId?:string}|{allowedVerbs:\"always\"|\"deny\"|\"once\"|\"room\"[];approvalId:string;laneKey:string;localMcpInstall?:{digest:string;preview:{availabilitySummary:string;digest:string;environment:{name:string;present:boolean}[];human:string;machine:string;mayDownloadOnFirstRun:boolean;name:string;package:{name:string;version?:string};relayId:string;source:{label:string;url?:string};subprocessSandboxed:false;transport:{args:string[];command:string;kind:\"stdio\"}|{kind:\"streamable-http\";url:string};unpinnedPackage:boolean;version:\"local-mcp-install-v1\"};version:\"local-mcp-install-v1\"};mediaGeneration?:{digest:string;expiresAt:string;preview:{mediaKind:\"music\"|\"video\";model:\"minimax-h3-enhanced-text-to-video\"|\"minimax-music-v26\"|\"seedance-2-5-reference-to-video-basic\"|\"seedance-2-5-text-to-video-basic\"|\"sonilo-v1-1-music\";prompt:{characterCount:number;summary:string;truncated:boolean};quote:{amountMicros:number;currency:\"USD\";display:string};referenceImages?:{artifactId:string;index:number;label:string}[];settings:{[key:string]:false|number|string|true};spendNotice:\"Approving starts a paid generation using this exact quote.\"};quoteDigest:string;revision:1;version:\"media-generation-approval-v1\"};network?:{host:string;port:number;reason:string;suggestedRule:{cidr?:string;host?:string;ports?:number[];suffix?:string;type:\"cidr\"|\"domain\"|\"wildcard\"}};origin?:\"task\";reason:string;reasonCode:\"command-scanner-high\"|\"command-scanner-medium\"|\"destructive-tool\"|\"external-binary\"|\"network-egress-denied\"|\"tier-bump\";requiresExplicitReview?:boolean;scopeInfo?:{approvalKind?:\"capability\"|\"tool\";capabilitySlug?:string;generalizedDisplay:string;onceDisplay:string;sameAsOnce:boolean}[];structuredSsh?:{approvedRequestDigest:string;argv?:string[];host:string;hostKeyFingerprint:string;hostTrust:\"changed\"|\"trusted\"|\"unknown\";localPath?:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";port:number;preparationId:string;previousHostKeyFingerprint?:string;program?:string;remotePath?:string;remoteUser:string;timeoutReason?:string;timeoutSeconds?:number;toolCallId:string;version:\"structured-ssh-v1\"};taskId?:string;taskRunId?:string;threadId:string;tools:{args:{[key:string]:unknown};id?:string;name:string;runShellTimeout?:{reason:string;timeoutSeconds:number};shareArtifactPreview?:{artifactPathSnippet:string;mimeType:string;roomLabel:string;sensitivity:\"normal\"|\"sensitive\";size:number;targetDisplayName:string;targetHandle:string;wouldCreate:boolean};shareMemoryPreview?:{memoryContentSnippet:string;memoryType:string;projection?:{audienceWarning:string;content:string;memberCount:number;mode:\"project\";roomKind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";roomLabel:string};roomLabel:string;sensitivity:\"normal\"|\"sensitive\";targetDisplayName:string;targetHandle:string;wouldCreate:boolean}}[];type:\"approval.ask\";userId?:string}|{anchorMessageId:number;laneKey:string;lastReplyAt:string;replyCount:number;summaryRevision:number;type:\"thread.summary.changed\"}|{approvalId:string;laneKey?:string;origin?:\"task\";resolution:\"approved\"|\"cancelled\"|\"denied\"|\"expired\";taskId?:string;taskRunId?:string;threadId:string;type:\"approval.resolved\";userId:string;verb?:\"always\"|\"deny\"|\"once\"|\"room\"}|{argsSummary?:string;authorAgentId?:string;laneKey?:string;toolCallId:string;toolName:string;turnId?:string;type:\"tool.start\"}|{artifactId:string;clientMutationId?:string;id:string;path:string;reloadRequired?:boolean;type:\"workspace.artifact.changed\"}|{artifactId:string;id:string;namespaceIds:string[];type:\"workspace.artifact.deleted\"}|{artifactId:string;id:string;newPath:string;oldPath:string;type:\"workspace.artifact.renamed\"}|{artifacts?:{artifactInternalId:string;basename:string;mimeType:string;roomId:string;sizeBytes:number}[];assistantMessageKey?:string;authorAgentId?:string;authorHarnessId?:string;content:string;editRevision?:number;laneKey:string;logicalMessageKey?:string;messageId:string;replyToMessageId?:number;role:\"ai\"|\"human\"|\"system\"|\"user\";senderUserId?:string;sourceUserId?:string;type:\"message.new\";workcardContinuation?:{kind:\"advanced_video\";referenceCount:number}}|{assistantMessageKey?:string;authorAgentId?:string;chunkSequence:number;content:string;done:boolean;laneKey:string;tokenUsage?:{inputTokens:number;outputTokens:number;totalTokens:number};turnId?:string;type:\"message.tokens\"}|{at:string;deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";networkPolicy:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";type:\"policy.changed\"}|{author:{displayName:string;kind:\"agent\"|\"app_tool\"|\"human\"};clientMutationId?:string;patch:{kind:\"anchored_text\";newString:string;oldString:string;replaceAll?:boolean;scope?:{from:number;to:number}};patchId:string;previousRevision:number;previousSha256:string;rebased?:boolean;requestId?:string;revision:number;sha256:string;target:{artifactInternalId:string;kind:\"artifact\";mimeType?:string;path:string;roomId?:string}|{currentFolderRef:string;kind:\"currentFile\";relativePath:string;relayOwnerUserId?:string};type:\"document.patch.applied\"}|{authorAgentId?:string;done:true;laneKey:`room:${string}`;protection:\"protected\";streaming:\"suppressed\";turnId?:string;type:\"message.tokens\";wireVersion:2}|{authorAgentId?:string;droppedBytes?:number;elapsedMs:number;endOffsetBytes:number;kind:\"exec-output\";laneKey?:string;offsetBytes:number;operation:\"exec\";phase:\"running\";sequence:number;stream:\"stderr\"|\"stdout\";text:string;toolCallId:string;turnId?:string;type:\"tool.structured_ssh.progress\";version:1}|{authorAgentId?:string;droppedBytes?:number;elapsedMs:number;endOffsetBytes:number;laneKey?:string;offsetBytes:number;phase:\"running\";sequence:number;stream:\"stderr\"|\"stdout\";text:string;toolCallId:string;turnId?:string;type:\"tool.run_shell.progress\";version:1}|{authorAgentId?:string;duration:number;error?:string;laneKey?:string;result?:string;resultTruncated?:boolean;runShellOutcome?:\"unknown\";status:\"error\"|\"success\";toolCallId:string;toolName:string;turnId?:string;type:\"tool.end\"}|{authorAgentId?:string;elapsedMs:number;kind:\"transfer\";laneKey?:string;operation:\"copy-download\"|\"copy-upload\";phase:\"starting\"|\"transferring\";sequence:number;toolCallId:string;totalBytes?:number;transferredBytes:number;turnId?:string;type:\"tool.structured_ssh.progress\";version:1}|{authorAgentId?:string;laneKey:string;phase:\"post_model\"|\"preparing_tool\"|\"thinking\";turnId:string;type:\"agent.progress\"}|{authorizationPlanBytesBase64url:string;authorizationScheme:\"runtime_foreground_v1\";clientActionSessionId:string;deadlineAt:number;invocationId:string;laneKey:string;recipientPublicKeyBase64url:string;roomId:string;sourceHumanPlanBytesBase64url:string;type:\"message.runtime_invocation_authorization_required\";userId:string;wireVersion:1}|{authorizationPlanBytesBase64url?:string;authorizationScheme?:\"runtime_foreground_v1\";clientActionSessionId:string;deadlineAt:number;executionId:string;laneKey:string;ordinaryPayloadBytesBase64url?:string;planBytesBase64url?:string;recipientPublicKeyBase64url?:string;roomId:string;sourceHumanPlanBytesBase64url?:string;type:\"message.shared_agent_authorization_required\";userId:string;wireVersion:1}|{awaitingFromUserIds:string[];laneKey?:string;ownerId:string;targetRoomId:string;taskId?:string;taskRunId?:string;threadId?:string;type:\"task.awaiting_reply\"}|{botActorId:string;change:\"cleared\"|\"extended\"|\"opened\";laneKey:string;reason:string;roomId:string;source:\"inferred\"|\"mention\"|\"reply\"|\"ui\";type:\"conductor.focus_changed\";userActorId:string}|{challengeId:string;expiresAt:string;laneKey:string;mode?:\"enrollPin\"|\"verify\";origin?:\"task\";taskId?:string;taskRunId?:string;threadId:string;type:\"identity.challenge\";userId?:string}|{choiceId:string;laneKey:string;options:{label:string;selector:string}[];threadId:string;toolCallId:string;toolName:string;type:\"host.choice\";userId?:string}|{chunkIndex:number;data:string;final:boolean;roomId?:string;sentenceIndex:number;type:\"voice.audio\";userId?:string}|{conductorMode:\"advanced\"|\"standard\";laneKey:string;roomId:string;type:\"room.conductor_mode.changed\"}|{content:string;editRevision:number;editedAt:string;laneKey:string;logicalMessageKey:string;type:\"message.updated\"}|{cursor:{sequence:number;snapshotRevision:number;streamId:string};hosts:{connected:boolean;label:string;lastSeenAt:string;readiness:\"compatible_online\"|\"identity_conflict\"|\"incompatible_online\"|\"offline\"|\"stale\"|\"unknown\";remoteHostId:string}[];type:\"remote.host.snapshot\"}|{detail?:string;jobId:string;kind?:\"deep-research\";laneKey?:string;phase:string;type:\"job.progress\"}|{displayName:string;roomId:string;type:\"typing.ping\";userId:string}|{displayReason:string;humanTurnId?:string;laneKey:string;messageId:string;options?:{botActorId:string;handle:string}[];outcome:\"ask_user\"|\"error\"|\"silent\"|\"wake\";reasonCode:\"ask_ambiguous_direct\"|\"ask_ambiguous_history\"|\"ask_router\"|\"redirect_rejected_duplicate\"|\"redirect_rejected_enqueue_failed\"|\"redirect_rejected_explicitly_selected\"|\"redirect_rejected_ineligible_target\"|\"redirect_rejected_no_target\"|\"redirect_rejected_same_source\"|\"redirect_rejected_visible_output\"|\"redirected\"|\"routing_error\"|\"silent_human_addressed\"|\"silent_no_route\"|\"silent_no_wakeable\"|\"silent_not_addressed\"|\"silent_router\"|\"silent_router_unresolved\"|\"wake_active_focus\"|\"wake_history\"|\"wake_mention\"|\"wake_reply\"|\"wake_router\"|\"wake_ui\"|\"wake_vocative\";roomId:string;selectedHandles?:string[];type:\"conductor.decision\";userActorId:string;userId:string}|{done:boolean;frameBytesBase64url:string;laneKey:string;operationId:string;ordinaryChunk:string;transcriptOrdinal:number;type:\"message.shadow_stream_frame\";wireVersion:1}|{done:boolean;frameBytesBase64url:string;laneKey:string;operationId:string;ordinaryChunk:string;transcriptOrdinal:number;type:\"message.shared_agent_stream_frame\";wireVersion:1}|{droppedCount:number;errorCode:string;sessionId:string;threadId:string;type:\"session.persistence_failed\"}|{durableEventDigestBase64url:string;laneKey:string;logicalMessageKey:string;operationId:string;ordinaryPayloadBytesBase64url:string;planBytesBase64url:string;policyRevision:number;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};protectedMessageDigestBase64url:string;requestBytesBase64url:string;senderDeviceSigningPublicKeyBase64url:string;transcriptOrdinal:number;type:\"message.human_peer_shadow\";wireVersion:1}|{durableEventDigestBase64url:string;laneKey:string;logicalMessageKey:string;operationId:string;ordinaryPayloadBytesBase64url:string;planBytesBase64url:string;policyRevision:number;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};protectedMessageDigestBase64url:string;requestBytesBase64url:string;senderDeviceSigningPublicKeyBase64url:string;transcriptOrdinal:number;type:\"message.shared_agent_shadow\";wireVersion:1}|{durableEventDigestBase64url:string;laneKey:string;operationId:string;ordinaryPayloadBytesBase64url:string;planBytesBase64url:string;policyRevision:number;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};transcriptOrdinal:number;type:\"message.shared_agent_output_shadow\";wireVersion:1}|{durableEventDigestBase64url:string;laneKey:string;operationId:string;ordinaryPayloadBytesBase64url:string;policyRevision:number;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};transcriptOrdinal:number;type:\"message.shadow_durable\";wireVersion:1}|{editRevision:number;laneKey:`room:${string}`;logicalMessageKey:string;message:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};protection:\"protected\";type:\"message.updated\";wireVersion:2}|{errorCategory?:\"auth\"|\"bad_request\"|\"context_exceeded\"|\"provider_unavailable\"|\"rate_limit\"|\"timeout\"|\"unknown\";jobId:string;laneKey?:string;message?:string;status:\"cancelled\"|\"completed\"|\"failed\"|\"queued\"|\"running\"|\"timed_out\";type:\"job.status\"}|{event:{actorId:string;actorKind:\"agent\"|\"user\";displayName:string;kind:\"member_added\"|\"member_removed\"};recipientSyncNamespaceId?:string;roomId:string;type:\"room_members_changed\"}|{eventId:string;host:{connected:boolean;label:string;lastSeenAt:string;readiness:\"compatible_online\"|\"identity_conflict\"|\"incompatible_online\"|\"offline\"|\"stale\"|\"unknown\";remoteHostId:string};remoteHostId:string;sequence:number;snapshotRevision:number;streamId:string;type:\"remote.host.connected\"}|{eventId:string;host:{connected:boolean;label:string;lastSeenAt:string;readiness:\"compatible_online\"|\"identity_conflict\"|\"incompatible_online\"|\"offline\"|\"stale\"|\"unknown\";remoteHostId:string};remoteHostId:string;sequence:number;snapshotRevision:number;streamId:string;type:\"remote.host.updated\"}|{eventId:string;remoteHostId:string;sequence:number;snapshotRevision:number;streamId:string;terminalReason:\"identity_conflict\"|\"offline\";type:\"remote.host.disconnected\"}|{eventId:string;remoteHostId:string;sequence:number;snapshotRevision:number;streamId:string;terminalReason:\"revoked\";type:\"remote.host.revoked\"}|{expiresAt?:string;jobId:string;ownerId:string;request?:{autoResolutionMs?:number;kind:\"user_input_required\";questions:{allowOther:boolean;header:string;id:string;multiSelect?:boolean;options?:{description?:string;id:string;label:string}[];prompt:string;secret:boolean}[]}|{command:{actionKinds:\"list_files\"|\"read\"|\"search\"|\"unknown\"[];detail:\"host_local_only\"|\"not_provided\"};kind:\"command_approval_required\";options:\"approve\"|\"approve_for_session\"|\"cancel\"|\"deny\"[];reason:\"host_local_only\"|\"not_provided\"}|{grantRoot:\"host_local_only\"|\"not_provided\";kind:\"file_change_approval_required\";options:\"approve\"|\"approve_for_session\"|\"cancel\"|\"deny\"[];reason:\"host_local_only\"|\"not_provided\"}|{kind:\"network_approval_required\";network:{host:string;protocol:\"http\"|\"https\"|\"socks5Tcp\"|\"socks5Udp\"};options:\"approve\"|\"approve_for_session\"|\"cancel\"|\"deny\"[];reason:\"host_local_only\"|\"not_provided\"}|{kind:\"permission_selection_required\";options:{id:string;label:string;semanticHint?:string}[];tool:{kind?:string;title?:string}}|{kind:\"permissions_approval_required\";permissions:{fileSystem?:{entryCount:number;pathDetail:\"host_local_only\"|\"not_provided\";readPathCount:number;writePathCount:number};network?:{enabled?:boolean}};reason:\"host_local_only\"|\"not_provided\"};requestId:string;roomId:string;taskId:string;type:\"codex.request\"}|{forkThreadId:string;jobId:string;laneKey:string;parentJobId?:string;parentThreadId:string;sequence:number;syntheticNoteCount:number;type:\"job.forked\";virtualJobIds:string[]}|{forkThreadId:string;jobId:string;laneKey:string;parentThreadId:string;sequence:number;splicedMessageCount:number;type:\"fork.spliced\"}|{from:string;laneKey:string;reason:\"auth\"|\"bad_request\"|\"context_exceeded\"|\"provider_unavailable\"|\"rate_limit\"|\"timeout\"|\"unknown\";to:string;turnId:string;type:\"model.fallback\"}|{hardExpiresAt:string;leaseExpiresAt:string;operationId:string;state:\"applying\"|\"draining\"|\"normal\";type:\"maintenance.status\"}|{humanTurnId?:string;laneKey:string;messageId:string;options:{botActorId:string;handle:string}[];reason:string;roomId:string;type:\"conductor.ask_user\";userActorId:string;userId:string}|{jobId:string;laneKey:string;type:\"job.dispatched\";virtualJobIds:string[]}|{jobId:string;result:\"failed\"|\"success\"|\"timed_out\";type:\"worker.complete\"}|{keyClass:\"ai\"|\"human\";laneKey:string;namespaceId:string;roomId:string;type:\"crypto.domain_key_catch_up_delivered\"|\"crypto.domain_key_catch_up_requested\"}|{laneKey:`room:${string}`;message:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};protection:\"protected\";type:\"message.new\";wireVersion:2}|{laneKey:string;messageId:number;type:\"message.deleted\"}|{laneKey:string;operationId:string;planBytesBase64url:string;streamStartBytesBase64url:string;transcriptOrdinal:number;type:\"message.shared_agent_stream_start\";wireVersion:1}|{laneKey:string;operationId:string;streamStartBytesBase64url:string;transcriptOrdinal:number;type:\"message.shadow_stream_start\";wireVersion:1}|{laneKey:string;origin?:\"task\";taskId?:string;taskRunId?:string;threadId:string;tools:{args:{[key:string]:unknown};id?:string;name:string;runShellTimeout?:{reason:string;timeoutSeconds:number};shareArtifactPreview?:{artifactPathSnippet:string;mimeType:string;roomLabel:string;sensitivity:\"normal\"|\"sensitive\";size:number;targetDisplayName:string;targetHandle:string;wouldCreate:boolean};shareMemoryPreview?:{memoryContentSnippet:string;memoryType:string;projection?:{audienceWarning:string;content:string;memberCount:number;mode:\"project\";roomKind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";roomLabel:string};roomLabel:string;sensitivity:\"normal\"|\"sensitive\";targetDisplayName:string;targetHandle:string;wouldCreate:boolean}}[];type:\"prove_it.challenge\";userId?:string}|{laneKey:string;ownerId:string;taskId:string;taskRunId:string;type:\"task.fired\"}|{laneKey:string;roomId:string;silence:{botActorId:string;botDisplayName:string;expiresAt:string;id:string;kind:\"deaf\"|\"mute\";setByDisplayName:string};type:\"room.silence.changed\"}|{laneKey:string;roomId:string;state:\"deciding\"|\"settled\";type:\"conductor.routing\";userActorId:string}|{laneKey:string;type:\"job.coalesced\";virtualJobId:string}|{messageId:string;occurredAt:string;parentRoomLabel?:string;roomId:string;roomLabel:string;senderActorId:string;senderDisplayName:string;topLevelRoomId:string;type:\"notification.message.important\";userId:string}|{name:string;onboardingCompleted:boolean;profileId:string;type:\"profile.updated\";userId?:string}|{ownerId:string;requestId:string;type:\"codex.request.resolved\"}|{ownerId:string;status:string;taskId:string;taskRunId:string;type:\"task.completed\"}|{ownerId:string;status:string;taskId:string;taskRunId:string;type:\"task.errored\"}|{ownerId:string;status:string;taskId:string;type:\"task.status\"}|{roomId:string;roomOwnImportantUnreadCount:number;roomOwnUnreadCount:number;topLevelImportantUnreadCount:number;topLevelRoomId:string;topLevelUnreadCount:number;type:\"room.notification.changed\";userId:string}|{speaking:boolean;type:\"voice.status\";voice:\"off\"|\"on\"}|{type:\"room.catalog.changed\"}|{type:\"voice.stop\"}[]",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body[].activity.args",
        "schema": "TaskAttentionToolArgumentsV1"
      },
      {
        "path": "response.body[].tools[].args",
        "schema": "TaskAttentionToolArgumentsV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.connections.oauth.complete.1rvn12q",
    "locator": "http:request_response:GET /connections/oauth/complete",
    "structuralSignatures": [
      "response.body:\"<!doctype html><html lang=\\\"en\\\"><head><meta charset=\\\"utf-8\\\"><meta name=\\\"viewport\\\" content=\\\"width=device-width,initial-scale=1\\\"><title>Return to Nautilo</title><style>body{margin:0;background:#111;color:#f5f5f5;font:16px system-ui;display:grid;min-height:100vh;place-items:center}main{max-width:32rem;padding:2rem;text-align:center}p{color:#aaa;line-height:1.5}</style></head><body><main><h1>Return to Nautilo</h1><p>Your account has returned control to Nautilo. Go back to the Nautilo app while it verifies your connection. You can close this page.</p></main></body></html>\""
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.admin.encryption.transition.114o1ir",
    "locator": "http:request_response:POST /api/admin/encryption-transition",
    "structuralSignatures": [
      "response.body:unknown",
      "response.body:{coverageReadiness:{protected:string;registered:string;unexercised:string;unsupported:string};domainKeyAuthority:{authority:{aiDomainHeads:string;aiNamespaceBundleAdvances:string;aiNamespaceBundles:string;humanDomainHeads:string;humanNamespaceBundleAdvances:string;humanNamespaceBundles:string};catchUp:{acknowledged:string;delivered:string;expired:string;requested:string;stale:string;unrecoverable:string;waiting:string};scope:\"domain_key_v2\"};dtoVersion:2;historyReads:{eligible:string;fallback:string;outcomes:{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"failed\";reason:\"integrity_failure\"|\"parity_mismatch\"|\"publication_failure\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"pending\";reason:\"none\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"reconciling\";reason:\"response_lost\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"unavailable\";reason:\"client_crypto_preparation_failed\"|\"client_crypto_unavailable\"|\"client_custody_unavailable\"|\"client_observation_expired\"|\"current_read_authority_unavailable\"|\"live_shadow_lifecycle_unavailable\"|\"namespace_encryption_not_ready\"|\"retained_key_material_unavailable\"|\"signer_evidence_unavailable\"|\"stale_authority_product\"|\"unmigrated\"|\"unsupported_operation\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"verified\";reason:\"none\"}[];pagesAttempted:string;pagesPending:string;pending:string;percent?:number;scope:\"browser_room_history_shadow_reads\";selected:string;verified:string};humanPeerLive:{recipientReads:{attempted:string;fallback:string;percent?:number;verified:string};scope:\"browser_human_only_live_messages\";writes:{eligible:string;fallback:string;pending:string;percent?:number;published:string}};liveTurns:{completeRoundTrip:{eligible:string;percent?:number;verified:string};entities:{eligible:string;entity:\"final_agent_message\"|\"human_message\"|\"tool_call\"|\"tool_result\";percent?:number;verified:string}[];fallbacks:{count:string;reason:\"agent_authority_unavailable\"|\"cancelled\"|\"deadline_expired\"|\"device_unavailable\"|\"domain_unavailable\"|\"integrity_failure\"|\"namespace_unavailable\"|\"parity_mismatch\"|\"product_conflict\"|\"protected_unavailable\"|\"recipient_lost\"|\"reservation_unavailable\"|\"stale_authority\";stage:\"agent_input\"|\"assistant_message\"|\"assistant_stream\"|\"client_verification\"|\"durable_transcript\"|\"human_admission\"|\"plan\"|\"session_establishment\"|\"session_reuse\"|\"shutdown\"|\"tool_call\"|\"tool_result\"}[];pending:{oldestPendingAt?:string;turns:string};scope:\"live_new_browser_private_room_turns\";stages:{eligible:string;percent?:number;stage:\"agent_protected_input\"|\"agent_stream_frame_chain\"|\"assistant_tool_call_boundary\"|\"browser_durable_transcript_parity\"|\"browser_human_prepare\"|\"browser_stream_frame_chain\"|\"browser_terminal_acknowledgement\"|\"human_durable_mapping\"|\"server_human_open_parity\"|\"tool_result_boundary\"|\"transcript_durable_mappings\";verified:string}[]};metrics:{attemptOutcomes:{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"failed\";reason:\"integrity_failure\"|\"parity_mismatch\"|\"publication_failure\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"pending\";reason:\"none\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"reconciling\";reason:\"response_lost\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"unavailable\";reason:\"client_crypto_preparation_failed\"|\"client_crypto_unavailable\"|\"client_custody_unavailable\"|\"client_observation_expired\"|\"current_read_authority_unavailable\"|\"live_shadow_lifecycle_unavailable\"|\"namespace_encryption_not_ready\"|\"retained_key_material_unavailable\"|\"signer_evidence_unavailable\"|\"stale_authority_product\"|\"unmigrated\"|\"unsupported_operation\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"verified\";reason:\"none\"}[];attemptSuccess:{eligible:string;percent?:number;verified:string};family:\"artifact\"|\"memory\"|\"message\"|\"overall\"|\"record\";pendingLifecycle:{oldestPendingAt?:string;operations:string};storedCoverage:{percent?:number;total:string;verified:string};touchedCoverage:{percent?:number;total:string;verified:string}}[];observationPressure:{admissionCapacity:string;capacityRows:string;maximumRetentionMs:number;pendingAdmissions:string;retainedRows:string};policy:{mode:\"plaintext_only\"|\"shadow_encryption\";revision:number;shadowBehavior:\"fallback\"|\"strict\";shadowEncryptionStartedAt?:string;updatedAt:string};runtimeHealth:{boundaries:{actorClass:\"agent\"|\"background\"|\"conductor\"|\"human\"|\"tool\";boundaryId:string;family:string;lastObservedAt?:string;occurrenceCount:string;operation:string;reason:string;state?:\"failed\"|\"repairing\"|\"unexercised\"|\"unsupported\"|\"verified\"|\"waiting_for_authority\"}[];failed:string;lastObservedAt?:string;policyRevision:number;repairing:string;unexercised:string;unsupported:string;verified:string;waitingForAuthority:string};sharedAgentLive:{agentRecipientReads:{attempted:string;fallback:string;percent?:number;verified:string};authorization:{established:string;expired:string;reused:string;revoked:string;unavailable:string};conductor:{authorizationEstablished:string;authorizationReused:string;awaitingAuthorization:string;awaitingUser:string;currentInputVerified:string;deterministic:string;eligible:string;fallback:string;fallbackReasons:{count:string;reason:string}[];floorManager:string;historyNotRequested:string;historyUnavailable:string;historyVerified:string;notSelected:string;selected:string;selectedAgentExecutions:string;unavailable:string;verifiedAwaitingUser:string;verifiedSilent:string;verifiedWake:string};executions:{authorized:string;awaitingAuthorization:string;completed:string;failed:string;fallback:string;protectedInputs:string;running:string};outputStages:{assistantPublished:string;streamCompleted:string;streamStarted:string;toolPublished:string};planningFallbacks:{deviceUnavailable:string;namespaceUnavailable:string;recipientSyncRequired:string;unavailable:string};recipientCoverage:{plaintextOnlyHumans:string;protectedDevices:string;protectedHumans:string;totalHumans:string};recipientReads:{attempted:string;fallback:string;percent?:number;verified:string};resumes:{attempted:string;authorized:string;awaitingAuthorization:string;completed:string;failed:string;fallback:string;running:string};scope:\"browser_multi_human_single_agent_live_messages\";writes:{eligible:string;fallback:string;pending:string;percent?:number;published:string}}}",
      "response.body:{currentRevision:number;error:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body",
        "schema": "EncryptionTransitionControlV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.apps.appid.live.session.apply.accepted.vkuwes",
    "locator": "http:request_response:POST /api/apps/:appId/live-session/apply-accepted",
    "structuralSignatures": [
      "request.body:{[key:string]:unknown}",
      "request.params:{appId:string}",
      "response.body:any",
      "response.body:{contentSha256:string;documentVersion:{kind:\"artifact_revision\";revision:number}|{kind:\"local_sha\";sha256:string};localRevisionRef?:string}",
      "response.body:{error:any}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "debtId": "debt.wire.arbitrary.11419pc"
      },
      {
        "path": "response.body",
        "debtId": "debt.wire.arbitrary.u00xqk"
      },
      {
        "path": "response.body.error",
        "debtId": "debt.wire.arbitrary.1em27u8"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.apps.appid.live.session.invalidate.review.1dx5obq",
    "locator": "http:request_response:POST /api/apps/:appId/live-session/invalidate-review",
    "structuralSignatures": [
      "request.params:{appId:string}",
      "response.body:{error:any}",
      "response.body:{error:string}",
      "response.body:{ok:true;taskStatus:\"failed\"|\"not_task\"|\"running\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.error",
        "schema": "LiveReviewRouteErrorV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.apps.appid.live.session.resolve.review.1o7tc4d",
    "locator": "http:request_response:POST /api/apps/:appId/live-session/resolve-review",
    "structuralSignatures": [
      "request.params:{appId:string}",
      "response.body:{error:any}",
      "response.body:{error:string}",
      "response.body:{ok:true;taskStatus:\"cancelled\"|\"completed\"|\"not_task\"|\"pending\"|\"running\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.error",
        "schema": "LiveReviewRouteErrorV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.apps.appid.live.session.reviews.1zam7b",
    "locator": "http:request_response:POST /api/apps/:appId/live-session/reviews",
    "structuralSignatures": [
      "request.body:{sessionToken?:unknown}",
      "request.params:{appId:string}",
      "response.body:{error:string}",
      "response.body:{proposals:{appId:string;documentVersion:{kind:\"artifact_revision\";revision:number}|{kind:\"local_sha\";sha256:string};operations:unknown[];proposalId:string;sessionId:string}[]}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.sessionToken",
        "schema": "BoundedOpaqueLiveSessionTokenV1"
      },
      {
        "path": "response.body.proposals[].operations[]",
        "schema": "PreflightedLiveReviewOperationV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.connected.apps.providerid.oauth.aami5j",
    "locator": "http:request_response:POST /api/connected-apps/:providerId/oauth",
    "structuralSignatures": [
      "request.params:{providerId:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.connected.web.accounts.8i5zzr",
    "locator": "http:request_response:POST /api/connected-web-accounts",
    "structuralSignatures": [
      "response.body:never",
      "response.body:{account:{createdAt:string;id:string;label:string;lastVerifiedAt?:string;origin:string;service:string;status:\"attention_needed\"|\"busy\"|\"connected\"|\"connecting\"|\"error\"|\"expired\"|\"provider_unavailable\"|\"revoked\";updatedAt:string};createdNewAccount:boolean;login:{expiresAt:string;liveViewUrl:string}}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.connected.web.accounts.id.cancel.login.ldka4e",
    "locator": "http:request_response:POST /api/connected-web-accounts/:id/cancel-login",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:never",
      "response.body:{account:{createdAt:string;id:string;label:string;lastVerifiedAt?:string;origin:string;service:string;status:\"attention_needed\"|\"busy\"|\"connected\"|\"connecting\"|\"error\"|\"expired\"|\"provider_unavailable\"|\"revoked\";updatedAt:string}}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.connected.web.accounts.id.cancel.read.1n8w29l",
    "locator": "http:request_response:POST /api/connected-web-accounts/:id/cancel-read",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:never",
      "response.body:{account:{createdAt:string;id:string;label:string;lastVerifiedAt?:string;origin:string;service:string;status:\"attention_needed\"|\"busy\"|\"connected\"|\"connecting\"|\"error\"|\"expired\"|\"provider_unavailable\"|\"revoked\";updatedAt:string}}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.connected.web.accounts.id.close.page.1xu4jzg",
    "locator": "http:request_response:POST /api/connected-web-accounts/:id/close-page",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:never",
      "response.body:{account:{createdAt:string;id:string;label:string;lastVerifiedAt?:string;origin:string;service:string;status:\"attention_needed\"|\"busy\"|\"connected\"|\"connecting\"|\"error\"|\"expired\"|\"provider_unavailable\"|\"revoked\";updatedAt:string}}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.connected.web.accounts.id.finish.1edvbwb",
    "locator": "http:request_response:POST /api/connected-web-accounts/:id/finish",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:never",
      "response.body:{createdAt:string;id:string;label:string;lastVerifiedAt?:string;origin:string;service:string;status:\"attention_needed\"|\"busy\"|\"connected\"|\"connecting\"|\"error\"|\"expired\"|\"provider_unavailable\"|\"revoked\";updatedAt:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.connected.web.accounts.id.open.page.1hqi8h4",
    "locator": "http:request_response:POST /api/connected-web-accounts/:id/open-page",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:never",
      "response.body:{account:{createdAt:string;id:string;label:string;lastVerifiedAt?:string;origin:string;service:string;status:\"attention_needed\"|\"busy\"|\"connected\"|\"connecting\"|\"error\"|\"expired\"|\"provider_unavailable\"|\"revoked\";updatedAt:string};createdNewAccount:boolean;login:{expiresAt:string;liveViewUrl:string}}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.connected.web.accounts.id.reconnect.1glcnsx",
    "locator": "http:request_response:POST /api/connected-web-accounts/:id/reconnect",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:never",
      "response.body:{account:{createdAt:string;id:string;label:string;lastVerifiedAt?:string;origin:string;service:string;status:\"attention_needed\"|\"busy\"|\"connected\"|\"connecting\"|\"error\"|\"expired\"|\"provider_unavailable\"|\"revoked\";updatedAt:string};createdNewAccount:boolean;login:{expiresAt:string;liveViewUrl:string}}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.connected.web.accounts.id.watch.read.qnfffy",
    "locator": "http:request_response:POST /api/connected-web-accounts/:id/watch-read",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:never",
      "response.body:{error:string}",
      "response.body:{liveViewUrl:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.health.keys.validate.1fst0pq",
    "locator": "http:request_response:POST /api/health/keys/validate",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{keys:{category:\"browser\"|\"conversion\"|\"llm\"|\"llm+embeddings\"|\"search\"|\"voice\";envVar:string;formatHint:string;hint:string;id:string;masked:string;name:string;purpose:string;required:boolean;signupUrl:string;status:\"invalid_format\"|\"invalid_key\"|\"missing\"|\"present\"|\"unreachable\"|\"verified\"}[];summary:{configured:number;hasConversion:boolean;hasEmbeddings:boolean;hasLlm:boolean;hasSearch:boolean;hasVoice:boolean;invalid:number;missing:number;total:number;verified:number}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.additional.operationid.activate.c0y3tj",
    "locator": "http:request_response:POST /api/protected/devices/additional/:operationId/activate",
    "structuralSignatures": [
      "response.body:{custodyRevision?:number;deviceId:string;deviceRevision?:number;formatVersion:1;operationId:string;status:\"active\"|\"syncing\";syncReason?:\"current_domain_sync_required\"|\"delivery_pending\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.membership.acknowledge.1mz2n8k",
    "locator": "http:request_response:POST /api/protected/devices/membership/acknowledge",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.membership.begin.1enf2o5",
    "locator": "http:request_response:POST /api/protected/devices/membership/begin",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.membership.initial.177ezf8",
    "locator": "http:request_response:POST /api/protected/devices/membership/initial",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.membership.operationid.add.198wieu",
    "locator": "http:request_response:POST /api/protected/devices/membership/:operationId/add",
    "structuralSignatures": [
      "response.body:{catch:function;finally:function;then:function}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.membership.operationid.join.1hhlkc3",
    "locator": "http:request_response:POST /api/protected/devices/membership/:operationId/join",
    "structuralSignatures": [
      "response.body:{catch:function;finally:function;then:function}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.membership.operationid.recovery.ptw94o",
    "locator": "http:request_response:POST /api/protected/devices/membership/:operationId/recovery",
    "structuralSignatures": [
      "response.body:{catch:function;finally:function;then:function}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.membership.operationid.remove.1ivhmkf",
    "locator": "http:request_response:POST /api/protected/devices/membership/:operationId/remove",
    "structuralSignatures": [
      "response.body:{catch:function;finally:function;then:function}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.membership.pending.97tc0b",
    "locator": "http:request_response:POST /api/protected/devices/membership/pending",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.membership.recovery.begin.q0fnwt",
    "locator": "http:request_response:POST /api/protected/devices/membership/recovery/begin",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.membership.roster.1tl6idv",
    "locator": "http:request_response:POST /api/protected/devices/membership/roster",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.membership.status.3e3cy",
    "locator": "http:request_response:POST /api/protected/devices/membership/status",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.id.members.8q9uus",
    "locator": "http:request_response:POST /api/rooms/:id/members",
    "structuralSignatures": [
      "request.body:{agentId?:string;kind?:string;roomRole?:string;userId?:string}",
      "request.params:{id:string}",
      "response.body:{actorId:string;kind:\"agent\"|\"user\";ok:boolean;protectedEncryption:{accessRevision:number;namespaceId:string;status:string}}",
      "response.body:{actorId:string;kind:\"agent\"|\"user\";ok:boolean}",
      "response.body:{code:string}",
      "response.body:{error:\"agent_not_found\"|\"agent_not_reachable\"|\"user_not_reachable\"}",
      "response.body:{error:\"agent_not_found\"}",
      "response.body:{error:\"agent_not_reachable\"|\"user_not_found\"|\"user_not_reachable\"}",
      "response.body:{error:\"subthread_member_not_in_parent\";message:string}",
      "response.body:{error:\"user_not_found\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.put.api.connected.apps.providerid.setup.1eoap6",
    "locator": "http:request_response:PUT /api/connected-apps/:providerId/setup",
    "structuralSignatures": [
      "request.params:{providerId:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.put.api.setup.research.provider.2u0o2y",
    "locator": "http:request_response:PUT /api/setup/research-provider",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{provider:\"auto\"|\"duckduckgo_html\";tavilyConfigured?:boolean}"
    ],
    "arbitraryPayloads": []
  }
];

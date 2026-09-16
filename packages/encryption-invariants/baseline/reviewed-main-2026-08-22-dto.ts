import type { DtoDeclaration } from "../src/node/dto-inventory";

export const SUPERSEDED_MAIN_2026_08_22_DTO_LOCATORS =
  new Set<string>([
  "http:accepted_arbitrary:packages/server/src/messaging/dispatch.ts#RoomPostMessageBody",
  "http:request_response:GET /api/admin/encryption-transition",
  "http:request_response:GET /api/admin/reflection-status",
  "http:request_response:GET /api/rooms",
  "http:request_response:GET /api/rooms/:id/addable-agents",
  "http:request_response:GET /api/rooms/discoverable",
  "http:request_response:GET /api/rooms/manageable",
  "http:request_response:GET /api/rooms/search",
  "http:request_response:GET /api/security/audit-log",
  "http:request_response:PATCH /api/tasks/:id",
  "http:request_response:POST /api/admin/encryption-transition",
  "http:request_response:POST /api/rooms/:roomId/messages",
  "http:request_response:POST /api/tasks"
]);

export const REVIEWED_MAIN_2026_08_22_DTO_DECLARATIONS:
  readonly DtoDeclaration[] = [
  {
    "observationId": "wire.http.accepted.arbitrary.packages.server.src.messaging.dispatch.ts.roompostmessagebody.cpix9d",
    "locator": "http:accepted_arbitrary:packages/server/src/messaging/dispatch.ts#RoomPostMessageBody",
    "structuralSignatures": [
      "declaration.payload:{activeMiniApp?:null|unresolved<ActiveMiniAppRequestContext>;artifactRefs?:unknown;attachments?:unknown;autoApprove?:boolean;cardContinuation?:unknown;clientActionSessionId?:unknown;content:string;currentFolder?:null|string;currentFolderRelayId?:null|string;focusedResources?:unknown;laneKey?:string;liveMiniAppSession?:null|unresolved<LiveMiniAppSessionCapability>|unresolved<TrustedLiveMiniAppSessionContext>;liveShadow?:unknown;mentionedHumanUserIds?:unknown;model?:null|string;replyToMessageId?:null|number;resumeMessageId?:null|number;resumeTurnId?:null|string;searchHistoryFlag?:boolean|null;uiSelectedBotActorId?:null|string;userTimezone?:null|string;voiceMode?:boolean;workspacePath?:null|string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "activeMiniApp",
        "debtId": "debt.wire.arbitrary.xqf6wa"
      },
      {
        "path": "artifactRefs",
        "debtId": "debt.wire.arbitrary.153n572"
      },
      {
        "path": "attachments",
        "debtId": "debt.wire.arbitrary.mmoyvk"
      },
      {
        "path": "cardContinuation",
        "schema": "AdvancedVideoWorkcardContinuationV1"
      },
      {
        "path": "clientActionSessionId",
        "schema": "ClientActionSessionIdV1"
      },
      {
        "path": "focusedResources",
        "debtId": "debt.wire.arbitrary.6n27cc"
      },
      {
        "path": "liveMiniAppSession",
        "debtId": "debt.wire.arbitrary.r1qla2"
      },
      {
        "path": "liveShadow",
        "schema": "LiveShadowMessageRequestV1"
      },
      {
        "path": "mentionedHumanUserIds",
        "schema": "canonical-human-user-id[]"
      }
    ]
  },
  {
    "observationId": "wire.http.accepted.arbitrary.packages.types.src.api.ts.chatsearchconversationhit.zjhaz6",
    "locator": "http:accepted_arbitrary:packages/types/src/api.ts#ChatSearchConversationHit",
    "structuralSignatures": [
      "declaration.payload:{matchedBy:\"label\"|\"participant\";room:{createdAt:string;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;lastMessageAt?:null|string;memberCount:number;messageCount?:number;parentRoomId?:null|string;roster?:{actorId:string;agentAvatar?:null|unresolved<AvatarRef>;agentId?:string;displayName:string;federatedId?:string;handle?:null|string;kind:\"agent\"|\"user\";userId?:string}[];threadRootMessageId?:null|number;type:string;unreadCount?:number}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "room.roster[].agentAvatar",
        "schema": "AvatarRef"
      }
    ]
  },
  {
    "observationId": "wire.http.accepted.arbitrary.packages.types.src.api.ts.chatsearchpage.1c41plp",
    "locator": "http:accepted_arbitrary:packages/types/src/api.ts#ChatSearchPage",
    "structuralSignatures": [
      "declaration.payload:{conversations:{matchedBy:\"label\"|\"participant\";room:{createdAt:string;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;lastMessageAt?:null|string;memberCount:number;messageCount?:number;parentRoomId?:null|string;roster?:{actorId:string;agentAvatar?:null|unresolved<AvatarRef>;agentId?:string;displayName:string;federatedId?:string;handle?:null|string;kind:\"agent\"|\"user\";userId?:string}[];threadRootMessageId?:null|number;type:string;unreadCount?:number}}[];conversationsTruncated:boolean;hasMoreOlderMessages:boolean;messageAsOf:null|{createdAt:string;messageId:string};messages:{parentRoomId?:string;parentRoomLabel?:string;roomId:string;roomKind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";roomLabel:string}[];nextOlderMessageCursor:null|{createdAt:string;messageId:string}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "conversations[].room.roster[].agentAvatar",
        "schema": "AvatarRef"
      }
    ]
  },
  {
    "observationId": "wire.http.accepted.arbitrary.packages.types.src.api.ts.roommessageliveshadowresult.ry98rx",
    "locator": "http:accepted_arbitrary:packages/types/src/api.ts#RoomMessageLiveShadowResult",
    "structuralSignatures": [
      "declaration.payload:{operationId:string;protectedMessage:unresolved<ProtectedMessageDtoV2>;responseVersion:1;status:\"human_verified\"}|{operationId:string;reason:\"agent_capacity_unavailable\"|\"authority_stale\"|\"deadline_expired\"|\"grant_invalid\"|\"human_parity_failed\"|\"human_persistence_failed\"|\"integrity_conflict\"|\"protected_open_failed\"|\"request_invalid\"|\"restart_lost\";responseVersion:1;status:\"ordinary_fallback\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "protectedMessage",
        "schema": "ProtectedMessageDtoV2"
      }
    ]
  },
  {
    "observationId": "wire.http.accepted.arbitrary.packages.types.src.api.ts.roomsummarydto.14sn4d2",
    "locator": "http:accepted_arbitrary:packages/types/src/api.ts#RoomSummaryDto",
    "structuralSignatures": [
      "declaration.payload:{createdAt:string;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;lastMessageAt?:null|string;memberCount:number;messageCount?:number;parentRoomId?:null|string;roster?:{actorId:string;agentAvatar?:null|unresolved<AvatarRef>;agentId?:string;displayName:string;federatedId?:string;handle?:null|string;kind:\"agent\"|\"user\";userId?:string}[];threadRootMessageId?:null|number;type:string;unreadCount?:number}"
    ],
    "arbitraryPayloads": [
      {
        "path": "roster[].agentAvatar",
        "schema": "AvatarRef"
      }
    ]
  },
  {
    "observationId": "wire.http.accepted.arbitrary.packages.types.src.api.ts.roomsummaryrostermemberdto.16zn2dl",
    "locator": "http:accepted_arbitrary:packages/types/src/api.ts#RoomSummaryRosterMemberDto",
    "structuralSignatures": [
      "declaration.payload:{actorId:string;agentAvatar?:null|unresolved<AvatarRef>;agentId?:string;displayName:string;federatedId?:string;handle?:null|string;kind:\"agent\"|\"user\";userId?:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "agentAvatar",
        "schema": "AvatarRef"
      }
    ]
  },
  {
    "observationId": "wire.http.produced.arbitrary.packages.types.src.api.ts.listroomsresponse.1hzt8au",
    "locator": "http:produced_arbitrary:packages/types/src/api.ts#ListRoomsResponse",
    "structuralSignatures": [
      "declaration.payload:{rooms:{createdAt:string;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;lastMessageAt?:null|string;memberCount:number;messageCount?:number;parentRoomId?:null|string;roster?:{actorId:string;agentAvatar?:null|unresolved<AvatarRef>;agentId?:string;displayName:string;federatedId?:string;handle?:null|string;kind:\"agent\"|\"user\";userId?:string}[];threadRootMessageId?:null|number;type:string;unreadCount?:number}[]}"
    ],
    "arbitraryPayloads": [
      {
        "path": "rooms[].roster[].agentAvatar",
        "schema": "AvatarRef"
      }
    ]
  },
  {
    "observationId": "wire.http.produced.arbitrary.packages.types.src.api.ts.roommessagesendresponse.1uxgabi",
    "locator": "http:produced_arbitrary:packages/types/src/api.ts#RoomMessageSendResponse",
    "structuralSignatures": [
      "declaration.payload:{accepted:true;attachments:{code?:string|undefined;decision:\"accept\"|\"blocked\"|\"reject\"|\"stub\";filename:string;id:string;kind?:string|undefined;reason?:string|undefined;threats?:string[]|undefined}[];coalesced:boolean;jobId:null|string;liveShadow?:{operationId:string;protectedMessage:unresolved<ProtectedMessageDtoV2>;responseVersion:1;status:\"human_verified\"}|{operationId:string;reason:\"agent_capacity_unavailable\"|\"authority_stale\"|\"deadline_expired\"|\"grant_invalid\"|\"human_parity_failed\"|\"human_persistence_failed\"|\"integrity_conflict\"|\"protected_open_failed\"|\"request_invalid\"|\"restart_lost\";responseVersion:1;status:\"ordinary_fallback\"};messageId:null|number}"
    ],
    "arbitraryPayloads": [
      {
        "path": "liveShadow.protectedMessage",
        "schema": "ProtectedMessageDtoV2"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.admin.encryption.transition.h8ulxt",
    "locator": "http:request_response:GET /api/admin/encryption-transition",
    "structuralSignatures": [
      "response.body:unknown",
      "response.body:{dtoVersion:1;liveTurns:{completeRoundTrip:{eligible:string;percent?:number;verified:string};entities:{eligible:string;entity:\"final_agent_message\"|\"human_message\"|\"tool_call\"|\"tool_result\";percent?:number;verified:string}[];fallbacks:{count:string;reason:\"agent_authority_unavailable\"|\"cancelled\"|\"deadline_expired\"|\"device_unavailable\"|\"domain_unavailable\"|\"integrity_failure\"|\"namespace_unavailable\"|\"parity_mismatch\"|\"product_conflict\"|\"protected_unavailable\"|\"recipient_lost\"|\"reservation_unavailable\"|\"stale_authority\";stage:\"agent_input\"|\"assistant_message\"|\"assistant_stream\"|\"client_verification\"|\"durable_transcript\"|\"human_admission\"|\"plan\"|\"shutdown\"|\"tool_call\"|\"tool_result\"}[];pending:{oldestPendingAt?:string;turns:string};scope:\"live_new_browser_private_room_turns\";stages:{eligible:string;percent?:number;stage:\"agent_protected_input\"|\"agent_stream_frame_chain\"|\"assistant_tool_call_boundary\"|\"browser_durable_transcript_parity\"|\"browser_human_prepare\"|\"browser_stream_frame_chain\"|\"browser_terminal_acknowledgement\"|\"human_durable_mapping\"|\"server_human_open_parity\"|\"tool_result_boundary\"|\"transcript_durable_mappings\";verified:string}[]};metrics:{attemptOutcomes:{count:string;operation:\"access_update\"|\"create\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"failed\";reason:\"integrity_failure\"|\"parity_mismatch\"|\"publication_failure\"}|{count:string;operation:\"access_update\"|\"create\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"pending\";reason:\"none\"}|{count:string;operation:\"access_update\"|\"create\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"reconciling\";reason:\"response_lost\"}|{count:string;operation:\"access_update\"|\"create\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"unavailable\";reason:\"client_crypto_preparation_failed\"|\"client_crypto_unavailable\"|\"client_custody_unavailable\"|\"client_observation_expired\"|\"namespace_encryption_not_ready\"|\"stale_authority_product\"|\"unmigrated\"|\"unsupported_operation\"}|{count:string;operation:\"access_update\"|\"create\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"verified\";reason:\"none\"}[];attemptSuccess:{eligible:string;percent?:number;verified:string};family:\"artifact\"|\"memory\"|\"message\"|\"overall\"|\"record\";pendingLifecycle:{oldestPendingAt?:string;operations:string};storedCoverage:{percent?:number;total:string;verified:string};touchedCoverage:{percent?:number;total:string;verified:string}}[];observationPressure:{admissionCapacity:string;capacityRows:string;maximumRetentionMs:number;pendingAdmissions:string;retainedRows:string};policy:{mode:\"plaintext_only\"|\"shadow_encryption\";revision:number;shadowEncryptionStartedAt?:string;updatedAt:string}}",
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
    "observationId": "wire.http.request.response.get.api.admin.reflection.status.eqtoyg",
    "locator": "http:request_response:GET /api/admin/reflection-status",
    "structuralSignatures": [
      "response.body:{current:{backlog:number;checkpointed:number;claimed:number;complete:number;deferred:number;due:number;maximumAttempts:number;maximumRecoveryRound:number;oldestOverdueMs:number;quarantined:number;recoveryEligible:number;staleLeases:number;totalRecords:number};currentFailures:{attemptCount:number;errorCode:\"authority_unavailable\"|\"candidate_unavailable\"|\"embedding_unavailable\"|\"invalid_model_output\"|\"projection_unavailable\"|\"publication_unavailable\"|\"record_unavailable\"|\"retry_exhausted\"|\"unexpected_failure\";occurredAt:string;stage:\"authority_projection\"|\"organization\"|\"search_projection\"}[];generatedAt:string;health:\"degraded\"|\"delayed\"|\"healthy\";last24h:{completedWork:number;syntheticParentsCreated:number};lastCompletedAt?:string;nextRecoveryAt?:string;projections:{availableRecords:number;current:number;incompatible:number;pending:number};scheduler:{amplification:\"normal\"|\"pressure\"|\"watch\";backlog:{oldestAgeMs:number;size:number};lastPoll?:{authorityElapsedMs:number;candidateElapsedMs:number;candidatesOpened:number;capacityOutcomes:number;claims:number;crossRoomCompletions:number;crossRoomPlans:number;databaseWork:number;deterministicNoChanges:number;elapsedMs:number;modelCalls:number;modelElapsedMs:number;modelFailures:number;noEffectiveAudience:number;protectedExecutionUnavailable:number;publicationElapsedMs:number;sameRoomCompletions:number;sameRoomPlans:number;searchProjectionElapsedMs:number;stalePlans:number;unsupportedAuthorityShapes:number};latency:{crossRoom:{candidate:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};endToEnd:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};model:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};publication:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};queue:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number}};sameRoom:{candidate:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};endToEnd:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};model:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};publication:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};queue:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number}}};nextEligiblePollAt?:string;pauseReason?:\"backlog_growth\"|\"elapsed_budget\"|\"recursive_amplification\"|\"repeated_failure\";recoveryIntervalMs:number;state:\"cooldown\"|\"disabled\"|\"pressure_paused\"|\"running\";window:{admitted:number;completed:number;created:number;polls:number}};stages:{authorityProjection:number;organization:number;searchProjection:number};window:{since:string;until:string}}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.rooms.wqflaq",
    "locator": "http:request_response:GET /api/rooms",
    "structuralSignatures": [
      "response.body:{rooms:{createdAt:string;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;lastMessageAt?:string;memberCount:number;messageCount?:number;parentRoomId?:string;roster?:{actorId:string;agentAvatar?:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};agentId?:string;displayName:string;federatedId?:string;handle?:string;kind:\"agent\"|\"user\";userId?:string}[];threadRootMessageId?:number;type:string;unreadCount?:number}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.rooms.id.addable.agents.4w6337",
    "locator": "http:request_response:GET /api/rooms/:id/addable-agents",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{agents:{agentId:string;agentOwnerDisplayName?:string;agentOwnerHandle?:string;agentOwnerUserId?:string;displayName:string;handle:string}[]}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.rooms.roomid.live.shadow.operationid.recovery.1ii8yec",
    "locator": "http:request_response:GET /api/rooms/:roomId/live-shadow/:operationId/recovery",
    "structuralSignatures": [
      "request.params:{operationId:string;roomId:string}",
      "response.body:{durableEvents:{durableEventDigestBase64url:string;laneKey:string;operationId:string;ordinaryPayloadBytesBase64url:string;policyRevision:number;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};transcriptOrdinal:number;type:\"message.shadow_durable\";wireVersion:1}[];human:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}}|{protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}}};jobId:string;responseVersion:number;state:\"client_verified\"|\"completed\";status:\"completed\"}|{human?:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}}|{protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}}};jobId:string;reason:string;responseVersion:number;state:\"failed\"|\"fallback\";status:\"fallback\"}|{human?:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}}|{protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}}};jobId:string;responseVersion:number;state:\"human_verified\"|\"planned\"|\"running\";status:\"pending\"}|{human?:{protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}}};responseVersion:number;status:\"absent\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.rooms.discoverable.1lfy0b0",
    "locator": "http:request_response:GET /api/rooms/discoverable",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{rooms:{createdAt:string;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;lastMessageAt?:string;memberCount:number;messageCount?:number;parentRoomId?:string;roster?:{actorId:string;agentAvatar?:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};agentId?:string;displayName:string;federatedId?:string;handle?:string;kind:\"agent\"|\"user\";userId?:string}[];threadRootMessageId?:number;type:string;unreadCount?:number}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.rooms.manageable.1anqps",
    "locator": "http:request_response:GET /api/rooms/manageable",
    "structuralSignatures": [
      "request.query:{includeArchived?:string}",
      "response.body:{rooms:{createdAt:string;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;lastMessageAt?:string;memberCount:number;messageCount?:number;parentRoomId?:string;roster?:{actorId:string;agentAvatar?:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};agentId?:string;displayName:string;federatedId?:string;handle?:string;kind:\"agent\"|\"user\";userId?:string}[];threadRootMessageId?:number;type:string;unreadCount?:number}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.rooms.search.av2x3",
    "locator": "http:request_response:GET /api/rooms/search",
    "structuralSignatures": [
      "request.query:{[key:string]:string}",
      "response.body:{code:string;error:string}",
      "response.body:{conversations:undefined[];conversationsTruncated:false;hasMoreOlderMessages:false;messageAsOf:null;messages:undefined[];nextOlderMessageCursor:null}",
      "response.body:{conversations:{matchedBy:\"label\"|\"participant\";room:{createdAt:string;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;lastMessageAt?:string;memberCount:number;messageCount?:number;parentRoomId?:string;roster?:{actorId:string;agentAvatar?:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};agentId?:string;displayName:string;federatedId?:string;handle?:string;kind:\"agent\"|\"user\";userId?:string}[];threadRootMessageId?:number;type:string;unreadCount?:number}}[];conversationsTruncated:boolean;hasMoreOlderMessages:boolean;messageAsOf:{createdAt:string;messageId:string};messages:{authorActorId?:string;authorAgentId?:string;authorDisplayName?:string;authorHandle?:string;createdAt:string;messageId:string;parentRoomId?:string;parentRoomLabel?:string;role:string;roomId:string;roomKind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";roomLabel:string;snippet:string;sourceUserId?:string;toolName?:string}[];nextOlderMessageCursor:{createdAt:string;messageId:string}}",
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
      "response.body:{events:{action:\"configure\"|\"remove\";actorId:string;clientId:string;ip:string;kind:\"google_oauth_client_config\";outcome:\"ok\";ts:string;userAgent:string}|{action:\"create\"|\"delete\"|\"disable\"|\"enable\"|\"update\";actorId:string;effectDigest?:string;ip:string;kind:\"mcp_server_config\";outcome:\"error\"|\"ok\";relayId?:string;serverName:string;ts:string;userAgent:string}|{action:\"delete\"|\"list\"|\"store\"|\"use\";actorId:string;connectionId?:string;errorKind?:string;field?:string;ip:string;kind:\"connection_vault_tool\";outcome:\"error\"|\"missing\"|\"ok\";service?:string;tool:string;ts:string;userAgent:string}|{action:string;actorId:string;errorKind?:string;ip:string;kind:\"memory.edit\";memoryId:string;namespaceId?:string;outcome:\"failure\"|\"success\";scopeId?:string;ts:string;userAgent:string}|{actorId:string;actorUserId:string;ip:string;kind:\"standing_approval_revoked\";label:string;roomId:string;route:\"DELETE /api/security/standing-approvals/:id\";ruleId:string;scope:\"room\"|\"server\";toolPattern:string;ts:string;userAgent:string}|{actorId:string;affectedPairingCount:number;correlationId:string;ip:string;kind:\"relay_pairing_lifecycle\";managementTarget:string;operation:\"group_revoke\"|\"historical_cleanup\";reason:\"confirmation_mismatch\"|\"not_found_or_foreign\"|\"revoked\"|\"store_error\";result:\"failed\"|\"not_found_or_foreign\"|\"stale\"|\"succeeded\";ts:string;userAgent:string;userId:string}|{actorId:string;after:{conductorModel:string;defaultChatModel:string;fallbackChain:string[];reflectionModel:string;stenographerModel:string};before:{conductorModel:string;defaultChatModel:string;fallbackChain:string[];reflectionModel:string;stenographerModel:string};changes?:{[key:string]:unknown};ip:string;kind:\"server_model_config_changed\";ts:string;userAgent:string}|{actorId:string;after:{mode:\"plaintext_only\"|\"shadow_encryption\";revision:number};before:{mode:\"plaintext_only\"|\"shadow_encryption\";revision:number};ip:string;kind:\"encryption_transition_policy_changed\";ts:string;userAgent:string}|{actorId:string;attemptedRoute:string;capability:string;ip:string;kind:\"capability_check_failed\";ts:string;userAgent:string}|{actorId:string;attemptedRoute:string;ip:string;kind:\"pin_check_failed\";pinOutcome:\"invalid\"|\"locked_out\";ts:string;userAgent:string}|{actorId:string;before:{mode:\"plaintext_only\"|\"shadow_encryption\";revision:number};ip:string;kind:\"encryption_transition_policy_change_requested\";requested:{expectedRevision:number;mode:\"plaintext_only\"|\"shadow_encryption\"};ts:string;userAgent:string}|{actorId:string;byUserId:string;fromUserId:string;ip:string;kind:\"room_archived\";roomId:string;ts:string;userAgent:string}|{actorId:string;byUserId:string;ip:string;kind:\"room_unarchived\";roomId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail:boolean;ip:string;kind:\"agent_role_removed\";roleSlug:string;targetAgentId:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail:boolean;ip:string;kind:\"room_member_removed\";roomId:string;targetActorId:string;targetActorKind:\"agent\"|\"user\";ts:string;userAgent:string}|{actorId:string;bypassedRail?:boolean;groupId:string;groupType:string;ip:string;kind:\"group_member_removed\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail?:boolean;ip:string;kind:\"agent_role_added\";replacedFromGroupId:string;roleSlug:string;targetAgentId:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];groupId:string;groupType:string;ip:string;kind:\"rbac_shared_access_assigned\";memberCount:number;ownerUserId:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];groupId:string;groupType:string;ip:string;kind:\"rbac_shared_access_created\";memberCount:number;ownerUserId:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];ip:string;kind:\"rbac_role_capabilities_set\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];ip:string;kind:\"rbac_role_created\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilityRevision:number;denialCode?:string;desktopSessionId:string;ip:string;kind:\"workstation_session_activated\"|\"workstation_session_broadened\"|\"workstation_session_denied\"|\"workstation_session_disabled\"|\"workstation_session_invalidated\"|\"workstation_session_narrowed\"|\"workstation_session_switched\";outcome?:string;relayId:string;route?:string;serverBindingId:string;ts:string;userAgent:string;userId:string}|{actorId:string;capabilityRevision:number;desktopSessionId:string;executionClass:\"profile_bound_sandbox\"|\"real_workstation\"|\"typed_broker\";ip:string;kind:\"workstation_admission\";outcome:\"auto\"|\"none\";pairingGeneration:string;profileId:string;profileRevision:number;reason:\"auto_admitted\"|\"critical_or_elevation_command\"|\"no_active_session\"|\"no_admitted_plan\"|\"run_shell_required\"|\"typed_broker_not_wired\";relayId:string;serverBindingId:string;toolCallId:string;toolName:string;ts:string;userAgent:string;userId:string}|{actorId:string;changes:{[key:string]:unknown};ip:string;kind:\"server_profile_changed\";ts:string;userAgent:string}|{actorId:string;changes:{[key:string]:unknown};ip:string;kind:\"server_research_provider_changed\";ts:string;userAgent:string}|{actorId:string;errorKind?:string;ip:string;kind:\"memory.delete\";memoryId:string;mode:\"archive\"|\"hard\";namespaceId?:string;outcome:\"failure\"|\"success\";scopeId?:string;ts:string;userAgent:string}|{actorId:string;fromOwnerUserId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_owner_transferred\";toOwnerUserId:string;ts:string;userAgent:string}|{actorId:string;fromUserId:string;ip:string;kind:\"room_ownership_transferred\";roomId:string;toUserId:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"group_member_added\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_created\";ownerUserId:string;roleSlugs:string[];ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_deleted\";ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_renamed\";label:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_roles_set\";roleSlugs:string[];ts:string;userAgent:string}|{actorId:string;handleHash:string;inviteKind:string;ip:string;kind:\"invite_bind_logto_user_succeeded\";logtoSub:string;targetGroupId?:string;targetRoomId?:string;tokenHash:string;ts:string;userAgent:string;userId:string}|{actorId:string;handleHash:string;ip:string;kind:\"logto_password_login_failed\";ts:string;userAgent:string;userId?:string}|{actorId:string;handleHash:string;ip:string;kind:\"logto_password_login_succeeded\";ts:string;userAgent:string;userId:string}|{actorId:string;handleHash:string;ip:string;kind:\"recovery_session_opened\";ts:string;userAgent:string}|{actorId:string;handleHash:string;ip:string;kind:\"recovery_session_rejected\";reason:\"logto_endpoint_missing\"|\"logto_unavailable\"|\"reject\"|\"unexpected_error\";ts:string;userAgent:string}|{actorId:string;handleHash?:string;inviteKind?:string;ip:string;kind:\"invite_bind_logto_user_failed\";logtoSub?:string;reason:string;targetGroupId?:string;targetRoomId?:string;tokenHash?:string;ts:string;userAgent:string}|{actorId:string;inviteId:string;inviteKind:string;ip:string;kind:\"invite_minted\";targetAgentId?:string;targetRoomId?:string;ts:string;userAgent:string}|{actorId:string;inviteId:string;ip:string;kind:\"invite_revoked\";ts:string;userAgent:string}|{actorId:string;inviteKind:string;ip:string;kind:\"invite_redeemed\";landingRoomId:string;newUserId:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"admin_password_reset_issued\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"approval_denied\"|\"approval_granted\";laneKey:string;network?:{host:string;port:number;reason:string;suggestedRule:{cidr?:string;host?:string;ports?:number[];suffix?:string;type:\"cidr\"|\"domain\"|\"wildcard\"}};route:\"POST /api/auth/approval-reply\";threadId:string;ts:string;userAgent:string;verb:\"always\"|\"deny\"|\"once\"|\"room\"}|{actorId:string;ip:string;kind:\"invite_complete_profile_failed\";reason:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"invite_redeem_cleanup_failed\";logtoSub:string;reason:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"invite_redeem_failed\";reason:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"logto_token_mint_failed\";logtoSub:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"pin_enrolled\";route:\"POST /api/auth/pin\";sessionUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"posture_changed\";next:{deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\"};prev:{deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\"};ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"rbac_role_deleted\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"rbac_role_renamed\";label:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"recovery_relay_code_unmatched\";ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"recovery_relay_read_denied\";reason:\"bad_request\"|\"not_found\";ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"resume_thread_auth_denied\";route:string;sessionUserId:string;threadId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_added\";roomId:string;roomRole:\"admin\"|\"member\";targetActorId:string;targetActorKind:\"agent\"|\"user\";targetAgentId?:string;targetUserId?:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_self_joined\";roomId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_self_left\";roomId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_deleted\";logtoRevoked:boolean;targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_disabled\";reason?:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_disabled_session_blocked\";route:string;sessionUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_enabled\";targetUserId:string;ts:string;userAgent:string}[];hasMore:boolean;nextCursor:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.events[].changes",
        "schema": "BoundedSecurityAuditChangesV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.patch.api.tasks.id.1conpo2",
    "locator": "http:request_response:PATCH /api/tasks/:id",
    "structuralSignatures": [
      "request.body:{cron?:string;expectedOutput?:string;prompt?:string;requestedModelId?:string;resultDelivery?:\"raw\"|\"raw_and_wake\"|\"wake\";runAt?:string;scheduleKind?:\"cron\"|\"now\"|\"one_shot\";selectionProfile?:\"balanced\"|\"cheap_private\"|\"cheap_smart\"|\"cheapest\"|\"most_private\"|\"private_cheap\"|\"private_smart\"|\"smart_cheap\"|\"smart_private\"|\"smartest\";selectionSpec?:{absoluteFloors?:{intelligenceRank?:number;maxCost?:number;privacy?:number};band?:\"cheap\"|\"privacy\"|\"smart\";objective:\"cheap\"|\"privacy\"|\"smart\"};targetChat?:\"last_in_namespace\"|\"new_in_namespace\"|\"orphan\";timeLimitSeconds?:number;timezone?:string;tools?:string[]}",
      "request.params:{id:string}",
      "response.body:{agentId?:string;agentName?:string;callingRoomId:string;createdAt?:string;cron?:string;harnessId?:string;id:string;lastError:string;lastModelId?:string;nextFireAt:string;preset:string;prompt:string;requestedModelId?:string;scheduleKind:string;status:string;targetRoomId?:string}",
      "response.body:{detail:{message:string};error:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.admin.encryption.transition.114o1ir",
    "locator": "http:request_response:POST /api/admin/encryption-transition",
    "structuralSignatures": [
      "response.body:unknown",
      "response.body:{currentRevision:number;error:string}",
      "response.body:{dtoVersion:1;liveTurns:{completeRoundTrip:{eligible:string;percent?:number;verified:string};entities:{eligible:string;entity:\"final_agent_message\"|\"human_message\"|\"tool_call\"|\"tool_result\";percent?:number;verified:string}[];fallbacks:{count:string;reason:\"agent_authority_unavailable\"|\"cancelled\"|\"deadline_expired\"|\"device_unavailable\"|\"domain_unavailable\"|\"integrity_failure\"|\"namespace_unavailable\"|\"parity_mismatch\"|\"product_conflict\"|\"protected_unavailable\"|\"recipient_lost\"|\"reservation_unavailable\"|\"stale_authority\";stage:\"agent_input\"|\"assistant_message\"|\"assistant_stream\"|\"client_verification\"|\"durable_transcript\"|\"human_admission\"|\"plan\"|\"shutdown\"|\"tool_call\"|\"tool_result\"}[];pending:{oldestPendingAt?:string;turns:string};scope:\"live_new_browser_private_room_turns\";stages:{eligible:string;percent?:number;stage:\"agent_protected_input\"|\"agent_stream_frame_chain\"|\"assistant_tool_call_boundary\"|\"browser_durable_transcript_parity\"|\"browser_human_prepare\"|\"browser_stream_frame_chain\"|\"browser_terminal_acknowledgement\"|\"human_durable_mapping\"|\"server_human_open_parity\"|\"tool_result_boundary\"|\"transcript_durable_mappings\";verified:string}[]};metrics:{attemptOutcomes:{count:string;operation:\"access_update\"|\"create\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"failed\";reason:\"integrity_failure\"|\"parity_mismatch\"|\"publication_failure\"}|{count:string;operation:\"access_update\"|\"create\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"pending\";reason:\"none\"}|{count:string;operation:\"access_update\"|\"create\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"reconciling\";reason:\"response_lost\"}|{count:string;operation:\"access_update\"|\"create\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"unavailable\";reason:\"client_crypto_preparation_failed\"|\"client_crypto_unavailable\"|\"client_custody_unavailable\"|\"client_observation_expired\"|\"namespace_encryption_not_ready\"|\"stale_authority_product\"|\"unmigrated\"|\"unsupported_operation\"}|{count:string;operation:\"access_update\"|\"create\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"verified\";reason:\"none\"}[];attemptSuccess:{eligible:string;percent?:number;verified:string};family:\"artifact\"|\"memory\"|\"message\"|\"overall\"|\"record\";pendingLifecycle:{oldestPendingAt?:string;operations:string};storedCoverage:{percent?:number;total:string;verified:string};touchedCoverage:{percent?:number;total:string;verified:string}}[];observationPressure:{admissionCapacity:string;capacityRows:string;maximumRetentionMs:number;pendingAdmissions:string;retainedRows:string};policy:{mode:\"plaintext_only\"|\"shadow_encryption\";revision:number;shadowEncryptionStartedAt?:string;updatedAt:string}}",
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
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.operationid.verify.148qbs4",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/:operationId/verify",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{operationId:string;roomId:string}",
      "response.body:{error:string}",
      "response.body:{operationId:string;responseVersion:number;status:\"replayed\"|\"verified\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "LiveShadowClientVerificationRequestV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.namespace.operationid.acknowledge.g4h9ob",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace/:operationId/acknowledge",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{operationId:string;roomId:string}",
      "response.body:{error:string}",
      "response.body:{responseVersion:number;status:\"already_ready\"|\"pending\"|\"ready\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "NamespaceDeliveryAcknowledgementRequestV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.namespace.operationid.deliveries.c9ndm9",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace/:operationId/deliveries",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{operationId:string;roomId:string}",
      "response.body:{acknowledgementBaseRevision:number;deliveries:{acknowledged:boolean;createdAt:number;expiresAt:number;messageId:string;operationId:string;payloadBytesBase64url:string;payloadHashBase64url:string;recipientDeviceId:string;recipientSequence:number}[];namespaceId:string;operationId:string;responseVersion:number;status:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "NamespaceDeliveryFetchRequestV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.namespace.operationid.stage.qd4y45",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace/:operationId/stage",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{operationId:string;roomId:string}",
      "response.body:{acknowledgementBaseRevision:number;deliveries:{acknowledged:boolean;createdAt:number;expiresAt:number;messageId:string;operationId:string;payloadBytesBase64url:string;payloadHashBase64url:string;recipientDeviceId:string;recipientSequence:number}[];namespaceId:string;operationId:string;responseVersion:number;status:\"reused\"|\"staged\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "NamespaceDeliveryStageRequestV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.namespace.plan.jmhzqt",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace/plan",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{roomId:string}",
      "response.body:{acknowledgementBaseRevision:number;domainHead:{domainId:string;epoch:number;providerId:string;stateHashBase64url:string};fetchDeviceRevision:number;initiatingDeviceId:string;namespaceId:string;operationId:string;responseVersion:1;status:\"required\";subjectHumanId:string}|{namespaceId:string;responseVersion:1;status:\"ready\";trustedDeviceRevision:number}|{reason:\"authority_stale\"|\"device_unavailable\"|\"domain_unavailable\"|\"room_ineligible\";responseVersion:1;status:\"unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "LiveShadowNamespacePlanRequestV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.plan.10x975p",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/plan",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{roomId:string}",
      "response.body:{error:string}",
      "response.body:{mode:\"plaintext_only\";responseVersion:1;status:\"disabled\"}|{planBytesBase64url:string;responseVersion:1;status:\"planned\"}|{reason:\"agent_authority_unavailable\"|\"device_unavailable\"|\"domain_unavailable\"|\"namespace_unavailable\"|\"policy_unavailable\"|\"reservation_unavailable\";responseVersion:1;status:\"unavailable\"}|{reason:\"client_not_browser\"|\"request_shape_unsupported\"|\"room_topology_unsupported\";responseVersion:1;status:\"ineligible\"}",
      "response.body:{reason:\"client_not_browser\";responseVersion:1;status:\"ineligible\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "LiveShadowMessagePlanRequestV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.messages.s536g0",
    "locator": "http:request_response:POST /api/rooms/:roomId/messages",
    "structuralSignatures": [
      "request.body:{activeMiniApp?:{appId:string;appName?:string;documentPath?:string;selection?:unknown;summary?:unknown;targetKind?:\"artifact\"|\"fs\";updatedAt:number};artifactRefs?:unknown;attachments?:unknown;autoApprove?:boolean;cardContinuation?:unknown;clientActionSessionId?:unknown;content:string;currentFolder?:string;currentFolderRelayId?:string;focusedResources?:unknown;laneKey?:string;liveMiniAppSession?:{appId:string;documentVersion:{kind:\"artifact_revision\";revision:number}|{kind:\"local_sha\";sha256:string};instructions:string;sessionId:string;sessionToken:string}|{documentVersion:{kind:\"artifact_revision\";revision:number}|{kind:\"local_sha\";sha256:string};sessionId:string;sessionToken:string};liveShadow?:unknown;mentionedHumanUserIds?:unknown;model?:string;replyToMessageId?:number;resumeMessageId?:number;resumeTurnId?:string;searchHistoryFlag?:boolean;uiSelectedBotActorId?:string;userTimezone?:string;voiceMode?:boolean;workspacePath?:string}",
      "request.params:{roomId:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.activeMiniApp.selection",
        "debtId": "debt.wire.arbitrary.fuqcpe"
      },
      {
        "path": "request.body.activeMiniApp.summary",
        "debtId": "debt.wire.arbitrary.hsnquc"
      },
      {
        "path": "request.body.artifactRefs",
        "debtId": "debt.wire.arbitrary.1ehm99a"
      },
      {
        "path": "request.body.attachments",
        "debtId": "debt.wire.arbitrary.1u9muu8"
      },
      {
        "path": "request.body.cardContinuation",
        "schema": "AdvancedVideoWorkcardContinuationV1"
      },
      {
        "path": "request.body.clientActionSessionId",
        "schema": "ClientActionSessionIdV1"
      },
      {
        "path": "request.body.focusedResources",
        "debtId": "debt.wire.arbitrary.1uwofi4"
      },
      {
        "path": "request.body.liveShadow",
        "schema": "LiveShadowMessageRequestV1"
      },
      {
        "path": "request.body.mentionedHumanUserIds",
        "schema": "canonical-human-user-id[]"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.tasks.1o4qxxy",
    "locator": "http:request_response:POST /api/tasks",
    "structuralSignatures": [
      "request.body:{cron?:string;expectedOutput?:string;parentTaskId?:string;prompt:string;requestedModelId?:string;resultDelivery?:\"raw\"|\"raw_and_wake\"|\"wake\";runAt?:string;scheduleKind?:\"cron\"|\"now\"|\"one_shot\";scopeId?:string;selectionProfile?:\"balanced\"|\"cheap_private\"|\"cheap_smart\"|\"cheapest\"|\"most_private\"|\"private_cheap\"|\"private_smart\"|\"smart_cheap\"|\"smart_private\"|\"smartest\";selectionSpec?:{absoluteFloors?:{intelligenceRank?:number;maxCost?:number;privacy?:number};band?:\"cheap\"|\"privacy\"|\"smart\";objective:\"cheap\"|\"privacy\"|\"smart\"};targetChat?:\"last_in_namespace\"|\"new_in_namespace\"|\"orphan\";timeLimitSeconds?:number;timezone?:string;tools?:string[];useScope?:boolean}",
      "response.body:{detail:{message:string};error:string}",
      "response.body:{error:string;message:string}",
      "response.body:{error:string}",
      "response.body:{nextFireAt:string;status:string;taskId:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.ws.server.to.client.message.shadow.durable.1mlld3b",
    "locator": "ws:server_to_client:message.shadow_durable",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.ws.server.to.client.message.shadow.stream.frame.hacwvy",
    "locator": "ws:server_to_client:message.shadow_stream_frame",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.ws.server.to.client.message.shadow.stream.start.d471xj",
    "locator": "ws:server_to_client:message.shadow_stream_start",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  }
];

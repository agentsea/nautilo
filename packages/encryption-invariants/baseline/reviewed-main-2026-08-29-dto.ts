import type { DtoDeclaration } from "../src/node/dto-inventory";

export const SUPERSEDED_MAIN_2026_08_29_DTO_LOCATORS = new Set<string>([
  "http:request_response:GET /api/admin/encryption-transition",
  "http:request_response:GET /api/admin/reflection-status",
  "http:request_response:GET /api/auth/whoami",
  "http:request_response:GET /api/codex/rooms/:roomId/requests",
  "http:request_response:GET /api/memory/:id",
  "http:request_response:GET /api/rooms/:id/messages",
  "http:request_response:GET /api/security/audit-log",
  "http:request_response:GET /api/security/posture",
  "http:request_response:GET /api/tasks",
  "http:request_response:GET /api/tasks/:id",
  "http:request_response:PATCH /api/tasks/:id",
  "http:request_response:POST /api/admin/access-control/changes/preview",
  "http:request_response:POST /api/admin/encryption-transition",
  "http:request_response:POST /api/admin/users/provision",
  "http:request_response:POST /api/auth/approval-reply",
  "http:request_response:POST /api/auth/identity-verify-resume",
  "http:request_response:POST /api/auth/pin",
  "http:request_response:POST /api/auth/prove-and-resume",
  "http:request_response:POST /api/codex/requests/:requestRef/respond",
  "http:request_response:POST /api/rooms/:id/stop",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/plan",
  "http:request_response:POST /api/workstation-access/activate",
  "http:request_response:POST /api/workstation-access/activate-profile",
  "http:request_response:POST /api/workstation-access/activate-profile/complete",
  "http:request_response:PUT /api/security/posture",
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#DesktopAutomationInvocationBinding",
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#DesktopAutomationInvocationBindingValidationResult",
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayClientMessage",
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest",
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage",
  "relay:server_to_client:relay:dispatch",
  "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage"
]);

export const REVIEWED_MAIN_2026_08_29_DTO_DECLARATIONS: readonly DtoDeclaration[] = [
  {
    "observationId": "wire.http.request.response.delete.api.human.blocks.userid.10cxaso",
    "locator": "http:request_response:DELETE /api/human-blocks/:userId",
    "structuralSignatures": [
      "request.params:{userId:string}",
      "response.body:{blockedByViewer:boolean;directInteractionBlocked:boolean;userId:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.delete.api.live.shadow.foreground.authorization.sessions.klxohs",
    "locator": "http:request_response:DELETE /api/live-shadow/foreground-authorization-sessions",
    "structuralSignatures": [
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.delete.api.mobile.user.agreement.8yam34",
    "locator": "http:request_response:DELETE /api/mobile-user-agreement",
    "structuralSignatures": [
      "response.body:{acceptance:{acceptedAt:string;agreementVersion:string;policyVersion:string;recipientManifestVersion:string;withdrawnAt:string};accepted:boolean;current:{agreementVersion:string;policyVersion:string;recipientManifestVersion:string}}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.admin.content.reports.1ksfq0t",
    "locator": "http:request_response:GET /api/admin/content-reports",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{nextCursor?:string;reports:{closedAt?:string;closedBy?:{displayName:string;handle?:string;userId:string};comment?:string;createdAt:string;id:string;preview:{attachments:{filename:string;mimeType:string;sizeBytes:number}[];displayName?:string;handle?:string;text?:string};reason:\"abuse_hate_harassment\"|\"other\"|\"sexual_exploitative\"|\"spam_scam\"|\"violence_threats\";reporter:{displayName:string;handle?:string;userId:string};roomId:string;sourceAvailable:boolean;status:\"closed\"|\"open\";target?:{messageId:number;type:\"message\"}|{type:\"person\";userId:string}}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.admin.encryption.transition.h8ulxt",
    "locator": "http:request_response:GET /api/admin/encryption-transition",
    "structuralSignatures": [
      "response.body:unknown",
      "response.body:{dtoVersion:1;historyReads:{eligible:string;fallback:string;outcomes:{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"failed\";reason:\"integrity_failure\"|\"parity_mismatch\"|\"publication_failure\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"pending\";reason:\"none\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"reconciling\";reason:\"response_lost\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"unavailable\";reason:\"client_crypto_preparation_failed\"|\"client_crypto_unavailable\"|\"client_custody_unavailable\"|\"client_observation_expired\"|\"current_read_authority_unavailable\"|\"live_shadow_lifecycle_unavailable\"|\"namespace_encryption_not_ready\"|\"retained_key_material_unavailable\"|\"signer_evidence_unavailable\"|\"stale_authority_product\"|\"unmigrated\"|\"unsupported_operation\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"verified\";reason:\"none\"}[];pagesAttempted:string;pagesPending:string;pending:string;percent?:number;scope:\"browser_room_history_shadow_reads\";selected:string;verified:string};humanPeerLive:{recipientReads:{attempted:string;fallback:string;percent?:number;verified:string};recipientSync:{ready:string;recoveryRequired:string;syncing:string;unrecoverable:string;waitingForAuthorizedDevice:string};scope:\"browser_human_only_live_messages\";writes:{eligible:string;fallback:string;pending:string;percent?:number;published:string}};liveTurns:{completeRoundTrip:{eligible:string;percent?:number;verified:string};entities:{eligible:string;entity:\"final_agent_message\"|\"human_message\"|\"tool_call\"|\"tool_result\";percent?:number;verified:string}[];fallbacks:{count:string;reason:\"agent_authority_unavailable\"|\"cancelled\"|\"deadline_expired\"|\"device_unavailable\"|\"domain_unavailable\"|\"integrity_failure\"|\"namespace_unavailable\"|\"parity_mismatch\"|\"product_conflict\"|\"protected_unavailable\"|\"recipient_lost\"|\"reservation_unavailable\"|\"stale_authority\";stage:\"agent_input\"|\"assistant_message\"|\"assistant_stream\"|\"client_verification\"|\"durable_transcript\"|\"human_admission\"|\"plan\"|\"session_establishment\"|\"session_reuse\"|\"shutdown\"|\"tool_call\"|\"tool_result\"}[];pending:{oldestPendingAt?:string;turns:string};scope:\"live_new_browser_private_room_turns\";stages:{eligible:string;percent?:number;stage:\"agent_protected_input\"|\"agent_stream_frame_chain\"|\"assistant_tool_call_boundary\"|\"browser_durable_transcript_parity\"|\"browser_human_prepare\"|\"browser_stream_frame_chain\"|\"browser_terminal_acknowledgement\"|\"human_durable_mapping\"|\"server_human_open_parity\"|\"tool_result_boundary\"|\"transcript_durable_mappings\";verified:string}[]};metrics:{attemptOutcomes:{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"failed\";reason:\"integrity_failure\"|\"parity_mismatch\"|\"publication_failure\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"pending\";reason:\"none\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"reconciling\";reason:\"response_lost\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"unavailable\";reason:\"client_crypto_preparation_failed\"|\"client_crypto_unavailable\"|\"client_custody_unavailable\"|\"client_observation_expired\"|\"current_read_authority_unavailable\"|\"live_shadow_lifecycle_unavailable\"|\"namespace_encryption_not_ready\"|\"retained_key_material_unavailable\"|\"signer_evidence_unavailable\"|\"stale_authority_product\"|\"unmigrated\"|\"unsupported_operation\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"verified\";reason:\"none\"}[];attemptSuccess:{eligible:string;percent?:number;verified:string};family:\"artifact\"|\"memory\"|\"message\"|\"overall\"|\"record\";pendingLifecycle:{oldestPendingAt?:string;operations:string};storedCoverage:{percent?:number;total:string;verified:string};touchedCoverage:{percent?:number;total:string;verified:string}}[];observationPressure:{admissionCapacity:string;capacityRows:string;maximumRetentionMs:number;pendingAdmissions:string;retainedRows:string};policy:{mode:\"plaintext_only\"|\"shadow_encryption\";revision:number;shadowEncryptionStartedAt?:string;updatedAt:string};sharedAgentLive:{agentRecipientReads:{attempted:string;fallback:string;percent?:number;verified:string};authorization:{established:string;expired:string;reused:string;revoked:string;unavailable:string};conductor:{authorizationEstablished:string;authorizationReused:string;awaitingAuthorization:string;awaitingUser:string;currentInputVerified:string;deterministic:string;eligible:string;fallback:string;fallbackReasons:{count:string;reason:string}[];floorManager:string;historyNotRequested:string;historyUnavailable:string;historyVerified:string;notSelected:string;selected:string;selectedAgentExecutions:string;unavailable:string;verifiedAwaitingUser:string;verifiedSilent:string;verifiedWake:string};executions:{authorized:string;awaitingAuthorization:string;completed:string;failed:string;fallback:string;protectedInputs:string;running:string};outputStages:{assistantPublished:string;streamCompleted:string;streamStarted:string;toolPublished:string};planningFallbacks:{deviceUnavailable:string;namespaceUnavailable:string;recipientSyncRequired:string;unavailable:string};recipientCoverage:{plaintextOnlyHumans:string;protectedDevices:string;protectedHumans:string;totalHumans:string};recipientReads:{attempted:string;fallback:string;percent?:number;verified:string};resumes:{attempted:string;authorized:string;awaitingAuthorization:string;completed:string;failed:string;fallback:string;running:string};scope:\"browser_multi_human_single_agent_live_messages\";writes:{eligible:string;fallback:string;pending:string;percent?:number;published:string}}}",
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
      "response.body:{current:{backlog:number;checkpointed:number;claimed:number;complete:number;currentParentViolations:number;deferred:number;due:number;maximumAttempts:number;maximumRecoveryRound:number;oldestOverdueMs:number;quarantined:number;recoveryEligible:number;staleLeases:number;totalRecords:number};currentFailures:{attemptCount:number;errorCode:\"authority_unavailable\"|\"candidate_unavailable\"|\"embedding_unavailable\"|\"invalid_model_output\"|\"projection_unavailable\"|\"publication_unavailable\"|\"record_unavailable\"|\"retry_exhausted\"|\"unexpected_failure\";occurredAt:string;stage:\"authority_projection\"|\"organization\"|\"search_projection\"}[];generatedAt:string;health:\"degraded\"|\"delayed\"|\"healthy\";last24h:{completedWork:number;syntheticParentsCreated:number};lastCompletedAt?:string;nextRecoveryAt?:string;projections:{availableRecords:number;current:number;incompatible:number;pending:number};scheduler:{amplification:\"normal\"|\"pressure\"|\"watch\";backlog:{oldestAgeMs:number;size:number};lastPoll?:{authorityElapsedMs:number;candidateElapsedMs:number;candidatesOpened:number;capacityOutcomes:number;claims:number;crossRoomCompletions:number;crossRoomPlans:number;databaseWork:number;deterministicNoChanges:number;elapsedMs:number;modelCalls:number;modelElapsedMs:number;modelFailures:number;noEffectiveAudience:number;protectedExecutionUnavailable:number;publicationElapsedMs:number;sameRoomCompletions:number;sameRoomPlans:number;searchProjectionElapsedMs:number;stalePlans:number;unsupportedAuthorityShapes:number};latency:{crossRoom:{candidate:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};endToEnd:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};model:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};publication:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};queue:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number}};sameRoom:{candidate:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};endToEnd:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};model:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};publication:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};queue:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number}}};nextEligiblePollAt?:string;pauseReason?:\"backlog_growth\"|\"elapsed_budget\"|\"recursive_amplification\"|\"repeated_failure\";recoveryIntervalMs:number;state:\"cooldown\"|\"disabled\"|\"pressure_paused\"|\"running\";window:{admitted:number;completed:number;created:number;polls:number}};stages:{authorityProjection:number;organization:number;searchProjection:number};window:{since:string;until:string}}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.auth.whoami.1qlua20",
    "locator": "http:request_response:GET /api/auth/whoami",
    "structuralSignatures": [
      "response.body:{capabilities:\"approve_destructive_actions\"|\"approve_spending\"|\"control_browser\"|\"control_desktop\"|\"control_home\"|\"create_rooms\"|\"invoke_agents\"|\"manage_agents\"|\"manage_billing\"|\"manage_groups\"|\"manage_members\"|\"manage_memories\"|\"manage_roles\"|\"manage_rooms\"|\"manage_server_operations\"|\"manage_server_security\"|\"manage_server_settings\"|\"manage_standing_approvals\"|\"manage_uncontained_host_commands\"|\"manage_workstation_profiles\"|\"moderate_content_reports\"|\"read_memories\"|\"read_server_settings\"|\"use_connections\"|\"use_google_workspace\"|\"use_image_generation\"|\"use_media_generation\"|\"use_project_content\"|\"use_project_execution\"|\"use_remote_hosts\"|\"use_research_tools\"|\"use_share_artifact\"|\"use_transcription\"|\"use_workstation\"|\"view_audit_log\"|\"write_artifacts\"[];displayName:string;externalId:string;features?:{office:{enabled:boolean}};groups:{id:string;label:string;roleSlug:string;type:string}[];handle:string;highestRole:string;instanceId:string;mustChangePassword:boolean;sessionActorId:string;sessionUserId:string;userIdentity:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.claude.connections.16g8974",
    "locator": "http:request_response:GET /api/claude-connections",
    "structuralSignatures": [
      "response.body:{catch:function;finally:function;then:function}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.codex.rooms.roomid.requests.h42d5o",
    "locator": "http:request_response:GET /api/codex/rooms/:roomId/requests",
    "structuralSignatures": [
      "request.params:{roomId:string}",
      "response.body:{code:string}",
      "response.body:{error:string}",
      "response.body:{items:{availability:\"actionable\"|\"unavailable\";event:{expiresAt:string;jobId:string;ownerId:string;request:{autoResolutionMs?:number;kind:\"user_input_required\";questions:{allowOther:boolean;header:string;id:string;multiSelect?:boolean;options?:object[];prompt:string;secret:boolean}[]};requestId:string;roomId:string;taskId:string;type:\"codex.request\"}}[];roomId:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.human.blocks.ibhsn4",
    "locator": "http:request_response:GET /api/human-blocks",
    "structuralSignatures": [
      "response.body:{blockedUserIds:string[]}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.human.blocks.userid.3sv2qn",
    "locator": "http:request_response:GET /api/human-blocks/:userId",
    "structuralSignatures": [
      "request.params:{userId:string}",
      "response.body:{blockedByViewer:boolean;directInteractionBlocked:boolean;userId:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.memory.id.1d5thzp",
    "locator": "http:request_response:GET /api/memory/:id",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{actionAuthority:{canArchive:boolean;canEdit:boolean;canHardDelete:boolean;canManageAccess:boolean};memory:{accessList:{displayName:string;userHandle:string}[];content:string;createdAt:Date;demotedAt:Date;demotedFrom:number;id:string;importance:number;namespaceIds:string[];tier:number;type:string;updatedAt:Date};memoryMode:\"namespace\"}",
      "response.body:{actionAuthority:{canArchive:boolean;canEdit:boolean;canHardDelete:boolean;canManageAccess:boolean};memory:{content:string;createdAt:Date;demotedAt:Date;demotedFrom:number;id:string;importance:number;namespaceIds:string[];tier:number;type:string;updatedAt:Date};memoryMode:\"scope\"}",
      "response.body:{actionAuthority:{canArchive:boolean;canEdit:boolean;canManageAccess:boolean};dtoVersion:1;memory:{dtoVersion:1;projection:{accessList?:{displayName:string;userHandle:string}[];contentRevision:number;createdAt:string;cryptoAccessRevision:number;demotedAt?:string;demotedFrom?:number;importance:number;memoryId:string;namespaceIds:string[];requiredNamespaceIds:string[];scopeOrigin?:\"scope\"|\"seed\";tier:number;updatedAt:string};protectedPayload?:{accessManifestBytesBase64url:string;accessManifestProofBytesBase64url?:string[];accessSignerEvidence:{evidenceBytesBase64url:string;kind:\"agent_runtime_publication\"|\"processor_authorization\"}[];cryptoObjectId:string;encryptedPayloadBytesBase64url:string;namespaceEnvelopes:{envelopeBytesBase64url:string;namespaceId:string}[];payloadVersion:1;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"incomplete_access_set\"|\"lost_key_material\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};memoryMode:\"namespace\"|\"scope\"}|{dtoVersion:1;reason:\"authorization_required\"|\"deleted\"|\"embedding_unavailable\"|\"encryption_pending\"|\"incomplete_access_set\"|\"integrity_failure\"|\"legacy_plaintext\"|\"missing_mapping\"|\"stale_revision\"|\"target_encryption_not_ready\"|\"text_search_unsupported\";status:\"unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.mobile.user.agreement.1r9nad1",
    "locator": "http:request_response:GET /api/mobile-user-agreement",
    "structuralSignatures": [
      "response.body:{acceptance:{acceptedAt:string;agreementVersion:string;policyVersion:string;recipientManifestVersion:string;withdrawnAt:string};accepted:boolean;current:{agreementVersion:string;policyVersion:string;recipientManifestVersion:string}}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.rooms.id.messages.1f82u0n",
    "locator": "http:request_response:GET /api/rooms/:id/messages",
    "structuralSignatures": [
      "request.params:{id:string}",
      "request.query:{[key:string]:string}",
      "response.body:{error:string}",
      "response.body:{messages:{artifacts:{artifactInternalId:string;basename:string;mimeType:string;roomId:string;sizeBytes:number}[];attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];authorAgentId?:string;content:string;createdAt:Date;displayContent?:string;editRevision?:number;editedAt?:string;id:string;lastReplyAt?:string;logicalMessageKey?:string;reactions:{actorIds:string[];count:number;emoji:string;truncated:boolean}[];replyCount?:number;replyToMessageId?:number;role:string;sourceUserId?:string;summaryRevision?:number;toolCalls:string;toolName?:string;workcardContinuation?:{kind:\"advanced_video\";referenceCount:number}}|{artifacts:{artifactInternalId:string;basename:string;mimeType:string;roomId:string;sizeBytes:number}[];attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];authorAgentId?:string;content:string;createdAt:Date;displayContent?:string;editRevision?:number;editedAt?:string;id:string;lastReplyAt?:string;logicalMessageKey?:string;reactions?:undefined;replyCount?:number;replyToMessageId?:number;role:string;sourceUserId?:string;summaryRevision?:number;toolCalls:string;toolName?:string;workcardContinuation?:{kind:\"advanced_video\";referenceCount:number}}|{artifacts?:undefined;attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];authorAgentId?:string;content:string;createdAt:Date;displayContent?:string;editRevision?:number;editedAt?:string;id:string;lastReplyAt?:string;logicalMessageKey?:string;reactions:{actorIds:string[];count:number;emoji:string;truncated:boolean}[];replyCount?:number;replyToMessageId?:number;role:string;sourceUserId?:string;summaryRevision?:number;toolCalls:string;toolName?:string;workcardContinuation?:{kind:\"advanced_video\";referenceCount:number}}|{artifacts?:undefined;attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];authorAgentId?:string;content:string;createdAt:Date;displayContent?:string;editRevision?:number;editedAt?:string;id:string;lastReplyAt?:string;logicalMessageKey?:string;reactions?:undefined;replyCount?:number;replyToMessageId?:number;role:string;sourceUserId?:string;summaryRevision?:number;toolCalls:string;toolName?:string;workcardContinuation?:{kind:\"advanced_video\";referenceCount:number}}[];pageInfo:{hasMoreBefore:boolean;oldestCursor:{createdAt:string;id:string}};shadowEncryption?:any}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.shadowEncryption",
        "schema": "ProtectedMessageDtoV2"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.security.audit.log.ef92mf",
    "locator": "http:request_response:GET /api/security/audit-log",
    "structuralSignatures": [
      "request.query:{actorId?:string;correlationId?:string;cursor?:string;kinds?:string;limit?:string;since?:string}",
      "response.body:{error:string}",
      "response.body:{events:{action:\"configure\"|\"remove\";actorId:string;clientId:string;ip:string;kind:\"google_oauth_client_config\";outcome:\"ok\";ts:string;userAgent:string}|{action:\"create\"|\"delete\"|\"disable\"|\"enable\"|\"update\";actorId:string;effectDigest?:string;ip:string;kind:\"mcp_server_config\";outcome:\"error\"|\"ok\";relayId?:string;serverName:string;ts:string;userAgent:string}|{action:\"delete\"|\"list\"|\"store\"|\"use\";actorId:string;connectionId?:string;errorKind?:string;field?:string;ip:string;kind:\"connection_vault_tool\";outcome:\"error\"|\"missing\"|\"ok\";service?:string;tool:string;ts:string;userAgent:string}|{action:string;actorId:string;errorKind?:string;ip:string;kind:\"memory.edit\";memoryId:string;namespaceId?:string;outcome:\"failure\"|\"success\";scopeId?:string;ts:string;userAgent:string}|{actorId:string;actorUserId:string;ip:string;kind:\"standing_approval_revoked\";label:string;roomId:string;route:\"DELETE /api/security/standing-approvals/:id\";ruleId:string;scope:\"room\"|\"server\";toolPattern:string;ts:string;userAgent:string}|{actorId:string;affectedPairingCount:number;correlationId:string;ip:string;kind:\"relay_pairing_lifecycle\";managementTarget:string;operation:\"group_revoke\"|\"historical_cleanup\";reason:\"confirmation_mismatch\"|\"not_found_or_foreign\"|\"revoked\"|\"store_error\";result:\"failed\"|\"not_found_or_foreign\"|\"stale\"|\"succeeded\";ts:string;userAgent:string;userId:string}|{actorId:string;after:{conductorModel:string;defaultChatModel:string;fallbackChain:string[];reflectionModel:string;stenographerModel:string};before:{conductorModel:string;defaultChatModel:string;fallbackChain:string[];reflectionModel:string;stenographerModel:string};changes?:{[key:string]:unknown};ip:string;kind:\"server_model_config_changed\";ts:string;userAgent:string}|{actorId:string;after:{mode:\"plaintext_only\"|\"shadow_encryption\";revision:number};before:{mode:\"plaintext_only\"|\"shadow_encryption\";revision:number};ip:string;kind:\"encryption_transition_policy_changed\";ts:string;userAgent:string}|{actorId:string;attemptedRoute:string;capability:string;ip:string;kind:\"capability_check_failed\";ts:string;userAgent:string}|{actorId:string;attemptedRoute:string;ip:string;kind:\"pin_check_failed\";pinOutcome:\"invalid\"|\"locked_out\";ts:string;userAgent:string}|{actorId:string;before:{mode:\"plaintext_only\"|\"shadow_encryption\";revision:number};ip:string;kind:\"encryption_transition_policy_change_requested\";requested:{expectedRevision:number;mode:\"plaintext_only\"|\"shadow_encryption\"};ts:string;userAgent:string}|{actorId:string;byUserId:string;fromUserId:string;ip:string;kind:\"room_archived\";roomId:string;ts:string;userAgent:string}|{actorId:string;byUserId:string;ip:string;kind:\"room_unarchived\";roomId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail:boolean;ip:string;kind:\"agent_role_removed\";roleSlug:string;targetAgentId:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail:boolean;ip:string;kind:\"room_member_removed\";roomId:string;targetActorId:string;targetActorKind:\"agent\"|\"user\";ts:string;userAgent:string}|{actorId:string;bypassedRail?:boolean;groupId:string;groupType:string;ip:string;kind:\"group_member_removed\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail?:boolean;ip:string;kind:\"agent_role_added\";replacedFromGroupId:string;roleSlug:string;targetAgentId:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];groupId:string;groupType:string;ip:string;kind:\"rbac_shared_access_assigned\";memberCount:number;ownerUserId:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];groupId:string;groupType:string;ip:string;kind:\"rbac_shared_access_created\";memberCount:number;ownerUserId:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];ip:string;kind:\"rbac_role_capabilities_set\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];ip:string;kind:\"rbac_role_created\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilityRevision:number;denialCode?:string;desktopSessionId:string;ip:string;kind:\"workstation_session_activated\"|\"workstation_session_broadened\"|\"workstation_session_denied\"|\"workstation_session_disabled\"|\"workstation_session_invalidated\"|\"workstation_session_narrowed\"|\"workstation_session_switched\";outcome?:string;relayId:string;route?:string;serverBindingId:string;ts:string;userAgent:string;userId:string}|{actorId:string;capabilityRevision:number;desktopSessionId:string;executionClass:\"profile_bound_sandbox\"|\"real_workstation\"|\"typed_broker\";ip:string;kind:\"workstation_admission\";outcome:\"auto\"|\"none\";pairingGeneration:string;profileId:string;profileRevision:number;reason:\"auto_admitted\"|\"critical_or_elevation_command\"|\"no_active_session\"|\"no_admitted_plan\"|\"run_shell_required\"|\"typed_broker_not_wired\";relayId:string;serverBindingId:string;toolCallId:string;toolName:string;ts:string;userAgent:string;userId:string}|{actorId:string;capabilityRevision?:number;desktopSessionId?:string;ip:string;kind:\"uncontained_host_commands_activated\"|\"uncontained_host_commands_denied\"|\"uncontained_host_commands_disabled\"|\"uncontained_host_commands_dispatch_admitted\"|\"uncontained_host_commands_dispatch_denied\"|\"uncontained_host_commands_invalidated\"|\"uncontained_host_commands_status_invalidated\";reason?:string;relayId?:string;route?:string;serverBindingId?:string;ts:string;userAgent:string;userId:string}|{actorId:string;changes:{[key:string]:unknown};ip:string;kind:\"server_profile_changed\";ts:string;userAgent:string}|{actorId:string;changes:{[key:string]:unknown};ip:string;kind:\"server_research_provider_changed\";ts:string;userAgent:string}|{actorId:string;errorKind?:string;ip:string;kind:\"memory.delete\";memoryId:string;mode:\"archive\"|\"hard\";namespaceId?:string;outcome:\"failure\"|\"success\";scopeId?:string;ts:string;userAgent:string}|{actorId:string;fromOwnerUserId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_owner_transferred\";toOwnerUserId:string;ts:string;userAgent:string}|{actorId:string;fromUserId:string;ip:string;kind:\"room_ownership_transferred\";roomId:string;toUserId:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"group_member_added\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_created\";ownerUserId:string;roleSlugs:string[];ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_deleted\";ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_renamed\";label:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_roles_set\";roleSlugs:string[];ts:string;userAgent:string}|{actorId:string;handleHash:string;inviteKind:string;ip:string;kind:\"invite_bind_logto_user_succeeded\";logtoSub:string;targetGroupId?:string;targetRoomId?:string;tokenHash:string;ts:string;userAgent:string;userId:string}|{actorId:string;handleHash:string;ip:string;kind:\"logto_password_login_failed\";ts:string;userAgent:string;userId?:string}|{actorId:string;handleHash:string;ip:string;kind:\"logto_password_login_succeeded\";ts:string;userAgent:string;userId:string}|{actorId:string;handleHash:string;ip:string;kind:\"recovery_session_opened\";ts:string;userAgent:string}|{actorId:string;handleHash:string;ip:string;kind:\"recovery_session_rejected\";reason:\"logto_endpoint_missing\"|\"logto_unavailable\"|\"reject\"|\"unexpected_error\";ts:string;userAgent:string}|{actorId:string;handleHash?:string;inviteKind?:string;ip:string;kind:\"invite_bind_logto_user_failed\";logtoSub?:string;reason:string;targetGroupId?:string;targetRoomId?:string;tokenHash?:string;ts:string;userAgent:string}|{actorId:string;inviteId:string;inviteKind:string;ip:string;kind:\"invite_minted\";targetAgentId?:string;targetRoomId?:string;ts:string;userAgent:string}|{actorId:string;inviteId:string;ip:string;kind:\"invite_revoked\";ts:string;userAgent:string}|{actorId:string;inviteKind:string;ip:string;kind:\"invite_redeemed\";landingRoomId:string;newUserId:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"admin_password_reset_issued\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"approval_denied\"|\"approval_granted\";laneKey:string;network?:{host:string;port:number;reason:string;suggestedRule:{cidr?:string;host?:string;ports?:number[];suffix?:string;type:\"cidr\"|\"domain\"|\"wildcard\"}};route:\"POST /api/auth/approval-reply\";threadId:string;ts:string;userAgent:string;verb:\"always\"|\"deny\"|\"once\"|\"room\"}|{actorId:string;ip:string;kind:\"invite_complete_profile_failed\";reason:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"invite_redeem_cleanup_failed\";logtoSub:string;reason:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"invite_redeem_failed\";reason:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"logto_token_mint_failed\";logtoSub:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"pin_enrolled\";route:\"POST /api/auth/pin\";sessionUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"posture_changed\";next:{deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\"};prev:{deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\"};ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"rbac_role_deleted\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"rbac_role_renamed\";label:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"recovery_relay_code_unmatched\";ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"recovery_relay_read_denied\";reason:\"bad_request\"|\"not_found\";ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"resume_thread_auth_denied\";route:string;sessionUserId:string;threadId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_added\";roomId:string;roomRole:\"admin\"|\"member\";targetActorId:string;targetActorKind:\"agent\"|\"user\";targetAgentId?:string;targetUserId?:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_self_joined\";roomId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_self_left\";roomId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_deleted\";logtoRevoked:boolean;targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_disabled\";reason?:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_disabled_session_blocked\";route:string;sessionUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_enabled\";targetUserId:string;ts:string;userAgent:string}[];hasMore:boolean;nextCursor:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.events[].changes",
        "schema": "BoundedSecurityAuditChangesV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.security.posture.1va0xgz",
    "locator": "http:request_response:GET /api/security/posture",
    "structuralSignatures": [
      "response.body:{actorRole:string;allowUncontainedHostCommands:boolean;backend:{kind:\"bubblewrap\"|\"passthrough\"|\"sandbox-exec\";procSupported?:boolean};capabilities:string[];deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";networkPolicy:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};readOnlyPaths:string[];securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";writablePaths:string[]}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.security.uncontained.host.commands.session.1767hmy",
    "locator": "http:request_response:GET /api/security/uncontained-host-commands/session",
    "structuralSignatures": [
      "request.query:{desktopSessionId?:string;relayId?:string}",
      "response.body:{activatedAt:string;active:boolean;eligible:boolean;reason:\"grant_missing\"|\"pin_invalid\"|\"pin_locked_out\"|\"policy_disabled\"|\"relay_binding_unavailable\"|\"role_floor_missing\"|\"session_binding_mismatch\"|\"session_inactive\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.tasks.1veo2i8",
    "locator": "http:request_response:GET /api/tasks",
    "structuralSignatures": [
      "request.query:{includeTerminal?:boolean;recentTerminalLimit?:number;status?:string}",
      "response.body:{agentId?:string;agentName?:string;callingRoomId:string;createdAt?:string;cron?:string;depth:number;harnessId?:string;id:string;lastError:string;lastModelId?:string;nextFireAt:string;parentTaskId:string;preset:string;prompt:string;requestedModelId?:string;scheduleKind:string;status:string;targetRoomId?:string;updatedAt?:string}[]",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.tasks.id.agent.avatar.1bxh1fe",
    "locator": "http:request_response:GET /api/tasks/:id/agent/avatar",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{catch:function;finally:function;then:function}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.tasks.id.gfjl0w",
    "locator": "http:request_response:GET /api/tasks/:id",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{error:string}",
      "response.body:{runs:{completedAt:string;id:string;lastError:string;modelId:string;resultText:string;startedAt:string;status:string;transcript?:{content:string;createdAt:string;role:string;toolCalls:{args:{[key:string]:unknown};id:string;name:string}[];toolName:string}[]}[];task:{agentId?:string;agentName?:string;callingRoomId:string;createdAt?:string;cron?:string;depth:number;harnessId?:string;id:string;lastError:string;lastModelId?:string;nextFireAt:string;parentTaskId:string;preset:string;prompt:string;requestedModelId?:string;scheduleKind:string;status:string;targetRoomId?:string;updatedAt?:string}&{createdAt:string;cron:string;expectedOutput:string;requestedModelId:string;resultDelivery:string;runAt:string;scopeId:string;selectionProfile:\"balanced\"|\"cheap_private\"|\"cheap_smart\"|\"cheapest\"|\"most_private\"|\"private_cheap\"|\"private_smart\"|\"smart_cheap\"|\"smart_private\"|\"smartest\";selectionSpec:{absoluteFloors?:{intelligenceRank?:number;maxCost?:number;privacy?:number};band?:\"cheap\"|\"privacy\"|\"smart\";objective:\"cheap\"|\"privacy\"|\"smart\"};targetChat:string;timezone:string;toolsMode:string;toolsWhitelist:string[];updatedAt:string;useScope:boolean}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.runs[].transcript[].toolCalls[].args",
        "debtId": "debt.wire.arbitrary.19ijf0o"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.tasks.pending.attention.113t48v",
    "locator": "http:request_response:GET /api/tasks/pending-attention",
    "structuralSignatures": [
      "response.body:{activity?:{appendResult?:boolean;appendResultSeparator?:\"\"|\"\\n\";args:{[key:string]:unknown};endedAt?:number;id:string;kind:\"command\"|\"file_change\"|\"status\"|\"tool\";name:string;result?:string;startedAt:number;status:\"completed\"|\"failed\"|\"running\"|\"waiting\"};detail:string;ownerId:string;taskId:string;taskRunId:string;type:\"task.progress\"}|{actor?:{agentId:string;kind:\"agent\"}|{humanId:string;kind:\"human\"};after?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};before?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};destinationBefore?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};mutation:\"move\";operationId:string;outcome:\"applied\"|\"rebased\";overwrite:true;path:{after?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};before?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};destinationBefore?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};kind:\"move\";overwrite:true};revisionGroupId:string;sequence:number;type:\"document.mutation.committed\"}|{actor?:{agentId:string;kind:\"agent\"}|{humanId:string;kind:\"human\"};after?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};before?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};editorSave?:{anchoredPatch?:{kind:\"anchored_text\";newString:string;oldString:string;replaceAll?:boolean;scope?:{from:number;to:number}};checkpoint:boolean;clientMutationId?:string;requestId?:string};mutation:\"update\";operationId:string;outcome:\"applied\"|\"rebased\";path:{after?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};before?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};kind:\"update\"};revisionGroupId:string;sequence:number;type:\"document.mutation.committed\";workspaceArtifactMetadata?:{afterMimeType:string;beforeMimeType:string}}|{actor?:{agentId:string;kind:\"agent\"}|{humanId:string;kind:\"human\"};after?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};before?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};mutation:\"move\";operationId:string;outcome:\"applied\"|\"rebased\";overwrite:false;path:{after?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};before?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};kind:\"move\";overwrite:false};revisionGroupId:string;sequence:number;type:\"document.mutation.committed\"}|{actor?:{agentId:string;kind:\"agent\"}|{humanId:string;kind:\"human\"};after?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};mutation:\"create\";operationId:string;outcome:\"applied\"|\"rebased\";path:{after?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};kind:\"create\"};revisionGroupId:string;sequence:number;type:\"document.mutation.committed\"}|{actor?:{agentId:string;kind:\"agent\"}|{humanId:string;kind:\"human\"};before?:{backendVersion:{kind:\"artifact_revision\";revision:number};identity:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string};sha256:string}|{backendVersion:{kind:\"local_sha\";sha256:string};identity:{canonicalPath:string;kind:\"local_file\";relayId:string};sha256:string};mutation:\"delete\";operationId:string;outcome:\"applied\"|\"rebased\";path:{before?:{artifactId:string;kind:\"workspace_artifact\";logicalPath:string}|{canonicalPath:string;kind:\"local_file\";relayId:string};kind:\"delete\"};revisionGroupId:string;sequence:number;type:\"document.mutation.committed\"}|{actorId:string;createdAt:string;emoji:string;laneKey:string;messageId:number;type:\"reaction.added\"}|{actorId:string;emoji:string;laneKey:string;messageId:number;type:\"reaction.removed\"}|{agentId:string;availableRevisions:number;latest:{createdAt:string;operation:string;pinned:boolean;redoEligible:boolean;revisionId:string;summary:string;turnId:string};path:string;type:\"revisions.state_changed\"}|{agentId?:string;final:boolean;index:number;lang?:string;text:string;type:\"voice.sentence\";userId?:string}|{agentId?:string;language:string;type:\"voice.suggestion\";userId?:string}|{allowedVerbs:\"always\"|\"deny\"|\"once\"|\"room\"[];approvalId:string;laneKey:string;localMcpInstall?:{digest:string;preview:{availabilitySummary:string;digest:string;environment:{name:string;present:boolean}[];human:string;machine:string;mayDownloadOnFirstRun:boolean;name:string;package:{name:string;version?:string};relayId:string;source:{label:string;url?:string};subprocessSandboxed:false;transport:{args:string[];command:string;kind:\"stdio\"}|{kind:\"streamable-http\";url:string};unpinnedPackage:boolean;version:\"local-mcp-install-v1\"};version:\"local-mcp-install-v1\"};mediaGeneration?:{digest:string;expiresAt:string;preview:{mediaKind:\"music\"|\"video\";model:\"minimax-h3-enhanced-text-to-video\"|\"minimax-music-v26\"|\"seedance-2-5-reference-to-video-basic\"|\"seedance-2-5-text-to-video-basic\"|\"sonilo-v1-1-music\";prompt:{characterCount:number;summary:string;truncated:boolean};quote:{amountMicros:number;currency:\"USD\";display:string};referenceImages?:{artifactId:string;index:number;label:string}[];settings:{[key:string]:false|number|string|true};spendNotice:\"Approving starts a paid generation using this exact quote.\"};quoteDigest:string;revision:1;version:\"media-generation-approval-v1\"};network?:{host:string;port:number;reason:string;suggestedRule:{cidr?:string;host?:string;ports?:number[];suffix?:string;type:\"cidr\"|\"domain\"|\"wildcard\"}};origin?:\"task\";reason:string;reasonCode:\"command-scanner-high\"|\"command-scanner-medium\"|\"destructive-tool\"|\"external-binary\"|\"network-egress-denied\"|\"tier-bump\";requiresExplicitReview?:boolean;scopeInfo?:{approvalKind?:\"capability\"|\"tool\";capabilitySlug?:string;generalizedDisplay:string;onceDisplay:string;sameAsOnce:boolean}[];structuredSsh?:{approvedRequestDigest:string;argv?:string[];host:string;hostKeyFingerprint:string;hostTrust:\"changed\"|\"trusted\"|\"unknown\";localPath?:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";port:number;preparationId:string;previousHostKeyFingerprint?:string;program?:string;remotePath?:string;remoteUser:string;timeoutReason?:string;timeoutSeconds?:number;toolCallId:string;version:\"structured-ssh-v1\"};taskId?:string;taskRunId?:string;threadId:string;tools:{args:{[key:string]:unknown};id?:string;name:string;shareArtifactPreview?:{artifactPathSnippet:string;mimeType:string;roomLabel:string;sensitivity:\"normal\"|\"sensitive\";size:number;targetDisplayName:string;targetHandle:string;wouldCreate:boolean};shareMemoryPreview?:{memoryContentSnippet:string;memoryType:string;projection?:{audienceWarning:string;content:string;memberCount:number;mode:\"project\";roomKind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";roomLabel:string};roomLabel:string;sensitivity:\"normal\"|\"sensitive\";targetDisplayName:string;targetHandle:string;wouldCreate:boolean}}[];type:\"approval.ask\";userId?:string}|{anchorMessageId:number;laneKey:string;lastReplyAt:string;replyCount:number;summaryRevision:number;type:\"thread.summary.changed\"}|{approvalId:string;laneKey?:string;origin?:\"task\";resolution:\"approved\"|\"cancelled\"|\"denied\"|\"expired\";taskId?:string;taskRunId?:string;threadId:string;type:\"approval.resolved\";userId:string;verb?:\"always\"|\"deny\"|\"once\"|\"room\"}|{argsSummary?:string;authorAgentId?:string;laneKey?:string;toolCallId:string;toolName:string;turnId?:string;type:\"tool.start\"}|{artifactId:string;clientMutationId?:string;id:string;path:string;reloadRequired?:boolean;type:\"workspace.artifact.changed\"}|{artifactId:string;id:string;namespaceIds:string[];type:\"workspace.artifact.deleted\"}|{artifactId:string;id:string;newPath:string;oldPath:string;type:\"workspace.artifact.renamed\"}|{artifacts?:{artifactInternalId:string;basename:string;mimeType:string;roomId:string;sizeBytes:number}[];assistantMessageKey?:string;authorAgentId?:string;content:string;editRevision?:number;laneKey:string;logicalMessageKey?:string;messageId:string;replyToMessageId?:number;role:\"ai\"|\"human\"|\"system\"|\"user\";senderUserId?:string;sourceUserId?:string;type:\"message.new\";workcardContinuation?:{kind:\"advanced_video\";referenceCount:number}}|{assistantMessageKey?:string;authorAgentId?:string;chunkSequence:number;content:string;done:boolean;laneKey:string;tokenUsage?:{inputTokens:number;outputTokens:number;totalTokens:number};turnId?:string;type:\"message.tokens\"}|{at:string;deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";networkPolicy:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";type:\"policy.changed\"}|{author:{displayName:string;kind:\"agent\"|\"app_tool\"|\"human\"};clientMutationId?:string;patch:{kind:\"anchored_text\";newString:string;oldString:string;replaceAll?:boolean;scope?:{from:number;to:number}};patchId:string;previousRevision:number;previousSha256:string;rebased?:boolean;requestId?:string;revision:number;sha256:string;target:{artifactInternalId:string;kind:\"artifact\";mimeType?:string;path:string;roomId?:string}|{currentFolderRef:string;kind:\"currentFile\";relativePath:string;relayOwnerUserId?:string};type:\"document.patch.applied\"}|{authorAgentId?:string;done:true;laneKey:`room:${string}`;protection:\"protected\";streaming:\"suppressed\";turnId?:string;type:\"message.tokens\";wireVersion:2}|{authorAgentId?:string;droppedBytes?:number;elapsedMs:number;endOffsetBytes:number;kind:\"exec-output\";laneKey?:string;offsetBytes:number;operation:\"exec\";phase:\"running\";sequence:number;stream:\"stderr\"|\"stdout\";text:string;toolCallId:string;turnId?:string;type:\"tool.structured_ssh.progress\";version:1}|{authorAgentId?:string;droppedBytes?:number;elapsedMs:number;endOffsetBytes:number;laneKey?:string;offsetBytes:number;phase:\"running\";sequence:number;stream:\"stderr\"|\"stdout\";text:string;toolCallId:string;turnId?:string;type:\"tool.run_shell.progress\";version:1}|{authorAgentId?:string;duration:number;error?:string;laneKey?:string;result?:string;resultTruncated?:boolean;runShellOutcome?:\"unknown\";status:\"error\"|\"success\";toolCallId:string;toolName:string;turnId?:string;type:\"tool.end\"}|{authorAgentId?:string;elapsedMs:number;kind:\"transfer\";laneKey?:string;operation:\"copy-download\"|\"copy-upload\";phase:\"starting\"|\"transferring\";sequence:number;toolCallId:string;totalBytes?:number;transferredBytes:number;turnId?:string;type:\"tool.structured_ssh.progress\";version:1}|{authorAgentId?:string;laneKey:string;phase:\"post_model\"|\"preparing_tool\"|\"thinking\";turnId:string;type:\"agent.progress\"}|{authorizationPlanBytesBase64url:string;authorizationScheme:\"runtime_foreground_v1\";clientActionSessionId:string;deadlineAt:number;invocationId:string;laneKey:string;recipientPublicKeyBase64url:string;roomId:string;sourceHumanPlanBytesBase64url:string;type:\"message.runtime_invocation_authorization_required\";userId:string;wireVersion:1}|{authorizationPlanBytesBase64url?:string;authorizationScheme?:\"runtime_foreground_v1\";clientActionSessionId:string;deadlineAt:number;executionId:string;laneKey:string;ordinaryPayloadBytesBase64url?:string;planBytesBase64url?:string;recipientPublicKeyBase64url?:string;roomId:string;sourceHumanPlanBytesBase64url?:string;type:\"message.shared_agent_authorization_required\";userId:string;wireVersion:1}|{awaitingFromUserIds:string[];laneKey?:string;ownerId:string;targetRoomId:string;taskId?:string;taskRunId?:string;threadId?:string;type:\"task.awaiting_reply\"}|{botActorId:string;change:\"cleared\"|\"extended\"|\"opened\";laneKey:string;reason:string;roomId:string;source:\"inferred\"|\"mention\"|\"reply\"|\"ui\";type:\"conductor.focus_changed\";userActorId:string}|{challengeId:string;expiresAt:string;laneKey:string;mode?:\"enrollPin\"|\"verify\";origin?:\"task\";taskId?:string;taskRunId?:string;threadId:string;type:\"identity.challenge\";userId?:string}|{choiceId:string;laneKey:string;options:{label:string;selector:string}[];threadId:string;toolCallId:string;toolName:string;type:\"host.choice\";userId?:string}|{chunkIndex:number;data:string;final:boolean;sentenceIndex:number;type:\"voice.audio\";userId?:string}|{conductorMode:\"advanced\"|\"standard\";laneKey:string;roomId:string;type:\"room.conductor_mode.changed\"}|{content:string;editRevision:number;editedAt:string;laneKey:string;logicalMessageKey:string;type:\"message.updated\"}|{cursor:{sequence:number;snapshotRevision:number;streamId:string};hosts:{connected:boolean;label:string;lastSeenAt:string;readiness:\"compatible_online\"|\"identity_conflict\"|\"incompatible_online\"|\"offline\"|\"stale\"|\"unknown\";remoteHostId:string}[];type:\"remote.host.snapshot\"}|{detail?:string;jobId:string;kind?:\"deep-research\";laneKey?:string;phase:string;type:\"job.progress\"}|{displayName:string;roomId:string;type:\"typing.ping\";userId:string}|{displayReason:string;humanTurnId?:string;laneKey:string;messageId:string;options?:{botActorId:string;handle:string}[];outcome:\"ask_user\"|\"error\"|\"silent\"|\"wake\";reasonCode:\"ask_ambiguous_direct\"|\"ask_ambiguous_history\"|\"ask_router\"|\"redirect_rejected_duplicate\"|\"redirect_rejected_enqueue_failed\"|\"redirect_rejected_explicitly_selected\"|\"redirect_rejected_ineligible_target\"|\"redirect_rejected_no_target\"|\"redirect_rejected_same_source\"|\"redirect_rejected_visible_output\"|\"redirected\"|\"routing_error\"|\"silent_human_addressed\"|\"silent_no_route\"|\"silent_no_wakeable\"|\"silent_not_addressed\"|\"silent_router\"|\"silent_router_unresolved\"|\"wake_active_focus\"|\"wake_history\"|\"wake_mention\"|\"wake_reply\"|\"wake_router\"|\"wake_ui\"|\"wake_vocative\";roomId:string;selectedHandles?:string[];type:\"conductor.decision\";userActorId:string;userId:string}|{done:boolean;frameBytesBase64url:string;laneKey:string;operationId:string;ordinaryChunk:string;transcriptOrdinal:number;type:\"message.shadow_stream_frame\";wireVersion:1}|{done:boolean;frameBytesBase64url:string;laneKey:string;operationId:string;ordinaryChunk:string;transcriptOrdinal:number;type:\"message.shared_agent_stream_frame\";wireVersion:1}|{droppedCount:number;errorCode:string;sessionId:string;threadId:string;type:\"session.persistence_failed\"}|{durableEventDigestBase64url:string;laneKey:string;logicalMessageKey:string;operationId:string;ordinaryPayloadBytesBase64url:string;planBytesBase64url:string;policyRevision:number;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};protectedMessageDigestBase64url:string;requestBytesBase64url:string;senderDeviceSigningPublicKeyBase64url:string;transcriptOrdinal:number;type:\"message.human_peer_shadow\";wireVersion:1}|{durableEventDigestBase64url:string;laneKey:string;logicalMessageKey:string;operationId:string;ordinaryPayloadBytesBase64url:string;planBytesBase64url:string;policyRevision:number;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};protectedMessageDigestBase64url:string;requestBytesBase64url:string;senderDeviceSigningPublicKeyBase64url:string;transcriptOrdinal:number;type:\"message.shared_agent_shadow\";wireVersion:1}|{durableEventDigestBase64url:string;laneKey:string;operationId:string;ordinaryPayloadBytesBase64url:string;planBytesBase64url:string;policyRevision:number;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};transcriptOrdinal:number;type:\"message.shared_agent_output_shadow\";wireVersion:1}|{durableEventDigestBase64url:string;laneKey:string;operationId:string;ordinaryPayloadBytesBase64url:string;policyRevision:number;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};transcriptOrdinal:number;type:\"message.shadow_durable\";wireVersion:1}|{editRevision:number;laneKey:`room:${string}`;logicalMessageKey:string;message:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};protection:\"protected\";type:\"message.updated\";wireVersion:2}|{errorCategory?:\"auth\"|\"bad_request\"|\"context_exceeded\"|\"provider_unavailable\"|\"rate_limit\"|\"timeout\"|\"unknown\";jobId:string;laneKey?:string;message?:string;status:\"cancelled\"|\"completed\"|\"failed\"|\"queued\"|\"running\"|\"timed_out\";type:\"job.status\"}|{event:{actorId:string;actorKind:\"agent\"|\"user\";displayName:string;kind:\"member_added\"|\"member_removed\"};recipientSyncNamespaceId?:string;roomId:string;type:\"room_members_changed\"}|{eventId:string;host:{connected:boolean;label:string;lastSeenAt:string;readiness:\"compatible_online\"|\"identity_conflict\"|\"incompatible_online\"|\"offline\"|\"stale\"|\"unknown\";remoteHostId:string};remoteHostId:string;sequence:number;snapshotRevision:number;streamId:string;type:\"remote.host.connected\"}|{eventId:string;host:{connected:boolean;label:string;lastSeenAt:string;readiness:\"compatible_online\"|\"identity_conflict\"|\"incompatible_online\"|\"offline\"|\"stale\"|\"unknown\";remoteHostId:string};remoteHostId:string;sequence:number;snapshotRevision:number;streamId:string;type:\"remote.host.updated\"}|{eventId:string;remoteHostId:string;sequence:number;snapshotRevision:number;streamId:string;terminalReason:\"identity_conflict\"|\"offline\";type:\"remote.host.disconnected\"}|{eventId:string;remoteHostId:string;sequence:number;snapshotRevision:number;streamId:string;terminalReason:\"revoked\";type:\"remote.host.revoked\"}|{expiresAt?:string;jobId:string;ownerId:string;request?:{autoResolutionMs?:number;kind:\"user_input_required\";questions:{allowOther:boolean;header:string;id:string;multiSelect?:boolean;options?:{description?:string;id:string;label:string}[];prompt:string;secret:boolean}[]}|{command:{actionKinds:\"list_files\"|\"read\"|\"search\"|\"unknown\"[];detail:\"host_local_only\"|\"not_provided\"};kind:\"command_approval_required\";options:\"approve\"|\"approve_for_session\"|\"cancel\"|\"deny\"[];reason:\"host_local_only\"|\"not_provided\"}|{grantRoot:\"host_local_only\"|\"not_provided\";kind:\"file_change_approval_required\";options:\"approve\"|\"approve_for_session\"|\"cancel\"|\"deny\"[];reason:\"host_local_only\"|\"not_provided\"}|{kind:\"network_approval_required\";network:{host:string;protocol:\"http\"|\"https\"|\"socks5Tcp\"|\"socks5Udp\"};options:\"approve\"|\"approve_for_session\"|\"cancel\"|\"deny\"[];reason:\"host_local_only\"|\"not_provided\"}|{kind:\"permission_selection_required\";options:{id:string;label:string;semanticHint?:string}[];tool:{kind?:string;title?:string}}|{kind:\"permissions_approval_required\";permissions:{fileSystem?:{entryCount:number;pathDetail:\"host_local_only\"|\"not_provided\";readPathCount:number;writePathCount:number};network?:{enabled?:boolean}};reason:\"host_local_only\"|\"not_provided\"};requestId:string;roomId:string;taskId:string;type:\"codex.request\"}|{forkThreadId:string;jobId:string;laneKey:string;parentJobId?:string;parentThreadId:string;sequence:number;syntheticNoteCount:number;type:\"job.forked\";virtualJobIds:string[]}|{forkThreadId:string;jobId:string;laneKey:string;parentThreadId:string;sequence:number;splicedMessageCount:number;type:\"fork.spliced\"}|{from:string;laneKey:string;reason:\"auth\"|\"bad_request\"|\"context_exceeded\"|\"provider_unavailable\"|\"rate_limit\"|\"timeout\"|\"unknown\";to:string;turnId:string;type:\"model.fallback\"}|{hardExpiresAt:string;leaseExpiresAt:string;operationId:string;state:\"applying\"|\"draining\"|\"normal\";type:\"maintenance.status\"}|{humanTurnId?:string;laneKey:string;messageId:string;options:{botActorId:string;handle:string}[];reason:string;roomId:string;type:\"conductor.ask_user\";userActorId:string;userId:string}|{jobId:string;laneKey:string;type:\"job.dispatched\";virtualJobIds:string[]}|{jobId:string;result:\"failed\"|\"success\"|\"timed_out\";type:\"worker.complete\"}|{laneKey:`room:${string}`;message:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};protection:\"protected\";type:\"message.new\";wireVersion:2}|{laneKey:string;messageId:number;type:\"message.deleted\"}|{laneKey:string;operationId:string;planBytesBase64url:string;streamStartBytesBase64url:string;transcriptOrdinal:number;type:\"message.shared_agent_stream_start\";wireVersion:1}|{laneKey:string;operationId:string;streamStartBytesBase64url:string;transcriptOrdinal:number;type:\"message.shadow_stream_start\";wireVersion:1}|{laneKey:string;origin?:\"task\";taskId?:string;taskRunId?:string;threadId:string;tools:{args:{[key:string]:unknown};id?:string;name:string;shareArtifactPreview?:{artifactPathSnippet:string;mimeType:string;roomLabel:string;sensitivity:\"normal\"|\"sensitive\";size:number;targetDisplayName:string;targetHandle:string;wouldCreate:boolean};shareMemoryPreview?:{memoryContentSnippet:string;memoryType:string;projection?:{audienceWarning:string;content:string;memberCount:number;mode:\"project\";roomKind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";roomLabel:string};roomLabel:string;sensitivity:\"normal\"|\"sensitive\";targetDisplayName:string;targetHandle:string;wouldCreate:boolean}}[];type:\"prove_it.challenge\";userId?:string}|{laneKey:string;ownerId:string;taskId:string;taskRunId:string;type:\"task.fired\"}|{laneKey:string;roomId:string;silence:{botActorId:string;botDisplayName:string;expiresAt:string;id:string;kind:\"deaf\"|\"mute\";setByDisplayName:string};type:\"room.silence.changed\"}|{laneKey:string;roomId:string;state:\"deciding\"|\"settled\";type:\"conductor.routing\";userActorId:string}|{laneKey:string;type:\"job.coalesced\";virtualJobId:string}|{messageId:string;occurredAt:string;parentRoomLabel?:string;roomId:string;roomLabel:string;senderActorId:string;senderDisplayName:string;topLevelRoomId:string;type:\"notification.message.important\";userId:string}|{name:string;onboardingCompleted:boolean;profileId:string;type:\"profile.updated\";userId?:string}|{ownerId:string;requestId:string;type:\"codex.request.resolved\"}|{ownerId:string;status:string;taskId:string;taskRunId:string;type:\"task.completed\"}|{ownerId:string;status:string;taskId:string;taskRunId:string;type:\"task.errored\"}|{ownerId:string;status:string;taskId:string;type:\"task.status\"}|{roomId:string;roomOwnImportantUnreadCount:number;roomOwnUnreadCount:number;topLevelImportantUnreadCount:number;topLevelRoomId:string;topLevelUnreadCount:number;type:\"room.notification.changed\";userId:string}|{speaking:boolean;type:\"voice.status\";voice:\"off\"|\"on\"}|{type:\"room.catalog.changed\"}|{type:\"voice.stop\"}[]",
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
    "observationId": "wire.http.request.response.patch.api.tasks.id.1conpo2",
    "locator": "http:request_response:PATCH /api/tasks/:id",
    "structuralSignatures": [
      "request.body:{cron?:string;expectedOutput?:string;prompt?:string;requestedModelId?:string;resultDelivery?:\"raw\"|\"raw_and_wake\"|\"wake\";runAt?:string;scheduleKind?:\"cron\"|\"now\"|\"one_shot\";selectionProfile?:\"balanced\"|\"cheap_private\"|\"cheap_smart\"|\"cheapest\"|\"most_private\"|\"private_cheap\"|\"private_smart\"|\"smart_cheap\"|\"smart_private\"|\"smartest\";selectionSpec?:{absoluteFloors?:{intelligenceRank?:number;maxCost?:number;privacy?:number};band?:\"cheap\"|\"privacy\"|\"smart\";objective:\"cheap\"|\"privacy\"|\"smart\"};targetChat?:\"last_in_namespace\"|\"new_in_namespace\"|\"orphan\";timeLimitSeconds?:number;timezone?:string;tools?:string[]}",
      "request.params:{id:string}",
      "response.body:{agentId?:string;agentName?:string;callingRoomId:string;createdAt?:string;cron?:string;depth:number;harnessId?:string;id:string;lastError:string;lastModelId?:string;nextFireAt:string;parentTaskId:string;preset:string;prompt:string;requestedModelId?:string;scheduleKind:string;status:string;targetRoomId?:string;updatedAt?:string}",
      "response.body:{detail:{message:string};error:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.admin.access.control.changes.preview.175w5tz",
    "locator": "http:request_response:POST /api/admin/access-control/changes/preview",
    "structuralSignatures": [
      "response.body:{affectedUserDelta?:{added:string[];removed:string[];unchanged:string[];userId:string};affectedUserDeltas?:{added:string[];removed:string[];unchanged:string[];userId:string}[];auditPreview:{actorId:string;bypassedRail?:boolean;groupId:string;groupType:string;kind:\"group_member_removed\";targetUserId:string}|{actorId:string;capabilities:string[];groupId:string;groupType:string;kind:\"rbac_shared_access_assigned\";memberCount:number;ownerUserId:string;roleId:string;roleSlug:string}|{actorId:string;capabilities:string[];groupId:string;groupType:string;kind:\"rbac_shared_access_created\";memberCount:number;ownerUserId:string;roleId:string;roleSlug:string}|{actorId:string;capabilities:string[];kind:\"rbac_role_capabilities_set\";roleId:string;roleSlug:string}|{actorId:string;capabilities:string[];kind:\"rbac_role_created\";roleId:string;roleSlug:string}|{actorId:string;fromOwnerUserId:string;groupId:string;groupType:string;kind:\"rbac_group_owner_transferred\";toOwnerUserId:string}|{actorId:string;groupId:string;groupType:string;kind:\"group_member_added\";targetUserId:string}|{actorId:string;groupId:string;groupType:string;kind:\"rbac_group_created\";ownerUserId:string;roleSlugs:string[]}|{actorId:string;groupId:string;groupType:string;kind:\"rbac_group_deleted\"}|{actorId:string;groupId:string;groupType:string;kind:\"rbac_group_renamed\";label:string}|{actorId:string;groupId:string;groupType:string;kind:\"rbac_group_roles_set\";roleSlugs:string[]}|{actorId:string;kind:\"rbac_role_deleted\";roleId:string;roleSlug:string}|{actorId:string;kind:\"rbac_role_renamed\";label:string;roleId:string;roleSlug:string};authorityDelta?:{added:string[];removed:string[];unchanged:string[]};checks:{code:\"insufficient_authority\"|\"invalid_custom_type\"|\"last_owner\"|\"missing_manage_groups\"|\"missing_manage_members\"|\"missing_manage_roles\"|\"missing_manage_uncontained_host_commands\"|\"nondelegable_capability\"|\"not_found\"|\"not_member\"|\"ok\"|\"owner_required\"|\"protected_definition\"|\"reserved_slug\"|\"reserved_type\"|\"unknown_capability\"|\"user_not_found\";detail?:string;missing?:string[];passed:boolean}[];currentAuthority?:string[];deletionConsequence?:{affectedGroups?:{groupId:string;groupType:string;memberCount:number}[];approvalChallengesRemoved?:number;groupRolesRemoved?:number;membersRemoved?:number;roleAssignmentsRemoved?:number;roleCapabilitiesRemoved?:number;targetId:string;targetKind:\"group\"|\"role\";targetLabel:string};failures:{code:\"insufficient_authority\"|\"invalid_custom_type\"|\"last_owner\"|\"missing_manage_groups\"|\"missing_manage_members\"|\"missing_manage_roles\"|\"missing_manage_uncontained_host_commands\"|\"nondelegable_capability\"|\"not_found\"|\"not_member\"|\"ok\"|\"owner_required\"|\"protected_definition\"|\"reserved_slug\"|\"reserved_type\"|\"unknown_capability\"|\"user_not_found\";detail?:string;missing?:string[];passed:boolean}[];fingerprint:string;ok:boolean;operation:{bypassLastOwner?:boolean;groupId:string;kind:\"membership.remove\";userId:string}|{capabilities:string[];kind:\"role.create\";label:string;slug:string}|{capabilities:string[];kind:\"role.set_capabilities\";roleId:string}|{group:{groupType:string;label:string;ownerUserId:string};kind:\"shared_access.assign_existing\";memberUserIds:string[];roleSlug:string}|{group:{groupType:string;label:string;ownerUserId:string};kind:\"shared_access.create\";memberUserIds:string[];role:{capabilities:string[];label:string;slug:string}}|{groupId:string;kind:\"group.delete\"}|{groupId:string;kind:\"group.rename\";label:string}|{groupId:string;kind:\"group.set_roles\";roleSlugs:string[]}|{groupId:string;kind:\"group.transfer_owner\";newOwnerUserId:string}|{groupId:string;kind:\"membership.add\";userId:string}|{groupType:string;kind:\"group.create\";label:string;ownerUserId:string;roleSlugs:string[]}|{kind:\"role.delete\";roleId:string}|{kind:\"role.rename\";label:string;roleId:string};proposedAuthority?:string[]}",
      "response.body:{error:string;issues:{code:\"custom\";input?:unknown;message:string;params?:{[key:string]:any};path:number|string|symbol[]}|{code:\"invalid_element\";input?:unknown;issues:$ZodIssueInvalidElement|{code:\"custom\";input?:unknown;message:string;params?:{[key:string]:any};path:number|string|symbol[]}|{code:\"invalid_format\";format:\"base64\"|\"base64url\"|\"cidrv4\"|\"cidrv6\"|\"cuid\"|\"cuid2\"|\"date\"|\"datetime\"|\"duration\"|\"e164\"|\"email\"|\"emoji\"|\"ends_with\"|\"guid\"|\"includes\"|\"ipv4\"|\"ipv6\"|\"json_string\"|\"jwt\"|\"ksuid\"|\"lowercase\"|\"nanoid\"|\"regex\"|\"starts_with\"|\"time\"|\"ulid\"|\"uppercase\"|\"url\"|\"uuid\"|\"xid\"|string&{};input?:string;message:string;path:number|string|symbol[];pattern?:string}|{code:\"invalid_key\";input?:unknown;issues:$ZodIssueInvalidElement|$ZodIssueInvalidKey|{code:\"custom\";input?:unknown;message:string;params?:{[key:string]:any};path:number|string|symbol[]}|{code:\"invalid_format\";format:\"base64\"|\"base64url\"|\"cidrv4\"|\"cidrv6\"|\"cuid\"|\"cuid2\"|\"date\"|\"datetime\"|\"duration\"|\"e164\"|\"email\"|\"emoji\"|\"ends_with\"|\"guid\"|\"includes\"|\"ipv4\"|\"ipv6\"|\"json_string\"|\"jwt\"|\"ksuid\"|\"lowercase\"|\"nanoid\"|\"regex\"|\"starts_with\"|\"time\"|\"ulid\"|\"uppercase\"|\"url\"|\"uuid\"|\"xid\"|string&{};input?:string;message:string;path:number|string|symbol[];pattern?:string}|{code:\"invalid_type\";expected:\"array\"|\"bigint\"|\"boolean\"|\"date\"|\"file\"|\"function\"|\"int\"|\"map\"|\"nan\"|\"never\"|\"nonoptional\"|\"null\"|\"number\"|\"object\"|\"record\"|\"set\"|\"string\"|\"symbol\"|\"tuple\"|\"undefined\"|\"void\"|string&{};input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_union\";discriminator?:string;errors:$ZodIssueCustom|$ZodIssueInvalidElement|$ZodIssueInvalidKey|$ZodIssueInvalidStringFormat|$ZodIssueInvalidType|$ZodIssueInvalidUnionMultipleMatch|$ZodIssueInvalidUnionNoMatch|$ZodIssueInvalidValue|$ZodIssueNotMultipleOf|$ZodIssueTooBig|$ZodIssueTooSmall|$ZodIssueUnrecognizedKeys[][];inclusive?:true;input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_union\";discriminator?:string;errors:[];inclusive:false;input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_value\";input?:unknown;message:string;path:number|string|symbol[];values:bigint|false|number|string|symbol|true[]}|{code:\"not_multiple_of\";divisor:number;input?:bigint|number;message:string;path:number|string|symbol[]}|{code:\"too_big\";exact?:boolean;inclusive?:boolean;input?:unknown;maximum:bigint|number;message:string;origin:\"array\"|\"bigint\"|\"date\"|\"file\"|\"int\"|\"number\"|\"set\"|\"string\"|string&{};path:number|string|symbol[]}|{code:\"too_small\";exact?:boolean;inclusive?:boolean;input?:unknown;message:string;minimum:bigint|number;origin:\"array\"|\"bigint\"|\"date\"|\"file\"|\"int\"|\"number\"|\"set\"|\"string\"|string&{};path:number|string|symbol[]}|{code:\"unrecognized_keys\";input?:{[key:string]:unknown};keys:string[];message:string;path:number|string|symbol[]}[];message:string;origin:\"map\"|\"record\";path:number|string|symbol[]}|{code:\"invalid_type\";expected:\"array\"|\"bigint\"|\"boolean\"|\"date\"|\"file\"|\"function\"|\"int\"|\"map\"|\"nan\"|\"never\"|\"nonoptional\"|\"null\"|\"number\"|\"object\"|\"record\"|\"set\"|\"string\"|\"symbol\"|\"tuple\"|\"undefined\"|\"void\"|string&{};input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_union\";discriminator?:string;errors:$ZodIssueInvalidElement|$ZodIssueInvalidUnionNoMatch|{code:\"custom\";input?:unknown;message:string;params?:Record;path:number|string|symbol[]}|{code:\"invalid_format\";format:\"base64\"|\"base64url\"|\"cidrv4\"|\"cidrv6\"|\"cuid\"|\"cuid2\"|\"date\"|\"datetime\"|\"duration\"|\"e164\"|\"email\"|\"emoji\"|\"ends_with\"|\"guid\"|\"includes\"|\"ipv4\"|\"ipv6\"|\"json_string\"|\"jwt\"|\"ksuid\"|\"lowercase\"|\"nanoid\"|\"regex\"|\"starts_with\"|\"time\"|\"ulid\"|\"uppercase\"|\"url\"|\"uuid\"|\"xid\"|object&string;input?:string;message:string;path:number|string|symbol[];pattern?:string}|{code:\"invalid_key\";input?:unknown;issues:$ZodIssueCustom|$ZodIssueInvalidElement|$ZodIssueInvalidKey|$ZodIssueInvalidStringFormat|$ZodIssueInvalidType|$ZodIssueInvalidUnionMultipleMatch|$ZodIssueInvalidUnionNoMatch|$ZodIssueInvalidValue|$ZodIssueNotMultipleOf|$ZodIssueTooBig|$ZodIssueTooSmall|$ZodIssueUnrecognizedKeys[];message:string;origin:\"map\"|\"record\";path:number|string|symbol[]}|{code:\"invalid_type\";expected:\"array\"|\"bigint\"|\"boolean\"|\"date\"|\"file\"|\"function\"|\"int\"|\"map\"|\"nan\"|\"never\"|\"nonoptional\"|\"null\"|\"number\"|\"object\"|\"record\"|\"set\"|\"string\"|\"symbol\"|\"tuple\"|\"undefined\"|\"void\"|object&string;input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_union\";discriminator?:string;errors:[];inclusive:false;input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_value\";input?:unknown;message:string;path:number|string|symbol[];values:bigint|false|number|string|symbol|true[]}|{code:\"not_multiple_of\";divisor:number;input?:bigint|number;message:string;path:number|string|symbol[]}|{code:\"too_big\";exact?:boolean;inclusive?:boolean;input?:unknown;maximum:bigint|number;message:string;origin:\"array\"|\"bigint\"|\"date\"|\"file\"|\"int\"|\"number\"|\"set\"|\"string\"|object&string;path:number|string|symbol[]}|{code:\"too_small\";exact?:boolean;inclusive?:boolean;input?:unknown;message:string;minimum:bigint|number;origin:\"array\"|\"bigint\"|\"date\"|\"file\"|\"int\"|\"number\"|\"set\"|\"string\"|object&string;path:number|string|symbol[]}|{code:\"unrecognized_keys\";input?:Record;keys:string[];message:string;path:number|string|symbol[]}[][];inclusive?:true;input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_union\";discriminator?:string;errors:[];inclusive:false;input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_value\";input?:unknown;message:string;path:number|string|symbol[];values:bigint|false|number|string|symbol|true[]}|{code:\"not_multiple_of\";divisor:number;input?:bigint|number;message:string;path:number|string|symbol[]}|{code:\"too_big\";exact?:boolean;inclusive?:boolean;input?:unknown;maximum:bigint|number;message:string;origin:\"array\"|\"bigint\"|\"date\"|\"file\"|\"int\"|\"number\"|\"set\"|\"string\"|string&{};path:number|string|symbol[]}|{code:\"too_small\";exact?:boolean;inclusive?:boolean;input?:unknown;message:string;minimum:bigint|number;origin:\"array\"|\"bigint\"|\"date\"|\"file\"|\"int\"|\"number\"|\"set\"|\"string\"|string&{};path:number|string|symbol[]}|{code:\"unrecognized_keys\";input?:{[key:string]:unknown};keys:string[];message:string;path:number|string|symbol[]}[];key:unknown;message:string;origin:\"map\"|\"set\";path:number|string|symbol[]}|{code:\"invalid_format\";format:\"base64\"|\"base64url\"|\"cidrv4\"|\"cidrv6\"|\"cuid\"|\"cuid2\"|\"date\"|\"datetime\"|\"duration\"|\"e164\"|\"email\"|\"emoji\"|\"ends_with\"|\"guid\"|\"includes\"|\"ipv4\"|\"ipv6\"|\"json_string\"|\"jwt\"|\"ksuid\"|\"lowercase\"|\"nanoid\"|\"regex\"|\"starts_with\"|\"time\"|\"ulid\"|\"uppercase\"|\"url\"|\"uuid\"|\"xid\"|string&{};input?:string;message:string;path:number|string|symbol[];pattern?:string}|{code:\"invalid_key\";input?:unknown;issues:$ZodIssueInvalidKey|{code:\"custom\";input?:unknown;message:string;params?:{[key:string]:any};path:number|string|symbol[]}|{code:\"invalid_element\";input?:unknown;issues:$ZodIssueInvalidElement|$ZodIssueInvalidKey|{code:\"custom\";input?:unknown;message:string;params?:{[key:string]:any};path:number|string|symbol[]}|{code:\"invalid_format\";format:\"base64\"|\"base64url\"|\"cidrv4\"|\"cidrv6\"|\"cuid\"|\"cuid2\"|\"date\"|\"datetime\"|\"duration\"|\"e164\"|\"email\"|\"emoji\"|\"ends_with\"|\"guid\"|\"includes\"|\"ipv4\"|\"ipv6\"|\"json_string\"|\"jwt\"|\"ksuid\"|\"lowercase\"|\"nanoid\"|\"regex\"|\"starts_with\"|\"time\"|\"ulid\"|\"uppercase\"|\"url\"|\"uuid\"|\"xid\"|string&{};input?:string;message:string;path:number|string|symbol[];pattern?:string}|{code:\"invalid_type\";expected:\"array\"|\"bigint\"|\"boolean\"|\"date\"|\"file\"|\"function\"|\"int\"|\"map\"|\"nan\"|\"never\"|\"nonoptional\"|\"null\"|\"number\"|\"object\"|\"record\"|\"set\"|\"string\"|\"symbol\"|\"tuple\"|\"undefined\"|\"void\"|string&{};input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_union\";discriminator?:string;errors:$ZodIssueCustom|$ZodIssueInvalidElement|$ZodIssueInvalidKey|$ZodIssueInvalidStringFormat|$ZodIssueInvalidType|$ZodIssueInvalidUnionMultipleMatch|$ZodIssueInvalidUnionNoMatch|$ZodIssueInvalidValue|$ZodIssueNotMultipleOf|$ZodIssueTooBig|$ZodIssueTooSmall|$ZodIssueUnrecognizedKeys[][];inclusive?:true;input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_union\";discriminator?:string;errors:[];inclusive:false;input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_value\";input?:unknown;message:string;path:number|string|symbol[];values:bigint|false|number|string|symbol|true[]}|{code:\"not_multiple_of\";divisor:number;input?:bigint|number;message:string;path:number|string|symbol[]}|{code:\"too_big\";exact?:boolean;inclusive?:boolean;input?:unknown;maximum:bigint|number;message:string;origin:\"array\"|\"bigint\"|\"date\"|\"file\"|\"int\"|\"number\"|\"set\"|\"string\"|string&{};path:number|string|symbol[]}|{code:\"too_small\";exact?:boolean;inclusive?:boolean;input?:unknown;message:string;minimum:bigint|number;origin:\"array\"|\"bigint\"|\"date\"|\"file\"|\"int\"|\"number\"|\"set\"|\"string\"|string&{};path:number|string|symbol[]}|{code:\"unrecognized_keys\";input?:{[key:string]:unknown};keys:string[];message:string;path:number|string|symbol[]}[];key:unknown;message:string;origin:\"map\"|\"set\";path:number|string|symbol[]}|{code:\"invalid_format\";format:\"base64\"|\"base64url\"|\"cidrv4\"|\"cidrv6\"|\"cuid\"|\"cuid2\"|\"date\"|\"datetime\"|\"duration\"|\"e164\"|\"email\"|\"emoji\"|\"ends_with\"|\"guid\"|\"includes\"|\"ipv4\"|\"ipv6\"|\"json_string\"|\"jwt\"|\"ksuid\"|\"lowercase\"|\"nanoid\"|\"regex\"|\"starts_with\"|\"time\"|\"ulid\"|\"uppercase\"|\"url\"|\"uuid\"|\"xid\"|string&{};input?:string;message:string;path:number|string|symbol[];pattern?:string}|{code:\"invalid_type\";expected:\"array\"|\"bigint\"|\"boolean\"|\"date\"|\"file\"|\"function\"|\"int\"|\"map\"|\"nan\"|\"never\"|\"nonoptional\"|\"null\"|\"number\"|\"object\"|\"record\"|\"set\"|\"string\"|\"symbol\"|\"tuple\"|\"undefined\"|\"void\"|string&{};input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_union\";discriminator?:string;errors:$ZodIssueInvalidKey|$ZodIssueInvalidUnionNoMatch|{code:\"custom\";input?:unknown;message:string;params?:Record;path:number|string|symbol[]}|{code:\"invalid_element\";input?:unknown;issues:$ZodIssueCustom|$ZodIssueInvalidElement|$ZodIssueInvalidKey|$ZodIssueInvalidStringFormat|$ZodIssueInvalidType|$ZodIssueInvalidUnionMultipleMatch|$ZodIssueInvalidUnionNoMatch|$ZodIssueInvalidValue|$ZodIssueNotMultipleOf|$ZodIssueTooBig|$ZodIssueTooSmall|$ZodIssueUnrecognizedKeys[];key:unknown;message:string;origin:\"map\"|\"set\";path:number|string|symbol[]}|{code:\"invalid_format\";format:\"base64\"|\"base64url\"|\"cidrv4\"|\"cidrv6\"|\"cuid\"|\"cuid2\"|\"date\"|\"datetime\"|\"duration\"|\"e164\"|\"email\"|\"emoji\"|\"ends_with\"|\"guid\"|\"includes\"|\"ipv4\"|\"ipv6\"|\"json_string\"|\"jwt\"|\"ksuid\"|\"lowercase\"|\"nanoid\"|\"regex\"|\"starts_with\"|\"time\"|\"ulid\"|\"uppercase\"|\"url\"|\"uuid\"|\"xid\"|object&string;input?:string;message:string;path:number|string|symbol[];pattern?:string}|{code:\"invalid_type\";expected:\"array\"|\"bigint\"|\"boolean\"|\"date\"|\"file\"|\"function\"|\"int\"|\"map\"|\"nan\"|\"never\"|\"nonoptional\"|\"null\"|\"number\"|\"object\"|\"record\"|\"set\"|\"string\"|\"symbol\"|\"tuple\"|\"undefined\"|\"void\"|object&string;input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_union\";discriminator?:string;errors:[];inclusive:false;input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_value\";input?:unknown;message:string;path:number|string|symbol[];values:bigint|false|number|string|symbol|true[]}|{code:\"not_multiple_of\";divisor:number;input?:bigint|number;message:string;path:number|string|symbol[]}|{code:\"too_big\";exact?:boolean;inclusive?:boolean;input?:unknown;maximum:bigint|number;message:string;origin:\"array\"|\"bigint\"|\"date\"|\"file\"|\"int\"|\"number\"|\"set\"|\"string\"|object&string;path:number|string|symbol[]}|{code:\"too_small\";exact?:boolean;inclusive?:boolean;input?:unknown;message:string;minimum:bigint|number;origin:\"array\"|\"bigint\"|\"date\"|\"file\"|\"int\"|\"number\"|\"set\"|\"string\"|object&string;path:number|string|symbol[]}|{code:\"unrecognized_keys\";input?:Record;keys:string[];message:string;path:number|string|symbol[]}[][];inclusive?:true;input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_union\";discriminator?:string;errors:[];inclusive:false;input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_value\";input?:unknown;message:string;path:number|string|symbol[];values:bigint|false|number|string|symbol|true[]}|{code:\"not_multiple_of\";divisor:number;input?:bigint|number;message:string;path:number|string|symbol[]}|{code:\"too_big\";exact?:boolean;inclusive?:boolean;input?:unknown;maximum:bigint|number;message:string;origin:\"array\"|\"bigint\"|\"date\"|\"file\"|\"int\"|\"number\"|\"set\"|\"string\"|string&{};path:number|string|symbol[]}|{code:\"too_small\";exact?:boolean;inclusive?:boolean;input?:unknown;message:string;minimum:bigint|number;origin:\"array\"|\"bigint\"|\"date\"|\"file\"|\"int\"|\"number\"|\"set\"|\"string\"|string&{};path:number|string|symbol[]}|{code:\"unrecognized_keys\";input?:{[key:string]:unknown};keys:string[];message:string;path:number|string|symbol[]}[];message:string;origin:\"map\"|\"record\";path:number|string|symbol[]}|{code:\"invalid_type\";expected:\"array\"|\"bigint\"|\"boolean\"|\"date\"|\"file\"|\"function\"|\"int\"|\"map\"|\"nan\"|\"never\"|\"nonoptional\"|\"null\"|\"number\"|\"object\"|\"record\"|\"set\"|\"string\"|\"symbol\"|\"tuple\"|\"undefined\"|\"void\"|string&{};input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_union\";discriminator?:string;errors:$ZodIssueInvalidUnionNoMatch|{code:\"custom\";input?:unknown;message:string;params?:{[key:string]:any};path:number|string|symbol[]}|{code:\"invalid_element\";input?:unknown;issues:$ZodIssueInvalidElement|$ZodIssueInvalidUnionNoMatch|{code:\"custom\";input?:unknown;message:string;params?:Record;path:number|string|symbol[]}|{code:\"invalid_format\";format:\"base64\"|\"base64url\"|\"cidrv4\"|\"cidrv6\"|\"cuid\"|\"cuid2\"|\"date\"|\"datetime\"|\"duration\"|\"e164\"|\"email\"|\"emoji\"|\"ends_with\"|\"guid\"|\"includes\"|\"ipv4\"|\"ipv6\"|\"json_string\"|\"jwt\"|\"ksuid\"|\"lowercase\"|\"nanoid\"|\"regex\"|\"starts_with\"|\"time\"|\"ulid\"|\"uppercase\"|\"url\"|\"uuid\"|\"xid\"|object&string;input?:string;message:string;path:number|string|symbol[];pattern?:string}|{code:\"invalid_key\";input?:unknown;issues:$ZodIssueCustom|$ZodIssueInvalidElement|$ZodIssueInvalidKey|$ZodIssueInvalidStringFormat|$ZodIssueInvalidType|$ZodIssueInvalidUnionMultipleMatch|$ZodIssueInvalidUnionNoMatch|$ZodIssueInvalidValue|$ZodIssueNotMultipleOf|$ZodIssueTooBig|$ZodIssueTooSmall|$ZodIssueUnrecognizedKeys[];message:string;origin:\"map\"|\"record\";path:number|string|symbol[]}|{code:\"invalid_type\";expected:\"array\"|\"bigint\"|\"boolean\"|\"date\"|\"file\"|\"function\"|\"int\"|\"map\"|\"nan\"|\"never\"|\"nonoptional\"|\"null\"|\"number\"|\"object\"|\"record\"|\"set\"|\"string\"|\"symbol\"|\"tuple\"|\"undefined\"|\"void\"|object&string;input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_union\";discriminator?:string;errors:[];inclusive:false;input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_value\";input?:unknown;message:string;path:number|string|symbol[];values:bigint|false|number|string|symbol|true[]}|{code:\"not_multiple_of\";divisor:number;input?:bigint|number;message:string;path:number|string|symbol[]}|{code:\"too_big\";exact?:boolean;inclusive?:boolean;input?:unknown;maximum:bigint|number;message:string;origin:\"array\"|\"bigint\"|\"date\"|\"file\"|\"int\"|\"number\"|\"set\"|\"string\"|object&string;path:number|string|symbol[]}|{code:\"too_small\";exact?:boolean;inclusive?:boolean;input?:unknown;message:string;minimum:bigint|number;origin:\"array\"|\"bigint\"|\"date\"|\"file\"|\"int\"|\"number\"|\"set\"|\"string\"|object&string;path:number|string|symbol[]}|{code:\"unrecognized_keys\";input?:Record;keys:string[];message:string;path:number|string|symbol[]}[];key:unknown;message:string;origin:\"map\"|\"set\";path:number|string|symbol[]}|{code:\"invalid_format\";format:\"base64\"|\"base64url\"|\"cidrv4\"|\"cidrv6\"|\"cuid\"|\"cuid2\"|\"date\"|\"datetime\"|\"duration\"|\"e164\"|\"email\"|\"emoji\"|\"ends_with\"|\"guid\"|\"includes\"|\"ipv4\"|\"ipv6\"|\"json_string\"|\"jwt\"|\"ksuid\"|\"lowercase\"|\"nanoid\"|\"regex\"|\"starts_with\"|\"time\"|\"ulid\"|\"uppercase\"|\"url\"|\"uuid\"|\"xid\"|string&{};input?:string;message:string;path:number|string|symbol[];pattern?:string}|{code:\"invalid_key\";input?:unknown;issues:$ZodIssueInvalidKey|$ZodIssueInvalidUnionNoMatch|{code:\"custom\";input?:unknown;message:string;params?:Record;path:number|string|symbol[]}|{code:\"invalid_element\";input?:unknown;issues:$ZodIssueCustom|$ZodIssueInvalidElement|$ZodIssueInvalidKey|$ZodIssueInvalidStringFormat|$ZodIssueInvalidType|$ZodIssueInvalidUnionMultipleMatch|$ZodIssueInvalidUnionNoMatch|$ZodIssueInvalidValue|$ZodIssueNotMultipleOf|$ZodIssueTooBig|$ZodIssueTooSmall|$ZodIssueUnrecognizedKeys[];key:unknown;message:string;origin:\"map\"|\"set\";path:number|string|symbol[]}|{code:\"invalid_format\";format:\"base64\"|\"base64url\"|\"cidrv4\"|\"cidrv6\"|\"cuid\"|\"cuid2\"|\"date\"|\"datetime\"|\"duration\"|\"e164\"|\"email\"|\"emoji\"|\"ends_with\"|\"guid\"|\"includes\"|\"ipv4\"|\"ipv6\"|\"json_string\"|\"jwt\"|\"ksuid\"|\"lowercase\"|\"nanoid\"|\"regex\"|\"starts_with\"|\"time\"|\"ulid\"|\"uppercase\"|\"url\"|\"uuid\"|\"xid\"|object&string;input?:string;message:string;path:number|string|symbol[];pattern?:string}|{code:\"invalid_type\";expected:\"array\"|\"bigint\"|\"boolean\"|\"date\"|\"file\"|\"function\"|\"int\"|\"map\"|\"nan\"|\"never\"|\"nonoptional\"|\"null\"|\"number\"|\"object\"|\"record\"|\"set\"|\"string\"|\"symbol\"|\"tuple\"|\"undefined\"|\"void\"|object&string;input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_union\";discriminator?:string;errors:[];inclusive:false;input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_value\";input?:unknown;message:string;path:number|string|symbol[];values:bigint|false|number|string|symbol|true[]}|{code:\"not_multiple_of\";divisor:number;input?:bigint|number;message:string;path:number|string|symbol[]}|{code:\"too_big\";exact?:boolean;inclusive?:boolean;input?:unknown;maximum:bigint|number;message:string;origin:\"array\"|\"bigint\"|\"date\"|\"file\"|\"int\"|\"number\"|\"set\"|\"string\"|object&string;path:number|string|symbol[]}|{code:\"too_small\";exact?:boolean;inclusive?:boolean;input?:unknown;message:string;minimum:bigint|number;origin:\"array\"|\"bigint\"|\"date\"|\"file\"|\"int\"|\"number\"|\"set\"|\"string\"|object&string;path:number|string|symbol[]}|{code:\"unrecognized_keys\";input?:Record;keys:string[];message:string;path:number|string|symbol[]}[];message:string;origin:\"map\"|\"record\";path:number|string|symbol[]}|{code:\"invalid_type\";expected:\"array\"|\"bigint\"|\"boolean\"|\"date\"|\"file\"|\"function\"|\"int\"|\"map\"|\"nan\"|\"never\"|\"nonoptional\"|\"null\"|\"number\"|\"object\"|\"record\"|\"set\"|\"string\"|\"symbol\"|\"tuple\"|\"undefined\"|\"void\"|string&{};input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_union\";discriminator?:string;errors:[];inclusive:false;input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_value\";input?:unknown;message:string;path:number|string|symbol[];values:bigint|false|number|string|symbol|true[]}|{code:\"not_multiple_of\";divisor:number;input?:bigint|number;message:string;path:number|string|symbol[]}|{code:\"too_big\";exact?:boolean;inclusive?:boolean;input?:unknown;maximum:bigint|number;message:string;origin:\"array\"|\"bigint\"|\"date\"|\"file\"|\"int\"|\"number\"|\"set\"|\"string\"|string&{};path:number|string|symbol[]}|{code:\"too_small\";exact?:boolean;inclusive?:boolean;input?:unknown;message:string;minimum:bigint|number;origin:\"array\"|\"bigint\"|\"date\"|\"file\"|\"int\"|\"number\"|\"set\"|\"string\"|string&{};path:number|string|symbol[]}|{code:\"unrecognized_keys\";input?:{[key:string]:unknown};keys:string[];message:string;path:number|string|symbol[]}[][];inclusive?:true;input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_union\";discriminator?:string;errors:[];inclusive:false;input?:unknown;message:string;path:number|string|symbol[]}|{code:\"invalid_value\";input?:unknown;message:string;path:number|string|symbol[];values:bigint|false|number|string|symbol|true[]}|{code:\"not_multiple_of\";divisor:number;input?:bigint|number;message:string;path:number|string|symbol[]}|{code:\"too_big\";exact?:boolean;inclusive?:boolean;input?:unknown;maximum:bigint|number;message:string;origin:\"array\"|\"bigint\"|\"date\"|\"file\"|\"int\"|\"number\"|\"set\"|\"string\"|string&{};path:number|string|symbol[]}|{code:\"too_small\";exact?:boolean;inclusive?:boolean;input?:unknown;message:string;minimum:bigint|number;origin:\"array\"|\"bigint\"|\"date\"|\"file\"|\"int\"|\"number\"|\"set\"|\"string\"|string&{};path:number|string|symbol[]}|{code:\"unrecognized_keys\";input?:{[key:string]:unknown};keys:string[];message:string;path:number|string|symbol[]}[]}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.issues[].input",
        "debtId": "debt.wire.arbitrary.xc369t"
      },
      {
        "path": "response.body.issues[].key",
        "debtId": "debt.wire.arbitrary.hupwii"
      },
      {
        "path": "response.body.issues[].params",
        "debtId": "debt.wire.arbitrary.jw3yix"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.admin.content.reports.reportid.actions.2nudx5",
    "locator": "http:request_response:POST /api/admin/content-reports/:reportId/actions",
    "structuralSignatures": [
      "request.params:{reportId:string}",
      "response.body:{error:string}",
      "response.body:{reportId:string;status:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.admin.encryption.transition.114o1ir",
    "locator": "http:request_response:POST /api/admin/encryption-transition",
    "structuralSignatures": [
      "response.body:unknown",
      "response.body:{currentRevision:number;error:string}",
      "response.body:{dtoVersion:1;historyReads:{eligible:string;fallback:string;outcomes:{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"failed\";reason:\"integrity_failure\"|\"parity_mismatch\"|\"publication_failure\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"pending\";reason:\"none\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"reconciling\";reason:\"response_lost\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"unavailable\";reason:\"client_crypto_preparation_failed\"|\"client_crypto_unavailable\"|\"client_custody_unavailable\"|\"client_observation_expired\"|\"current_read_authority_unavailable\"|\"live_shadow_lifecycle_unavailable\"|\"namespace_encryption_not_ready\"|\"retained_key_material_unavailable\"|\"signer_evidence_unavailable\"|\"stale_authority_product\"|\"unmigrated\"|\"unsupported_operation\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"verified\";reason:\"none\"}[];pagesAttempted:string;pagesPending:string;pending:string;percent?:number;scope:\"browser_room_history_shadow_reads\";selected:string;verified:string};humanPeerLive:{recipientReads:{attempted:string;fallback:string;percent?:number;verified:string};recipientSync:{ready:string;recoveryRequired:string;syncing:string;unrecoverable:string;waitingForAuthorizedDevice:string};scope:\"browser_human_only_live_messages\";writes:{eligible:string;fallback:string;pending:string;percent?:number;published:string}};liveTurns:{completeRoundTrip:{eligible:string;percent?:number;verified:string};entities:{eligible:string;entity:\"final_agent_message\"|\"human_message\"|\"tool_call\"|\"tool_result\";percent?:number;verified:string}[];fallbacks:{count:string;reason:\"agent_authority_unavailable\"|\"cancelled\"|\"deadline_expired\"|\"device_unavailable\"|\"domain_unavailable\"|\"integrity_failure\"|\"namespace_unavailable\"|\"parity_mismatch\"|\"product_conflict\"|\"protected_unavailable\"|\"recipient_lost\"|\"reservation_unavailable\"|\"stale_authority\";stage:\"agent_input\"|\"assistant_message\"|\"assistant_stream\"|\"client_verification\"|\"durable_transcript\"|\"human_admission\"|\"plan\"|\"session_establishment\"|\"session_reuse\"|\"shutdown\"|\"tool_call\"|\"tool_result\"}[];pending:{oldestPendingAt?:string;turns:string};scope:\"live_new_browser_private_room_turns\";stages:{eligible:string;percent?:number;stage:\"agent_protected_input\"|\"agent_stream_frame_chain\"|\"assistant_tool_call_boundary\"|\"browser_durable_transcript_parity\"|\"browser_human_prepare\"|\"browser_stream_frame_chain\"|\"browser_terminal_acknowledgement\"|\"human_durable_mapping\"|\"server_human_open_parity\"|\"tool_result_boundary\"|\"transcript_durable_mappings\";verified:string}[]};metrics:{attemptOutcomes:{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"failed\";reason:\"integrity_failure\"|\"parity_mismatch\"|\"publication_failure\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"pending\";reason:\"none\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"reconciling\";reason:\"response_lost\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"unavailable\";reason:\"client_crypto_preparation_failed\"|\"client_crypto_unavailable\"|\"client_custody_unavailable\"|\"client_observation_expired\"|\"current_read_authority_unavailable\"|\"live_shadow_lifecycle_unavailable\"|\"namespace_encryption_not_ready\"|\"retained_key_material_unavailable\"|\"signer_evidence_unavailable\"|\"stale_authority_product\"|\"unmigrated\"|\"unsupported_operation\"}|{count:string;operation:\"access_update\"|\"create\"|\"read\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"verified\";reason:\"none\"}[];attemptSuccess:{eligible:string;percent?:number;verified:string};family:\"artifact\"|\"memory\"|\"message\"|\"overall\"|\"record\";pendingLifecycle:{oldestPendingAt?:string;operations:string};storedCoverage:{percent?:number;total:string;verified:string};touchedCoverage:{percent?:number;total:string;verified:string}}[];observationPressure:{admissionCapacity:string;capacityRows:string;maximumRetentionMs:number;pendingAdmissions:string;retainedRows:string};policy:{mode:\"plaintext_only\"|\"shadow_encryption\";revision:number;shadowEncryptionStartedAt?:string;updatedAt:string};sharedAgentLive:{agentRecipientReads:{attempted:string;fallback:string;percent?:number;verified:string};authorization:{established:string;expired:string;reused:string;revoked:string;unavailable:string};conductor:{authorizationEstablished:string;authorizationReused:string;awaitingAuthorization:string;awaitingUser:string;currentInputVerified:string;deterministic:string;eligible:string;fallback:string;fallbackReasons:{count:string;reason:string}[];floorManager:string;historyNotRequested:string;historyUnavailable:string;historyVerified:string;notSelected:string;selected:string;selectedAgentExecutions:string;unavailable:string;verifiedAwaitingUser:string;verifiedSilent:string;verifiedWake:string};executions:{authorized:string;awaitingAuthorization:string;completed:string;failed:string;fallback:string;protectedInputs:string;running:string};outputStages:{assistantPublished:string;streamCompleted:string;streamStarted:string;toolPublished:string};planningFallbacks:{deviceUnavailable:string;namespaceUnavailable:string;recipientSyncRequired:string;unavailable:string};recipientCoverage:{plaintextOnlyHumans:string;protectedDevices:string;protectedHumans:string;totalHumans:string};recipientReads:{attempted:string;fallback:string;percent?:number;verified:string};resumes:{attempted:string;authorized:string;awaitingAuthorization:string;completed:string;failed:string;fallback:string;running:string};scope:\"browser_multi_human_single_agent_live_messages\";writes:{eligible:string;fallback:string;pending:string;percent?:number;published:string}}}",
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
    "observationId": "wire.http.request.response.post.api.admin.users.provision.1ds6x6s",
    "locator": "http:request_response:POST /api/admin/users/provision",
    "structuralSignatures": [
      "request.body:{[key:string]:unknown;displayName?:unknown;email?:unknown;handle?:unknown;permanentCredential?:unknown;roleSlug?:unknown}",
      "response.body:{actorId:string;auditRecorded:boolean;credential:{disposition:\"issued\";pin:string;recoveryCodes:string[];temporaryPassword:string}|{disposition:\"not_reissued\"}|{disposition:\"provided\";recoveryCodes:string[]};idempotent:boolean;landingRoomId:string;memberId:string;ok:boolean;receiptId:string;roleSlug:\"admin\"|\"contributor\"|\"guest\"|\"member\"|\"owner\"|\"superuser\"}",
      "response.body:{code:any;retrySafe:any}",
      "response.body:{code:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.displayName",
        "schema": "ProvisionMemberIntent.displayName"
      },
      {
        "path": "request.body.email",
        "schema": "ProvisionMemberIntent.email"
      },
      {
        "path": "request.body.handle",
        "schema": "ProvisionMemberIntent.handle"
      },
      {
        "path": "request.body.permanentCredential",
        "schema": "TransientOperatorCredentialV1"
      },
      {
        "path": "request.body.roleSlug",
        "schema": "ProvisionMemberIntent.roleSlug"
      },
      {
        "path": "response.body.code",
        "schema": "ProvisionMemberFailure.code"
      },
      {
        "path": "response.body.retrySafe",
        "schema": "ProvisionMemberFailure.retrySafe"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.auth.approval.reply.p3nnrh",
    "locator": "http:request_response:POST /api/auth/approval-reply",
    "structuralSignatures": [
      "request.body:{approvalId?:string;authorizationDeviceId?:string;clientActionSessionId?:string;laneKey?:string;localMcpInstallDigest?:string;mediaGenerationDigest?:string;mediaGenerationQuoteDigest?:string;mediaGenerationRevision?:number;threadId?:string;verb?:string}",
      "response.body:{capability?:any;code?:any;error:any}",
      "response.body:{code:string;error:string}",
      "response.body:{error:string}",
      "response.body:{ok:boolean}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.capability",
        "schema": "AuthorizationResumeCapabilityV1"
      },
      {
        "path": "response.body.code",
        "schema": "AuthorizationResumeCode"
      },
      {
        "path": "response.body.error",
        "debtId": "debt.wire.arbitrary.1htcncx"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.auth.identity.verify.resume.g7jmt3",
    "locator": "http:request_response:POST /api/auth/identity-verify-resume",
    "structuralSignatures": [
      "request.body:{authorizationDeviceId?:string;clientActionSessionId?:string;laneKey?:string;pin:string;threadId:string}",
      "response.body:{capability?:any;code?:any;error:any}",
      "response.body:{code:string;error:string}",
      "response.body:{error:string;retryAfterMs:number}",
      "response.body:{error:string}",
      "response.body:{ok:boolean}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.capability",
        "schema": "AuthorizationResumeCapabilityV1"
      },
      {
        "path": "response.body.code",
        "schema": "AuthorizationResumeCode"
      },
      {
        "path": "response.body.error",
        "schema": "AuthorizationResumeError"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.auth.pin.sj48n2",
    "locator": "http:request_response:POST /api/auth/pin",
    "structuralSignatures": [
      "request.body:{authorizationDeviceId?:string;clientActionSessionId?:string;currentPin?:string;laneKey?:string;newPin:string;threadId?:string}",
      "response.body:{capability:any;code:any;error:any}",
      "response.body:{code:string;error:string}",
      "response.body:{enrolled:boolean;ok:boolean;recoveryCodes:string[]}",
      "response.body:{error:string;retryAfterMs:number}",
      "response.body:{error:string}",
      "response.body:{ok:boolean}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.capability",
        "schema": "AuthorizationResumeCapabilityV1"
      },
      {
        "path": "response.body.code",
        "schema": "AuthorizationResumeCode"
      },
      {
        "path": "response.body.error",
        "schema": "AuthorizationResumeError"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.auth.prove.and.resume.1049ell",
    "locator": "http:request_response:POST /api/auth/prove-and-resume",
    "structuralSignatures": [
      "request.body:{authorizationDeviceId?:string;clientActionSessionId?:string;denied?:boolean;laneKey?:string;pin?:string;threadId:string}",
      "response.body:{capability?:any;code?:any;error:any}",
      "response.body:{code:string;error:string}",
      "response.body:{error:string;retryAfterMs:number}",
      "response.body:{error:string}",
      "response.body:{ok:boolean}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.capability",
        "schema": "AuthorizationResumeCapabilityV1"
      },
      {
        "path": "response.body.code",
        "schema": "AuthorizationResumeCode"
      },
      {
        "path": "response.body.error",
        "debtId": "debt.wire.arbitrary.1viwnx"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.claude.connections.check.1dsdc6x",
    "locator": "http:request_response:POST /api/claude-connections/check",
    "structuralSignatures": [
      "response.body:{catch:function;finally:function;then:function}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.claude.connections.model.1e62vxw",
    "locator": "http:request_response:POST /api/claude-connections/model",
    "structuralSignatures": [
      "response.body:{code:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.claude.connections.toggle.1ld113f",
    "locator": "http:request_response:POST /api/claude-connections/toggle",
    "structuralSignatures": [
      "response.body:{catch:function;finally:function;then:function}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.codex.requests.requestref.respond.xjlupz",
    "locator": "http:request_response:POST /api/codex/requests/:requestRef/respond",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{requestRef:string}",
      "response.body:void",
      "response.body:{catch:function;finally:function;then:function}",
      "response.body:{code:string}",
      "response.body:{error:string}",
      "response.body:{requestId:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "CodexRequestResponseV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.content.reports.1tu573z",
    "locator": "http:request_response:POST /api/content-reports",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{id:string;receivedAt:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.id.messages.shadow.read.operationid.ack.llcwzm",
    "locator": "http:request_response:POST /api/rooms/:id/messages/shadow-read/:operationId/ack",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{id:string;operationId:string}",
      "response.body:{error:string}",
      "response.body:{operationId:string;responseVersion:1;status:\"accepted\"|\"replayed\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "ClosedRequestBodyV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.id.stop.gxwr69",
    "locator": "http:request_response:POST /api/rooms/:id/stop",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{droppedBufferedLanes:number;droppedQueuedTurns:number;stopped:boolean;stoppedJobs:number;stoppedTasks?:number}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.grant.domain.grantdomainid.acknowledge.199jhda",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/grant-domain/:grantDomainId/acknowledge",
    "structuralSignatures": [
      "request.params:{grantDomainId?:string;roomId?:string}",
      "response.body:{acknowledgementDigestBase64url:string;responseVersion:number;status:\"acknowledged\"|\"replayed\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.grant.domain.grantdomainid.fetch.bxvo6q",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/grant-domain/:grantDomainId/fetch",
    "structuralSignatures": [
      "request.params:{grantDomainId?:string;roomId?:string}",
      "response.body:{domainKeyGeneration:number;envelopeIssuerSigningPublicKeyBase64url:string;grantDomainId:string;headDigestBase64url:string;participantDigestBase64url:string;publicationAuthorizationRevision:number&{ readonly [counterBrand]: \"AuthorizationRevision\"; };publicationDigestBase64url:string;recipientDeviceRevision:number;recipientEnvelopeBytesBase64url:string;recipientEnvelopeDigestBase64url:string;responseVersion:number}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.grant.domain.namespaceid.bundle.plan.fyoto5",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/grant-domain/:namespaceId/bundle/plan",
    "structuralSignatures": [
      "request.params:{namespaceId?:string;roomId?:string}",
      "response.body:{bindingDigestBase64url:string;bundleBytesBase64url:string;bundleRevision:number;deadlineAt?:undefined;domainAuthorizationRevision:number&{ readonly [counterBrand]: \"AuthorizationRevision\"; };domainKeyGeneration:number;grantDomainAuthorizationRevision?:undefined;grantDomainHeadDigestBase64url?:undefined;grantDomainId:string;grantDomainKeyGeneration?:undefined;idempotencyKey?:undefined;issuedAt?:undefined;issuerDeviceId?:undefined;issuerDeviceSigningGeneration?:undefined;issuerDeviceSigningPublicKeyBase64url:string;issuerHumanId?:undefined;namespaceAccessRevision?:undefined;namespaceAiGeneration?:undefined;namespaceAiHeadDigestBase64url?:undefined;namespaceAudienceFingerprintBase64url?:undefined;namespaceId:string&{ readonly [portableIdBrand]: \"NamespaceId\"; };operationId?:undefined;participantDigestBase64url:string;previousBindingDigestBase64url?:undefined;responseVersion:1;retainedAuthorities?:undefined;retainedAuthoritySetDigestBase64url?:undefined;status:\"ready\"}|{bindingDigestBase64url?:undefined;bundleBytesBase64url?:undefined;bundleRevision:number;deadlineAt:number;domainAuthorizationRevision?:undefined;domainKeyGeneration?:undefined;grantDomainAuthorizationRevision:number&{ readonly [counterBrand]: \"AuthorizationRevision\"; };grantDomainHeadDigestBase64url:string;grantDomainId:string;grantDomainKeyGeneration:number;idempotencyKey:string;issuedAt:number;issuerDeviceId:string&{ readonly [portableIdBrand]: \"CryptoDeviceId\"; };issuerDeviceSigningGeneration:number;issuerDeviceSigningPublicKeyBase64url:string;issuerHumanId:string&{ readonly [portableIdBrand]: \"HumanId\"; };namespaceAccessRevision:number;namespaceAiGeneration:number;namespaceAiHeadDigestBase64url:string;namespaceAudienceFingerprintBase64url:string;namespaceId:string&{ readonly [portableIdBrand]: \"NamespaceId\"; };operationId:string;participantDigestBase64url:string;previousBindingDigestBase64url:string;responseVersion:1;retainedAuthorities:{accessRevision:number&{ readonly [counterBrand]: \"AccessRevision\"; };audienceFingerprintBase64url:string;generation:number&{ readonly [counterBrand]: \"NamespaceKeyGeneration\"; };headDigestBase64url:string;publicationDigestBase64url:string;publicationSetDigestBase64url:string}[];retainedAuthoritySetDigestBase64url:string;status:\"create_required\"}|{bindingDigestBase64url?:undefined;bundleBytesBase64url?:undefined;bundleRevision?:undefined;deadlineAt?:undefined;domainAuthorizationRevision?:undefined;domainKeyGeneration?:undefined;grantDomainAuthorizationRevision?:undefined;grantDomainHeadDigestBase64url?:undefined;grantDomainId?:undefined;grantDomainKeyGeneration?:undefined;idempotencyKey?:undefined;issuedAt?:undefined;issuerDeviceId?:undefined;issuerDeviceSigningGeneration?:undefined;issuerDeviceSigningPublicKeyBase64url?:undefined;issuerHumanId?:undefined;namespaceAccessRevision?:undefined;namespaceAiGeneration?:undefined;namespaceAiHeadDigestBase64url?:undefined;namespaceAudienceFingerprintBase64url?:undefined;namespaceId?:undefined;operationId?:undefined;participantDigestBase64url?:undefined;previousBindingDigestBase64url?:undefined;reason:\"authority_inconsistent\"|\"grant_domain_unavailable\"|\"issuer_unavailable\"|\"namespace_authority_unavailable\";responseVersion:1;retainedAuthorities?:undefined;retainedAuthoritySetDigestBase64url?:undefined;status:\"unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.grant.domain.namespaceid.bundle.publish.1ixc3ul",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/grant-domain/:namespaceId/bundle/publish",
    "structuralSignatures": [
      "request.params:{namespaceId?:string;roomId?:string}",
      "response.body:{bindingDigestBase64url:string;bundleRevision:number;domainAuthorizationRevision:number&{ readonly [counterBrand]: \"AuthorizationRevision\"; };domainKeyGeneration:number;grantDomainId:string;namespaceId:string&{ readonly [portableIdBrand]: \"NamespaceId\"; };operationId:string;participantDigestBase64url:string;responseVersion:number;retainedAuthoritySetDigestBase64url:string;status:\"published\"|\"replayed\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.grant.domain.namespaceid.plan.13ze3pe",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/grant-domain/:namespaceId/plan",
    "structuralSignatures": [
      "request.params:{namespaceId?:string;roomId?:string}",
      "response.body:{authorizationRevision:number&{ readonly [counterBrand]: \"AuthorizationRevision\"; };deadlineAt:number;domainKeyGeneration:number;grantDomainId:string;headDigestBase64url?:undefined;idempotencyKey:string;issuedAt:number;issuerDeviceId:string&{ readonly [portableIdBrand]: \"CryptoDeviceId\"; };issuerDeviceSigningGeneration:number;issuerDeviceSigningPublicKeyBase64url:string;issuerHumanId:string&{ readonly [portableIdBrand]: \"HumanId\"; };operationId:string;participantDigestBase64url:string;participantHumanIds:string&{ readonly [portableIdBrand]: \"HumanId\"; }[];pendingParticipantHumanIds:string&{ readonly [portableIdBrand]: \"HumanId\"; }[];pendingRecipients?:undefined;previousHeadDigestBase64url:string;publicationAuthorizationRevision?:undefined;publicationBytesBase64url?:undefined;publicationDigestBase64url?:undefined;recipientDeviceSigningKeyGeneration?:undefined;recipientEnvelopeBytesBase64url?:undefined;recipientEnvelopeDigestBase64url?:undefined;recipients:{recipientHumanId:string&{ readonly [portableIdBrand]: \"HumanId\"; };recipientKeyGeneration:number;recipientKeyId:string;recipientKind:\"device\"|\"recovery\";recipientPublicKeyBase64url:string;recipientPublicKeyDigestBase64url:string}[];responseVersion:1;status:\"create_required\"|\"rotation_required\";subjectHumanId?:undefined}|{authorizationRevision:number&{ readonly [counterBrand]: \"AuthorizationRevision\"; };deadlineAt?:undefined;domainKeyGeneration:number;grantDomainId:string;headDigestBase64url:string;idempotencyKey?:undefined;issuedAt?:undefined;issuerDeviceId?:undefined;issuerDeviceSigningGeneration?:undefined;issuerDeviceSigningPublicKeyBase64url:string;issuerHumanId?:undefined;operationId?:undefined;participantDigestBase64url:string;participantHumanIds:string&{ readonly [portableIdBrand]: \"HumanId\"; }[];pendingParticipantHumanIds:string&{ readonly [portableIdBrand]: \"HumanId\"; }[];pendingRecipients:{recipientHumanId:string&{ readonly [portableIdBrand]: \"HumanId\"; };recipientKeyGeneration:number;recipientKeyId:string;recipientKind:\"device\"|\"recovery\";recipientPublicKeyBase64url:string;recipientPublicKeyDigestBase64url:string}[];previousHeadDigestBase64url?:undefined;publicationAuthorizationRevision:number&{ readonly [counterBrand]: \"AuthorizationRevision\"; };publicationBytesBase64url:string;publicationDigestBase64url:string;recipientDeviceSigningKeyGeneration:number;recipientEnvelopeBytesBase64url:string;recipientEnvelopeDigestBase64url:string;recipients?:undefined;responseVersion:1;status:\"ready\";subjectHumanId:string&{ readonly [portableIdBrand]: \"HumanId\"; }}|{authorizationRevision?:undefined;deadlineAt?:undefined;domainKeyGeneration?:undefined;grantDomainId?:undefined;headDigestBase64url?:undefined;idempotencyKey?:undefined;issuedAt?:undefined;issuerDeviceId?:undefined;issuerDeviceSigningGeneration?:undefined;issuerDeviceSigningPublicKeyBase64url?:undefined;issuerHumanId?:undefined;operationId?:undefined;participantDigestBase64url?:undefined;participantHumanIds?:undefined;pendingParticipantHumanIds?:undefined;pendingRecipients?:undefined;previousHeadDigestBase64url?:undefined;publicationAuthorizationRevision?:undefined;publicationBytesBase64url?:undefined;publicationDigestBase64url?:undefined;reason:\"authority_inconsistent\"|\"issuer_unavailable\"|\"recipient_inventory_incomplete\"|\"recipient_sync_required\";recipientDeviceSigningKeyGeneration?:undefined;recipientEnvelopeBytesBase64url?:undefined;recipientEnvelopeDigestBase64url?:undefined;recipients?:undefined;responseVersion:1;status:\"unavailable\";subjectHumanId?:undefined}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.grant.domain.namespaceid.publish.1tkfiu0",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/grant-domain/:namespaceId/publish",
    "structuralSignatures": [
      "request.params:{namespaceId?:string;roomId?:string}",
      "response.body:{authorizationRevision:number&{ readonly [counterBrand]: \"AuthorizationRevision\"; };domainKeyGeneration:number;grantDomainId:string;headDigestBase64url:string;operationId:string;participantDigestBase64url:string;pendingParticipantHumanIds:string&{ readonly [portableIdBrand]: \"HumanId\"; }[];publicationAuthorizationRevision:number&{ readonly [counterBrand]: \"AuthorizationRevision\"; };publicationDigestBase64url:string;recipientCount:number;recipientSetDigestBase64url:string;responseVersion:number;status:\"published\"|\"replayed\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.grant.domain.namespaceid.recipient.sync.authorize.1tkwujk",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/grant-domain/:namespaceId/recipient-sync/authorize",
    "structuralSignatures": [
      "request.params:{namespaceId?:string;roomId?:string}",
      "response.body:{authorizationDigestBase64url:string;domainKeyGeneration:number;envelopeDigestBase64url:string;grantDomainId:string;operationId:string;participantDigestBase64url:string;recipientHumanId:string&{ readonly [portableIdBrand]: \"HumanId\"; };recipientKeyGeneration:number;recipientKeyId:string;recipientKind:\"device\"|\"recovery\";responseVersion:number;status:\"authorized\"|\"replayed\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.grant.domain.namespaceid.recipient.sync.plan.fx2arm",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/grant-domain/:namespaceId/recipient-sync/plan",
    "structuralSignatures": [
      "request.params:{namespaceId?:string;roomId?:string}",
      "response.body:{authorizationRevision:number&{ readonly [counterBrand]: \"AuthorizationRevision\"; };deadlineAt:number;domainKeyGeneration:number;envelopeIssuerSigningPublicKeyBase64url?:undefined;grantDomainId:string;headDigestBase64url:string;idempotencyKey:string;issuedAt:number;issuerDeviceId:string&{ readonly [portableIdBrand]: \"CryptoDeviceId\"; };issuerDeviceSigningGeneration:number;issuerDeviceSigningPublicKeyBase64url:string;issuerHumanId:string&{ readonly [portableIdBrand]: \"HumanId\"; };operationId:string;participantDigestBase64url:string;publicationAuthorizationRevision:number&{ readonly [counterBrand]: \"AuthorizationRevision\"; };publicationDigestBase64url:string;recipientEnvelopeBytesBase64url?:undefined;recipientEnvelopeDigestBase64url?:undefined;recipientHumanId?:undefined;recipientKeyGeneration?:undefined;recipientKeyId?:undefined;recipientKind?:undefined;responseVersion:1;sourceEnvelopeBytesBase64url:string;sourceEnvelopeDigestBase64url:string;sourceEnvelopeIssuerSigningPublicKeyBase64url:string;status:\"authorization_required\";target:{recipientHumanId:string&{ readonly [portableIdBrand]: \"HumanId\"; };recipientKeyGeneration:number;recipientKeyId:string;recipientKind:\"device\"|\"recovery\";recipientPublicKeyBase64url:string;recipientPublicKeyDigestBase64url:string}}|{authorizationRevision:number&{ readonly [counterBrand]: \"AuthorizationRevision\"; };deadlineAt?:undefined;domainKeyGeneration:number;envelopeIssuerSigningPublicKeyBase64url:string;grantDomainId:string;headDigestBase64url:string;idempotencyKey?:undefined;issuedAt?:undefined;issuerDeviceId?:undefined;issuerDeviceSigningGeneration?:undefined;issuerDeviceSigningPublicKeyBase64url?:undefined;issuerHumanId?:undefined;operationId?:undefined;participantDigestBase64url:string;publicationAuthorizationRevision:number&{ readonly [counterBrand]: \"AuthorizationRevision\"; };publicationDigestBase64url:string;recipientEnvelopeBytesBase64url:string;recipientEnvelopeDigestBase64url:string;recipientHumanId:string&{ readonly [portableIdBrand]: \"HumanId\"; };recipientKeyGeneration:number;recipientKeyId:string;recipientKind:\"device\"|\"recovery\";responseVersion:1;sourceEnvelopeBytesBase64url?:undefined;sourceEnvelopeDigestBase64url?:undefined;sourceEnvelopeIssuerSigningPublicKeyBase64url?:undefined;status:\"ready\";target?:undefined}|{authorizationRevision?:undefined;deadlineAt?:undefined;domainKeyGeneration?:undefined;envelopeIssuerSigningPublicKeyBase64url?:undefined;grantDomainId?:undefined;headDigestBase64url?:undefined;idempotencyKey?:undefined;issuedAt?:undefined;issuerDeviceId?:undefined;issuerDeviceSigningGeneration?:undefined;issuerDeviceSigningPublicKeyBase64url?:undefined;issuerHumanId?:undefined;operationId?:undefined;participantDigestBase64url?:undefined;publicationAuthorizationRevision?:undefined;publicationDigestBase64url?:undefined;reason:\"authority_inconsistent\"|\"grant_domain_unavailable\"|\"issuer_unavailable\"|\"source_envelope_unavailable\"|\"target_unavailable\";recipientEnvelopeBytesBase64url?:undefined;recipientEnvelopeDigestBase64url?:undefined;recipientHumanId?:undefined;recipientKeyGeneration?:undefined;recipientKeyId?:undefined;recipientKind?:undefined;responseVersion:1;sourceEnvelopeBytesBase64url?:undefined;sourceEnvelopeDigestBase64url?:undefined;sourceEnvelopeIssuerSigningPublicKeyBase64url?:undefined;status:\"unavailable\";target?:undefined}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.human.peer.operationid.ack.16rg31f",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/human-peer/:operationId/ack",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{operationId:string;roomId:string}",
      "response.body:{error:string}",
      "response.body:{operationId:string;responseVersion:number;status:\"replayed\"|\"verified\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "HumanPeerLiveShadowProtocolV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.human.peer.operationid.ack.plan.bs0t1t",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/human-peer/:operationId/ack-plan",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{operationId:string;roomId:string}",
      "response.body:{clientDeviceId:string;clientDeviceSigningKeyGeneration:number;hostAuthorizationRevision:number;responseVersion:number;status:\"ready\";subjectHumanId:string}|{reason:\"current_read_authority_unavailable\"|\"operation_unavailable\";responseVersion:number;status:\"unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "HumanPeerLiveShadowProtocolV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.namespace.authority.namespaceid.acknowledge.p552vp",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace-authority/:namespaceId/acknowledge",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{namespaceId:string;roomId:string}",
      "response.body:{acknowledgementDigestBase64url:string;responseVersion:number;status:\"acknowledged\"|\"replayed\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "NamespaceKeyAuthorityProtocolV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.namespace.authority.namespaceid.fetch.1geomw5",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace-authority/:namespaceId/fetch",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{namespaceId:string;roomId:string}",
      "response.body:{accessRevision:number;authorizationBytesBase64url:string;authorizationDigestBase64url:string;envelopeDigestBase64url:string;generation:number;headDigestBase64url:string;issuerDeviceSigningPublicKeyBase64url:string;keyClass:\"ai\"|\"human\";namespaceId:string&{ readonly [portableIdBrand]: \"NamespaceId\"; };origin:\"recipient_authorization\";publicationDigestBase64url:string;recipientDeviceRevision:number;responseVersion:1}|{accessRevision:number;envelopeDigestBase64url:string;generation:number;headDigestBase64url:string;issuerDeviceSigningPublicKeyBase64url:string;keyClass:\"ai\"|\"human\";namespaceId:string&{ readonly [portableIdBrand]: \"NamespaceId\"; };origin:\"publication\";publicationDigestBase64url:string;publicationSetBytesBase64url:string;publicationSetDigestBase64url:string;recipientDeviceRevision:number;responseVersion:1}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "NamespaceKeyAuthorityProtocolV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.namespace.authority.namespaceid.plan.1vau1as",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace-authority/:namespaceId/plan",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{namespaceId:string;roomId:string}",
      "response.body:{accessRevision:number;audienceFingerprintBase64url:string;classes:[{generation:number;headDigestBase64url:string;keyClass:\"ai\";publicationDigestBase64url:string},{generation:number;headDigestBase64url:string;keyClass:\"human\";publicationDigestBase64url:string},unknown];namespaceId:string;publicationSetDigestBase64url:string;responseVersion:1;status:\"ready\"}|{accessRevision:number;audienceFingerprintBase64url:string;classes:[{generation:number;headDigestBase64url?:string;keyClass:\"ai\";previousHeadDigestBase64url?:string;publicationDigestBase64url?:string},{generation:number;headDigestBase64url?:string;keyClass:\"human\";previousHeadDigestBase64url?:string;publicationDigestBase64url?:string},unknown];deadlineAt:number;idempotencyKey:string;issuedAt:number;issuerDeviceId:string;issuerDeviceSigningKeyGeneration:number;issuerDeviceSigningPublicKeyBase64url:string;issuerHumanId:string;namespaceId:string;operationId:string;recipients:{recipientHumanId:string;recipientKeyGeneration:number;recipientKeyId:string;recipientKind:\"device\"|\"recovery\";recipientPublicKeyBase64url:string;recipientPublicKeyDigestBase64url:string}[];responseVersion:1;status:\"create_required\"}|{reason:\"authority_inconsistent\"|\"issuer_unavailable\"|\"participant_custody_unavailable\"|\"recipient_inventory_incomplete\"|\"rewrap_required\"|\"room_ineligible\";responseVersion:1;status:\"unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "NamespaceKeyAuthorityProtocolV1"
      },
      {
        "path": "response.body.classes[2]",
        "schema": "NamespaceKeyAuthorityProtocolV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.namespace.authority.namespaceid.publish.8rrqt6",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace-authority/:namespaceId/publish",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{namespaceId:string;roomId:string}",
      "response.body:{classes:[{generation:number;headDigestBase64url:string;keyClass:\"ai\";publicationDigestBase64url:string},{generation:number;headDigestBase64url:string;keyClass:\"human\";publicationDigestBase64url:string}];namespaceId:string&{ readonly [portableIdBrand]: \"NamespaceId\"; };operationId:string;publicationSetDigestBase64url:string;responseVersion:number;status:\"published\"|\"replayed\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "NamespaceKeyAuthorityProtocolV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.namespace.authority.namespaceid.recipient.sync.authorize.fuj672",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace-authority/:namespaceId/recipient-sync/authorize",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{namespaceId:string;roomId:string}",
      "response.body:{authorizationDigestBase64url:string;envelopeCount:number;operationId:string;responseVersion:number;status:\"authorized\"|\"replayed\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "NamespaceKeyAuthorityProtocolV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.namespace.authority.namespaceid.recipient.sync.plan.1xa3wks",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/namespace-authority/:namespaceId/recipient-sync/plan",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{namespaceId:string;roomId:string}",
      "response.body:{coveredGenerationCount:number;currentAccessRevision:number;currentAudienceFingerprintBase64url:string;deadlineAt:number;entries:{generation:number;generationKeyCommitmentBase64url:string;keyClass:\"ai\"|\"human\";namespaceId:string;sourceAccessRevision:number;sourceAudienceFingerprintBase64url:string;sourceHeadDigestBase64url:string;sourcePublicationDigestBase64url:string;sourcePublicationSetDigestBase64url:string;sourceRecipientEnvelopeDigestBase64url:string}[];hasMore:boolean;idempotencyKey:string;issuedAt:number;issuerDeviceId:string;issuerDeviceSigningKeyGeneration:number;issuerDeviceSigningPublicKeyBase64url:string;issuerHumanId:string;operationId:string;requiredGenerationCount:number;responseVersion:1;status:\"authorization_required\";target:{recipientHumanId:string;recipientKeyGeneration:number;recipientKeyId:string;recipientKind:\"device\"|\"recovery\";recipientPublicKeyBase64url:string;recipientPublicKeyDigestBase64url:string}}|{coveredGenerationCount:number;requiredGenerationCount:number;responseVersion:1;status:\"ready\"}|{coveredGenerationCount?:number;reason:\"authority_inconsistent\"|\"generation_rotation_required\"|\"issuer_unavailable\"|\"recovery_required\"|\"source_inventory_incomplete\"|\"target_unavailable\"|\"unrecoverable\"|\"waiting_for_authorized_device\"|\"waiting_for_recipient_enrollment\";requiredGenerationCount?:number;responseVersion:1;status:\"unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "NamespaceKeyAuthorityProtocolV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.plan.10x975p",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/plan",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{roomId:string}",
      "response.body:{authorizationScheme?:\"human_ai_readable_v1\"|\"human_peer_v1\"|\"shared_agent_v1\";reason:\"agent_authority_unavailable\"|\"device_unavailable\"|\"domain_unavailable\"|\"namespace_unavailable\"|\"policy_unavailable\"|\"recipient_sync_required\"|\"reservation_unavailable\";requiredNamespaceIds?:string[];responseVersion:1;status:\"unavailable\"}|{mode:\"plaintext_only\";responseVersion:1;status:\"disabled\"}|{planBytesBase64url:string;responseVersion:1;status:\"planned\"}|{reason:\"client_not_browser\"|\"request_shape_unsupported\"|\"room_topology_unsupported\";responseVersion:1;status:\"ineligible\"}",
      "response.body:{error:string}",
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
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.runtime.invocation.invocationid.authorize.3g5yvx",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/runtime-invocation/:invocationId/authorize",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{invocationId:string;roomId:string}",
      "response.body:{error:string}",
      "response.body:{invocationId:string;responseVersion:number;status:\"authorized\"|\"replayed\"|\"unavailable\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "ClosedRequestBodyV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.shared.agent.executionid.authorize.j2medh",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/shared-agent/:executionId/authorize",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{executionId:string;roomId:string}",
      "response.body:{error:string}",
      "response.body:{executionId:string;responseVersion:number;status:\"authorized\"|\"replayed\"|\"unavailable\"}",
      "response.body:{executionId:string;responseVersion:number;status:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "SharedAgentLiveShadowProtocolV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.shared.agent.operationid.ack.1bt1ptg",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/shared-agent/:operationId/ack",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{operationId:string;roomId:string}",
      "response.body:{error:string}",
      "response.body:{operationId:string;responseVersion:number;status:\"replayed\"|\"verified\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "SharedAgentLiveShadowProtocolV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.shared.agent.operationid.ack.plan.9x815g",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/shared-agent/:operationId/ack-plan",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{operationId:string;roomId:string}",
      "response.body:{clientDeviceId:string;clientDeviceSigningKeyGeneration:number;hostAuthorizationRevision:number;responseVersion:number;status:\"ready\";subjectHumanId:string}|{reason:\"current_read_authority_unavailable\"|\"operation_unavailable\";responseVersion:number;status:\"unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "SharedAgentLiveShadowProtocolV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.shared.agent.output.executionid.ack.1pb5usn",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/shared-agent-output/:executionId/ack",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{executionId:string;roomId:string}",
      "response.body:{error:string}",
      "response.body:{operationId:string;responseVersion:number;status:\"replayed\"|\"verified\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "SharedAgentLiveShadowProtocolV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.shared.agent.output.executionid.read.plan.dwrj8a",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/shared-agent-output/:executionId/read-plan",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{executionId:string;roomId:string}",
      "response.body:{clientDeviceId:string;clientDeviceSigningKeyGeneration:number;hostAuthorizationRevision:number;responseVersion:number;status:\"ready\";subjectHumanId:string}|{reason:\"current_read_authority_unavailable\"|\"operation_unavailable\";responseVersion:number;status:\"unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "SharedAgentLiveShadowProtocolV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.security.uncontained.host.commands.activate.1imn7e9",
    "locator": "http:request_response:POST /api/security/uncontained-host-commands/activate",
    "structuralSignatures": [
      "request.body:{desktopSessionId?:unknown;pin?:unknown;relayId?:unknown}",
      "response.body:{activatedAt:string;active:boolean;ok:boolean}",
      "response.body:{error:any;retryAfterMs?:any}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.desktopSessionId",
        "schema": "ClosedRequestBodyDesktopSessionIdV1"
      },
      {
        "path": "request.body.pin",
        "schema": "TransientOperatorCredentialV1"
      },
      {
        "path": "request.body.relayId",
        "schema": "ClosedRequestBodyRelayIdV1"
      },
      {
        "path": "response.body.error",
        "schema": "ClosedResponseBodyErrorV1"
      },
      {
        "path": "response.body.retryAfterMs",
        "schema": "ClosedResponseBodyRetryAfterMsV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.security.uncontained.host.commands.disable.8z4e5o",
    "locator": "http:request_response:POST /api/security/uncontained-host-commands/disable",
    "structuralSignatures": [
      "request.body:{desktopSessionId?:unknown;relayId?:unknown}",
      "response.body:{disabled:boolean;ok:boolean}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.desktopSessionId",
        "schema": "ClosedRequestBodyDesktopSessionIdV1"
      },
      {
        "path": "request.body.relayId",
        "schema": "ClosedRequestBodyRelayIdV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.workstation.access.activate.1w23scg",
    "locator": "http:request_response:POST /api/workstation-access/activate",
    "structuralSignatures": [
      "request.body:{binding?:unknown;pin?:unknown;startupReceipt?:unknown}",
      "response.body:{capability:\"use_workstation\";error:string}",
      "response.body:{error:any;reason:any}",
      "response.body:{error:any}",
      "response.body:{error:string;retryAfterMs:number}",
      "response.body:{error:string}",
      "response.body:{ok:boolean;outcome:\"activated\"|\"broadened\"|\"invalidated\"|\"narrowed\"|\"switched\";session:{activatedAt:string;agentScope:\"all_owned_agents\";capabilityRevision:number;desktopSessionId:string;grantIds:string[];instanceId:string;pairingGeneration:string;profileId:string;profileRevision:number;relayId:string;serverBindingId:string;userId:string};startupReceipt?:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.binding",
        "debtId": "debt.wire.arbitrary.1n3dm17"
      },
      {
        "path": "request.body.pin",
        "schema": "TransientOperatorCredentialV1"
      },
      {
        "path": "request.body.startupReceipt",
        "schema": "TransientOperatorCredentialV1"
      },
      {
        "path": "response.body.error",
        "debtId": "debt.wire.arbitrary.1x8r20c"
      },
      {
        "path": "response.body.reason",
        "debtId": "debt.wire.arbitrary.6al9jy"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.workstation.access.activate.profile.complete.1k49he",
    "locator": "http:request_response:POST /api/workstation-access/activate-profile/complete",
    "structuralSignatures": [
      "request.body:{authorization?:unknown}",
      "response.body:{capability:\"use_workstation\";error:string}",
      "response.body:{error:any;reason:any}",
      "response.body:{error:string}",
      "response.body:{ok:boolean;outcome:\"activated\"|\"broadened\"|\"invalidated\"|\"narrowed\"|\"switched\";session:{activatedAt:string;agentScope:\"all_owned_agents\";capabilityRevision:number;desktopSessionId:string;grantIds:string[];instanceId:string;pairingGeneration:string;profileId:string;profileRevision:number;relayId:string;serverBindingId:string;userId:string};startupReceipt?:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.authorization",
        "debtId": "debt.wire.arbitrary.x4s0b1"
      },
      {
        "path": "response.body.error",
        "debtId": "debt.wire.arbitrary.ujg0na"
      },
      {
        "path": "response.body.reason",
        "debtId": "debt.wire.arbitrary.q65sxo"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.workstation.access.activate.profile.guy94",
    "locator": "http:request_response:POST /api/workstation-access/activate-profile",
    "structuralSignatures": [
      "request.body:{desktopSessionId?:unknown;instanceId?:unknown;pin?:unknown;profileId?:unknown;profileRevision?:unknown;relayId?:unknown;startupReceipt?:unknown}",
      "response.body:{authorization:string;expiresAt:string;ok:boolean}",
      "response.body:{capability:\"use_workstation\";error:string}",
      "response.body:{error:string;retryAfterMs:number}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.desktopSessionId",
        "debtId": "debt.wire.arbitrary.11be0w7"
      },
      {
        "path": "request.body.instanceId",
        "debtId": "debt.wire.arbitrary.1pdgy8c"
      },
      {
        "path": "request.body.pin",
        "schema": "TransientOperatorCredentialV1"
      },
      {
        "path": "request.body.profileId",
        "debtId": "debt.wire.arbitrary.1h7fpe6"
      },
      {
        "path": "request.body.profileRevision",
        "debtId": "debt.wire.arbitrary.1ebdevm"
      },
      {
        "path": "request.body.relayId",
        "debtId": "debt.wire.arbitrary.1sziywa"
      },
      {
        "path": "request.body.startupReceipt",
        "schema": "TransientOperatorCredentialV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.put.api.admin.users.id.permanent.credentials.1bth93n",
    "locator": "http:request_response:PUT /api/admin/users/:id/permanent-credentials",
    "structuralSignatures": [
      "request.body:{[key:string]:unknown;password?:unknown;pin?:unknown}",
      "request.params:{id:string}",
      "response.body:{auditRecorded:boolean;memberId:string;ok:boolean}",
      "response.body:{code:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.password",
        "schema": "TransientOperatorCredentialV1"
      },
      {
        "path": "request.body.pin",
        "schema": "TransientOperatorCredentialV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.put.api.human.blocks.userid.blekgi",
    "locator": "http:request_response:PUT /api/human-blocks/:userId",
    "structuralSignatures": [
      "request.params:{userId:string}",
      "response.body:{blockedByViewer:boolean;directInteractionBlocked:boolean;userId:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.put.api.mobile.user.agreement.1ni8v6q",
    "locator": "http:request_response:PUT /api/mobile-user-agreement",
    "structuralSignatures": [
      "request.body:{agreementVersion?:unknown}",
      "response.body:{acceptance:{acceptedAt:string;agreementVersion:string;policyVersion:string;recipientManifestVersion:string;withdrawnAt:string};accepted:boolean;current:{agreementVersion:string;policyVersion:string;recipientManifestVersion:string}}",
      "response.body:{code:string;currentAgreementVersion:\"mobile-user-agreement-v1\";error:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.agreementVersion",
        "schema": "ClosedRequestBodyAgreementVersionV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.put.api.security.posture.du15aa",
    "locator": "http:request_response:PUT /api/security/posture",
    "structuralSignatures": [
      "request.body:{allowUncontainedHostCommands?:unknown;deploymentMode?:string;networkPolicy?:unknown;pin?:string;securityLevel?:string}",
      "response.body:{allowUncontainedHostCommands:boolean;capabilities:\"manage_server_security\"|\"manage_uncontained_host_commands\"[];changed:boolean;deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";networkPolicy:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\"}",
      "response.body:{capability:\"manage_server_security\"|\"manage_uncontained_host_commands\";error:string}",
      "response.body:{error:string;retryAfterMs:number}",
      "response.body:{error:string;valid:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\"[]}",
      "response.body:{error:string;valid:\"desktop-locked\"|\"desktop-permissive\"|\"server\"[]}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.allowUncontainedHostCommands",
        "schema": "ClosedRequestBodyAllowUncontainedHostCommandsV1"
      },
      {
        "path": "request.body.networkPolicy",
        "debtId": "debt.wire.arbitrary.29ocdw"
      }
    ]
  },
  {
    "observationId": "wire.relay.declared.arbitrary.packages.relay.src.protocol.ts.desktopautomationinvocationbinding.98aja8",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#DesktopAutomationInvocationBinding",
    "structuralSignatures": [
      "declaration.payload:{computerUseContextId:string;computerUseInvocationId:string;desktopSessionId:string;grantGeneration:number;installationEpoch:string;lineageId:string;originAgentId:string;originHumanId:string;originRunId:string;pairingGeneration:string;provider:\"cua\"|\"peekaboo\";providerGeneration:string;relayId:string;supportedActions:unresolved<DesktopAutomationAction>[];supportsElementTargeting?:boolean;supportsTargetedObservation:boolean;supportsVerification:boolean;supportsWindowCreation?:boolean;usedFallback:boolean;version:4|typeof RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION}"
    ],
    "arbitraryPayloads": [
      {
        "path": "supportedActions[]",
        "schema": "DesktopAutomationActionSetV1"
      }
    ]
  },
  {
    "observationId": "wire.relay.declared.arbitrary.packages.relay.src.protocol.ts.desktopautomationinvocationbindingvalidationresult.1hhbx16",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#DesktopAutomationInvocationBindingValidationResult",
    "structuralSignatures": [
      "declaration.payload:{binding:{computerUseContextId:string;computerUseInvocationId:string;desktopSessionId:string;grantGeneration:number;installationEpoch:string;lineageId:string;originAgentId:string;originHumanId:string;originRunId:string;pairingGeneration:string;provider:\"cua\"|\"peekaboo\";providerGeneration:string;relayId:string;supportedActions:unresolved<DesktopAutomationAction>[];supportsElementTargeting?:boolean;supportsTargetedObservation:boolean;supportsVerification:boolean;supportsWindowCreation?:boolean;usedFallback:boolean;version:4|typeof RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION};ok:true}|{error:string;ok:false}"
    ],
    "arbitraryPayloads": [
      {
        "path": "binding.supportedActions[]",
        "schema": "DesktopAutomationActionSetV1"
      }
    ]
  },
  {
    "observationId": "wire.relay.declared.arbitrary.packages.relay.src.protocol.ts.relayclientmessage.jzsixz",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayClientMessage",
    "structuralSignatures": [
      "declaration.payload:unresolved<RelayAcpClientMessage>|unresolved<RelayClaudeConnectionDiscoveryResult>|unresolved<RelayClaudeExecutionDesktopEvent>|unresolved<RelayCodexCommandResponseMessage>|unresolved<RelayCodexEventMessage>|unresolved<RelayCodexRequestMessage>|unresolved<RelayCodexStatusMessage>|{capabilities:unresolved<RelayCapabilities>;capabilitiesByProtocolVersion?:undefined|{[key:string]:unresolved<RelayCapabilities>};capabilityRevision?:number|undefined;desktopSessionId?:string|undefined;protocolRange?:undefined|{maximum:number;minimum:number};protocolVersion:number;relayId:string;token?:string|undefined;type:\"relay:register\";userId:string}|{capabilities:unresolved<RelayCapabilities>;capabilityRevision:number;desktopSessionId:string;relayId:string;type:\"relay:update-capabilities\"}|{correlationId:string;droppedBytes?:number|undefined;elapsedMs:number;endOffsetBytes:number;kind:\"exec-output\";offsetBytes:number;operation:\"exec\";phase:\"running\";sequence:number;stream:\"stderr\"|\"stdout\";text:string;type:\"relay:structured-ssh-progress\";version:1}|{correlationId:string;elapsedMs:number;kind:\"transfer\";operation:\"copy-download\"|\"copy-upload\";phase:\"starting\"|\"transferring\";sequence:number;totalBytes?:number|undefined;transferredBytes:number;type:\"relay:structured-ssh-progress\";version:1}|{correlationId:string;droppedBytes?:number|undefined;elapsedMs:number;endOffsetBytes:number;offsetBytes:number;phase:\"running\";sequence:number;stream:\"stderr\"|\"stdout\";text:string;type:\"relay:run-shell-progress\";version:1}|{correlationId:string;durationMs?:number|undefined;error?:string|undefined;errorCode?:string|undefined;networkDeniedDestination?:undefined|{host:string;port:number;reason:string};result?:unknown;status:\"error\"|\"ok\";type:\"relay:result\"}|{digest:string;environment:{name:string;present:boolean}[];failure?:undefined|{code:\"discovery_timeout\"|\"empty_toolset\"|\"internal\"|\"invalid_request\"|\"missing_environment\"|\"missing_launcher\"|\"protocol_failed\"|\"spawn_failed\"};launcher:\"missing\"|\"not-applicable\"|\"present\";machineLabel:string;requestId:string;status:\"blocked\"|\"ready\";targetName:string;type:\"relay:mcp-preflight-result\"}|{digest:string;failure?:undefined|{code:\"discovery_timeout\"|\"empty_toolset\"|\"internal\"|\"invalid_request\"|\"missing_environment\"|\"missing_launcher\"|\"protocol_failed\"|\"spawn_failed\"};operationId:string;state:\"connected\"|\"failed\"|\"stopped\";targetName:string;toolNames:string[];type:\"relay:mcp-configure-result\"}|{errorCode:\"capability_disabled\"|\"capability_unavailable\"|\"config_destination_mismatch\"|\"config_output_invalid\"|\"config_required_value_missing\"|\"config_unsafe_directive\"|\"config_value_invalid\"|\"connection_ambiguous\"|\"connection_catalog_malformed\"|\"connection_catalog_overflow\"|\"connection_catalog_unavailable\"|\"connection_catalog_unreadable\"|\"connection_not_found\"|\"connection_source_drift\"|\"destination_unavailable\"|\"host_key_ambiguous\"|\"host_key_changed\"|\"host_key_missing\"|\"invalid_destination\"|\"invalid_host\"|\"invalid_port\"|\"invalid_remote_user\"|\"invalid_request\"|\"lookup_aborted\"|\"lookup_failed\"|\"lookup_invalid_request\"|\"lookup_output_invalid\"|\"lookup_output_limited\"|\"lookup_timed_out\"|\"observer_unavailable\"|\"openssh_connection_catalog_malformed\"|\"openssh_connection_catalog_overflow\"|\"openssh_connection_catalog_unreadable\"|\"openssh_connection_catalog_unsupported_match\"|\"openssh_connection_catalog_unsupported_source\"|\"preparation_unavailable\"|\"prepare_unavailable\"|\"remote_user_missing\"|\"resolve_aborted\"|\"resolve_failed\"|\"resolve_output_limited\"|\"resolve_spawn_failed\"|\"resolve_timed_out\"|\"scan_aborted\"|\"scan_failed\"|\"scan_invalid_request\"|\"scan_output_limited\"|\"scan_timed_out\"|\"scanner_output_invalid\"|\"tool_disabled\"|\"topology_mismatch\"|\"trust_store_corrupt\"|\"trust_store_instance_mismatch\"|\"trust_store_unavailable\"|\"trust_unavailable\";failure?:undefined|{candidates?:undefined|{name:string;source:\"nautilo-profile\"|\"openssh\"}[];code:unresolved<Exclude>;completeness?:false|undefined;configuredBounds?:undefined|{bytes?:number;files?:number;includeDepth?:number;records?:number};observed?:undefined|{bytes:number;files:number;records:number};phase:\"catalog\"|\"dispatch_reresolve\"|\"host_key_scan\"|\"intent\"|\"known_hosts_lookup\"|\"parse\"|\"policy\"|\"resolve\"|\"trust_store_lookup\";recovery:\"choose_connection\"|\"correct_destination\"|\"provide_remote_user\"|\"reduce_connection_catalog\"|\"repair_connection_source\"|\"retry\";retrySafe:true;sideEffectStarted:false;source?:\"nautilo-profile\"|\"openssh\"|undefined;stateChanged:false};requestId:string;status:\"error\";type:\"relay:ssh-prepared\"}|{requestId:string;response:{approval:{host:string;hostKeyFingerprint:string;hostTrust:\"changed\"|\"trusted\"|\"unknown\";operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";port:number;previousHostKeyFingerprint?:string|undefined;remoteUser:string;requestedDestination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string}};approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";preparationId:string;requestId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_PREPARE_VERSION};status:\"ok\";type:\"relay:ssh-prepared\"}|{relayId:string;type:\"relay:disconnect\"}|{relayId:string;type:\"relay:heartbeat\"}|{serverName:string;tools:{annotations?:undefined|{[key:string]:unknown};description?:string|undefined;inputSchema:unknown;name:string}[];type:\"relay:advertise-mcp-tools\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "capabilities",
        "debtId": "debt.wire.arbitrary.8w2kkq"
      },
      {
        "path": "capabilitiesByProtocolVersion",
        "schema": "relay-capabilities-by-protocol-version-v1"
      },
      {
        "path": "failure.code",
        "schema": "RelaySshResolutionFailureCodeV1"
      },
      {
        "path": "result",
        "debtId": "debt.wire.arbitrary.1ukvpkl"
      },
      {
        "path": "tools[].annotations",
        "debtId": "debt.wire.arbitrary.14ss1pz"
      },
      {
        "path": "tools[].inputSchema",
        "debtId": "debt.wire.arbitrary.sii4bq"
      }
    ]
  },
  {
    "observationId": "wire.relay.declared.arbitrary.packages.relay.src.protocol.ts.relaydispatchrequest.1xd01c2",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest",
    "structuralSignatures": [
      "declaration.payload:{allowedRoots?:string[]|undefined;approvalObtained:boolean;args:{[key:string]:unknown};browserPageOwnerBinding?:undefined|{desktopSessionId:null|string;instanceId:string;relayId:string;userId:string};browserPageSnapshotReferencePublication?:true|undefined;correlationId:string;desktopAutomationBinding?:undefined|{computerUseContextId:string;computerUseInvocationId:string;desktopSessionId:string;grantGeneration:number;installationEpoch:string;lineageId:string;originAgentId:string;originHumanId:string;originRunId:string;pairingGeneration:string;provider:\"cua\"|\"peekaboo\";providerGeneration:string;relayId:string;supportedActions:unresolved<DesktopAutomationAction>[];supportsElementTargeting?:boolean;supportsTargetedObservation:boolean;supportsVerification:boolean;supportsWindowCreation?:boolean;usedFallback:boolean;version:4|typeof RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION};desktopFilesystemGrantRequest?:undefined|{grantIds:string[];operation:unresolved<DesktopFilesystemAccessOperation>;policy:{expiresAt?:string|undefined;lifetime:unresolved<DesktopFilesystemGrantLifetime>;policyVersion:number};requestedRoot:string;requiredOperations?:undefined|unresolved<DesktopFilesystemAccessOperation>[];subject:unresolved<DesktopFilesystemGrantSubject>;version:typeof RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION};executionClass?:\"browser\"|\"desktop\"|\"fs\"|\"local-file\"|\"real_workstation\"|\"structured-ssh\"|undefined;impact:\"destructive\"|\"high\"|\"low\"|\"read-only\";reportRunShellProgress?:(progress: Omit<RelayRunShellProgressMessage, \"type\" | \"correlationId\">) => void|undefined;reportStructuredSshProgress?:(progress: RelayStructuredSshProgressObservation) => void|undefined;runShellOwnerBinding?:undefined|{desktopSessionId:null|string;instanceId:string;relayId:string;userId:string};sandboxProfile?:undefined|{config:{mode:\"disabled\"|\"enabled\";networkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};passthroughEnv:string[];projectPaths:string[];protectedFileMaskPath?:string;protectedPaths?:string[];readOnlyPaths?:string[];writablePaths:string[]};dataDir:string;failIfNoBackend:boolean;mode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";toolsBin:string;workspace:string};sshBinding?:undefined|{admissionId:string;approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";preparationId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_DISPATCH_BINDING_VERSION};structuredSshOutputOwnerBinding?:undefined|{desktopSessionId:null|string;instanceId:string;relayId:string;userId:string};timeout?:number|undefined;toolName:string;uncontainedHostCommandsSession?:true|undefined;workstationShellBinding?:undefined|{capabilityRevision:number;currentFolder:string;desktopSessionId:string;executionClass:typeof RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS;grantIds:string[];grantRevision:number;operation:unresolved<DesktopFilesystemAccessOperation>;pairingGeneration:string;profileId:string;profileRevision:number;protectedPolicyVersion:number;relayId:string;serverBindingId:string;subject:{agentScope:string;instanceId:string;relayId:string;userId:string};toolCallId:string;version:typeof RELAY_WORKSTATION_SHELL_BINDING_VERSION}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "args",
        "debtId": "debt.wire.arbitrary.1ezwf46"
      },
      {
        "path": "desktopAutomationBinding.supportedActions[]",
        "schema": "DesktopAutomationActionSetV1"
      },
      {
        "path": "desktopFilesystemGrantRequest.operation",
        "debtId": "debt.wire.arbitrary.17fihje"
      },
      {
        "path": "desktopFilesystemGrantRequest.policy.lifetime",
        "debtId": "debt.wire.arbitrary.z9b8ho"
      },
      {
        "path": "desktopFilesystemGrantRequest.requiredOperations[]",
        "debtId": "debt.wire.arbitrary.1gab0xm"
      },
      {
        "path": "desktopFilesystemGrantRequest.subject",
        "debtId": "debt.wire.arbitrary.mw6nar"
      },
      {
        "path": "workstationShellBinding.operation",
        "debtId": "debt.wire.arbitrary.5z45ay"
      }
    ]
  },
  {
    "observationId": "wire.relay.declared.arbitrary.packages.relay.src.protocol.ts.relayservermessage.7iw1ir",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage",
    "structuralSignatures": [
      "declaration.payload:unresolved<RelayAcpServerMessage>|unresolved<RelayClaudeConnectionDiscoverCommand>|unresolved<RelayClaudeExecutionCommand>|unresolved<RelayCodexCancelMessage>|unresolved<RelayCodexCommandMessage>|unresolved<RelayCodexCreditMessage>|unresolved<RelayCodexRequestResponseMessage>|unresolved<RelayRegisteredV8>|{allowedRoots?:string[]|undefined;approvalObtained:boolean;args:{[key:string]:unknown};correlationId:string;desktopAutomationBinding?:undefined|{computerUseContextId:string;computerUseInvocationId:string;desktopSessionId:string;grantGeneration:number;installationEpoch:string;lineageId:string;originAgentId:string;originHumanId:string;originRunId:string;pairingGeneration:string;provider:\"cua\"|\"peekaboo\";providerGeneration:string;relayId:string;supportedActions:unresolved<DesktopAutomationAction>[];supportsElementTargeting?:boolean;supportsTargetedObservation:boolean;supportsVerification:boolean;supportsWindowCreation?:boolean;usedFallback:boolean;version:4|typeof RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION};desktopFilesystemGrantRequest?:undefined|{grantIds:string[];operation:unresolved<DesktopFilesystemAccessOperation>;policy:{expiresAt?:string|undefined;lifetime:unresolved<DesktopFilesystemGrantLifetime>;policyVersion:number};requestedRoot:string;requiredOperations?:undefined|unresolved<DesktopFilesystemAccessOperation>[];subject:unresolved<DesktopFilesystemGrantSubject>;version:typeof RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION};executionClass?:\"browser\"|\"desktop\"|\"fs\"|\"local-file\"|\"real_workstation\"|\"structured-ssh\"|undefined;impact:\"destructive\"|\"high\"|\"low\"|\"read-only\";sandboxProfile?:undefined|{config:{mode:\"disabled\"|\"enabled\";networkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};passthroughEnv:string[];projectPaths:string[];protectedFileMaskPath?:string;protectedPaths?:string[];readOnlyPaths?:string[];writablePaths:string[]};dataDir:string;failIfNoBackend:boolean;mode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";toolsBin:string;workspace:string};sshBinding?:undefined|{admissionId:string;approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";preparationId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_DISPATCH_BINDING_VERSION};timeout?:number|undefined;toolName:string;type:\"relay:dispatch\";uncontainedHostCommandsSession?:true|undefined;workstationShellBinding?:undefined|{capabilityRevision:number;currentFolder:string;desktopSessionId:string;executionClass:typeof RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS;grantIds:string[];grantRevision:number;operation:unresolved<DesktopFilesystemAccessOperation>;pairingGeneration:string;profileId:string;profileRevision:number;protectedPolicyVersion:number;relayId:string;serverBindingId:string;subject:{agentScope:string;instanceId:string;relayId:string;userId:string};toolCallId:string;version:typeof RELAY_WORKSTATION_SHELL_BINDING_VERSION}}|{capabilityRevision:number;error?:string|undefined;relayId:string;status:\"ok\"|\"rejected\";type:\"relay:capabilities-updated\"}|{correlationId:string;type:\"relay:cancel\"}|{digest:string;requestId:string;server:{envPassthrough?:null|string[]|undefined;excludeTools?:null|string[]|undefined;includeTools?:null|string[]|undefined;name:string;namespaceId?:null|string|undefined;transport:{[key:string]:unknown};transportKind:\"sse-legacy\"|\"stdio\"|\"streamable-http\";trustTier?:null|string|undefined};type:\"relay:mcp-preflight\"}|{message:string;type:\"relay:error\"}|{operation?:undefined|{digest:string;operationId:string;phase:\"rollback\"|\"start\";targetName:string};servers:{envPassthrough?:null|string[]|undefined;excludeTools?:null|string[]|undefined;includeTools?:null|string[]|undefined;name:string;namespaceId?:null|string|undefined;transport:{[key:string]:unknown};transportKind:\"sse-legacy\"|\"stdio\"|\"streamable-http\";trustTier?:null|string|undefined}[];type:\"relay:configure-mcp\"}|{protocolVersion?:number|undefined;relayId:string;type:\"relay:registered\"}|{request:{approvedRequest:{args:{argv:string[];destination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string};program:string;timeoutReason?:string|undefined;timeoutSeconds:number};toolCallId:string;toolName:\"structured_ssh_exec\";version:typeof RELAY_SSH_APPROVED_REQUEST_VERSION}|{args:{destination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string};localPath:string;remotePath:string;timeoutReason?:string|undefined;timeoutSeconds:number};toolCallId:string;toolName:\"structured_ssh_copy_download\";version:typeof RELAY_SSH_APPROVED_REQUEST_VERSION}|{args:{destination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string};localPath:string;remotePath:string;timeoutReason?:string|undefined;timeoutSeconds:number};toolCallId:string;toolName:\"structured_ssh_copy_upload\";version:typeof RELAY_SSH_APPROVED_REQUEST_VERSION}|{args:{destination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string}};toolCallId:string;toolName:\"structured_ssh_auth\";version:typeof RELAY_SSH_APPROVED_REQUEST_VERSION};approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";requestId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_PREPARE_VERSION};type:\"relay:ssh-prepare\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "args",
        "debtId": "debt.wire.arbitrary.10l7ijx"
      },
      {
        "path": "desktopAutomationBinding.supportedActions[]",
        "schema": "DesktopAutomationActionSetV1"
      },
      {
        "path": "desktopFilesystemGrantRequest.operation",
        "debtId": "debt.wire.arbitrary.r7i6zb"
      },
      {
        "path": "desktopFilesystemGrantRequest.policy.lifetime",
        "debtId": "debt.wire.arbitrary.1ubqbt9"
      },
      {
        "path": "desktopFilesystemGrantRequest.requiredOperations[]",
        "debtId": "debt.wire.arbitrary.7se5i1"
      },
      {
        "path": "desktopFilesystemGrantRequest.subject",
        "debtId": "debt.wire.arbitrary.x11eyu"
      },
      {
        "path": "server.transport",
        "schema": "McpTransportConfigV1"
      },
      {
        "path": "servers[].transport",
        "debtId": "debt.wire.arbitrary.1ud8cwz"
      },
      {
        "path": "workstationShellBinding.operation",
        "debtId": "debt.wire.arbitrary.wz4efj"
      }
    ]
  },
  {
    "observationId": "wire.relay.server.to.client.arbitrary.packages.relay.src.protocol.ts.relaydispatchmessage.f3am3r",
    "locator": "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage",
    "structuralSignatures": [
      "declaration.payload:{allowedRoots?:string[]|undefined;approvalObtained:boolean;args:{[key:string]:unknown};correlationId:string;desktopAutomationBinding?:undefined|{computerUseContextId:string;computerUseInvocationId:string;desktopSessionId:string;grantGeneration:number;installationEpoch:string;lineageId:string;originAgentId:string;originHumanId:string;originRunId:string;pairingGeneration:string;provider:\"cua\"|\"peekaboo\";providerGeneration:string;relayId:string;supportedActions:unresolved<DesktopAutomationAction>[];supportsElementTargeting?:boolean;supportsTargetedObservation:boolean;supportsVerification:boolean;supportsWindowCreation?:boolean;usedFallback:boolean;version:4|typeof RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION};desktopFilesystemGrantRequest?:undefined|{grantIds:string[];operation:unresolved<DesktopFilesystemAccessOperation>;policy:{expiresAt?:string|undefined;lifetime:unresolved<DesktopFilesystemGrantLifetime>;policyVersion:number};requestedRoot:string;requiredOperations?:undefined|unresolved<DesktopFilesystemAccessOperation>[];subject:unresolved<DesktopFilesystemGrantSubject>;version:typeof RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION};executionClass?:\"browser\"|\"desktop\"|\"fs\"|\"local-file\"|\"real_workstation\"|\"structured-ssh\"|undefined;impact:\"destructive\"|\"high\"|\"low\"|\"read-only\";sandboxProfile?:undefined|{config:{mode:\"disabled\"|\"enabled\";networkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};passthroughEnv:string[];projectPaths:string[];protectedFileMaskPath?:string;protectedPaths?:string[];readOnlyPaths?:string[];writablePaths:string[]};dataDir:string;failIfNoBackend:boolean;mode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";toolsBin:string;workspace:string};sshBinding?:undefined|{admissionId:string;approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";preparationId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_DISPATCH_BINDING_VERSION};timeout?:number|undefined;toolName:string;type:\"relay:dispatch\";uncontainedHostCommandsSession?:true|undefined;workstationShellBinding?:undefined|{capabilityRevision:number;currentFolder:string;desktopSessionId:string;executionClass:typeof RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS;grantIds:string[];grantRevision:number;operation:unresolved<DesktopFilesystemAccessOperation>;pairingGeneration:string;profileId:string;profileRevision:number;protectedPolicyVersion:number;relayId:string;serverBindingId:string;subject:{agentScope:string;instanceId:string;relayId:string;userId:string};toolCallId:string;version:typeof RELAY_WORKSTATION_SHELL_BINDING_VERSION}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "args",
        "debtId": "debt.wire.arbitrary.18ha82p"
      },
      {
        "path": "desktopAutomationBinding.supportedActions[]",
        "schema": "DesktopAutomationActionSetV1"
      },
      {
        "path": "desktopFilesystemGrantRequest.operation",
        "debtId": "debt.wire.arbitrary.v76hib"
      },
      {
        "path": "desktopFilesystemGrantRequest.policy.lifetime",
        "debtId": "debt.wire.arbitrary.gayz1l"
      },
      {
        "path": "desktopFilesystemGrantRequest.requiredOperations[]",
        "debtId": "debt.wire.arbitrary.3ukfxh"
      },
      {
        "path": "desktopFilesystemGrantRequest.subject",
        "debtId": "debt.wire.arbitrary.1n2ozki"
      },
      {
        "path": "workstationShellBinding.operation",
        "debtId": "debt.wire.arbitrary.2ylip7"
      }
    ]
  },
  {
    "observationId": "wire.relay.server.to.client.relay.dispatch.lnqowy",
    "locator": "relay:server_to_client:relay:dispatch",
    "structuralSignatures": [
      "frame.payload:{allowedRoots?:string[]|undefined;approvalObtained:boolean;args:{[key:string]:unknown};correlationId:string;desktopAutomationBinding?:undefined|{computerUseContextId:string;computerUseInvocationId:string;desktopSessionId:string;grantGeneration:number;installationEpoch:string;lineageId:string;originAgentId:string;originHumanId:string;originRunId:string;pairingGeneration:string;provider:\"cua\"|\"peekaboo\";providerGeneration:string;relayId:string;supportedActions:unresolved<DesktopAutomationAction>[];supportsElementTargeting?:boolean;supportsTargetedObservation:boolean;supportsVerification:boolean;supportsWindowCreation?:boolean;usedFallback:boolean;version:4|typeof RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION};desktopFilesystemGrantRequest?:undefined|{grantIds:string[];operation:unresolved<DesktopFilesystemAccessOperation>;policy:{expiresAt?:string|undefined;lifetime:unresolved<DesktopFilesystemGrantLifetime>;policyVersion:number};requestedRoot:string;requiredOperations?:undefined|unresolved<DesktopFilesystemAccessOperation>[];subject:unresolved<DesktopFilesystemGrantSubject>;version:typeof RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION};executionClass?:\"browser\"|\"desktop\"|\"fs\"|\"local-file\"|\"real_workstation\"|\"structured-ssh\"|undefined;impact:\"destructive\"|\"high\"|\"low\"|\"read-only\";sandboxProfile?:undefined|{config:{mode:\"disabled\"|\"enabled\";networkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};passthroughEnv:string[];projectPaths:string[];protectedFileMaskPath?:string;protectedPaths?:string[];readOnlyPaths?:string[];writablePaths:string[]};dataDir:string;failIfNoBackend:boolean;mode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";toolsBin:string;workspace:string};sshBinding?:undefined|{admissionId:string;approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";preparationId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_DISPATCH_BINDING_VERSION};timeout?:number|undefined;toolName:string;type:\"relay:dispatch\";uncontainedHostCommandsSession?:true|undefined;workstationShellBinding?:undefined|{capabilityRevision:number;currentFolder:string;desktopSessionId:string;executionClass:typeof RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS;grantIds:string[];grantRevision:number;operation:unresolved<DesktopFilesystemAccessOperation>;pairingGeneration:string;profileId:string;profileRevision:number;protectedPolicyVersion:number;relayId:string;serverBindingId:string;subject:{agentScope:string;instanceId:string;relayId:string;userId:string};toolCallId:string;version:typeof RELAY_WORKSTATION_SHELL_BINDING_VERSION}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "args",
        "debtId": "debt.wire.arbitrary.1ctmkbq"
      },
      {
        "path": "desktopAutomationBinding.supportedActions[]",
        "schema": "DesktopAutomationActionSetV1"
      },
      {
        "path": "desktopFilesystemGrantRequest.operation",
        "debtId": "debt.wire.arbitrary.1r2lg8a"
      },
      {
        "path": "desktopFilesystemGrantRequest.policy.lifetime",
        "debtId": "debt.wire.arbitrary.1qh4tzw"
      },
      {
        "path": "desktopFilesystemGrantRequest.requiredOperations[]",
        "debtId": "debt.wire.arbitrary.134xvtm"
      },
      {
        "path": "desktopFilesystemGrantRequest.subject",
        "debtId": "debt.wire.arbitrary.9hhok3"
      },
      {
        "path": "workstationShellBinding.operation",
        "debtId": "debt.wire.arbitrary.1aip35m"
      }
    ]
  },
  {
    "observationId": "wire.ws.server.to.client.message.human.peer.shadow.qk25py",
    "locator": "ws:server_to_client:message.human_peer_shadow",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.ws.server.to.client.message.runtime.invocation.authorization.required.1q05p5i",
    "locator": "ws:server_to_client:message.runtime_invocation_authorization_required",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.ws.server.to.client.message.shared.agent.authorization.required.x65i2e",
    "locator": "ws:server_to_client:message.shared_agent_authorization_required",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.ws.server.to.client.message.shared.agent.output.shadow.1xt2hzh",
    "locator": "ws:server_to_client:message.shared_agent_output_shadow",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.ws.server.to.client.message.shared.agent.shadow.1lhpt7d",
    "locator": "ws:server_to_client:message.shared_agent_shadow",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.ws.server.to.client.message.shared.agent.stream.frame.pip9lz",
    "locator": "ws:server_to_client:message.shared_agent_stream_frame",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.ws.server.to.client.message.shared.agent.stream.start.pb3e3a",
    "locator": "ws:server_to_client:message.shared_agent_stream_start",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  }
];

import type { DtoDeclaration } from "../src/node/dto-inventory";

export const REVIEWED_MAIN_2026_08_20_DTO_DECLARATIONS:
  readonly DtoDeclaration[] = [
  {
    "observationId": "wire.http.request.response.delete.api.account.xa0h58",
    "locator": "http:request_response:DELETE /api/account",
    "structuralSignatures": [
      "request.body:{[key:string]:unknown}",
      "response.body:{code:string;error:string}",
      "response.body:{error:string}",
      "response.body:{logtoRevoked:boolean;ok:boolean;reconciliationPending:boolean}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "AccountDeletionConfirmationV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.delete.api.admin.users.id.1etqh4b",
    "locator": "http:request_response:DELETE /api/admin/users/:id",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{code:\"active_media_operation\";eligible:false}|{code:\"federated_user\";eligible:false}|{code:\"last_owner\";eligible:false}|{code:\"owns_shared_rooms\";eligible:false;sharedRoomCount:number}|{code:\"protected_custody\";eligible:false}|{code:\"user_not_found\";eligible:false}|{eligible:true}",
      "response.body:{code:\"active_media_operation\";eligible:false}|{code:\"last_owner\";eligible:false}|{code:\"owns_shared_rooms\";eligible:false;sharedRoomCount:number}|{code:\"protected_custody\";eligible:false}",
      "response.body:{code:\"federated_user\";error:\"federated_user\"}",
      "response.body:{code:any;error:any}",
      "response.body:{error:\"user_not_found\"}",
      "response.body:{error:any}",
      "response.body:{logtoRevoked:any;mutation:{auditRecorded:boolean;receiptId:string;recovery:{kind:string;userId:string}[];retrySafe:boolean;stateChanged:boolean};ok:boolean}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.code",
        "schema": "AccountDeletionResultV1"
      },
      {
        "path": "response.body.error",
        "schema": "AccountDeletionResultV1"
      },
      {
        "path": "response.body.logtoRevoked",
        "schema": "AccountDeletionResultV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.account.deletion.eligibility.p2nsia",
    "locator": "http:request_response:GET /api/account/deletion/eligibility",
    "structuralSignatures": [
      "response.body:{code:\"active_media_operation\";eligible:false}|{code:\"federated_user\";eligible:false}|{code:\"last_owner\";eligible:false}|{code:\"owns_shared_rooms\";eligible:false;sharedRoomCount:number}|{code:\"protected_custody\";eligible:false}|{code:\"user_not_found\";eligible:false}|{eligible:true}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.admin.encryption.transition.h8ulxt",
    "locator": "http:request_response:GET /api/admin/encryption-transition",
    "structuralSignatures": [
      "response.body:unknown",
      "response.body:{dtoVersion:1;metrics:{attemptOutcomes:{count:string;operation:\"access_update\"|\"create\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"failed\";reason:\"integrity_failure\"|\"parity_mismatch\"|\"publication_failure\"}|{count:string;operation:\"access_update\"|\"create\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"pending\";reason:\"none\"}|{count:string;operation:\"access_update\"|\"create\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"reconciling\";reason:\"response_lost\"}|{count:string;operation:\"access_update\"|\"create\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"unavailable\";reason:\"client_crypto_preparation_failed\"|\"client_crypto_unavailable\"|\"client_custody_unavailable\"|\"client_observation_expired\"|\"namespace_encryption_not_ready\"|\"stale_authority_product\"|\"unmigrated\"|\"unsupported_operation\"}|{count:string;operation:\"access_update\"|\"create\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"verified\";reason:\"none\"}[];attemptSuccess:{eligible:string;percent?:number;verified:string};family:\"artifact\"|\"memory\"|\"message\"|\"overall\"|\"record\";pendingLifecycle:{oldestPendingAt?:string;operations:string};storedCoverage:{percent?:number;total:string;verified:string};touchedCoverage:{percent?:number;total:string;verified:string}}[];observationPressure:{admissionCapacity:string;capacityRows:string;maximumRetentionMs:number;pendingAdmissions:string;retainedRows:string};policy:{mode:\"plaintext_only\"|\"shadow_writes\";revision:number;shadowWritesStartedAt?:string;updatedAt:string}}",
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
    "observationId": "wire.http.request.response.get.api.admin.server.models.1k8b8za",
    "locator": "http:request_response:GET /api/admin/server-models",
    "structuralSignatures": [
      "response.body:{conductorModel:string;defaultChatModel:string;fallbackChain:string[];reasoningOutput:{[key:string]:boolean};reasoningPolicy:{defaultEffort:\"high\"|\"low\"|\"max\"|\"medium\"|\"minimal\"|\"off\"|\"xhigh\";overrides:{[key:string]:\"high\"|\"low\"|\"max\"|\"medium\"|\"minimal\"|\"off\"|\"xhigh\"}};reflectionModel:string;stenographerModel:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.auth.whoami.1qlua20",
    "locator": "http:request_response:GET /api/auth/whoami",
    "structuralSignatures": [
      "response.body:{capabilities:\"approve_destructive_actions\"|\"approve_spending\"|\"control_browser\"|\"control_desktop\"|\"control_home\"|\"create_rooms\"|\"invoke_agents\"|\"manage_agents\"|\"manage_billing\"|\"manage_groups\"|\"manage_members\"|\"manage_memories\"|\"manage_roles\"|\"manage_rooms\"|\"manage_server_operations\"|\"manage_server_security\"|\"manage_server_settings\"|\"manage_standing_approvals\"|\"manage_workstation_profiles\"|\"read_memories\"|\"read_server_settings\"|\"use_destructive_tools\"|\"use_google_workspace\"|\"use_high_impact_tools\"|\"use_image_generation\"|\"use_research_tools\"|\"use_share_artifact\"|\"use_terminal\"|\"use_transcription\"|\"use_workstation_profiles\"|\"view_audit_log\"|\"write_artifacts\"[];displayName:string;externalId:string;features?:{office:{enabled:boolean}};groups:{id:string;label:string;roleSlug:string;type:string}[];handle:string;highestRole:string;instanceId:string;mustChangePassword:boolean;sessionActorId:string;sessionUserId:string;userIdentity:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.codex.18siw0x",
    "locator": "http:request_response:GET /api/codex",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{profiles:{accountEmail?:string;authState:\"error\"|\"expired\"|\"login_pending\"|\"signed_in\"|\"signed_out\";id:string;label:string;lastErrorCode?:string;planType?:string;rateLimits?:{credits?:{balance?:string;hasCredits:boolean;unlimited:boolean};freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;plan?:\"business\"|\"edu\"|\"enterprise\"|\"free\"|\"go\"|\"plus\"|\"pro\"|\"prolite\"|\"team\"|\"unknown\"|\"usage_based\";primary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};reached?:\"credits_depleted\"|\"rate_limit_reached\"|\"usage_limit_reached\";secondary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};spendControl?:{limit:string;remainingPercent:number;resetsAt:string;used:string}};reconciliationState:\"cleanup_required\"|\"current\"|\"reconnecting\";registrationState:\"provisional\"|\"registered\";revision:number;usage?:{daily:{startDate:string;tokens:string}[];freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;summary:{currentStreakDays?:string;lifetimeTokens?:string;longestRunningTurnSec?:string;longestStreakDays?:string;peakDailyTokens?:string}};usageObservedAt?:string}[];runtime:{available:boolean;collaborationModeAvailable:boolean;compatibilityDiagnostics?:{feature:\"approvals\"|\"collaboration_modes\"|\"core\"|\"request_user_input\"|\"steer\";reason:\"changed_field_shape\"|\"missing_field\"|\"missing_member\"}[];installation?:{canCancel:boolean;code?:\"CODEX_RUNTIME_ARTIFACT_INVALID\"|\"CODEX_RUNTIME_CANCELLED\"|\"CODEX_RUNTIME_EXECUTABLE_LIMIT\"|\"CODEX_RUNTIME_IDENTITY_CHANGED\"|\"CODEX_RUNTIME_INCOMPATIBLE\"|\"CODEX_RUNTIME_INSTALL_FAILED\"|\"CODEX_RUNTIME_NOT_EXECUTABLE\"|\"CODEX_RUNTIME_NOT_FOUND\"|\"CODEX_RUNTIME_OUTPUT_LIMIT\"|\"CODEX_RUNTIME_PATH_INVALID\"|\"CODEX_RUNTIME_PLATFORM_UNSUPPORTED\"|\"CODEX_RUNTIME_SCHEMA_INVALID\"|\"CODEX_RUNTIME_SIGNATURE_INVALID\"|\"CODEX_RUNTIME_STANDALONE_UNSUPPORTED\"|\"CODEX_RUNTIME_TIMEOUT\"|\"CODEX_RUNTIME_UNHEALTHY\"|\"CODEX_RUNTIME_VERSION_INVALID\"|\"CODEX_RUNTIME_WRONG_ARCHITECTURE\";phase:\"activating\"|\"cancelled\"|\"downloading\"|\"failed\"|\"ready\"|\"resolving\"|\"staging\"|\"verifying\";receivedBytes:number;totalBytes:number};runtimeGeneration?:number;source?:\"external\"|\"managed\";state:\"absent\"|\"draining\"|\"failed\"|\"incompatible\"|\"installing\"|\"limited\"|\"ready\"|\"unavailable\";version?:string}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.directory.search.inmvgu",
    "locator": "http:request_response:GET /api/directory/search",
    "structuralSignatures": [
      "request.query:{agentScope?:string;kind?:string;limit?:string;offset?:string;q?:string}",
      "response.body:{error:string}",
      "response.body:{results:{actionReason:\"available\"|\"invoke_agents_required\";actionable:boolean;agentOwnerDisplayName?:string;agentOwnerHandle?:string;agentOwnerUserId?:string;displayName:string;handle:string;id:string;kind:\"agent\"|\"user\";lastContactAt:string}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.security.audit.log.ef92mf",
    "locator": "http:request_response:GET /api/security/audit-log",
    "structuralSignatures": [
      "request.query:{actorId?:string;correlationId?:string;cursor?:string;kinds?:string;limit?:string;since?:string}",
      "response.body:{error:string}",
      "response.body:{events:{action:\"configure\"|\"remove\";actorId:string;clientId:string;ip:string;kind:\"google_oauth_client_config\";outcome:\"ok\";ts:string;userAgent:string}|{action:\"create\"|\"delete\"|\"disable\"|\"enable\"|\"update\";actorId:string;effectDigest?:string;ip:string;kind:\"mcp_server_config\";outcome:\"error\"|\"ok\";relayId?:string;serverName:string;ts:string;userAgent:string}|{action:\"delete\"|\"list\"|\"store\"|\"use\";actorId:string;connectionId?:string;errorKind?:string;field?:string;ip:string;kind:\"connection_vault_tool\";outcome:\"error\"|\"missing\"|\"ok\";service?:string;tool:string;ts:string;userAgent:string}|{action:string;actorId:string;errorKind?:string;ip:string;kind:\"memory.edit\";memoryId:string;namespaceId?:string;outcome:\"failure\"|\"success\";scopeId?:string;ts:string;userAgent:string}|{actorId:string;actorUserId:string;ip:string;kind:\"standing_approval_revoked\";label:string;roomId:string;route:\"DELETE /api/security/standing-approvals/:id\";ruleId:string;scope:\"room\"|\"server\";toolPattern:string;ts:string;userAgent:string}|{actorId:string;affectedPairingCount:number;correlationId:string;ip:string;kind:\"relay_pairing_lifecycle\";managementTarget:string;operation:\"group_revoke\"|\"historical_cleanup\";reason:\"confirmation_mismatch\"|\"not_found_or_foreign\"|\"revoked\"|\"store_error\";result:\"failed\"|\"not_found_or_foreign\"|\"stale\"|\"succeeded\";ts:string;userAgent:string;userId:string}|{actorId:string;after:{conductorModel:string;defaultChatModel:string;fallbackChain:string[];reflectionModel:string;stenographerModel:string};before:{conductorModel:string;defaultChatModel:string;fallbackChain:string[];reflectionModel:string;stenographerModel:string};changes?:{[key:string]:unknown};ip:string;kind:\"server_model_config_changed\";ts:string;userAgent:string}|{actorId:string;after:{mode:\"plaintext_only\"|\"shadow_writes\";revision:number};before:{mode:\"plaintext_only\"|\"shadow_writes\";revision:number};ip:string;kind:\"encryption_transition_policy_changed\";ts:string;userAgent:string}|{actorId:string;attemptedRoute:string;capability:string;ip:string;kind:\"capability_check_failed\";ts:string;userAgent:string}|{actorId:string;attemptedRoute:string;ip:string;kind:\"pin_check_failed\";pinOutcome:\"invalid\"|\"locked_out\";ts:string;userAgent:string}|{actorId:string;before:{mode:\"plaintext_only\"|\"shadow_writes\";revision:number};ip:string;kind:\"encryption_transition_policy_change_requested\";requested:{expectedRevision:number;mode:\"plaintext_only\"|\"shadow_writes\"};ts:string;userAgent:string}|{actorId:string;byUserId:string;fromUserId:string;ip:string;kind:\"room_archived\";roomId:string;ts:string;userAgent:string}|{actorId:string;byUserId:string;ip:string;kind:\"room_unarchived\";roomId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail:boolean;ip:string;kind:\"agent_role_removed\";roleSlug:string;targetAgentId:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail:boolean;ip:string;kind:\"room_member_removed\";roomId:string;targetActorId:string;targetActorKind:\"agent\"|\"user\";ts:string;userAgent:string}|{actorId:string;bypassedRail?:boolean;groupId:string;groupType:string;ip:string;kind:\"group_member_removed\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail?:boolean;ip:string;kind:\"agent_role_added\";replacedFromGroupId:string;roleSlug:string;targetAgentId:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];groupId:string;groupType:string;ip:string;kind:\"rbac_shared_access_assigned\";memberCount:number;ownerUserId:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];groupId:string;groupType:string;ip:string;kind:\"rbac_shared_access_created\";memberCount:number;ownerUserId:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];ip:string;kind:\"rbac_role_capabilities_set\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];ip:string;kind:\"rbac_role_created\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilityRevision:number;denialCode?:string;desktopSessionId:string;ip:string;kind:\"workstation_session_activated\"|\"workstation_session_broadened\"|\"workstation_session_denied\"|\"workstation_session_disabled\"|\"workstation_session_invalidated\"|\"workstation_session_narrowed\"|\"workstation_session_switched\";outcome?:string;relayId:string;route?:string;serverBindingId:string;ts:string;userAgent:string;userId:string}|{actorId:string;capabilityRevision:number;desktopSessionId:string;executionClass:\"profile_bound_sandbox\"|\"real_workstation\"|\"typed_broker\";ip:string;kind:\"workstation_admission\";outcome:\"auto\"|\"none\";pairingGeneration:string;profileId:string;profileRevision:number;reason:\"auto_admitted\"|\"critical_or_elevation_command\"|\"no_active_session\"|\"no_admitted_plan\"|\"run_shell_required\"|\"typed_broker_not_wired\";relayId:string;serverBindingId:string;toolCallId:string;toolName:string;ts:string;userAgent:string;userId:string}|{actorId:string;changes:{[key:string]:unknown};ip:string;kind:\"server_profile_changed\";ts:string;userAgent:string}|{actorId:string;changes:{[key:string]:unknown};ip:string;kind:\"server_research_provider_changed\";ts:string;userAgent:string}|{actorId:string;errorKind?:string;ip:string;kind:\"memory.delete\";memoryId:string;mode:\"archive\"|\"hard\";namespaceId?:string;outcome:\"failure\"|\"success\";scopeId?:string;ts:string;userAgent:string}|{actorId:string;fromOwnerUserId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_owner_transferred\";toOwnerUserId:string;ts:string;userAgent:string}|{actorId:string;fromUserId:string;ip:string;kind:\"room_ownership_transferred\";roomId:string;toUserId:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"group_member_added\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_created\";ownerUserId:string;roleSlugs:string[];ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_deleted\";ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_renamed\";label:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_roles_set\";roleSlugs:string[];ts:string;userAgent:string}|{actorId:string;handleHash:string;inviteKind:string;ip:string;kind:\"invite_bind_logto_user_succeeded\";logtoSub:string;targetGroupId?:string;targetRoomId?:string;tokenHash:string;ts:string;userAgent:string;userId:string}|{actorId:string;handleHash:string;ip:string;kind:\"logto_password_login_failed\";ts:string;userAgent:string;userId?:string}|{actorId:string;handleHash:string;ip:string;kind:\"logto_password_login_succeeded\";ts:string;userAgent:string;userId:string}|{actorId:string;handleHash:string;ip:string;kind:\"recovery_session_opened\";ts:string;userAgent:string}|{actorId:string;handleHash:string;ip:string;kind:\"recovery_session_rejected\";reason:\"logto_endpoint_missing\"|\"logto_unavailable\"|\"reject\"|\"unexpected_error\";ts:string;userAgent:string}|{actorId:string;handleHash?:string;inviteKind?:string;ip:string;kind:\"invite_bind_logto_user_failed\";logtoSub?:string;reason:string;targetGroupId?:string;targetRoomId?:string;tokenHash?:string;ts:string;userAgent:string}|{actorId:string;inviteId:string;inviteKind:string;ip:string;kind:\"invite_minted\";targetAgentId?:string;targetRoomId?:string;ts:string;userAgent:string}|{actorId:string;inviteId:string;ip:string;kind:\"invite_revoked\";ts:string;userAgent:string}|{actorId:string;inviteKind:string;ip:string;kind:\"invite_redeemed\";landingRoomId:string;newUserId:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"admin_password_reset_issued\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"approval_denied\"|\"approval_granted\";laneKey:string;network?:{host:string;port:number;reason:string;suggestedRule:{cidr?:string;host?:string;ports?:number[];suffix?:string;type:\"cidr\"|\"domain\"|\"wildcard\"}};route:\"POST /api/auth/approval-reply\";threadId:string;ts:string;userAgent:string;verb:\"always\"|\"deny\"|\"once\"|\"room\"}|{actorId:string;ip:string;kind:\"invite_complete_profile_failed\";reason:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"invite_redeem_cleanup_failed\";logtoSub:string;reason:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"invite_redeem_failed\";reason:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"logto_token_mint_failed\";logtoSub:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"pin_enrolled\";route:\"POST /api/auth/pin\";sessionUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"posture_changed\";next:{deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\"};prev:{deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\"};ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"rbac_role_deleted\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"rbac_role_renamed\";label:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"recovery_relay_code_unmatched\";ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"recovery_relay_read_denied\";reason:\"bad_request\"|\"not_found\";ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"resume_thread_auth_denied\";route:string;sessionUserId:string;threadId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_added\";roomId:string;roomRole:\"admin\"|\"member\";targetActorId:string;targetActorKind:\"agent\"|\"user\";targetAgentId?:string;targetUserId?:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_self_joined\";roomId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_self_left\";roomId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_deleted\";logtoRevoked:boolean;targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_disabled\";reason?:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_disabled_session_blocked\";route:string;sessionUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_enabled\";targetUserId:string;ts:string;userAgent:string}[];hasMore:boolean;nextCursor:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.events[].changes",
        "schema": "BoundedSecurityAuditChangesV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.patch.api.codex.profiles.profileid.1js0vj9",
    "locator": "http:request_response:PATCH /api/codex/profiles/:profileId",
    "structuralSignatures": [
      "request.params:{profileId:string}",
      "response.body:{accountEmail?:string;authState:\"error\"|\"expired\"|\"login_pending\"|\"signed_in\"|\"signed_out\";id:string;label:string;lastErrorCode?:string;planType?:string;rateLimits?:{credits?:{balance?:string;hasCredits:boolean;unlimited:boolean};freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;plan?:\"business\"|\"edu\"|\"enterprise\"|\"free\"|\"go\"|\"plus\"|\"pro\"|\"prolite\"|\"team\"|\"unknown\"|\"usage_based\";primary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};reached?:\"credits_depleted\"|\"rate_limit_reached\"|\"usage_limit_reached\";secondary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};spendControl?:{limit:string;remainingPercent:number;resetsAt:string;used:string}};reconciliationState:\"cleanup_required\"|\"current\"|\"reconnecting\";registrationState:\"provisional\"|\"registered\";revision:number;usage?:{daily:{startDate:string;tokens:string}[];freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;summary:{currentStreakDays?:string;lifetimeTokens?:string;longestRunningTurnSec?:string;longestStreakDays?:string;peakDailyTokens?:string}};usageObservedAt?:string}",
      "response.body:{code:string}",
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
      "response.body:{dtoVersion:1;metrics:{attemptOutcomes:{count:string;operation:\"access_update\"|\"create\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"failed\";reason:\"integrity_failure\"|\"parity_mismatch\"|\"publication_failure\"}|{count:string;operation:\"access_update\"|\"create\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"pending\";reason:\"none\"}|{count:string;operation:\"access_update\"|\"create\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"reconciling\";reason:\"response_lost\"}|{count:string;operation:\"access_update\"|\"create\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"unavailable\";reason:\"client_crypto_preparation_failed\"|\"client_crypto_unavailable\"|\"client_custody_unavailable\"|\"client_observation_expired\"|\"namespace_encryption_not_ready\"|\"stale_authority_product\"|\"unmigrated\"|\"unsupported_operation\"}|{count:string;operation:\"access_update\"|\"create\"|\"read_repair\"|\"unsupported\"|\"update\";outcome:\"verified\";reason:\"none\"}[];attemptSuccess:{eligible:string;percent?:number;verified:string};family:\"artifact\"|\"memory\"|\"message\"|\"overall\"|\"record\";pendingLifecycle:{oldestPendingAt?:string;operations:string};storedCoverage:{percent?:number;total:string;verified:string};touchedCoverage:{percent?:number;total:string;verified:string}}[];observationPressure:{admissionCapacity:string;capacityRows:string;maximumRetentionMs:number;pendingAdmissions:string;retainedRows:string};policy:{mode:\"plaintext_only\"|\"shadow_writes\";revision:number;shadowWritesStartedAt?:string;updatedAt:string}}",
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
    "observationId": "wire.http.request.response.post.api.admin.server.models.1nyrg5s",
    "locator": "http:request_response:POST /api/admin/server-models",
    "structuralSignatures": [
      "response.body:{conductorModel:string;defaultChatModel:string;fallbackChain:string[];reasoningOutput:{[key:string]:boolean};reasoningPolicy:{defaultEffort:\"high\"|\"low\"|\"max\"|\"medium\"|\"minimal\"|\"off\"|\"xhigh\";overrides:{[key:string]:\"high\"|\"low\"|\"max\"|\"medium\"|\"minimal\"|\"off\"|\"xhigh\"}};reflectionModel:string;stenographerModel:string}",
      "response.body:{error:any}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.error",
        "debtId": "debt.wire.arbitrary.zogb98"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.codex.profiles.profileid.account.1urrxbx",
    "locator": "http:request_response:POST /api/codex/profiles/:profileId/account",
    "structuralSignatures": [
      "request.params:{profileId:string}",
      "response.body:{authState:\"error\"|\"expired\"|\"login_pending\"|\"signed_in\"|\"signed_out\";profile:{accountEmail?:string;authState:\"error\"|\"expired\"|\"login_pending\"|\"signed_in\"|\"signed_out\";id:string;label:string;lastErrorCode?:string;planType?:string;rateLimits?:{credits?:{balance?:string;hasCredits:boolean;unlimited:boolean};freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;plan?:\"business\"|\"edu\"|\"enterprise\"|\"free\"|\"go\"|\"plus\"|\"pro\"|\"prolite\"|\"team\"|\"unknown\"|\"usage_based\";primary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};reached?:\"credits_depleted\"|\"rate_limit_reached\"|\"usage_limit_reached\";secondary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};spendControl?:{limit:string;remainingPercent:number;resetsAt:string;used:string}};reconciliationState:\"cleanup_required\"|\"current\"|\"reconnecting\";registrationState:\"provisional\"|\"registered\";revision:number;usage?:{daily:{startDate:string;tokens:string}[];freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;summary:{currentStreakDays?:string;lifetimeTokens?:string;longestRunningTurnSec?:string;longestStreakDays?:string;peakDailyTokens?:string}};usageObservedAt?:string}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.codex.profiles.profileid.login.cancel.f86poi",
    "locator": "http:request_response:POST /api/codex/profiles/:profileId/login/cancel",
    "structuralSignatures": [
      "request.params:{profileId:string}",
      "response.body:{authState:\"error\"|\"expired\"|\"login_pending\"|\"signed_in\"|\"signed_out\";profile:{accountEmail?:string;authState:\"error\"|\"expired\"|\"login_pending\"|\"signed_in\"|\"signed_out\";id:string;label:string;lastErrorCode?:string;planType?:string;rateLimits?:{credits?:{balance?:string;hasCredits:boolean;unlimited:boolean};freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;plan?:\"business\"|\"edu\"|\"enterprise\"|\"free\"|\"go\"|\"plus\"|\"pro\"|\"prolite\"|\"team\"|\"unknown\"|\"usage_based\";primary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};reached?:\"credits_depleted\"|\"rate_limit_reached\"|\"usage_limit_reached\";secondary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};spendControl?:{limit:string;remainingPercent:number;resetsAt:string;used:string}};reconciliationState:\"cleanup_required\"|\"current\"|\"reconnecting\";registrationState:\"provisional\"|\"registered\";revision:number;usage?:{daily:{startDate:string;tokens:string}[];freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;summary:{currentStreakDays?:string;lifetimeTokens?:string;longestRunningTurnSec?:string;longestStreakDays?:string;peakDailyTokens?:string}};usageObservedAt?:string}}",
      "response.body:{error:string}",
      "response.body:{state:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.codex.profiles.profileid.logout.19pi37g",
    "locator": "http:request_response:POST /api/codex/profiles/:profileId/logout",
    "structuralSignatures": [
      "request.params:{profileId:string}",
      "response.body:{authState:\"error\"|\"expired\"|\"login_pending\"|\"signed_in\"|\"signed_out\";profile:{accountEmail?:string;authState:\"error\"|\"expired\"|\"login_pending\"|\"signed_in\"|\"signed_out\";id:string;label:string;lastErrorCode?:string;planType?:string;rateLimits?:{credits?:{balance?:string;hasCredits:boolean;unlimited:boolean};freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;plan?:\"business\"|\"edu\"|\"enterprise\"|\"free\"|\"go\"|\"plus\"|\"pro\"|\"prolite\"|\"team\"|\"unknown\"|\"usage_based\";primary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};reached?:\"credits_depleted\"|\"rate_limit_reached\"|\"usage_limit_reached\";secondary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};spendControl?:{limit:string;remainingPercent:number;resetsAt:string;used:string}};reconciliationState:\"cleanup_required\"|\"current\"|\"reconnecting\";registrationState:\"provisional\"|\"registered\";revision:number;usage?:{daily:{startDate:string;tokens:string}[];freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;summary:{currentStreakDays?:string;lifetimeTokens?:string;longestRunningTurnSec?:string;longestStreakDays?:string;peakDailyTokens?:string}};usageObservedAt?:string}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.codex.profiles.xkpz32",
    "locator": "http:request_response:POST /api/codex/profiles",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{loginRef:string;profile:{accountEmail?:string;authState:\"error\"|\"expired\"|\"login_pending\"|\"signed_in\"|\"signed_out\";id:string;label:string;lastErrorCode?:string;planType?:string;rateLimits?:{credits?:{balance?:string;hasCredits:boolean;unlimited:boolean};freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;plan?:\"business\"|\"edu\"|\"enterprise\"|\"free\"|\"go\"|\"plus\"|\"pro\"|\"prolite\"|\"team\"|\"unknown\"|\"usage_based\";primary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};reached?:\"credits_depleted\"|\"rate_limit_reached\"|\"usage_limit_reached\";secondary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};spendControl?:{limit:string;remainingPercent:number;resetsAt:string;used:string}};reconciliationState:\"cleanup_required\"|\"current\"|\"reconnecting\";registrationState:\"provisional\"|\"registered\";revision:number;usage?:{daily:{startDate:string;tokens:string}[];freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;summary:{currentStreakDays?:string;lifetimeTokens?:string;longestRunningTurnSec?:string;longestStreakDays?:string;peakDailyTokens?:string}};usageObservedAt?:string}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.additional.begin.1ju9zwc",
    "locator": "http:request_response:POST /api/protected/devices/additional/begin",
    "structuralSignatures": [
      "response.body:{domains:{authorizationRevision:number;committerDeviceId:string;committerSigningPublicKeyBase64url:string;domainId:string;expectedHead:{domainId:string;epoch:number;providerId:string;stateHashBase64url:string};namespaces:{accessRevision:number;aiEnvelopeBytesBase64url:string;bindingHashBase64url:string;bindingProofBytesBase64url:string[];humanEnvelopeBytesBase64url:string;namespaceId:string}[];participantDigestBase64url:string;rosterBytesBase64url:string}[];enrollment:{authorizationDigestBase64url:string;authorizationEvidenceDigestBase64url:string;challengeId:string;clientKind:\"browser\"|\"electron\";deviceGeneration:1;deviceId:string;deviceRevision:0;encryptionPublicKeyBase64url:string;expectedCustodyRevision:number;expectedRecoveryGeneration:number;expiresAt:number;formatVersion:1;humanActorId:string;idempotencyKey:string;installationLineageDigestBase64url:string;inventoryCount:number;inventoryDigestBase64url:string;inventoryRevision:number;issuedAt:number;method:\"device_approval\";operationId:string;signingPublicKeyBase64url:string;status:\"pending\";userId:string};formatVersion:1;progress?:\"approval_required\"|\"awaiting_target\"|\"transfer_ready\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.additional.operationid.ack.8an2mj",
    "locator": "http:request_response:POST /api/protected/devices/additional/:operationId/ack",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{status:\"acknowledged\"|\"duplicate\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.additional.operationid.activate.c0y3tj",
    "locator": "http:request_response:POST /api/protected/devices/additional/:operationId/activate",
    "structuralSignatures": [
      "response.body:{custodyRevision?:number;deviceId:string;deviceRevision?:number;formatVersion:1;operationId:string;status:\"active\"|\"syncing\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.additional.operationid.approve.amvh9b",
    "locator": "http:request_response:POST /api/protected/devices/additional/:operationId/approve",
    "structuralSignatures": [
      "response.body:{completedDomains:number;formatVersion:1;operationId:string;requiredDomains:number;status:\"admitted\"|\"duplicate\"|\"syncing\";targetDeviceId:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.additional.operationid.deliveries.6nj072",
    "locator": "http:request_response:POST /api/protected/devices/additional/:operationId/deliveries",
    "structuralSignatures": [
      "response.body:{deviceId:string;formatVersion:1;highWatermark:number;messages:{createdAt:number;domainId?:string;expiresAt:number;formatVersion:1;kind:\"device_transfer\"|\"public_state\";messageId:string;operationId:string;payloadBytesBase64url:string;payloadHashBase64url:string;recipientSequence:number}[];operationId:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.additional.operationid.join.packages.7891mo",
    "locator": "http:request_response:POST /api/protected/devices/additional/:operationId/join-packages",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{status:\"duplicate\"|\"published\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.additional.operationid.transition.plan.1igivar",
    "locator": "http:request_response:POST /api/protected/devices/additional/:operationId/transition-plan",
    "structuralSignatures": [
      "response.body:{domains:{claim:{leaseExpiresAt:number;retryCount:number;state:\"awaiting_committer\"|\"preparing\";workerId:string};joinPackageBytesBase64url:string;plan:{authorizationRevision:number;committerDeviceId:string;committerSigningPublicKeyBase64url:string;domainId:string;expectedHead:{domainId:string;epoch:number;providerId:string;stateHashBase64url:string};namespaces:{accessRevision:number;aiEnvelopeBytesBase64url:string;bindingHashBase64url:string;bindingProofBytesBase64url:string[];humanEnvelopeBytesBase64url:string;namespaceId:string}[];participantDigestBase64url:string;rosterBytesBase64url:string}}[];formatVersion:1;operationId:string;targetDeviceId:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.additional.operationid.transitions.1q3sg56",
    "locator": "http:request_response:POST /api/protected/devices/additional/:operationId/transitions",
    "structuralSignatures": [
      "response.body:{completedDomains:number;formatVersion:1;operationId:string;requiredDomains:number;status:\"admitted\"|\"duplicate\"|\"syncing\";targetDeviceId:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.additional.pending.13xpw22",
    "locator": "http:request_response:POST /api/protected/devices/additional/pending",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{formatVersion:1;pending:{domains:{authorizationRevision:number;committerDeviceId:string;committerSigningPublicKeyBase64url:string;domainId:string;expectedHead:{domainId:string;epoch:number;providerId:string;stateHashBase64url:string};namespaces:{accessRevision:number;aiEnvelopeBytesBase64url:string;bindingHashBase64url:string;bindingProofBytesBase64url:string[];humanEnvelopeBytesBase64url:string;namespaceId:string}[];participantDigestBase64url:string;rosterBytesBase64url:string}[];enrollment:{authorizationDigestBase64url:string;authorizationEvidenceDigestBase64url:string;challengeId:string;clientKind:\"browser\"|\"electron\";deviceGeneration:1;deviceId:string;deviceRevision:0;encryptionPublicKeyBase64url:string;expectedCustodyRevision:number;expectedRecoveryGeneration:number;expiresAt:number;formatVersion:1;humanActorId:string;idempotencyKey:string;installationLineageDigestBase64url:string;inventoryCount:number;inventoryDigestBase64url:string;inventoryRevision:number;issuedAt:number;method:\"device_approval\";operationId:string;signingPublicKeyBase64url:string;status:\"pending\";userId:string};formatVersion:1;progress?:\"approval_required\"|\"awaiting_target\"|\"transfer_ready\"}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.initial.bootstrap.begin.18shjtw",
    "locator": "http:request_response:POST /api/protected/devices/initial-bootstrap/begin",
    "structuralSignatures": [
      "response.body:{authorizationDigestBase64url:string;authorizationEvidenceDigestBase64url:string;challengeId:string;clientKind:\"browser\"|\"electron\";context:{authorityId:string;kind:\"preparation\"};deviceId:string;encryptionPublicKeyBase64url:string;expiresAt:number;formatVersion:1;humanActorId:string;idempotencyKey:string;installationLineageDigestBase64url:string;issuedAt:number;recoveryKeyId:string;recoveryPublicKeyBase64url:string;signingPublicKeyBase64url:string;userId:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.initial.bootstrap.complete.1vt2q00",
    "locator": "http:request_response:POST /api/protected/devices/initial-bootstrap/complete",
    "structuralSignatures": [
      "response.body:{auditRef:string;committedAt:number;custodyRevision:1;deviceId:string;deviceRevision:1;formatVersion:1;humanActorId:string;recoveryGeneration:1;recoveryKeyId:string;status:\"active\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.initial.bootstrap.receipt.ufrdmd",
    "locator": "http:request_response:POST /api/protected/devices/initial-bootstrap/receipt",
    "structuralSignatures": [
      "response.body:{auditRef:string;committedAt:number;custodyRevision:1;deviceId:string;deviceRevision:1;formatVersion:1;humanActorId:string;recoveryGeneration:1;recoveryKeyId:string;status:\"active\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.initial.domain.1tt332s",
    "locator": "http:request_response:POST /api/protected/devices/initial-domain",
    "structuralSignatures": [
      "response.body:{committedAt:number;deviceId:string;domainId:string;epoch:0;formatVersion:1;humanId:string;operationId:string;providerId:string;rosterHashBase64url:string;stateHashBase64url:string;status:\"active\";submissionDigestBase64url:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.devices.initial.domain.plan.14rbwi6",
    "locator": "http:request_response:POST /api/protected/devices/initial-domain/plan",
    "structuralSignatures": [
      "response.body:{activeDeviceIds:string[];currentDomainHead:null;deliveryHighWatermark:number;deviceId:string;domainId:string;formatVersion:1;humanId:string;operationId:string;status:\"planned\";trustedDeviceRevision:number;trustedHostAuthorizationRevision:number}|{deviceId:string;domainId:string;epoch:number;formatVersion:1;humanId:string;providerId:string;stateHashBase64url:string;status:\"active\"}|{formatVersion:1;reason:\"device_unavailable\"|\"existing_domain_requires_delivery\"|\"multiple_active_devices_require_fanout\"|\"stale_identity\";status:\"unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.protected.shadow.attempts.observe.xpgfjj",
    "locator": "http:request_response:POST /api/protected/shadow-attempts/observe",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{status:\"accepted\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.relay.declared.arbitrary.packages.relay.src.protocol.ts.desktopautomationinvocationbinding.98aja8",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#DesktopAutomationInvocationBinding",
    "structuralSignatures": [
      "declaration.payload:{computerUseContextId:string;computerUseInvocationId:string;desktopSessionId:string;grantGeneration:number;installationEpoch:string;lineageId:string;originAgentId:string;originHumanId:string;originRunId:string;pairingGeneration:string;provider:\"cua\"|\"peekaboo\";providerGeneration:string;relayId:string;supportedActions:unresolved<DesktopAutomationAction>[];supportsTargetedObservation:boolean;supportsVerification:boolean;usedFallback:boolean;version:typeof RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION}"
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
      "declaration.payload:{binding:{computerUseContextId:string;computerUseInvocationId:string;desktopSessionId:string;grantGeneration:number;installationEpoch:string;lineageId:string;originAgentId:string;originHumanId:string;originRunId:string;pairingGeneration:string;provider:\"cua\"|\"peekaboo\";providerGeneration:string;relayId:string;supportedActions:unresolved<DesktopAutomationAction>[];supportsTargetedObservation:boolean;supportsVerification:boolean;usedFallback:boolean;version:typeof RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION};ok:true}|{error:string;ok:false}"
    ],
    "arbitraryPayloads": [
      {
        "path": "binding.supportedActions[]",
        "schema": "DesktopAutomationActionSetV1"
      }
    ]
  },
  {
    "observationId": "wire.relay.declared.arbitrary.packages.relay.src.protocol.ts.relaydispatchrequest.1xd01c2",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest",
    "structuralSignatures": [
      "declaration.payload:{allowedRoots?:string[]|undefined;approvalObtained:boolean;args:{[key:string]:unknown};browserPageOwnerBinding?:undefined|{desktopSessionId:null|string;instanceId:string;relayId:string;userId:string};browserPageSnapshotReferencePublication?:true|undefined;correlationId:string;desktopAutomationBinding?:undefined|{computerUseContextId:string;computerUseInvocationId:string;desktopSessionId:string;grantGeneration:number;installationEpoch:string;lineageId:string;originAgentId:string;originHumanId:string;originRunId:string;pairingGeneration:string;provider:\"cua\"|\"peekaboo\";providerGeneration:string;relayId:string;supportedActions:unresolved<DesktopAutomationAction>[];supportsTargetedObservation:boolean;supportsVerification:boolean;usedFallback:boolean;version:typeof RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION};desktopFilesystemGrantRequest?:undefined|{grantIds:string[];operation:unresolved<DesktopFilesystemAccessOperation>;policy:{expiresAt?:string|undefined;lifetime:unresolved<DesktopFilesystemGrantLifetime>;policyVersion:number};requestedRoot:string;requiredOperations?:undefined|unresolved<DesktopFilesystemAccessOperation>[];subject:unresolved<DesktopFilesystemGrantSubject>;version:typeof RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION};executionClass?:\"browser\"|\"desktop\"|\"fs\"|\"local-file\"|\"real_workstation\"|\"structured-ssh\"|undefined;impact:\"destructive\"|\"high\"|\"low\"|\"read-only\";reportRunShellProgress?:(progress: Omit<RelayRunShellProgressMessage, \"type\" | \"correlationId\">) => void|undefined;reportStructuredSshProgress?:(progress: RelayStructuredSshProgressObservation) => void|undefined;runShellOwnerBinding?:undefined|{desktopSessionId:null|string;instanceId:string;relayId:string;userId:string};sandboxProfile?:undefined|{config:{mode:\"disabled\"|\"enabled\";networkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};passthroughEnv:string[];projectPaths:string[];protectedFileMaskPath?:string;protectedPaths?:string[];readOnlyPaths?:string[];writablePaths:string[]};dataDir:string;failIfNoBackend:boolean;mode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";toolsBin:string;workspace:string};sshBinding?:undefined|{admissionId:string;approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";preparationId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_DISPATCH_BINDING_VERSION};structuredSshOutputOwnerBinding?:undefined|{desktopSessionId:null|string;instanceId:string;relayId:string;userId:string};timeout?:number|undefined;toolName:string;workstationShellBinding?:undefined|{capabilityRevision:number;currentFolder:string;desktopSessionId:string;executionClass:typeof RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS;grantIds:string[];grantRevision:number;operation:unresolved<DesktopFilesystemAccessOperation>;pairingGeneration:string;profileId:string;profileRevision:number;protectedPolicyVersion:number;relayId:string;serverBindingId:string;subject:{agentScope:string;instanceId:string;relayId:string;userId:string};toolCallId:string;version:typeof RELAY_WORKSTATION_SHELL_BINDING_VERSION}}"
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
      "declaration.payload:unresolved<RelayAcpServerMessage>|unresolved<RelayCodexCancelMessage>|unresolved<RelayCodexCommandMessage>|unresolved<RelayCodexCreditMessage>|unresolved<RelayCodexRequestResponseMessage>|unresolved<RelayRegisteredV8>|{allowedRoots?:string[]|undefined;approvalObtained:boolean;args:{[key:string]:unknown};correlationId:string;desktopAutomationBinding?:undefined|{computerUseContextId:string;computerUseInvocationId:string;desktopSessionId:string;grantGeneration:number;installationEpoch:string;lineageId:string;originAgentId:string;originHumanId:string;originRunId:string;pairingGeneration:string;provider:\"cua\"|\"peekaboo\";providerGeneration:string;relayId:string;supportedActions:unresolved<DesktopAutomationAction>[];supportsTargetedObservation:boolean;supportsVerification:boolean;usedFallback:boolean;version:typeof RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION};desktopFilesystemGrantRequest?:undefined|{grantIds:string[];operation:unresolved<DesktopFilesystemAccessOperation>;policy:{expiresAt?:string|undefined;lifetime:unresolved<DesktopFilesystemGrantLifetime>;policyVersion:number};requestedRoot:string;requiredOperations?:undefined|unresolved<DesktopFilesystemAccessOperation>[];subject:unresolved<DesktopFilesystemGrantSubject>;version:typeof RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION};executionClass?:\"browser\"|\"desktop\"|\"fs\"|\"local-file\"|\"real_workstation\"|\"structured-ssh\"|undefined;impact:\"destructive\"|\"high\"|\"low\"|\"read-only\";sandboxProfile?:undefined|{config:{mode:\"disabled\"|\"enabled\";networkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};passthroughEnv:string[];projectPaths:string[];protectedFileMaskPath?:string;protectedPaths?:string[];readOnlyPaths?:string[];writablePaths:string[]};dataDir:string;failIfNoBackend:boolean;mode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";toolsBin:string;workspace:string};sshBinding?:undefined|{admissionId:string;approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";preparationId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_DISPATCH_BINDING_VERSION};timeout?:number|undefined;toolName:string;type:\"relay:dispatch\";workstationShellBinding?:undefined|{capabilityRevision:number;currentFolder:string;desktopSessionId:string;executionClass:typeof RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS;grantIds:string[];grantRevision:number;operation:unresolved<DesktopFilesystemAccessOperation>;pairingGeneration:string;profileId:string;profileRevision:number;protectedPolicyVersion:number;relayId:string;serverBindingId:string;subject:{agentScope:string;instanceId:string;relayId:string;userId:string};toolCallId:string;version:typeof RELAY_WORKSTATION_SHELL_BINDING_VERSION}}|{capabilityRevision:number;error?:string|undefined;relayId:string;status:\"ok\"|\"rejected\";type:\"relay:capabilities-updated\"}|{correlationId:string;type:\"relay:cancel\"}|{digest:string;requestId:string;server:{envPassthrough?:null|string[]|undefined;excludeTools?:null|string[]|undefined;includeTools?:null|string[]|undefined;name:string;namespaceId?:null|string|undefined;transport:{[key:string]:unknown};transportKind:\"sse-legacy\"|\"stdio\"|\"streamable-http\";trustTier?:null|string|undefined};type:\"relay:mcp-preflight\"}|{message:string;type:\"relay:error\"}|{operation?:undefined|{digest:string;operationId:string;phase:\"rollback\"|\"start\";targetName:string};servers:{envPassthrough?:null|string[]|undefined;excludeTools?:null|string[]|undefined;includeTools?:null|string[]|undefined;name:string;namespaceId?:null|string|undefined;transport:{[key:string]:unknown};transportKind:\"sse-legacy\"|\"stdio\"|\"streamable-http\";trustTier?:null|string|undefined}[];type:\"relay:configure-mcp\"}|{protocolVersion?:number|undefined;relayId:string;type:\"relay:registered\"}|{request:{approvedRequest:{args:{argv:string[];destination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string};program:string;timeoutReason?:string|undefined;timeoutSeconds:number};toolCallId:string;toolName:\"structured_ssh_exec\";version:typeof RELAY_SSH_APPROVED_REQUEST_VERSION}|{args:{destination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string};localPath:string;remotePath:string;timeoutReason?:string|undefined;timeoutSeconds:number};toolCallId:string;toolName:\"structured_ssh_copy_download\";version:typeof RELAY_SSH_APPROVED_REQUEST_VERSION}|{args:{destination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string};localPath:string;remotePath:string;timeoutReason?:string|undefined;timeoutSeconds:number};toolCallId:string;toolName:\"structured_ssh_copy_upload\";version:typeof RELAY_SSH_APPROVED_REQUEST_VERSION}|{args:{destination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string}};toolCallId:string;toolName:\"structured_ssh_auth\";version:typeof RELAY_SSH_APPROVED_REQUEST_VERSION};approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";requestId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_PREPARE_VERSION};type:\"relay:ssh-prepare\"}"
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
      "declaration.payload:{allowedRoots?:string[]|undefined;approvalObtained:boolean;args:{[key:string]:unknown};correlationId:string;desktopAutomationBinding?:undefined|{computerUseContextId:string;computerUseInvocationId:string;desktopSessionId:string;grantGeneration:number;installationEpoch:string;lineageId:string;originAgentId:string;originHumanId:string;originRunId:string;pairingGeneration:string;provider:\"cua\"|\"peekaboo\";providerGeneration:string;relayId:string;supportedActions:unresolved<DesktopAutomationAction>[];supportsTargetedObservation:boolean;supportsVerification:boolean;usedFallback:boolean;version:typeof RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION};desktopFilesystemGrantRequest?:undefined|{grantIds:string[];operation:unresolved<DesktopFilesystemAccessOperation>;policy:{expiresAt?:string|undefined;lifetime:unresolved<DesktopFilesystemGrantLifetime>;policyVersion:number};requestedRoot:string;requiredOperations?:undefined|unresolved<DesktopFilesystemAccessOperation>[];subject:unresolved<DesktopFilesystemGrantSubject>;version:typeof RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION};executionClass?:\"browser\"|\"desktop\"|\"fs\"|\"local-file\"|\"real_workstation\"|\"structured-ssh\"|undefined;impact:\"destructive\"|\"high\"|\"low\"|\"read-only\";sandboxProfile?:undefined|{config:{mode:\"disabled\"|\"enabled\";networkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};passthroughEnv:string[];projectPaths:string[];protectedFileMaskPath?:string;protectedPaths?:string[];readOnlyPaths?:string[];writablePaths:string[]};dataDir:string;failIfNoBackend:boolean;mode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";toolsBin:string;workspace:string};sshBinding?:undefined|{admissionId:string;approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";preparationId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_DISPATCH_BINDING_VERSION};timeout?:number|undefined;toolName:string;type:\"relay:dispatch\";workstationShellBinding?:undefined|{capabilityRevision:number;currentFolder:string;desktopSessionId:string;executionClass:typeof RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS;grantIds:string[];grantRevision:number;operation:unresolved<DesktopFilesystemAccessOperation>;pairingGeneration:string;profileId:string;profileRevision:number;protectedPolicyVersion:number;relayId:string;serverBindingId:string;subject:{agentScope:string;instanceId:string;relayId:string;userId:string};toolCallId:string;version:typeof RELAY_WORKSTATION_SHELL_BINDING_VERSION}}"
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
      "frame.payload:{allowedRoots?:string[]|undefined;approvalObtained:boolean;args:{[key:string]:unknown};correlationId:string;desktopAutomationBinding?:undefined|{computerUseContextId:string;computerUseInvocationId:string;desktopSessionId:string;grantGeneration:number;installationEpoch:string;lineageId:string;originAgentId:string;originHumanId:string;originRunId:string;pairingGeneration:string;provider:\"cua\"|\"peekaboo\";providerGeneration:string;relayId:string;supportedActions:unresolved<DesktopAutomationAction>[];supportsTargetedObservation:boolean;supportsVerification:boolean;usedFallback:boolean;version:typeof RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION};desktopFilesystemGrantRequest?:undefined|{grantIds:string[];operation:unresolved<DesktopFilesystemAccessOperation>;policy:{expiresAt?:string|undefined;lifetime:unresolved<DesktopFilesystemGrantLifetime>;policyVersion:number};requestedRoot:string;requiredOperations?:undefined|unresolved<DesktopFilesystemAccessOperation>[];subject:unresolved<DesktopFilesystemGrantSubject>;version:typeof RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION};executionClass?:\"browser\"|\"desktop\"|\"fs\"|\"local-file\"|\"real_workstation\"|\"structured-ssh\"|undefined;impact:\"destructive\"|\"high\"|\"low\"|\"read-only\";sandboxProfile?:undefined|{config:{mode:\"disabled\"|\"enabled\";networkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};passthroughEnv:string[];projectPaths:string[];protectedFileMaskPath?:string;protectedPaths?:string[];readOnlyPaths?:string[];writablePaths:string[]};dataDir:string;failIfNoBackend:boolean;mode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";toolsBin:string;workspace:string};sshBinding?:undefined|{admissionId:string;approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";preparationId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_DISPATCH_BINDING_VERSION};timeout?:number|undefined;toolName:string;type:\"relay:dispatch\";workstationShellBinding?:undefined|{capabilityRevision:number;currentFolder:string;desktopSessionId:string;executionClass:typeof RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS;grantIds:string[];grantRevision:number;operation:unresolved<DesktopFilesystemAccessOperation>;pairingGeneration:string;profileId:string;profileRevision:number;protectedPolicyVersion:number;relayId:string;serverBindingId:string;subject:{agentScope:string;instanceId:string;relayId:string;userId:string};toolCallId:string;version:typeof RELAY_WORKSTATION_SHELL_BINDING_VERSION}}"
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
  }
];

export const SUPERSEDED_MAIN_2026_08_20_DTO_LOCATORS = new Set<string>(
  REVIEWED_MAIN_2026_08_20_DTO_DECLARATIONS.map((entry) => entry.locator),
);

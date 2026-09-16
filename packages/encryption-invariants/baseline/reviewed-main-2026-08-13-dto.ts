import type { DtoDeclaration } from "../src/node/dto-inventory";

export const REVIEWED_MAIN_2026_08_13_DTO_DECLARATIONS: readonly DtoDeclaration[] = [
  {
    "observationId": "wire.app.bridge.host.to.app.nautilo.app.presentation.theme.1pl37nq",
    "locator": "app_bridge:host_to_app:nautilo.app.presentation.theme",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.delete.api.admin.users.id.1etqh4b",
    "locator": "http:request_response:DELETE /api/admin/users/:id",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{code:string;error:string}",
      "response.body:{code:string;sharedRoomCount:number}",
      "response.body:{code:string}",
      "response.body:{error:string}",
      "response.body:{logtoRevoked:boolean;mutation:{auditRecorded:boolean;receiptId:string;recovery:{kind:string;userId:string}[];retrySafe:boolean;stateChanged:boolean};ok:boolean}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.delete.api.invites.id.1b843ut",
    "locator": "http:request_response:DELETE /api/invites/:id",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{error:string}",
      "response.body:{mutation:{auditRecorded:boolean;receiptId:string;recovery:undefined[];retrySafe:boolean;stateChanged:boolean};ok:boolean}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.delete.api.mcp.servers.name.1q2dxkc",
    "locator": "http:request_response:DELETE /api/mcp-servers/:name",
    "structuralSignatures": [
      "request.params:{name:string}",
      "response.body:any",
      "response.body:object",
      "response.body:{catch:function;finally:function;then:function}",
      "response.body:{error:string;name:string}",
      "response.body:{error:string}",
      "response.body:{name:string;ok:boolean}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body",
        "debtId": "debt.wire.arbitrary.unfmes"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.admin.users.12jlf0u",
    "locator": "http:request_response:GET /api/admin/users",
    "structuralSignatures": [
      "request.query:{cursor?:string;include_federated?:string;limit?:number|string;search?:string}",
      "response.body:{error:string}",
      "response.body:{nextCursor:string;page:{complete:boolean;continuationAvailable:boolean;hasMore:boolean;nextCursor:string;returned:number};users:{createdAt:Date;disabledAt:Date;disabledBy:string;disabledReason:string;displayName:string;groups:{id:string;label:string;roleSlug:string;type:string}[];handle:string;id:string;lastSeenAt:Date;server:string}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.admin.users.rollout.rolloutid.101ficf",
    "locator": "http:request_response:GET /api/admin/users/rollout/:rolloutId",
    "structuralSignatures": [
      "request.params:{rolloutId:string}",
      "response.body:{code:string}",
      "response.body:{createdAt:string;fingerprint:string;items:{credentialDisposition:string;errorCode:string;handle:string;memberId:string;receiptId:string;roleSlug:string;sequence:number;state:string;updatedAt:string}[];ok:true;rolloutId:string;status:string;updatedAt:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.invites.1ucoajo",
    "locator": "http:request_response:GET /api/invites",
    "structuralSignatures": [
      "request.query:{all?:string;cursor?:string;limit?:string}",
      "response.body:{error:string}",
      "response.body:{invites:{createdAt:Date;displayName:string;expiresAt:Date;id:string;kind:string;maxUses:number;revokedAt:Date;targetRoleSlug:string;targetRoomId:string;targetRoomLabel:string;usedCount:number}[];page:{complete:boolean;continuationAvailable:boolean;hasMore:boolean;nextCursor:string;returned:number}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.security.audit.log.ef92mf",
    "locator": "http:request_response:GET /api/security/audit-log",
    "structuralSignatures": [
      "request.query:{actorId?:string;correlationId?:string;cursor?:string;kinds?:string;limit?:string;since?:string}",
      "response.body:{error:string}",
      "response.body:{events:{action:\"configure\"|\"remove\";actorId:string;clientId:string;ip:string;kind:\"google_oauth_client_config\";outcome:\"ok\";ts:string;userAgent:string}|{action:\"create\"|\"delete\"|\"disable\"|\"enable\"|\"update\";actorId:string;effectDigest?:string;ip:string;kind:\"mcp_server_config\";outcome:\"error\"|\"ok\";relayId?:string;serverName:string;ts:string;userAgent:string}|{action:\"delete\"|\"list\"|\"store\"|\"use\";actorId:string;connectionId?:string;errorKind?:string;field?:string;ip:string;kind:\"connection_vault_tool\";outcome:\"error\"|\"missing\"|\"ok\";service?:string;tool:string;ts:string;userAgent:string}|{action:string;actorId:string;errorKind?:string;ip:string;kind:\"memory.edit\";memoryId:string;namespaceId?:string;outcome:\"failure\"|\"success\";scopeId?:string;ts:string;userAgent:string}|{actorId:string;actorUserId:string;ip:string;kind:\"standing_approval_revoked\";label:string;roomId:string;route:\"DELETE /api/security/standing-approvals/:id\";ruleId:string;scope:\"room\"|\"server\";toolPattern:string;ts:string;userAgent:string}|{actorId:string;affectedPairingCount:number;correlationId:string;ip:string;kind:\"relay_pairing_lifecycle\";managementTarget:string;operation:\"group_revoke\"|\"historical_cleanup\";reason:\"confirmation_mismatch\"|\"not_found_or_foreign\"|\"revoked\"|\"store_error\";result:\"failed\"|\"not_found_or_foreign\"|\"stale\"|\"succeeded\";ts:string;userAgent:string;userId:string}|{actorId:string;after:{conductorModel:string;defaultChatModel:string;fallbackChain:string[];stenographerModel:string};before:{conductorModel:string;defaultChatModel:string;fallbackChain:string[];stenographerModel:string};ip:string;kind:\"server_model_config_changed\";ts:string;userAgent:string}|{actorId:string;attemptedRoute:string;capability:string;ip:string;kind:\"capability_check_failed\";ts:string;userAgent:string}|{actorId:string;attemptedRoute:string;ip:string;kind:\"pin_check_failed\";pinOutcome:\"invalid\"|\"locked_out\";ts:string;userAgent:string}|{actorId:string;byUserId:string;fromUserId:string;ip:string;kind:\"room_archived\";roomId:string;ts:string;userAgent:string}|{actorId:string;byUserId:string;ip:string;kind:\"room_unarchived\";roomId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail:boolean;ip:string;kind:\"agent_role_removed\";roleSlug:string;targetAgentId:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail:boolean;ip:string;kind:\"room_member_removed\";roomId:string;targetActorId:string;targetActorKind:\"agent\"|\"user\";ts:string;userAgent:string}|{actorId:string;bypassedRail?:boolean;groupId:string;groupType:string;ip:string;kind:\"group_member_removed\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail?:boolean;ip:string;kind:\"agent_role_added\";replacedFromGroupId:string;roleSlug:string;targetAgentId:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];groupId:string;groupType:string;ip:string;kind:\"rbac_shared_access_assigned\";memberCount:number;ownerUserId:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];groupId:string;groupType:string;ip:string;kind:\"rbac_shared_access_created\";memberCount:number;ownerUserId:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];ip:string;kind:\"rbac_role_capabilities_set\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];ip:string;kind:\"rbac_role_created\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilityRevision:number;denialCode?:string;desktopSessionId:string;ip:string;kind:\"workstation_session_activated\"|\"workstation_session_broadened\"|\"workstation_session_denied\"|\"workstation_session_disabled\"|\"workstation_session_invalidated\"|\"workstation_session_narrowed\"|\"workstation_session_switched\";outcome?:string;relayId:string;route?:string;serverBindingId:string;ts:string;userAgent:string;userId:string}|{actorId:string;capabilityRevision:number;desktopSessionId:string;executionClass:\"profile_bound_sandbox\"|\"real_workstation\"|\"typed_broker\";ip:string;kind:\"workstation_admission\";outcome:\"auto\"|\"none\";pairingGeneration:string;profileId:string;profileRevision:number;reason:\"auto_admitted\"|\"critical_or_elevation_command\"|\"no_active_session\"|\"no_admitted_plan\"|\"run_shell_required\"|\"typed_broker_not_wired\";relayId:string;serverBindingId:string;toolCallId:string;toolName:string;ts:string;userAgent:string;userId:string}|{actorId:string;errorKind?:string;ip:string;kind:\"memory.delete\";memoryId:string;mode:\"archive\"|\"hard\";namespaceId?:string;outcome:\"failure\"|\"success\";scopeId?:string;ts:string;userAgent:string}|{actorId:string;fromOwnerUserId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_owner_transferred\";toOwnerUserId:string;ts:string;userAgent:string}|{actorId:string;fromUserId:string;ip:string;kind:\"room_ownership_transferred\";roomId:string;toUserId:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"group_member_added\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_created\";ownerUserId:string;roleSlugs:string[];ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_deleted\";ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_renamed\";label:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_roles_set\";roleSlugs:string[];ts:string;userAgent:string}|{actorId:string;handleHash:string;inviteKind:string;ip:string;kind:\"invite_bind_logto_user_succeeded\";logtoSub:string;targetGroupId?:string;targetRoomId?:string;tokenHash:string;ts:string;userAgent:string;userId:string}|{actorId:string;handleHash:string;ip:string;kind:\"logto_password_login_failed\";ts:string;userAgent:string;userId?:string}|{actorId:string;handleHash:string;ip:string;kind:\"logto_password_login_succeeded\";ts:string;userAgent:string;userId:string}|{actorId:string;handleHash:string;ip:string;kind:\"recovery_session_opened\";ts:string;userAgent:string}|{actorId:string;handleHash:string;ip:string;kind:\"recovery_session_rejected\";reason:\"logto_endpoint_missing\"|\"logto_unavailable\"|\"reject\"|\"unexpected_error\";ts:string;userAgent:string}|{actorId:string;handleHash?:string;inviteKind?:string;ip:string;kind:\"invite_bind_logto_user_failed\";logtoSub?:string;reason:string;targetGroupId?:string;targetRoomId?:string;tokenHash?:string;ts:string;userAgent:string}|{actorId:string;inviteId:string;inviteKind:string;ip:string;kind:\"invite_minted\";targetAgentId?:string;targetRoomId?:string;ts:string;userAgent:string}|{actorId:string;inviteId:string;ip:string;kind:\"invite_revoked\";ts:string;userAgent:string}|{actorId:string;inviteKind:string;ip:string;kind:\"invite_redeemed\";landingRoomId:string;newUserId:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"admin_password_reset_issued\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"approval_denied\"|\"approval_granted\";laneKey:string;network?:{host:string;port:number;reason:string;suggestedRule:{cidr?:string;host?:string;ports?:number[];suffix?:string;type:\"cidr\"|\"domain\"|\"wildcard\"}};route:\"POST /api/auth/approval-reply\";threadId:string;ts:string;userAgent:string;verb:\"always\"|\"deny\"|\"once\"|\"room\"}|{actorId:string;ip:string;kind:\"invite_complete_profile_failed\";reason:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"invite_redeem_cleanup_failed\";logtoSub:string;reason:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"invite_redeem_failed\";reason:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"logto_token_mint_failed\";logtoSub:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"pin_enrolled\";route:\"POST /api/auth/pin\";sessionUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"posture_changed\";next:{deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\"};prev:{deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\"};ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"rbac_role_deleted\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"rbac_role_renamed\";label:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"recovery_relay_code_unmatched\";ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"recovery_relay_read_denied\";reason:\"bad_request\"|\"not_found\";ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"resume_thread_auth_denied\";route:string;sessionUserId:string;threadId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_added\";roomId:string;roomRole:\"admin\"|\"member\";targetActorId:string;targetActorKind:\"agent\"|\"user\";targetAgentId?:string;targetUserId?:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_self_joined\";roomId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_self_left\";roomId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_deleted\";logtoRevoked:boolean;targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_disabled\";reason?:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_disabled_session_blocked\";route:string;sessionUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_enabled\";targetUserId:string;ts:string;userAgent:string}[];hasMore:boolean;nextCursor:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.health.1ebkeq1",
    "locator": "http:request_response:GET /health",
    "structuralSignatures": [
      "response.body:{authRequired:boolean;deploymentIdentity:string;enrolled:boolean;logtoDesktopAppId:string;logtoEndpoint:string;logtoMobileAppId:string;logtoMobileWebAppId:string;logtoResource:string;logtoTuiAppId:string;logtoTuiLoopbackAppId:string;logtoWorkbenchAppId:string;maintenanceState?:\"applying\"|\"draining\"|\"normal\";passwordRecoveryDriver:\"disabled\"|\"logto_native\"|\"oss_relay\";relayPairingContractVersion:number;serverUrl:string;status:string;workbenchUrl:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.mobile.1a8zqps",
    "locator": "http:request_response:GET /mobile/*",
    "structuralSignatures": [
      "response.body:{error:string;message:string;statusCode:number}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.mobile.93qiay",
    "locator": "http:request_response:GET /mobile/",
    "structuralSignatures": [
      "response.body:string"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.mobile.favicon.ico.187ci41",
    "locator": "http:request_response:GET /mobile/favicon.ico",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.mobile.vbj48x",
    "locator": "http:request_response:GET /mobile",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.admin.users.id.disable.1f3b5cf",
    "locator": "http:request_response:POST /api/admin/users/:id/disable",
    "structuralSignatures": [
      "request.body:{reason?:string}",
      "request.params:{id:string}",
      "response.body:{code:string;error:string}",
      "response.body:{code:string}",
      "response.body:{error:string}",
      "response.body:{mutation:{auditRecorded:boolean;receiptId:string;recovery:{kind:string;userId:string}[];retrySafe:boolean;stateChanged:boolean};ok:boolean}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.admin.users.id.enable.v6cbbu",
    "locator": "http:request_response:POST /api/admin/users/:id/enable",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{code:string;error:string}",
      "response.body:{error:string}",
      "response.body:{mutation:{auditRecorded:boolean;receiptId:string;recovery:undefined[];retrySafe:boolean;stateChanged:boolean};ok:boolean}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.admin.users.id.reset.password.1g6cxrm",
    "locator": "http:request_response:POST /api/admin/users/:id/reset-password",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{code:string;error:string}",
      "response.body:{delivery:\"one_time_url\";mutation:{auditRecorded:boolean;receiptId:string;recovery:{kind:string;userId:string}[];retrySafe:boolean;stateChanged:boolean};ok:boolean;token:string;url:string}|{delivery:\"temporary_password\";mustChangePassword:true;mutation:{auditRecorded:boolean;receiptId:string;recovery:{kind:string;userId:string}[];retrySafe:boolean;stateChanged:boolean};ok:boolean;temporaryPassword:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.admin.users.provision.1ds6x6s",
    "locator": "http:request_response:POST /api/admin/users/provision",
    "structuralSignatures": [
      "request.body:{[key:string]:unknown;displayName?:unknown;email?:unknown;handle?:unknown;roleSlug?:unknown}",
      "response.body:{actorId:string;auditRecorded:boolean;credential:{disposition:\"issued\";pin:string;recoveryCodes:string[];temporaryPassword:string}|{disposition:\"not_reissued\"};idempotent:boolean;landingRoomId:string;memberId:string;ok:boolean;receiptId:string;roleSlug:\"admin\"|\"contributor\"|\"guest\"|\"member\"|\"owner\"|\"superuser\"}",
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
    "observationId": "wire.http.request.response.post.api.admin.users.rollout.apply.65t0od",
    "locator": "http:request_response:POST /api/admin/users/rollout/apply",
    "structuralSignatures": [
      "request.body:{fingerprint?:unknown;manifest?:unknown}",
      "response.body:{code:any;index?:any}",
      "response.body:{code:any}",
      "response.body:{code:string}",
      "response.body:{createdAt:string;credentials:undefined[];fingerprint:string;idempotent:boolean;items:{credentialDisposition:string;errorCode:string;handle:string;memberId:string;receiptId:string;roleSlug:string;sequence:number;state:string;updatedAt:string}[];ok:true;rolloutId:string;status:string;updatedAt:string}",
      "response.body:{createdAt:string;credentials:{handle:string;pin:string;recoveryCodes:string[];sequence:number;temporaryPassword:string}[];fingerprint:string;idempotent:boolean;items:{credentialDisposition:string;errorCode:string;handle:string;memberId:string;receiptId:string;roleSlug:string;sequence:number;state:string;updatedAt:string}[];ok:true;rolloutId:string;status:string;updatedAt:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.fingerprint",
        "schema": "RolloutFingerprintSha256"
      },
      {
        "path": "request.body.manifest",
        "schema": "RolloutManifestV1"
      },
      {
        "path": "response.body.code",
        "schema": "RolloutPlanFailure.code"
      },
      {
        "path": "response.body.index",
        "schema": "RolloutPlanFailure.index"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.admin.users.rollout.plan.1d1hslg",
    "locator": "http:request_response:POST /api/admin/users/rollout/plan",
    "structuralSignatures": [
      "request.body:unknown",
      "response.body:{bounds:{maxMembers:number;requestedMembers:number};fingerprint:string;ok:true;operations:{displayName:string;email?:string;handle:string;roleSlug:\"admin\"|\"contributor\"|\"guest\"|\"member\"|\"superuser\"}&{idempotencyKey:string;index:number}[];schemaVersion:1;serverInstanceId:string;warnings:string[]}",
      "response.body:{code:any;index?:any}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "RolloutManifestV1"
      },
      {
        "path": "response.body.code",
        "schema": "RolloutPlanFailure.code"
      },
      {
        "path": "response.body.index",
        "schema": "RolloutPlanFailure.index"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.admin.users.rollout.rolloutid.acknowledge.608l1y",
    "locator": "http:request_response:POST /api/admin/users/rollout/:rolloutId/acknowledge",
    "structuralSignatures": [
      "request.body:{sequences?:unknown}",
      "request.params:{rolloutId:string}",
      "response.body:{code:string}",
      "response.body:{createdAt:string;fingerprint:string;items:{credentialDisposition:string;errorCode:string;handle:string;memberId:string;receiptId:string;roleSlug:string;sequence:number;state:string;updatedAt:string}[];ok:true;rolloutId:string;status:string;updatedAt:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.sequences",
        "schema": "RolloutCredentialSequenceList"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.admin.users.rollout.rolloutid.resume.d0mn9d",
    "locator": "http:request_response:POST /api/admin/users/rollout/:rolloutId/resume",
    "structuralSignatures": [
      "request.params:{rolloutId:string}",
      "response.body:{code:string}",
      "response.body:{createdAt:string;credentials:{handle:string;pin:string;recoveryCodes:string[];sequence:number;temporaryPassword:string}[];fingerprint:string;items:{credentialDisposition:string;errorCode:string;handle:string;memberId:string;receiptId:string;roleSlug:string;sequence:number;state:string;updatedAt:string}[];ok:true;rolloutId:string;status:string;updatedAt:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.invites.er8mei",
    "locator": "http:request_response:POST /api/invites",
    "structuralSignatures": [
      "request.body:{[key:string]:unknown}",
      "response.body:{error:string}",
      "response.body:{expiresAt:Date;id:string;kind:\"server\";maxUses:number;mutation:{auditRecorded:boolean;receiptId:string;recovery:{inviteId:string;kind:string}[];retrySafe:boolean;stateChanged:boolean};token:string;url:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.displayName",
        "debtId": "debt.wire.arbitrary.ijzyc1"
      },
      {
        "path": "request.body.expiresAt",
        "debtId": "debt.wire.arbitrary.1in7fsl"
      },
      {
        "path": "request.body.kind",
        "debtId": "debt.wire.arbitrary.gyxj5i"
      },
      {
        "path": "request.body.maxUses",
        "debtId": "debt.wire.arbitrary.3ipdwi"
      },
      {
        "path": "request.body.targetGroupRoleSlug",
        "debtId": "debt.wire.arbitrary.18hkmn3"
      },
      {
        "path": "request.body.targetRoomId",
        "debtId": "debt.wire.arbitrary.19cpw5b"
      }
    ]
  },
  {
    "observationId": "wire.sse.produced.get.api.workspace.artifacts.events.document.patch.applied.5ne1vk",
    "locator": "sse:produced:GET /api/workspace/artifacts/events#document.patch.applied",
    "structuralSignatures": [
      "event.payload:{author:{displayName:string;kind:\"agent\"|\"app_tool\"|\"human\"};clientMutationId?:string;patch:{kind:\"anchored_text\";newString:string;oldString:string;replaceAll?:boolean;scope?:{from:number;to:number}};patchId:string;previousRevision:number;previousSha256:string;rebased?:boolean;requestId?:string;revision:number;sha256:string;target:{artifactInternalId:string;kind:\"artifact\";mimeType?:string;path:string;roomId?:string}|{currentFolderRef:string;kind:\"currentFile\";relativePath:string;relayOwnerUserId?:string};type:\"document.patch.applied\"}"
    ],
    "arbitraryPayloads": []
  }
];

export const REVIEWED_MAIN_2026_08_13_SUPERSEDED_DTO_LOCATORS: ReadonlySet<string> = new Set([
  "app_bridge:host_to_app:nautilo.app.presentation.theme",
  "http:request_response:DELETE /api/admin/users/:id",
  "http:request_response:DELETE /api/invites/:id",
  "http:request_response:DELETE /api/mcp-servers/:name",
  "http:request_response:GET /api/admin/users",
  "http:request_response:GET /api/admin/users/rollout/:rolloutId",
  "http:request_response:GET /api/invites",
  "http:request_response:GET /api/security/audit-log",
  "http:request_response:GET /health",
  "http:request_response:GET /mobile/*",
  "http:request_response:GET /mobile/",
  "http:request_response:GET /mobile/favicon.ico",
  "http:request_response:GET /mobile",
  "http:request_response:POST /api/admin/users/:id/disable",
  "http:request_response:POST /api/admin/users/:id/enable",
  "http:request_response:POST /api/admin/users/:id/reset-password",
  "http:request_response:POST /api/admin/users/provision",
  "http:request_response:POST /api/admin/users/rollout/apply",
  "http:request_response:POST /api/admin/users/rollout/plan",
  "http:request_response:POST /api/admin/users/rollout/:rolloutId/acknowledge",
  "http:request_response:POST /api/admin/users/rollout/:rolloutId/resume",
  "http:request_response:POST /api/invites",
  "sse:produced:GET /api/workspace/artifacts/events#document.patch.applied"
]);

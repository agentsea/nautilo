import type { DtoDeclaration } from "../src/node/dto-inventory";

/** Exact DTO additions and superseding signatures reviewed after the 2026-08-11 main merge. */
export const REVIEWED_MAIN_2026_08_11_DTO_DECLARATIONS:
  readonly DtoDeclaration[] = [
  {
    "observationId": "wire.http.request.response.delete.api.codex.profiles.profileid.bda0i2",
    "locator": "http:request_response:DELETE /api/codex/profiles/:profileId",
    "structuralSignatures": [
      "request.params:{profileId:string}",
      "response.body:{code:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.delete.api.push.installations.bindingid.1oi4in2",
    "locator": "http:request_response:DELETE /api/push/installations/:bindingId",
    "structuralSignatures": [
      "request.params:{bindingId:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.delete.api.setup.owner.claim.vorsnf",
    "locator": "http:request_response:DELETE /api/setup/owner-claim",
    "structuralSignatures": [
      "response.body:{error:\"nothing-to-revoke\"|\"owner-bound\"|\"revoked\";schemaVersion:number}",
      "response.body:{error:string;schemaVersion:number}",
      "response.body:{schemaVersion:number;state:\"awaiting-owner\"|\"claim-active\"|\"owner-bound\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.acp.harnesses.1xrl9ox",
    "locator": "http:request_response:GET /api/acp/harnesses",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{harnesses:{declaredCapabilities:{execution:\"supported\"|\"unknown\"|\"unsupported\";requests:\"supported\"|\"unknown\"|\"unsupported\";resume:\"supported\"|\"unknown\"|\"unsupported\";steer:\"supported\"|\"unknown\"|\"unsupported\";stop:\"supported\"|\"unknown\"|\"unsupported\"};displayName:string;id:string;integration:{authentication:\"existing_session\"|\"interactive\"|\"none\";resume:\"new_session_only\"|\"resume_existing_session\"|\"runtime_decides\"};setup:{activation:\"automatic\"|\"user_initiated\";installation:\"manual\"|\"not_required\"|\"on_demand\"}}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.codex.18siw0x",
    "locator": "http:request_response:GET /api/codex",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{profiles:{accountEmail?:string;authState:\"error\"|\"expired\"|\"login_pending\"|\"signed_in\"|\"signed_out\";id:string;label:string;lastErrorCode?:string;planType?:string;rateLimits?:{credits?:{balance?:string;hasCredits:boolean;unlimited:boolean};freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;plan?:\"business\"|\"edu\"|\"enterprise\"|\"free\"|\"go\"|\"plus\"|\"pro\"|\"prolite\"|\"team\"|\"unknown\"|\"usage_based\";primary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};reached?:\"credits_depleted\"|\"rate_limit_reached\"|\"usage_limit_reached\";secondary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};spendControl?:{limit:string;remainingPercent:number;resetsAt:string;used:string}};revision:number;usage?:{daily:{startDate:string;tokens:string}[];freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;summary:{currentStreakDays?:string;lifetimeTokens?:string;longestRunningTurnSec?:string;longestStreakDays?:string;peakDailyTokens?:string}};usageObservedAt?:string}[];runtime:{available:boolean;collaborationModeAvailable:boolean;compatibilityDiagnostics?:{feature:\"approvals\"|\"collaboration_modes\"|\"core\"|\"request_user_input\"|\"steer\";reason:\"changed_field_shape\"|\"missing_field\"|\"missing_member\"}[];installation?:{canCancel:boolean;code?:\"CODEX_RUNTIME_ARTIFACT_INVALID\"|\"CODEX_RUNTIME_CANCELLED\"|\"CODEX_RUNTIME_EXECUTABLE_LIMIT\"|\"CODEX_RUNTIME_IDENTITY_CHANGED\"|\"CODEX_RUNTIME_INCOMPATIBLE\"|\"CODEX_RUNTIME_INSTALL_FAILED\"|\"CODEX_RUNTIME_NOT_EXECUTABLE\"|\"CODEX_RUNTIME_NOT_FOUND\"|\"CODEX_RUNTIME_OUTPUT_LIMIT\"|\"CODEX_RUNTIME_PATH_INVALID\"|\"CODEX_RUNTIME_PLATFORM_UNSUPPORTED\"|\"CODEX_RUNTIME_SCHEMA_INVALID\"|\"CODEX_RUNTIME_SIGNATURE_INVALID\"|\"CODEX_RUNTIME_STANDALONE_UNSUPPORTED\"|\"CODEX_RUNTIME_TIMEOUT\"|\"CODEX_RUNTIME_UNHEALTHY\"|\"CODEX_RUNTIME_VERSION_INVALID\"|\"CODEX_RUNTIME_WRONG_ARCHITECTURE\";phase:\"activating\"|\"cancelled\"|\"downloading\"|\"failed\"|\"ready\"|\"resolving\"|\"staging\"|\"verifying\";receivedBytes:number;totalBytes:number};runtimeGeneration?:number;source?:\"external\"|\"managed\";state:\"absent\"|\"draining\"|\"failed\"|\"incompatible\"|\"installing\"|\"limited\"|\"ready\"|\"unavailable\";version?:string}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.codex.preference.10fg6hn",
    "locator": "http:request_response:GET /api/codex/preference",
    "structuralSignatures": [
      "response.body:{enabled:boolean;posture:\"codex_default\"|\"full_access_headless\"|\"prompted_workspace\";profileId?:string;revision:number}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.codex.profiles.profileid.models.c2j1v6",
    "locator": "http:request_response:GET /api/codex/profiles/:profileId/models",
    "structuralSignatures": [
      "request.params:{profileId:string}",
      "response.body:{models:{description:string;displayName:string;id:string;isDefault:boolean;model:string}[]}&{preferredModelId:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.codex.profiles.profileid.rate.limits.w1cz7p",
    "locator": "http:request_response:GET /api/codex/profiles/:profileId/rate-limits",
    "structuralSignatures": [
      "request.params:{profileId:string}",
      "response.body:{credits:{balance:string;hasCredits:boolean;unlimited:boolean};freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;plan:\"business\"|\"edu\"|\"enterprise\"|\"free\"|\"go\"|\"plus\"|\"pro\"|\"prolite\"|\"team\"|\"unknown\"|\"usage_based\";primary:{resetsAt:string;usedPercent:number;windowDurationMins:number};reached:\"credits_depleted\"|\"rate_limit_reached\"|\"usage_limit_reached\";secondary:{resetsAt:string;usedPercent:number;windowDurationMins:number};spendControl:{limit:string;remainingPercent:number;resetsAt:string;used:string}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.codex.profiles.profileid.usage.1mbco3j",
    "locator": "http:request_response:GET /api/codex/profiles/:profileId/usage",
    "structuralSignatures": [
      "request.params:{profileId:string}",
      "response.body:{daily:{startDate:string;tokens:string}[];freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;summary:{currentStreakDays:string;lifetimeTokens:string;longestRunningTurnSec:string;longestStreakDays:string;peakDailyTokens:string}}"
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
      "response.body:{items:{availability:\"actionable\"|\"unavailable\";event:{expiresAt:string;jobId:string;ownerId:string;request:{autoResolutionMs?:number;kind:\"user_input_required\";questions:{allowOther:boolean;header:string;id:string;options?:object[];prompt:string;secret:boolean}[]};requestId:string;roomId:string;taskId:string;type:\"codex.request\"}}[];roomId:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.push.installations.bindingid.1xv9kt3",
    "locator": "http:request_response:GET /api/push/installations/:bindingId",
    "structuralSignatures": [
      "request.params:{bindingId:string}",
      "response.body:{bindingId:string;enabled:boolean;installationId:string;permission:\"denied\"|\"granted\"|\"undetermined\";platform:\"android\"|\"ios\";state:\"active\"|\"disabled\"|\"revoked\"|\"unavailable\";tokenGeneration:number;updatedAt:string;version:1}"
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
      "response.body:{conversations:{matchedBy:\"label\"|\"participant\";room:{createdAt:string;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;lastMessageAt?:string;memberCount:number;messageCount?:number;parentRoomId?:string;roster?:{actorId:string;agentId?:string;displayName:string;federatedId?:string;handle?:string;kind:\"agent\"|\"user\";userId?:string}[];threadRootMessageId?:number;type:string;unreadCount?:number}}[];conversationsTruncated:boolean;hasMoreOlderMessages:boolean;messageAsOf:{createdAt:string;messageId:string};messages:{authorActorId?:string;authorAgentId?:string;authorDisplayName?:string;authorHandle?:string;createdAt:string;messageId:string;parentRoomId?:string;parentRoomLabel?:string;role:string;roomId:string;roomKind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";roomLabel:string;snippet:string;sourceUserId?:string;toolName?:string}[];nextOlderMessageCursor:{createdAt:string;messageId:string}}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.setup.owner.claim.status.1e6edx1",
    "locator": "http:request_response:GET /api/setup/owner-claim/status",
    "structuralSignatures": [
      "response.body:{schemaVersion:number;state:\"awaiting-owner\"|\"claim-active\"|\"owner-bound\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.setup.research.provider.nvb2u9",
    "locator": "http:request_response:GET /api/setup/research-provider",
    "structuralSignatures": [
      "response.body:{desktopReaderAvailable:boolean;keylessSearchAvailable:boolean;provider:string;tavilyConfigured:boolean}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.skills.tool.options.1blkb1o",
    "locator": "http:request_response:GET /api/skills/tool-options",
    "structuralSignatures": [
      "response.body:{tools:{category:string;description:string;label:string;name:string}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.patch.api.codex.profiles.profileid.1js0vj9",
    "locator": "http:request_response:PATCH /api/codex/profiles/:profileId",
    "structuralSignatures": [
      "request.params:{profileId:string}",
      "response.body:{accountEmail?:string;authState:\"error\"|\"expired\"|\"login_pending\"|\"signed_in\"|\"signed_out\";id:string;label:string;lastErrorCode?:string;planType?:string;rateLimits?:{credits?:{balance?:string;hasCredits:boolean;unlimited:boolean};freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;plan?:\"business\"|\"edu\"|\"enterprise\"|\"free\"|\"go\"|\"plus\"|\"pro\"|\"prolite\"|\"team\"|\"unknown\"|\"usage_based\";primary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};reached?:\"credits_depleted\"|\"rate_limit_reached\"|\"usage_limit_reached\";secondary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};spendControl?:{limit:string;remainingPercent:number;resetsAt:string;used:string}};revision:number;usage?:{daily:{startDate:string;tokens:string}[];freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;summary:{currentStreakDays?:string;lifetimeTokens?:string;longestRunningTurnSec?:string;longestStreakDays?:string;peakDailyTokens?:string}};usageObservedAt?:string}",
      "response.body:{code:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.patch.api.push.installations.bindingid.1dqf2ll",
    "locator": "http:request_response:PATCH /api/push/installations/:bindingId",
    "structuralSignatures": [
      "request.params:{bindingId:string}",
      "response.body:{bindingId:string;enabled:boolean;installationId:string;permission:\"denied\"|\"granted\"|\"undetermined\";platform:\"android\"|\"ios\";state:\"active\"|\"disabled\"|\"revoked\"|\"unavailable\";tokenGeneration:number;updatedAt:string;version:1}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.acp.harnesses.harnessid.readiness.favo8s",
    "locator": "http:request_response:POST /api/acp/harnesses/:harnessId/readiness",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{harnessId:string}",
      "response.body:{action:string;state:\"authentication_required\"|\"incompatible\"|\"missing\"|\"ready\"|\"unavailable\"}",
      "response.body:{action:string;state:string}",
      "response.body:{code:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "HermesAcpReadinessRequestV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.codex.profiles.profileid.account.1urrxbx",
    "locator": "http:request_response:POST /api/codex/profiles/:profileId/account",
    "structuralSignatures": [
      "request.params:{profileId:string}",
      "response.body:{authState:\"error\"|\"expired\"|\"login_pending\"|\"signed_in\"|\"signed_out\";profile:{accountEmail?:string;authState:\"error\"|\"expired\"|\"login_pending\"|\"signed_in\"|\"signed_out\";id:string;label:string;lastErrorCode?:string;planType?:string;rateLimits?:{credits?:{balance?:string;hasCredits:boolean;unlimited:boolean};freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;plan?:\"business\"|\"edu\"|\"enterprise\"|\"free\"|\"go\"|\"plus\"|\"pro\"|\"prolite\"|\"team\"|\"unknown\"|\"usage_based\";primary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};reached?:\"credits_depleted\"|\"rate_limit_reached\"|\"usage_limit_reached\";secondary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};spendControl?:{limit:string;remainingPercent:number;resetsAt:string;used:string}};revision:number;usage?:{daily:{startDate:string;tokens:string}[];freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;summary:{currentStreakDays?:string;lifetimeTokens?:string;longestRunningTurnSec?:string;longestStreakDays?:string;peakDailyTokens?:string}};usageObservedAt?:string}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.codex.profiles.profileid.login.145rfw7",
    "locator": "http:request_response:POST /api/codex/profiles/:profileId/login",
    "structuralSignatures": [
      "request.params:{profileId:string}",
      "response.body:{loginRef:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.codex.profiles.profileid.login.cancel.f86poi",
    "locator": "http:request_response:POST /api/codex/profiles/:profileId/login/cancel",
    "structuralSignatures": [
      "request.params:{profileId:string}",
      "response.body:{authState:\"error\"|\"expired\"|\"login_pending\"|\"signed_in\"|\"signed_out\";profile:{accountEmail?:string;authState:\"error\"|\"expired\"|\"login_pending\"|\"signed_in\"|\"signed_out\";id:string;label:string;lastErrorCode?:string;planType?:string;rateLimits?:{credits?:{balance?:string;hasCredits:boolean;unlimited:boolean};freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;plan?:\"business\"|\"edu\"|\"enterprise\"|\"free\"|\"go\"|\"plus\"|\"pro\"|\"prolite\"|\"team\"|\"unknown\"|\"usage_based\";primary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};reached?:\"credits_depleted\"|\"rate_limit_reached\"|\"usage_limit_reached\";secondary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};spendControl?:{limit:string;remainingPercent:number;resetsAt:string;used:string}};revision:number;usage?:{daily:{startDate:string;tokens:string}[];freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;summary:{currentStreakDays?:string;lifetimeTokens?:string;longestRunningTurnSec?:string;longestStreakDays?:string;peakDailyTokens?:string}};usageObservedAt?:string}}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.codex.profiles.profileid.logout.19pi37g",
    "locator": "http:request_response:POST /api/codex/profiles/:profileId/logout",
    "structuralSignatures": [
      "request.params:{profileId:string}",
      "response.body:{authState:\"error\"|\"expired\"|\"login_pending\"|\"signed_in\"|\"signed_out\";profile:{accountEmail?:string;authState:\"error\"|\"expired\"|\"login_pending\"|\"signed_in\"|\"signed_out\";id:string;label:string;lastErrorCode?:string;planType?:string;rateLimits?:{credits?:{balance?:string;hasCredits:boolean;unlimited:boolean};freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;plan?:\"business\"|\"edu\"|\"enterprise\"|\"free\"|\"go\"|\"plus\"|\"pro\"|\"prolite\"|\"team\"|\"unknown\"|\"usage_based\";primary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};reached?:\"credits_depleted\"|\"rate_limit_reached\"|\"usage_limit_reached\";secondary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};spendControl?:{limit:string;remainingPercent:number;resetsAt:string;used:string}};revision:number;usage?:{daily:{startDate:string;tokens:string}[];freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;summary:{currentStreakDays?:string;lifetimeTokens?:string;longestRunningTurnSec?:string;longestStreakDays?:string;peakDailyTokens?:string}};usageObservedAt?:string}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.codex.profiles.xkpz32",
    "locator": "http:request_response:POST /api/codex/profiles",
    "structuralSignatures": [
      "response.body:{accountEmail?:string;authState:\"error\"|\"expired\"|\"login_pending\"|\"signed_in\"|\"signed_out\";id:string;label:string;lastErrorCode?:string;planType?:string;rateLimits?:{credits?:{balance?:string;hasCredits:boolean;unlimited:boolean};freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;plan?:\"business\"|\"edu\"|\"enterprise\"|\"free\"|\"go\"|\"plus\"|\"pro\"|\"prolite\"|\"team\"|\"unknown\"|\"usage_based\";primary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};reached?:\"credits_depleted\"|\"rate_limit_reached\"|\"usage_limit_reached\";secondary?:{resetsAt?:string;usedPercent:number;windowDurationMins?:number};spendControl?:{limit:string;remainingPercent:number;resetsAt:string;used:string}};revision:number;usage?:{daily:{startDate:string;tokens:string}[];freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;summary:{currentStreakDays?:string;lifetimeTokens?:string;longestRunningTurnSec?:string;longestStreakDays?:string;peakDailyTokens?:string}};usageObservedAt?:string}",
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
    "observationId": "wire.http.request.response.post.api.codex.runtime.activate.m17eoo",
    "locator": "http:request_response:POST /api/codex/runtime/activate",
    "structuralSignatures": [
      "response.body:{available:boolean;collaborationModeAvailable:boolean;compatibilityDiagnostics?:{feature:\"approvals\"|\"collaboration_modes\"|\"core\"|\"request_user_input\"|\"steer\";reason:\"changed_field_shape\"|\"missing_field\"|\"missing_member\"}[];installation?:{canCancel:boolean;code?:\"CODEX_RUNTIME_ARTIFACT_INVALID\"|\"CODEX_RUNTIME_CANCELLED\"|\"CODEX_RUNTIME_EXECUTABLE_LIMIT\"|\"CODEX_RUNTIME_IDENTITY_CHANGED\"|\"CODEX_RUNTIME_INCOMPATIBLE\"|\"CODEX_RUNTIME_INSTALL_FAILED\"|\"CODEX_RUNTIME_NOT_EXECUTABLE\"|\"CODEX_RUNTIME_NOT_FOUND\"|\"CODEX_RUNTIME_OUTPUT_LIMIT\"|\"CODEX_RUNTIME_PATH_INVALID\"|\"CODEX_RUNTIME_PLATFORM_UNSUPPORTED\"|\"CODEX_RUNTIME_SCHEMA_INVALID\"|\"CODEX_RUNTIME_SIGNATURE_INVALID\"|\"CODEX_RUNTIME_STANDALONE_UNSUPPORTED\"|\"CODEX_RUNTIME_TIMEOUT\"|\"CODEX_RUNTIME_UNHEALTHY\"|\"CODEX_RUNTIME_VERSION_INVALID\"|\"CODEX_RUNTIME_WRONG_ARCHITECTURE\";phase:\"activating\"|\"cancelled\"|\"downloading\"|\"failed\"|\"ready\"|\"resolving\"|\"staging\"|\"verifying\";receivedBytes:number;totalBytes:number};runtimeGeneration?:number;source?:\"external\"|\"managed\";state:\"absent\"|\"draining\"|\"failed\"|\"incompatible\"|\"installing\"|\"limited\"|\"ready\"|\"unavailable\";version?:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.codex.runtime.cancel.1kn9wvn",
    "locator": "http:request_response:POST /api/codex/runtime/cancel",
    "structuralSignatures": [
      "response.body:{available:boolean;collaborationModeAvailable:boolean;compatibilityDiagnostics?:{feature:\"approvals\"|\"collaboration_modes\"|\"core\"|\"request_user_input\"|\"steer\";reason:\"changed_field_shape\"|\"missing_field\"|\"missing_member\"}[];installation?:{canCancel:boolean;code?:\"CODEX_RUNTIME_ARTIFACT_INVALID\"|\"CODEX_RUNTIME_CANCELLED\"|\"CODEX_RUNTIME_EXECUTABLE_LIMIT\"|\"CODEX_RUNTIME_IDENTITY_CHANGED\"|\"CODEX_RUNTIME_INCOMPATIBLE\"|\"CODEX_RUNTIME_INSTALL_FAILED\"|\"CODEX_RUNTIME_NOT_EXECUTABLE\"|\"CODEX_RUNTIME_NOT_FOUND\"|\"CODEX_RUNTIME_OUTPUT_LIMIT\"|\"CODEX_RUNTIME_PATH_INVALID\"|\"CODEX_RUNTIME_PLATFORM_UNSUPPORTED\"|\"CODEX_RUNTIME_SCHEMA_INVALID\"|\"CODEX_RUNTIME_SIGNATURE_INVALID\"|\"CODEX_RUNTIME_STANDALONE_UNSUPPORTED\"|\"CODEX_RUNTIME_TIMEOUT\"|\"CODEX_RUNTIME_UNHEALTHY\"|\"CODEX_RUNTIME_VERSION_INVALID\"|\"CODEX_RUNTIME_WRONG_ARCHITECTURE\";phase:\"activating\"|\"cancelled\"|\"downloading\"|\"failed\"|\"ready\"|\"resolving\"|\"staging\"|\"verifying\";receivedBytes:number;totalBytes:number};runtimeGeneration?:number;source?:\"external\"|\"managed\";state:\"absent\"|\"draining\"|\"failed\"|\"incompatible\"|\"installing\"|\"limited\"|\"ready\"|\"unavailable\";version?:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.codex.runtime.inspect.7v6olb",
    "locator": "http:request_response:POST /api/codex/runtime/inspect",
    "structuralSignatures": [
      "response.body:{available:boolean;collaborationModeAvailable:boolean;compatibilityDiagnostics?:{feature:\"approvals\"|\"collaboration_modes\"|\"core\"|\"request_user_input\"|\"steer\";reason:\"changed_field_shape\"|\"missing_field\"|\"missing_member\"}[];installation?:{canCancel:boolean;code?:\"CODEX_RUNTIME_ARTIFACT_INVALID\"|\"CODEX_RUNTIME_CANCELLED\"|\"CODEX_RUNTIME_EXECUTABLE_LIMIT\"|\"CODEX_RUNTIME_IDENTITY_CHANGED\"|\"CODEX_RUNTIME_INCOMPATIBLE\"|\"CODEX_RUNTIME_INSTALL_FAILED\"|\"CODEX_RUNTIME_NOT_EXECUTABLE\"|\"CODEX_RUNTIME_NOT_FOUND\"|\"CODEX_RUNTIME_OUTPUT_LIMIT\"|\"CODEX_RUNTIME_PATH_INVALID\"|\"CODEX_RUNTIME_PLATFORM_UNSUPPORTED\"|\"CODEX_RUNTIME_SCHEMA_INVALID\"|\"CODEX_RUNTIME_SIGNATURE_INVALID\"|\"CODEX_RUNTIME_STANDALONE_UNSUPPORTED\"|\"CODEX_RUNTIME_TIMEOUT\"|\"CODEX_RUNTIME_UNHEALTHY\"|\"CODEX_RUNTIME_VERSION_INVALID\"|\"CODEX_RUNTIME_WRONG_ARCHITECTURE\";phase:\"activating\"|\"cancelled\"|\"downloading\"|\"failed\"|\"ready\"|\"resolving\"|\"staging\"|\"verifying\";receivedBytes:number;totalBytes:number};runtimeGeneration?:number;source?:\"external\"|\"managed\";state:\"absent\"|\"draining\"|\"failed\"|\"incompatible\"|\"installing\"|\"limited\"|\"ready\"|\"unavailable\";version?:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.codex.runtime.install.v3id3c",
    "locator": "http:request_response:POST /api/codex/runtime/install",
    "structuralSignatures": [
      "response.body:{available:boolean;collaborationModeAvailable:boolean;compatibilityDiagnostics?:{feature:\"approvals\"|\"collaboration_modes\"|\"core\"|\"request_user_input\"|\"steer\";reason:\"changed_field_shape\"|\"missing_field\"|\"missing_member\"}[];installation?:{canCancel:boolean;code?:\"CODEX_RUNTIME_ARTIFACT_INVALID\"|\"CODEX_RUNTIME_CANCELLED\"|\"CODEX_RUNTIME_EXECUTABLE_LIMIT\"|\"CODEX_RUNTIME_IDENTITY_CHANGED\"|\"CODEX_RUNTIME_INCOMPATIBLE\"|\"CODEX_RUNTIME_INSTALL_FAILED\"|\"CODEX_RUNTIME_NOT_EXECUTABLE\"|\"CODEX_RUNTIME_NOT_FOUND\"|\"CODEX_RUNTIME_OUTPUT_LIMIT\"|\"CODEX_RUNTIME_PATH_INVALID\"|\"CODEX_RUNTIME_PLATFORM_UNSUPPORTED\"|\"CODEX_RUNTIME_SCHEMA_INVALID\"|\"CODEX_RUNTIME_SIGNATURE_INVALID\"|\"CODEX_RUNTIME_STANDALONE_UNSUPPORTED\"|\"CODEX_RUNTIME_TIMEOUT\"|\"CODEX_RUNTIME_UNHEALTHY\"|\"CODEX_RUNTIME_VERSION_INVALID\"|\"CODEX_RUNTIME_WRONG_ARCHITECTURE\";phase:\"activating\"|\"cancelled\"|\"downloading\"|\"failed\"|\"ready\"|\"resolving\"|\"staging\"|\"verifying\";receivedBytes:number;totalBytes:number};runtimeGeneration?:number;source?:\"external\"|\"managed\";state:\"absent\"|\"draining\"|\"failed\"|\"incompatible\"|\"installing\"|\"limited\"|\"ready\"|\"unavailable\";version?:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.mcp.servers.name.check.frtdw0",
    "locator": "http:request_response:POST /api/mcp-servers/:name/check",
    "structuralSignatures": [
      "request.params:{name:string}",
      "response.body:any",
      "response.body:object",
      "response.body:{check:{failureCode:string;missingEnvironment:string[];status:\"connected\"|\"failed\"|\"needs_attention\"|\"ready\"};server:{createdAt:Date;enabled:boolean;envPassthrough:string[];excludeTools:string[];health:\"circuit-open\"|\"connected\"|\"disconnected\"|\"error\"|\"unknown\";host:string;id:string;includeTools:string[];lastCheckFailureCode:string;lastCheckMissingEnvironment:string[];lastCheckStatus:string;lastCheckedAt:Date;lastConnectedAt:Date;name:string;namespaceId:string;toolCount:number;transport:unknown;transportKind:string;trustTier:string;updatedAt:Date}}",
      "response.body:{error:string;name:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body",
        "schema": "McpConnectionCheckRouteResponseV1"
      },
      {
        "path": "response.body.server.transport",
        "schema": "McpTransportConfigV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.owner.claim.complete.profile.1jtkapc",
    "locator": "http:request_response:POST /api/owner-claim/complete-profile",
    "structuralSignatures": [
      "request.body:{claim?:unknown;displayName?:unknown;pin?:unknown}",
      "response.body:unknown",
      "response.body:{code:any;error:any}",
      "response.body:{error:string}",
      "response.body:{landingRoomId:string;ok:boolean;recoveryCodes:string[]}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.claim",
        "schema": "BootstrapOwnerClaimTokenV1"
      },
      {
        "path": "request.body.displayName",
        "schema": "OwnerDisplayNameV1"
      },
      {
        "path": "request.body.pin",
        "schema": "OwnerPinV1"
      },
      {
        "path": "response.body",
        "schema": "OwnerClaimRouteResponseV1"
      },
      {
        "path": "response.body.code",
        "schema": "OwnerClaimFailureCodeV1"
      },
      {
        "path": "response.body.error",
        "schema": "OwnerClaimFailureCodeV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.owner.claim.prepare.auth.1gmbf5f",
    "locator": "http:request_response:POST /api/owner-claim/prepare-auth",
    "structuralSignatures": [
      "request.body:{claim?:unknown;handle?:unknown}",
      "response.body:unknown",
      "response.body:{code:string;error:string}",
      "response.body:{continuation:string;handle:string;state:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.claim",
        "schema": "BootstrapOwnerClaimTokenV1"
      },
      {
        "path": "request.body.handle",
        "schema": "NormalizedOwnerHandleV1"
      },
      {
        "path": "response.body",
        "schema": "OwnerClaimRouteResponseV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.owner.claim.prepare.logto.signup.1p1bkjv",
    "locator": "http:request_response:POST /api/owner-claim/prepare-logto-signup",
    "structuralSignatures": [
      "request.body:{claim?:unknown;handle?:unknown}",
      "response.body:unknown",
      "response.body:{code:string;error:string}",
      "response.body:{error:string}",
      "response.body:{handle:string;state:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.claim",
        "schema": "BootstrapOwnerClaimTokenV1"
      },
      {
        "path": "request.body.handle",
        "schema": "NormalizedOwnerHandleV1"
      },
      {
        "path": "response.body",
        "schema": "OwnerClaimRouteResponseV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.owner.claim.preview.pzr2bx",
    "locator": "http:request_response:POST /api/owner-claim/preview",
    "structuralSignatures": [
      "request.body:{claim?:unknown}",
      "response.body:unknown",
      "response.body:{code:string;error:string}",
      "response.body:{continuation:\"new-owner\"|\"resume-owner\";expiresAt:Date;inviterHandle:string;kind:string;usesRemaining:number}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.claim",
        "schema": "BootstrapOwnerClaimTokenV1"
      },
      {
        "path": "response.body",
        "schema": "OwnerClaimRouteResponseV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.push.installations.bindingid.revoke.19g6ak",
    "locator": "http:request_response:POST /api/push/installations/:bindingId/revoke",
    "structuralSignatures": [
      "request.params:{bindingId:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.push.installations.bindingid.test.165vsc6",
    "locator": "http:request_response:POST /api/push/installations/:bindingId/test",
    "structuralSignatures": [
      "request.params:{bindingId:string}",
      "response.body:{accepted:boolean;notificationId:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.push.installations.q0e0z6",
    "locator": "http:request_response:POST /api/push/installations",
    "structuralSignatures": [
      "response.body:{bindingId:string;enabled:boolean;installationId:string;permission:\"denied\"|\"granted\"|\"undetermined\";platform:\"android\"|\"ios\";state:\"active\"|\"disabled\"|\"revoked\"|\"unavailable\";tokenGeneration:number;updatedAt:string;version:1}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.setup.owner.claim.redeem.t9yc7t",
    "locator": "http:request_response:POST /api/setup/owner-claim/redeem",
    "structuralSignatures": [
      "response.body:unknown",
      "response.body:{code:any;error:any;message?:any;schemaVersion:number}",
      "response.body:{error:string;schemaVersion:number}",
      "response.body:{recoveryCodes:string[];schemaVersion:number;state:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body",
        "schema": "OwnerClaimRouteResponseV1"
      },
      {
        "path": "response.body.code",
        "schema": "OwnerClaimFailureCodeV1"
      },
      {
        "path": "response.body.error",
        "schema": "OwnerClaimFailureCodeV1"
      },
      {
        "path": "response.body.message",
        "schema": "OwnerClaimFailureMessageV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.put.api.codex.preference.1iq0blm",
    "locator": "http:request_response:PUT /api/codex/preference",
    "structuralSignatures": [
      "response.body:{enabled:boolean;posture:\"codex_default\"|\"full_access_headless\"|\"prompted_workspace\";profileId?:string;revision:number}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.put.api.setup.owner.claim.kwy98d",
    "locator": "http:request_response:PUT /api/setup/owner-claim",
    "structuralSignatures": [
      "response.body:{error:\"already-installed\"|\"expired-claim\"|\"installed\"|\"invalid-claim\"|\"owner-bound\";schemaVersion:number}",
      "response.body:{error:string;schemaVersion:number}",
      "response.body:{schemaVersion:number;state:\"awaiting-owner\"|\"claim-active\"|\"owner-bound\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.put.api.setup.research.provider.2u0o2y",
    "locator": "http:request_response:PUT /api/setup/research-provider",
    "structuralSignatures": [
      "response.body:{desktopReaderAvailable:boolean;keylessSearchAvailable:boolean;provider:\"auto\"|\"duckduckgo_html\";tavilyConfigured:boolean}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.relay.client.to.server.arbitrary.packages.relay.src.protocol.ts.relaysshpreparedmessage.1cnz4hs",
    "locator": "relay:client_to_server_arbitrary:packages/relay/src/protocol.ts#RelaySshPreparedMessage",
    "structuralSignatures": [
      "declaration.payload:{errorCode:\"capability_disabled\"|\"capability_unavailable\"|\"config_destination_mismatch\"|\"config_output_invalid\"|\"config_required_value_missing\"|\"config_unsafe_directive\"|\"config_value_invalid\"|\"connection_ambiguous\"|\"connection_catalog_malformed\"|\"connection_catalog_overflow\"|\"connection_catalog_unavailable\"|\"connection_catalog_unreadable\"|\"connection_not_found\"|\"connection_source_drift\"|\"destination_unavailable\"|\"host_key_ambiguous\"|\"host_key_changed\"|\"host_key_missing\"|\"invalid_destination\"|\"invalid_host\"|\"invalid_port\"|\"invalid_remote_user\"|\"invalid_request\"|\"lookup_aborted\"|\"lookup_failed\"|\"lookup_invalid_request\"|\"lookup_output_invalid\"|\"lookup_output_limited\"|\"lookup_timed_out\"|\"observer_unavailable\"|\"openssh_connection_catalog_malformed\"|\"openssh_connection_catalog_overflow\"|\"openssh_connection_catalog_unreadable\"|\"openssh_connection_catalog_unsupported_match\"|\"openssh_connection_catalog_unsupported_source\"|\"preparation_unavailable\"|\"prepare_unavailable\"|\"remote_user_missing\"|\"resolve_aborted\"|\"resolve_failed\"|\"resolve_output_limited\"|\"resolve_spawn_failed\"|\"resolve_timed_out\"|\"scan_aborted\"|\"scan_failed\"|\"scan_invalid_request\"|\"scan_output_limited\"|\"scan_timed_out\"|\"scanner_output_invalid\"|\"tool_disabled\"|\"topology_mismatch\"|\"trust_store_corrupt\"|\"trust_store_instance_mismatch\"|\"trust_store_unavailable\"|\"trust_unavailable\";failure?:undefined|{candidates?:undefined|{name:string;source:\"nautilo-profile\"|\"openssh\"}[];code:unresolved<Exclude>;completeness?:false|undefined;configuredBounds?:undefined|{bytes?:number;files?:number;includeDepth?:number;records?:number};observed?:undefined|{bytes:number;files:number;records:number};phase:\"catalog\"|\"dispatch_reresolve\"|\"host_key_scan\"|\"intent\"|\"known_hosts_lookup\"|\"parse\"|\"policy\"|\"resolve\"|\"trust_store_lookup\";recovery:\"choose_connection\"|\"correct_destination\"|\"provide_remote_user\"|\"reduce_connection_catalog\"|\"repair_connection_source\"|\"retry\";retrySafe:true;sideEffectStarted:false;source?:\"nautilo-profile\"|\"openssh\"|undefined;stateChanged:false};requestId:string;status:\"error\";type:\"relay:ssh-prepared\"}|{requestId:string;response:{approval:{host:string;hostKeyFingerprint:string;hostTrust:\"changed\"|\"trusted\"|\"unknown\";operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";port:number;previousHostKeyFingerprint?:string|undefined;remoteUser:string;requestedDestination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string}};approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";preparationId:string;requestId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_PREPARE_VERSION};status:\"ok\";type:\"relay:ssh-prepared\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "failure.code",
        "schema": "RelaySshResolutionFailureCodeV1"
      }
    ]
  },
  {
    "observationId": "wire.relay.client.to.server.relay.codex.event.15gehcy",
    "locator": "relay:client_to_server:relay:codex-event",
    "structuralSignatures": [
      "frame.payload:{event:unresolved<Extract>;eventSequence:number;scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number}&{childGeneration:number}&{bindingGeneration:number;bindingId:string;jobId:string;taskId:string;threadId:string}&{workspace:{expiresAt:string;fingerprint:string;issuedAt:string;revision:number;workspaceRef:string}}&{turnId:string}&{eventId:string}&{itemId:string};type:\"relay:codex-event\"}|{event:unresolved<Extract>;eventSequence:number;scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number}&{childGeneration:number}&{bindingGeneration:number;bindingId:string;jobId:string;taskId:string;threadId:string}&{workspace:{expiresAt:string;fingerprint:string;issuedAt:string;revision:number;workspaceRef:string}}&{turnId:string}&{eventId:string};type:\"relay:codex-event\"}|{event:unresolved<Extract>;eventSequence:number;scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number}&{childGeneration:number}&{eventId:string};type:\"relay:codex-event\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "event",
        "schema": "CodexAppServerEventV1"
      }
    ]
  },
  {
    "observationId": "wire.relay.client.to.server.relay.codex.request.15vhbkr",
    "locator": "relay:client_to_server:relay:codex-request",
    "structuralSignatures": [
      "frame.payload:{request:{autoResolutionMs:null|number;expiresAt:string;kind:\"user_input\";questions:{header:string;id:string;isOther:boolean;isSecret:boolean;options:null|{description:string;id:string;label:string}[];question:string}[]};scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number}&{childGeneration:number}&{bindingGeneration:number;bindingId:string;jobId:string;taskId:string;threadId:string}&{workspace:{expiresAt:string;fingerprint:string;issuedAt:string;revision:number;workspaceRef:string}}&{turnId:string}&{eventId:string}&{itemId:string}&{requestRef:string};type:\"relay:codex-request\"}|{request:{choices:\"accept\"|\"acceptForSession\"|\"cancel\"|\"decline\"[];command:{actionKinds:\"list_files\"|\"read\"|\"search\"|\"unknown\"[];detail:\"host_local_only\"|\"not_provided\"};expiresAt:string;kind:\"command_approval\";reason:\"host_local_only\"|\"not_provided\"};scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number}&{childGeneration:number}&{bindingGeneration:number;bindingId:string;jobId:string;taskId:string;threadId:string}&{workspace:{expiresAt:string;fingerprint:string;issuedAt:string;revision:number;workspaceRef:string}}&{turnId:string}&{eventId:string}&{itemId:string}&{requestRef:string};type:\"relay:codex-request\"}|{request:{choices:\"accept\"|\"acceptForSession\"|\"cancel\"|\"decline\"[];expiresAt:string;grantRoot:\"host_local_only\"|\"not_provided\";kind:\"file_change_approval\";reason:\"host_local_only\"|\"not_provided\"};scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number}&{childGeneration:number}&{bindingGeneration:number;bindingId:string;jobId:string;taskId:string;threadId:string}&{workspace:{expiresAt:string;fingerprint:string;issuedAt:string;revision:number;workspaceRef:string}}&{turnId:string}&{eventId:string}&{itemId:string}&{requestRef:string};type:\"relay:codex-request\"}|{request:{choices:\"accept\"|\"acceptForSession\"|\"cancel\"|\"decline\"[];expiresAt:string;kind:\"network_approval\";network:{host:string;protocol:\"http\"|\"https\"|\"socks5Tcp\"|\"socks5Udp\"};reason:\"host_local_only\"|\"not_provided\"};scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number}&{childGeneration:number}&{bindingGeneration:number;bindingId:string;jobId:string;taskId:string;threadId:string}&{workspace:{expiresAt:string;fingerprint:string;issuedAt:string;revision:number;workspaceRef:string}}&{turnId:string}&{eventId:string}&{itemId:string}&{requestRef:string};type:\"relay:codex-request\"}|{request:{expiresAt:string;kind:\"permissions_approval\";permissions:{fileSystem:null|{entryCount:number;pathDetail:\"host_local_only\"|\"not_provided\";readPathCount:number;writePathCount:number};network:null|{enabled:boolean|null}};reason:\"host_local_only\"|\"not_provided\"};scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number}&{childGeneration:number}&{bindingGeneration:number;bindingId:string;jobId:string;taskId:string;threadId:string}&{workspace:{expiresAt:string;fingerprint:string;issuedAt:string;revision:number;workspaceRef:string}}&{turnId:string}&{eventId:string}&{itemId:string}&{requestRef:string};type:\"relay:codex-request\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.relay.client.to.server.relay.codex.status.ejxdug",
    "locator": "relay:client_to_server:relay:codex-status",
    "structuralSignatures": [
      "frame.payload:{capabilityRevision:number;socket:{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number};status:{compatibility?:\"certified\"|\"compatible_uncertified\"|\"incompatible\"|\"limited\";features?:{codexApprovals:boolean;collaborationMode?:boolean;explicitSteer:boolean;requestUserInput:boolean;stableConversation:boolean};profiles?:{accountGeneration:number;childGeneration?:number;profileGeneration:number;profileHandle:string;rateLimits?:{credits:null|{balance:null|string;hasCredits:boolean;unlimited:boolean};freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;plan:\"business\"|\"edu\"|\"enterprise\"|\"free\"|\"go\"|\"plus\"|\"pro\"|\"prolite\"|\"team\"|\"unknown\"|\"usage_based\"|null;primary:null|{resetsAt:null|string;usedPercent:number;windowDurationMins:null|number};reached:\"credits_depleted\"|\"rate_limit_reached\"|\"usage_limit_reached\"|null;secondary:null|{resetsAt:null|string;usedPercent:number;windowDurationMins:null|number};spendControl:null|{limit:string;remainingPercent:number;resetsAt:string;used:string}};state:\"busy\"|\"draining\"|\"reauth_required\"|\"signed_in\"|\"signed_out\";usage?:{daily:{startDate:string;tokens:string}[];freshness:\"cached\"|\"live\"|\"stale\";observedAt:string;summary:{currentStreakDays:null|string;lifetimeTokens:null|string;longestRunningTurnSec:null|string;longestStreakDays:null|string;peakDailyTokens:null|string}}}[];runtime?:{compatibilityDiagnostics?:{feature:\"approvals\"|\"collaboration_modes\"|\"core\"|\"request_user_input\"|\"steer\";reason:\"changed_field_shape\"|\"missing_field\"|\"missing_member\"}[];installRef?:string;installation?:{canCancel:boolean;code?:\"CODEX_RUNTIME_ARTIFACT_INVALID\"|\"CODEX_RUNTIME_CANCELLED\"|\"CODEX_RUNTIME_EXECUTABLE_LIMIT\"|\"CODEX_RUNTIME_IDENTITY_CHANGED\"|\"CODEX_RUNTIME_INCOMPATIBLE\"|\"CODEX_RUNTIME_INSTALL_FAILED\"|\"CODEX_RUNTIME_NOT_EXECUTABLE\"|\"CODEX_RUNTIME_NOT_FOUND\"|\"CODEX_RUNTIME_OUTPUT_LIMIT\"|\"CODEX_RUNTIME_PATH_INVALID\"|\"CODEX_RUNTIME_PLATFORM_UNSUPPORTED\"|\"CODEX_RUNTIME_SCHEMA_INVALID\"|\"CODEX_RUNTIME_SIGNATURE_INVALID\"|\"CODEX_RUNTIME_STANDALONE_UNSUPPORTED\"|\"CODEX_RUNTIME_TIMEOUT\"|\"CODEX_RUNTIME_UNHEALTHY\"|\"CODEX_RUNTIME_VERSION_INVALID\"|\"CODEX_RUNTIME_WRONG_ARCHITECTURE\";phase:\"absent\"|\"activating\"|\"cancelled\"|\"downloading\"|\"failed\"|\"ready\"|\"resolving\"|\"rollback\"|\"staging\"|\"verifying\";receivedBytes:number;totalBytes:number};source?:\"external\"|\"managed\";state:\"absent\"|\"draining\"|\"failed\"|\"incompatible\"|\"installing\"|\"ready\";version?:string};runtimeGeneration?:number;state:\"limited\"|\"ready\"|\"runtime_incompatible\"|\"runtime_unavailable\"|\"supervisor_unavailable\"|\"workspace_unavailable\";workspace:{receipt:{expiresAt:string;fingerprint:string;issuedAt:string;revision:number;workspaceRef:string};state:\"bound\"}|{state:\"stale\"|\"unavailable\"}};type:\"relay:codex-status\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.relay.client.to.server.relay.mcp.configure.result.1wnwpjd",
    "locator": "relay:client_to_server:relay:mcp-configure-result",
    "structuralSignatures": [
      "frame.payload:{digest:string;failure?:undefined|{code:\"discovery_timeout\"|\"empty_toolset\"|\"internal\"|\"invalid_request\"|\"missing_environment\"|\"missing_launcher\"|\"protocol_failed\"|\"spawn_failed\"};operationId:string;state:\"connected\"|\"failed\"|\"stopped\";targetName:string;toolNames:string[];type:\"relay:mcp-configure-result\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.relay.client.to.server.relay.mcp.preflight.result.1yzxsp8",
    "locator": "relay:client_to_server:relay:mcp-preflight-result",
    "structuralSignatures": [
      "frame.payload:{digest:string;environment:{name:string;present:boolean}[];failure?:undefined|{code:\"discovery_timeout\"|\"empty_toolset\"|\"internal\"|\"invalid_request\"|\"missing_environment\"|\"missing_launcher\"|\"protocol_failed\"|\"spawn_failed\"};launcher:\"missing\"|\"not-applicable\"|\"present\";machineLabel:string;requestId:string;status:\"blocked\"|\"ready\";targetName:string;type:\"relay:mcp-preflight-result\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.relay.client.to.server.relay.run.shell.progress.1i2kufy",
    "locator": "relay:client_to_server:relay:run-shell-progress",
    "structuralSignatures": [
      "frame.payload:{correlationId:string;droppedBytes?:number|undefined;elapsedMs:number;endOffsetBytes:number;offsetBytes:number;phase:\"running\";sequence:number;stream:\"stderr\"|\"stdout\";text:string;type:\"relay:run-shell-progress\";version:1}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.relay.client.to.server.relay.ssh.prepared.1jjevl4",
    "locator": "relay:client_to_server:relay:ssh-prepared",
    "structuralSignatures": [
      "frame.payload:{errorCode:\"capability_disabled\"|\"capability_unavailable\"|\"config_destination_mismatch\"|\"config_output_invalid\"|\"config_required_value_missing\"|\"config_unsafe_directive\"|\"config_value_invalid\"|\"connection_ambiguous\"|\"connection_catalog_malformed\"|\"connection_catalog_overflow\"|\"connection_catalog_unavailable\"|\"connection_catalog_unreadable\"|\"connection_not_found\"|\"connection_source_drift\"|\"destination_unavailable\"|\"host_key_ambiguous\"|\"host_key_changed\"|\"host_key_missing\"|\"invalid_destination\"|\"invalid_host\"|\"invalid_port\"|\"invalid_remote_user\"|\"invalid_request\"|\"lookup_aborted\"|\"lookup_failed\"|\"lookup_invalid_request\"|\"lookup_output_invalid\"|\"lookup_output_limited\"|\"lookup_timed_out\"|\"observer_unavailable\"|\"openssh_connection_catalog_malformed\"|\"openssh_connection_catalog_overflow\"|\"openssh_connection_catalog_unreadable\"|\"openssh_connection_catalog_unsupported_match\"|\"openssh_connection_catalog_unsupported_source\"|\"preparation_unavailable\"|\"prepare_unavailable\"|\"remote_user_missing\"|\"resolve_aborted\"|\"resolve_failed\"|\"resolve_output_limited\"|\"resolve_spawn_failed\"|\"resolve_timed_out\"|\"scan_aborted\"|\"scan_failed\"|\"scan_invalid_request\"|\"scan_output_limited\"|\"scan_timed_out\"|\"scanner_output_invalid\"|\"tool_disabled\"|\"topology_mismatch\"|\"trust_store_corrupt\"|\"trust_store_instance_mismatch\"|\"trust_store_unavailable\"|\"trust_unavailable\";failure?:undefined|{candidates?:undefined|{name:string;source:\"nautilo-profile\"|\"openssh\"}[];code:unresolved<Exclude>;completeness?:false|undefined;configuredBounds?:undefined|{bytes?:number;files?:number;includeDepth?:number;records?:number};observed?:undefined|{bytes:number;files:number;records:number};phase:\"catalog\"|\"dispatch_reresolve\"|\"host_key_scan\"|\"intent\"|\"known_hosts_lookup\"|\"parse\"|\"policy\"|\"resolve\"|\"trust_store_lookup\";recovery:\"choose_connection\"|\"correct_destination\"|\"provide_remote_user\"|\"reduce_connection_catalog\"|\"repair_connection_source\"|\"retry\";retrySafe:true;sideEffectStarted:false;source?:\"nautilo-profile\"|\"openssh\"|undefined;stateChanged:false};requestId:string;status:\"error\";type:\"relay:ssh-prepared\"}|{requestId:string;response:{approval:{host:string;hostKeyFingerprint:string;hostTrust:\"changed\"|\"trusted\"|\"unknown\";operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";port:number;previousHostKeyFingerprint?:string|undefined;remoteUser:string;requestedDestination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string}};approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";preparationId:string;requestId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_PREPARE_VERSION};status:\"ok\";type:\"relay:ssh-prepared\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "failure.code",
        "schema": "RelaySshResolutionFailureCodeV1"
      }
    ]
  },
  {
    "observationId": "wire.relay.client.to.server.relay.structured.ssh.progress.z8frf4",
    "locator": "relay:client_to_server:relay:structured-ssh-progress",
    "structuralSignatures": [
      "frame.payload:{correlationId:string;droppedBytes?:number|undefined;elapsedMs:number;endOffsetBytes:number;kind:\"exec-output\";offsetBytes:number;operation:\"exec\";phase:\"running\";sequence:number;stream:\"stderr\"|\"stdout\";text:string;type:\"relay:structured-ssh-progress\";version:1}|{correlationId:string;elapsedMs:number;kind:\"transfer\";operation:\"copy-download\"|\"copy-upload\";phase:\"starting\"|\"transferring\";sequence:number;totalBytes?:number|undefined;transferredBytes:number;type:\"relay:structured-ssh-progress\";version:1}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.relay.declared.arbitrary.packages.relay.src.protocol.ts.relaysshresolutionfailure.koqsk1",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelaySshResolutionFailure",
    "structuralSignatures": [
      "declaration.payload:{candidates?:undefined|{name:string;source:\"nautilo-profile\"|\"openssh\"}[];code:unresolved<Exclude>;completeness?:false|undefined;configuredBounds?:undefined|{bytes?:number;files?:number;includeDepth?:number;records?:number};observed?:undefined|{bytes:number;files:number;records:number};phase:\"catalog\"|\"dispatch_reresolve\"|\"host_key_scan\"|\"intent\"|\"known_hosts_lookup\"|\"parse\"|\"policy\"|\"resolve\"|\"trust_store_lookup\";recovery:\"choose_connection\"|\"correct_destination\"|\"provide_remote_user\"|\"reduce_connection_catalog\"|\"repair_connection_source\"|\"retry\";retrySafe:true;sideEffectStarted:false;source?:\"nautilo-profile\"|\"openssh\"|undefined;stateChanged:false}"
    ],
    "arbitraryPayloads": [
      {
        "path": "code",
        "schema": "RelaySshResolutionFailureCodeV1"
      }
    ]
  },
  {
    "observationId": "wire.relay.server.to.client.arbitrary.packages.relay.src.protocol.ts.relaymcppreflightmessage.1fd65bs",
    "locator": "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayMcpPreflightMessage",
    "structuralSignatures": [
      "declaration.payload:{digest:string;requestId:string;server:{envPassthrough?:null|string[]|undefined;excludeTools?:null|string[]|undefined;includeTools?:null|string[]|undefined;name:string;namespaceId?:null|string|undefined;transport:{[key:string]:unknown};transportKind:\"sse-legacy\"|\"stdio\"|\"streamable-http\";trustTier?:null|string|undefined};type:\"relay:mcp-preflight\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "server.transport",
        "schema": "McpTransportConfigV1"
      }
    ]
  },
  {
    "observationId": "wire.relay.server.to.client.relay.codex.cancel.s7vdt0",
    "locator": "relay:server_to_client:relay:codex-cancel",
    "structuralSignatures": [
      "frame.payload:{reason:\"deadline\"|\"generation_replaced\"|\"job_stop\"|\"profile_removed\"|\"relay_disconnect\";scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number}&{childGeneration:number}&{bindingGeneration:number;bindingId:string;jobId:string;taskId:string;threadId:string}&{workspace:{expiresAt:string;fingerprint:string;issuedAt:string;revision:number;workspaceRef:string}}&{turnId:string};type:\"relay:codex-cancel\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.relay.server.to.client.relay.codex.command.1qiyian",
    "locator": "relay:server_to_client:relay:codex-command",
    "structuralSignatures": [
      "frame.payload:{command:{actorRef:string;kind:\"steer_turn\";userText:string}|{kind:\"interrupt_turn\";reason:\"deadline\"|\"drain\"|\"user_stop\"};commandId:string;scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number}&{childGeneration:number}&{bindingGeneration:number;bindingId:string;jobId:string;taskId:string;threadId:string}&{workspace:{expiresAt:string;fingerprint:string;issuedAt:string;revision:number;workspaceRef:string}}&{turnId:string};type:\"relay:codex-command\"}|{command:{artifactRef:string;kind:\"runtime_install\"}|{installRef:string;kind:\"runtime_cancel_install\"}|{kind:\"runtime_activate\";runtimeGeneration:number}|{kind:\"runtime_inspect\"}|{kind:\"runtime_remove\";runtimeGeneration:number}|{kind:\"runtime_rollback\"}|{kind:\"profile_create\";profileGeneration:number;profileHandle:string};commandId:string;scope:{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number};type:\"relay:codex-command\"}|{command:{collaborationMode?:\"plan\";kind:\"start_turn\";turnInputRef:string;userText:string}|{kind:\"release_binding\"}|{kind:\"resume_binding\"};commandId:string;scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number}&{childGeneration:number}&{bindingGeneration:number;bindingId:string;jobId:string;taskId:string;threadId:string}&{workspace:{expiresAt:string;fingerprint:string;issuedAt:string;revision:number;workspaceRef:string}};type:\"relay:codex-command\"}|{command:{deadlineAt:string;kind:\"drain_profile\"}|{kind:\"terminate_child\";reason:\"host_shutdown\"|\"interrupt_escalation\"};commandId:string;scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number}&{childGeneration:number};type:\"relay:codex-command\"}|{command:{kind:\"account_login_cancel\";loginRef:string}|{kind:\"account_login_start\"}|{kind:\"account_logout\"}|{kind:\"account_rate_limits_read\"}|{kind:\"account_read\"}|{kind:\"account_usage_read\"}|{kind:\"model_list\"};commandId:string;scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number}&{childGeneration:number};type:\"relay:codex-command\"}|{command:{kind:\"ensure_profile_child\";posture:{anchorMode:\"danger-full-access\";approvalPolicy:\"never\";kind:\"full_access_headless\"}|{anchorMode:\"default\";kind:\"codex_default\"}|{anchorMode:\"workspace-write\";approvalPolicy:\"on-request\";kind:\"prompted_workspace\"}};commandId:string;scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number};type:\"relay:codex-command\"}|{command:{kind:\"open_binding\";model?:string;posture:{anchorMode:\"danger-full-access\";approvalPolicy:\"never\";kind:\"full_access_headless\"}|{anchorMode:\"default\";kind:\"codex_default\"}|{anchorMode:\"workspace-write\";approvalPolicy:\"on-request\";kind:\"prompted_workspace\"};workingDirectory?:string};commandId:string;scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number}&{childGeneration:number}&{bindingGeneration:number;bindingId:string;jobId:string;taskId:string;workspace:{expiresAt:string;fingerprint:string;issuedAt:string;revision:number;workspaceRef:string}};type:\"relay:codex-command\"}|{command:{kind:\"profile_remove\";profileGeneration:number;profileHandle:string};commandId:string;scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number};type:\"relay:codex-command\"}|{command:{kind:\"rebind_binding\";nextBindingGeneration:number;successorWorkspace:{expiresAt:string;fingerprint:string;issuedAt:string;revision:number;workspaceRef:string}};commandId:string;scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number}&{childGeneration:number}&{bindingGeneration:number;bindingId:string;jobId:string;taskId:string;threadId:string};type:\"relay:codex-command\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.relay.server.to.client.relay.codex.credit.tl8wj7",
    "locator": "relay:server_to_client:relay:codex-credit",
    "structuralSignatures": [
      "frame.payload:{grantBytes:number;grantEvents:number;scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number}&{childGeneration:number};throughEventSequence:number;type:\"relay:codex-credit\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.relay.server.to.client.relay.codex.request.response.27c1q5",
    "locator": "relay:server_to_client:relay:codex-request-response",
    "structuralSignatures": [
      "frame.payload:{response:{answers:unresolved<Readonly>;kind:\"user_input\"};scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number}&{childGeneration:number}&{bindingGeneration:number;bindingId:string;jobId:string;taskId:string;threadId:string}&{workspace:{expiresAt:string;fingerprint:string;issuedAt:string;revision:number;workspaceRef:string}}&{turnId:string}&{eventId:string}&{itemId:string}&{requestRef:string};type:\"relay:codex-request-response\"}|{response:{decision:\"accept\"|\"acceptForSession\"|\"cancel\"|\"decline\";kind:\"command_approval\"|\"file_change_approval\"|\"network_approval\"};scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number}&{childGeneration:number}&{bindingGeneration:number;bindingId:string;jobId:string;taskId:string;threadId:string}&{workspace:{expiresAt:string;fingerprint:string;issuedAt:string;revision:number;workspaceRef:string}}&{turnId:string}&{eventId:string}&{itemId:string}&{requestRef:string};type:\"relay:codex-request-response\"}|{response:{grants:{fileSystem:boolean;network:boolean};kind:\"permissions_approval\";scope:\"session\"|\"turn\"};scope:{accountGeneration:number;profileGeneration:number;profileHandle:string;runtimeGeneration:number}&{capabilityRevision:number}&{desktopSessionId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;selectedProtocolVersion:number}&{childGeneration:number}&{bindingGeneration:number;bindingId:string;jobId:string;taskId:string;threadId:string}&{workspace:{expiresAt:string;fingerprint:string;issuedAt:string;revision:number;workspaceRef:string}}&{turnId:string}&{eventId:string}&{itemId:string}&{requestRef:string};type:\"relay:codex-request-response\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.answers",
        "schema": "CodexUserInputAnswersV1"
      }
    ]
  },
  {
    "observationId": "wire.relay.server.to.client.relay.mcp.preflight.18k2ymi",
    "locator": "relay:server_to_client:relay:mcp-preflight",
    "structuralSignatures": [
      "frame.payload:{digest:string;requestId:string;server:{envPassthrough?:null|string[]|undefined;excludeTools?:null|string[]|undefined;includeTools?:null|string[]|undefined;name:string;namespaceId?:null|string|undefined;transport:{[key:string]:unknown};transportKind:\"sse-legacy\"|\"stdio\"|\"streamable-http\";trustTier?:null|string|undefined};type:\"relay:mcp-preflight\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "server.transport",
        "schema": "McpTransportConfigV1"
      }
    ]
  },
  {
    "observationId": "wire.relay.server.to.client.relay.ssh.prepare.18i1luc",
    "locator": "relay:server_to_client:relay:ssh-prepare",
    "structuralSignatures": [
      "frame.payload:{request:{approvedRequest:{args:{argv:string[];destination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string};program:string;timeoutReason?:string|undefined;timeoutSeconds:number};toolCallId:string;toolName:\"structured_ssh_exec\";version:typeof RELAY_SSH_APPROVED_REQUEST_VERSION}|{args:{destination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string};localPath:string;remotePath:string;timeoutReason?:string|undefined;timeoutSeconds:number};toolCallId:string;toolName:\"structured_ssh_copy_download\";version:typeof RELAY_SSH_APPROVED_REQUEST_VERSION}|{args:{destination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string};localPath:string;remotePath:string;timeoutReason?:string|undefined;timeoutSeconds:number};toolCallId:string;toolName:\"structured_ssh_copy_upload\";version:typeof RELAY_SSH_APPROVED_REQUEST_VERSION}|{args:{destination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string}};toolCallId:string;toolName:\"structured_ssh_auth\";version:typeof RELAY_SSH_APPROVED_REQUEST_VERSION};approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";requestId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_PREPARE_VERSION};type:\"relay:ssh-prepare\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.ws.server.to.client.codex.request.187deq8",
    "locator": "ws:server_to_client:codex.request",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.ws.server.to.client.codex.request.resolved.1lmuzka",
    "locator": "ws:server_to_client:codex.request.resolved",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.ws.server.to.client.tool.run.shell.progress.vx68yt",
    "locator": "ws:server_to_client:tool.run_shell.progress",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.ws.server.to.client.tool.structured.ssh.progress.10q2z2b",
    "locator": "ws:server_to_client:tool.structured_ssh.progress",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.accepted.arbitrary.packages.server.src.messaging.dispatch.ts.roompostmessagebody.cpix9d",
    "locator": "http:accepted_arbitrary:packages/server/src/messaging/dispatch.ts#RoomPostMessageBody",
    "structuralSignatures": [
      "declaration.payload:{activeMiniApp?:null|unresolved<ActiveMiniAppRequestContext>;artifactRefs?:unknown;attachments?:unknown;autoApprove?:boolean;content:string;currentFolder?:null|string;currentFolderRelayId?:null|string;focusedResources?:unknown;laneKey?:string;liveMiniAppSession?:null|unresolved<LiveMiniAppSessionCapability>|unresolved<TrustedLiveMiniAppSessionContext>;mentionedHumanUserIds?:unknown;model?:null|string;replyToMessageId?:null|number;resumeMessageId?:null|number;resumeTurnId?:null|string;searchHistoryFlag?:boolean|null;uiSelectedBotActorId?:null|string;userTimezone?:null|string;voiceMode?:boolean;workspacePath?:null|string}"
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
        "path": "focusedResources",
        "debtId": "debt.wire.arbitrary.6n27cc"
      },
      {
        "path": "liveMiniAppSession",
        "debtId": "debt.wire.arbitrary.r1qla2"
      },
      {
        "path": "mentionedHumanUserIds",
        "schema": "canonical-human-user-id[]"
      }
    ]
  },
  {
    "observationId": "wire.http.accepted.arbitrary.packages.types.src.api.ts.sendmessagerequest.80siy2",
    "locator": "http:accepted_arbitrary:packages/types/src/api.ts#SendMessageRequest",
    "structuralSignatures": [
      "declaration.payload:{activeMiniApp?:null|undefined|{appId:string;appName?:string;documentPath?:string;selection?:unknown;summary?:unknown;targetKind?:\"artifact\"|\"fs\";updatedAt:number};artifactRefs?:null|undefined|{artifactId:string;mimeType:string;path:string;size:number}[];attachments?:undefined|{attachmentId:string}[];autoApprove?:boolean|undefined;currentFolder?:null|string|undefined;currentFolderRelayId?:null|string|undefined;focusedResources?:null|undefined|{artifactId:string;kind:\"workspace-artifact\"}|{kind:\"local-file\";name:string;path:string;relayId:string;rootPath:string}[];laneKey?:string|undefined;liveMiniAppSession?:null|undefined|{documentVersion:{kind:\"artifact_revision\";revision:number}|{kind:\"local_sha\";sha256:string};sessionId:string;sessionToken:string};mentionedHumanUserIds?:string[]|undefined;message:string;model?:string|undefined;replyToMessageId?:null|number|undefined;roomId?:string|undefined;userTimezone?:string|undefined;voiceMode?:boolean|undefined;workspacePath?:null|string|undefined}"
    ],
    "arbitraryPayloads": [
      {
        "path": "activeMiniApp.selection",
        "debtId": "debt.wire.arbitrary.1e6ug5x"
      },
      {
        "path": "activeMiniApp.summary",
        "debtId": "debt.wire.arbitrary.1ncarmb"
      }
    ]
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
    "observationId": "wire.http.request.response.get.api.mcp.servers.1j7qk9f",
    "locator": "http:request_response:GET /api/mcp-servers",
    "structuralSignatures": [
      "response.body:any",
      "response.body:{servers:{createdAt:Date;enabled:boolean;envPassthrough:string[];excludeTools:string[];health:\"circuit-open\"|\"connected\"|\"disconnected\"|\"error\"|\"unknown\";host:string;id:string;includeTools:string[];lastCheckFailureCode:string;lastCheckMissingEnvironment:string[];lastCheckStatus:string;lastCheckedAt:Date;lastConnectedAt:Date;name:string;namespaceId:string;toolCount:number;transport:unknown;transportKind:string;trustTier:string;updatedAt:Date}[]}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body",
        "debtId": "debt.wire.arbitrary.vvxgez"
      },
      {
        "path": "response.body.servers[].transport",
        "debtId": "debt.wire.arbitrary.rifb8m"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.mcp.servers.name.1j2f6oh",
    "locator": "http:request_response:GET /api/mcp-servers/:name",
    "structuralSignatures": [
      "request.params:{name:string}",
      "response.body:any",
      "response.body:object",
      "response.body:{error:string;name:string}",
      "response.body:{server:{createdAt:Date;enabled:boolean;envPassthrough:string[];excludeTools:string[];health:\"circuit-open\"|\"connected\"|\"disconnected\"|\"error\"|\"unknown\";host:string;id:string;includeTools:string[];lastCheckFailureCode:string;lastCheckMissingEnvironment:string[];lastCheckStatus:string;lastCheckedAt:Date;lastConnectedAt:Date;name:string;namespaceId:string;toolCount:number;transport:unknown;transportKind:string;trustTier:string;updatedAt:Date}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body",
        "debtId": "debt.wire.arbitrary.bza1b9"
      },
      {
        "path": "response.body.server.transport",
        "debtId": "debt.wire.arbitrary.8qyj7x"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.mcp.servers.name.tools.9ui9ad",
    "locator": "http:request_response:GET /api/mcp-servers/:name/tools",
    "structuralSignatures": [
      "request.params:{name:string}",
      "response.body:any",
      "response.body:object",
      "response.body:{error:string;name:string}",
      "response.body:{tools:{description?:string;enabled:boolean;name:string}[]}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body",
        "debtId": "debt.wire.arbitrary.1dsv8sh"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.profile.agent.photo.library.entries.entryid.media.nfhaoi",
    "locator": "http:request_response:GET /api/profile/agent-photo-library/entries/:entryId/media",
    "structuralSignatures": [
      "request.params:{entryId:string}",
      "request.query:{size?:string}",
      "response.body:Buffer",
      "response.body:{error:{code:string;message:string;retryable:boolean}}"
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
      "response.body:{messages:undefined[];pageInfo:{hasMoreBefore:boolean;oldestCursor:{createdAt:string;id:string}}}",
      "response.body:{messages:{artifacts:{artifactInternalId:string;basename:string;mimeType:string;roomId:string;sizeBytes:number}[];attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];authorAgentId?:string;content:string;createdAt:Date;displayContent?:string;editRevision?:number;editedAt?:string;id:string;lastReplyAt?:string;logicalMessageKey?:string;reactions:{actorIds:string[];count:number;emoji:string;truncated:boolean}[];replyCount?:number;replyToMessageId?:number;role:string;sourceUserId?:string;summaryRevision?:number;toolCalls:string;toolName?:string}|{artifacts:{artifactInternalId:string;basename:string;mimeType:string;roomId:string;sizeBytes:number}[];attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];authorAgentId?:string;content:string;createdAt:Date;displayContent?:string;editRevision?:number;editedAt?:string;id:string;lastReplyAt?:string;logicalMessageKey?:string;reactions?:undefined;replyCount?:number;replyToMessageId?:number;role:string;sourceUserId?:string;summaryRevision?:number;toolCalls:string;toolName?:string}|{artifacts?:undefined;attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];authorAgentId?:string;content:string;createdAt:Date;displayContent?:string;editRevision?:number;editedAt?:string;id:string;lastReplyAt?:string;logicalMessageKey?:string;reactions:{actorIds:string[];count:number;emoji:string;truncated:boolean}[];replyCount?:number;replyToMessageId?:number;role:string;sourceUserId?:string;summaryRevision?:number;toolCalls:string;toolName?:string}|{artifacts?:undefined;attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];authorAgentId?:string;content:string;createdAt:Date;displayContent?:string;editRevision?:number;editedAt?:string;id:string;lastReplyAt?:string;logicalMessageKey?:string;reactions?:undefined;replyCount?:number;replyToMessageId?:number;role:string;sourceUserId?:string;summaryRevision?:number;toolCalls:string;toolName?:string}[];pageInfo:{hasMoreBefore:boolean;oldestCursor:{createdAt:string;id:string}}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.security.audit.log.ef92mf",
    "locator": "http:request_response:GET /api/security/audit-log",
    "structuralSignatures": [
      "request.query:{actorId?:string;kinds?:string;limit?:string;since?:string}",
      "response.body:{error:string}",
      "response.body:{events:{action:\"create\"|\"delete\"|\"disable\"|\"enable\"|\"update\";actorId:string;effectDigest?:string;ip:string;kind:\"mcp_server_config\";outcome:\"error\"|\"ok\";relayId?:string;serverName:string;ts:string;userAgent:string}|{action:\"delete\"|\"list\"|\"store\"|\"use\";actorId:string;connectionId?:string;errorKind?:string;field?:string;ip:string;kind:\"connection_vault_tool\";outcome:\"error\"|\"missing\"|\"ok\";service?:string;tool:string;ts:string;userAgent:string}|{action:string;actorId:string;errorKind?:string;ip:string;kind:\"memory.edit\";memoryId:string;namespaceId?:string;outcome:\"failure\"|\"success\";scopeId?:string;ts:string;userAgent:string}|{actorId:string;actorUserId:string;ip:string;kind:\"standing_approval_revoked\";label:string;roomId:string;route:\"DELETE /api/security/standing-approvals/:id\";ruleId:string;scope:\"room\"|\"server\";toolPattern:string;ts:string;userAgent:string}|{actorId:string;affectedPairingCount:number;correlationId:string;ip:string;kind:\"relay_pairing_lifecycle\";managementTarget:string;operation:\"group_revoke\"|\"historical_cleanup\";reason:\"confirmation_mismatch\"|\"not_found_or_foreign\"|\"revoked\"|\"store_error\";result:\"failed\"|\"not_found_or_foreign\"|\"stale\"|\"succeeded\";ts:string;userAgent:string;userId:string}|{actorId:string;after:{conductorModel:string;defaultChatModel:string;fallbackChain:string[];stenographerModel:string};before:{conductorModel:string;defaultChatModel:string;fallbackChain:string[];stenographerModel:string};ip:string;kind:\"server_model_config_changed\";ts:string;userAgent:string}|{actorId:string;attemptedRoute:string;capability:string;ip:string;kind:\"capability_check_failed\";ts:string;userAgent:string}|{actorId:string;attemptedRoute:string;ip:string;kind:\"pin_check_failed\";pinOutcome:\"invalid\"|\"locked_out\";ts:string;userAgent:string}|{actorId:string;byUserId:string;fromUserId:string;ip:string;kind:\"room_archived\";roomId:string;ts:string;userAgent:string}|{actorId:string;byUserId:string;ip:string;kind:\"room_unarchived\";roomId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail:boolean;ip:string;kind:\"agent_role_removed\";roleSlug:string;targetAgentId:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail:boolean;ip:string;kind:\"room_member_removed\";roomId:string;targetActorId:string;targetActorKind:\"agent\"|\"user\";ts:string;userAgent:string}|{actorId:string;bypassedRail?:boolean;groupId:string;groupType:string;ip:string;kind:\"group_member_removed\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail?:boolean;ip:string;kind:\"agent_role_added\";replacedFromGroupId:string;roleSlug:string;targetAgentId:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];groupId:string;groupType:string;ip:string;kind:\"rbac_shared_access_assigned\";memberCount:number;ownerUserId:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];groupId:string;groupType:string;ip:string;kind:\"rbac_shared_access_created\";memberCount:number;ownerUserId:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];ip:string;kind:\"rbac_role_capabilities_set\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];ip:string;kind:\"rbac_role_created\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilityRevision:number;denialCode?:string;desktopSessionId:string;ip:string;kind:\"workstation_session_activated\"|\"workstation_session_broadened\"|\"workstation_session_denied\"|\"workstation_session_disabled\"|\"workstation_session_invalidated\"|\"workstation_session_narrowed\"|\"workstation_session_switched\";outcome?:string;relayId:string;route?:string;serverBindingId:string;ts:string;userAgent:string;userId:string}|{actorId:string;capabilityRevision:number;desktopSessionId:string;executionClass:\"profile_bound_sandbox\"|\"real_workstation\"|\"typed_broker\";ip:string;kind:\"workstation_admission\";outcome:\"auto\"|\"none\";pairingGeneration:string;profileId:string;profileRevision:number;reason:\"auto_admitted\"|\"critical_or_elevation_command\"|\"no_active_session\"|\"no_admitted_plan\"|\"run_shell_required\"|\"typed_broker_not_wired\";relayId:string;serverBindingId:string;toolCallId:string;toolName:string;ts:string;userAgent:string;userId:string}|{actorId:string;errorKind?:string;ip:string;kind:\"memory.delete\";memoryId:string;mode:\"archive\"|\"hard\";namespaceId?:string;outcome:\"failure\"|\"success\";scopeId?:string;ts:string;userAgent:string}|{actorId:string;fromOwnerUserId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_owner_transferred\";toOwnerUserId:string;ts:string;userAgent:string}|{actorId:string;fromUserId:string;ip:string;kind:\"room_ownership_transferred\";roomId:string;toUserId:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"group_member_added\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_created\";ownerUserId:string;roleSlugs:string[];ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_deleted\";ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_renamed\";label:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_roles_set\";roleSlugs:string[];ts:string;userAgent:string}|{actorId:string;handleHash:string;inviteKind:string;ip:string;kind:\"invite_bind_logto_user_succeeded\";logtoSub:string;targetGroupId?:string;targetRoomId?:string;tokenHash:string;ts:string;userAgent:string;userId:string}|{actorId:string;handleHash:string;ip:string;kind:\"logto_password_login_failed\";ts:string;userAgent:string;userId?:string}|{actorId:string;handleHash:string;ip:string;kind:\"logto_password_login_succeeded\";ts:string;userAgent:string;userId:string}|{actorId:string;handleHash:string;ip:string;kind:\"recovery_session_opened\";ts:string;userAgent:string}|{actorId:string;handleHash:string;ip:string;kind:\"recovery_session_rejected\";reason:\"logto_endpoint_missing\"|\"logto_unavailable\"|\"reject\"|\"unexpected_error\";ts:string;userAgent:string}|{actorId:string;handleHash?:string;inviteKind?:string;ip:string;kind:\"invite_bind_logto_user_failed\";logtoSub?:string;reason:string;targetGroupId?:string;targetRoomId?:string;tokenHash?:string;ts:string;userAgent:string}|{actorId:string;inviteId:string;inviteKind:string;ip:string;kind:\"invite_minted\";targetAgentId?:string;targetRoomId?:string;ts:string;userAgent:string}|{actorId:string;inviteId:string;ip:string;kind:\"invite_revoked\";ts:string;userAgent:string}|{actorId:string;inviteKind:string;ip:string;kind:\"invite_redeemed\";landingRoomId:string;newUserId:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"admin_password_reset_issued\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"approval_denied\"|\"approval_granted\";laneKey:string;network?:{host:string;port:number;reason:string;suggestedRule:{cidr?:string;host?:string;ports?:number[];suffix?:string;type:\"cidr\"|\"domain\"|\"wildcard\"}};route:\"POST /api/auth/approval-reply\";threadId:string;ts:string;userAgent:string;verb:\"always\"|\"deny\"|\"once\"|\"room\"}|{actorId:string;ip:string;kind:\"invite_complete_profile_failed\";reason:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"invite_redeem_cleanup_failed\";logtoSub:string;reason:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"invite_redeem_failed\";reason:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"logto_token_mint_failed\";logtoSub:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"pin_enrolled\";route:\"POST /api/auth/pin\";sessionUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"posture_changed\";next:{deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\"};prev:{deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\"};ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"rbac_role_deleted\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"rbac_role_renamed\";label:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"recovery_relay_code_unmatched\";ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"recovery_relay_read_denied\";reason:\"bad_request\"|\"not_found\";ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"resume_thread_auth_denied\";route:string;sessionUserId:string;threadId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_added\";roomId:string;roomRole:\"admin\"|\"member\";targetActorId:string;targetActorKind:\"agent\"|\"user\";targetAgentId?:string;targetUserId?:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_self_joined\";roomId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_self_left\";roomId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_deleted\";logtoRevoked:boolean;targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_disabled\";reason?:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_disabled_session_blocked\";route:string;sessionUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_enabled\";targetUserId:string;ts:string;userAgent:string}[];hasMore:boolean}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.sessions.latest.ueq1mn",
    "locator": "http:request_response:GET /api/sessions/latest",
    "structuralSignatures": [
      "request.query:{[key:string]:string}",
      "response.body:{error:string}",
      "response.body:{messages:undefined[];session:null}",
      "response.body:{messages:{artifacts:{artifactInternalId:string;basename:string;mimeType:string;roomId:string;sizeBytes:number}[];attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];content:string;createdAt:Date;displayContent?:string;editRevision?:number;editedAt?:string;id:string;logicalMessageKey?:string;reactions:{actorIds:string[];count:number;emoji:string;truncated:boolean}[];replyToMessageId?:number;role:string;toolCalls:string;toolName?:string}|{artifacts:{artifactInternalId:string;basename:string;mimeType:string;roomId:string;sizeBytes:number}[];attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];content:string;createdAt:Date;displayContent?:string;editRevision?:number;editedAt?:string;id:string;logicalMessageKey?:string;reactions?:undefined;replyToMessageId?:number;role:string;toolCalls:string;toolName?:string}|{artifacts?:undefined;attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];content:string;createdAt:Date;displayContent?:string;editRevision?:number;editedAt?:string;id:string;logicalMessageKey?:string;reactions:{actorIds:string[];count:number;emoji:string;truncated:boolean}[];replyToMessageId?:number;role:string;toolCalls:string;toolName?:string}|{artifacts?:undefined;attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];content:string;createdAt:Date;displayContent?:string;editRevision?:number;editedAt?:string;id:string;logicalMessageKey?:string;reactions?:undefined;replyToMessageId?:number;role:string;toolCalls:string;toolName?:string}[];pageInfo:{hasMoreBefore:boolean;oldestCursor:{createdAt:string;id:string}};session:{id:string;messageCount:number;startedAt:Date;threadId:string;title:string}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.setup.status.1fa8sfa",
    "locator": "http:request_response:GET /api/setup/status",
    "structuralSignatures": [
      "response.body:{claimInvitePathHint:string;claimRequired:boolean;deployConfigConsumedAt:string;deploymentMode:\"cloud-managed\"|\"dev-multi-instance\"|\"lan-self-host\"|\"local-self-host\";instanceId:string;providers:{hasConversion:boolean;hasLlm:boolean;hasSearch:boolean;hasVoice:boolean;managedByCloud:boolean};recommendedSetupSurface:{kind:\"ask-admin\"|\"cli\"|\"electron-onboarding\"|\"workbench-admin\";url:string};serverProfile:{description?:string;descriptionVisibility?:\"members\"|\"public\";icon:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};name:string;reviewedAt?:string};serverUrl:string;setupState:\"claimed-needs-auth\"|\"fresh-unclaimed\"|\"ready\"|\"server-needs-keys\";viewer:{byokConfigured:boolean;canManageServerSettings:boolean;genieCustomized:boolean;handleAutoGenerated:boolean;passwordWasTemp:boolean;pinEnrolled:boolean}}",
      "response.body:{claimRequired:boolean;deployConfigConsumedAt:string;deploymentMode:\"cloud-managed\"|\"dev-multi-instance\"|\"lan-self-host\"|\"local-self-host\";instanceId:string;recommendedSetupSurface:{kind:\"ask-admin\"|\"cli\"|\"electron-onboarding\"|\"workbench-admin\";url:string};serverProfile:{description?:string;descriptionVisibility?:\"members\"|\"public\";icon:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};name:string;reviewedAt?:string};serverUrl:string;setupState:\"claimed-needs-auth\"|\"fresh-unclaimed\"|\"ready\"|\"server-needs-keys\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.tasks.1veo2i8",
    "locator": "http:request_response:GET /api/tasks",
    "structuralSignatures": [
      "request.query:{includeTerminal?:boolean;status?:string}",
      "response.body:{agentId:string;agentName:string;callingRoomId:string;createdAt:string;cron?:string;harnessId?:string;id:string;lastModelId:string;nextFireAt:string;preset:string;prompt:string;requestedModelId:string;scheduleKind:string;status:string;targetRoomId:string}[]",
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
      "response.body:{runs:{completedAt:string;id:string;lastError:string;modelId:string;resultText:string;startedAt:string;status:string;transcript?:{content:string;createdAt:string;role:string;toolCalls:{args:{[key:string]:unknown};id:string;name:string}[];toolName:string}[]}[];task:{agentId?:string;agentName?:string;callingRoomId:string;createdAt?:string;cron?:string;harnessId?:string;id:string;lastModelId?:string;nextFireAt:string;preset:string;prompt:string;requestedModelId?:string;scheduleKind:string;status:string;targetRoomId?:string}&{createdAt:string;cron:string;depth:number;expectedOutput:string;parentTaskId:string;requestedModelId:string;resultDelivery:string;runAt:string;scopeId:string;selectionProfile:\"balanced\"|\"cheap_private\"|\"cheap_smart\"|\"cheapest\"|\"most_private\"|\"private_cheap\"|\"private_smart\"|\"smart_cheap\"|\"smart_private\"|\"smartest\";selectionSpec:{absoluteFloors?:{intelligenceRank?:number;maxCost?:number;privacy?:number};band?:\"cheap\"|\"privacy\"|\"smart\";objective:\"cheap\"|\"privacy\"|\"smart\"};targetChat:string;timezone:string;toolsMode:string;toolsWhitelist:string[];updatedAt:string;useScope:boolean}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.runs[].transcript[].toolCalls[].args",
        "debtId": "debt.wire.arbitrary.19ijf0o"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.voices.1ob9cop",
    "locator": "http:request_response:GET /api/voices",
    "structuralSignatures": [
      "response.body:{cachedAt:null;curated:{description:string;label:string;language:string;previewUrl:string;slug:string;voiceId:string}[];elevenLabsConfigured:boolean;error:string;voices:undefined[]}",
      "response.body:{cachedAt:number;curated:{description:string;label:string;language:string;previewUrl:string;slug:string;voiceId:string}[];elevenLabsConfigured:boolean;error?:string;voices:{description:string;labels:{[key:string]:string};name:string;voiceId:string}[]}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.workspace.artifacts.id.lv68nb",
    "locator": "http:request_response:GET /api/workspace/artifacts/:id",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{artifactId:string;canWrite:boolean;createdAt:string;id:string;mimeType:string;namespaceIds:string[];path:string;revision:number;size:number;updatedAt:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.patch.api.mcp.servers.name.enabled.9lgdnx",
    "locator": "http:request_response:PATCH /api/mcp-servers/:name/enabled",
    "structuralSignatures": [
      "request.body:{enabled?:unknown}",
      "request.params:{name:string}",
      "response.body:any",
      "response.body:object",
      "response.body:{catch:function;finally:function;then:function}",
      "response.body:{error:string;name:string}",
      "response.body:{error:string}",
      "response.body:{server:{createdAt:Date;enabled:boolean;envPassthrough:string[];excludeTools:string[];health:\"circuit-open\"|\"connected\"|\"disconnected\"|\"error\"|\"unknown\";host:string;id:string;includeTools:string[];lastCheckFailureCode:string;lastCheckMissingEnvironment:string[];lastCheckStatus:string;lastCheckedAt:Date;lastConnectedAt:Date;name:string;namespaceId:string;toolCount:number;transport:unknown;transportKind:string;trustTier:string;updatedAt:Date}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.enabled",
        "debtId": "debt.wire.arbitrary.1uav798"
      },
      {
        "path": "response.body",
        "debtId": "debt.wire.arbitrary.17tbh3t"
      },
      {
        "path": "response.body.server.transport",
        "debtId": "debt.wire.arbitrary.13488vl"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.patch.api.mcp.servers.name.tools.tool.zed8h4",
    "locator": "http:request_response:PATCH /api/mcp-servers/:name/tools/:tool",
    "structuralSignatures": [
      "request.body:{enabled?:unknown}",
      "request.params:{name:string;tool:string}",
      "response.body:any",
      "response.body:object",
      "response.body:{catch:function;finally:function;then:function}",
      "response.body:{error:string;name:string}",
      "response.body:{error:string}",
      "response.body:{server:{createdAt:Date;enabled:boolean;envPassthrough:string[];excludeTools:string[];health:\"circuit-open\"|\"connected\"|\"disconnected\"|\"error\"|\"unknown\";host:string;id:string;includeTools:string[];lastCheckFailureCode:string;lastCheckMissingEnvironment:string[];lastCheckStatus:string;lastCheckedAt:Date;lastConnectedAt:Date;name:string;namespaceId:string;toolCount:number;transport:unknown;transportKind:string;trustTier:string;updatedAt:Date};tools:{description?:string;enabled:boolean;name:string}[]}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.enabled",
        "debtId": "debt.wire.arbitrary.12n0ucb"
      },
      {
        "path": "response.body",
        "debtId": "debt.wire.arbitrary.4kw73s"
      },
      {
        "path": "response.body.server.transport",
        "debtId": "debt.wire.arbitrary.1sgfqzq"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.patch.api.tasks.id.1conpo2",
    "locator": "http:request_response:PATCH /api/tasks/:id",
    "structuralSignatures": [
      "request.body:{cron?:string;expectedOutput?:string;prompt?:string;requestedModelId?:string;resultDelivery?:\"raw\"|\"wake\";runAt?:string;scheduleKind?:\"cron\"|\"now\"|\"one_shot\";selectionProfile?:\"balanced\"|\"cheap_private\"|\"cheap_smart\"|\"cheapest\"|\"most_private\"|\"private_cheap\"|\"private_smart\"|\"smart_cheap\"|\"smart_private\"|\"smartest\";selectionSpec?:{absoluteFloors?:{intelligenceRank?:number;maxCost?:number;privacy?:number};band?:\"cheap\"|\"privacy\"|\"smart\";objective:\"cheap\"|\"privacy\"|\"smart\"};targetChat?:\"last_in_namespace\"|\"new_in_namespace\"|\"orphan\";timeLimitSeconds?:number;timezone?:string;tools?:string[]}",
      "request.params:{id:string}",
      "response.body:{agentId?:string;agentName?:string;callingRoomId:string;createdAt?:string;cron?:string;harnessId?:string;id:string;lastModelId?:string;nextFireAt:string;preset:string;prompt:string;requestedModelId?:string;scheduleKind:string;status:string;targetRoomId?:string}",
      "response.body:{detail:{message:string};error:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.patch.api.workspace.artifacts.id.d13bd",
    "locator": "http:request_response:PATCH /api/workspace/artifacts/:id",
    "structuralSignatures": [
      "request.body:{newPath?:unknown}",
      "request.params:{id:string}",
      "response.body:{artifactId:string;canWrite:boolean;createdAt:string;id:string;mimeType:string;namespaceIds:string[];path:string;revision:number;size:number;updatedAt:string}",
      "response.body:{error:any}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.newPath",
        "debtId": "debt.wire.arbitrary.1c3muk4"
      },
      {
        "path": "response.body.error",
        "debtId": "debt.wire.arbitrary.n3ktod"
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
      "response.body:{documentVersion:{kind:\"local_sha\";sha256:string};localRevisionRef:string}",
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
    "observationId": "wire.http.request.response.post.api.auth.approval.reply.p3nnrh",
    "locator": "http:request_response:POST /api/auth/approval-reply",
    "structuralSignatures": [
      "request.body:{approvalId?:string;laneKey?:string;localMcpInstallDigest?:string;threadId?:string;verb?:string}",
      "response.body:{code:string;error:string}",
      "response.body:{error:any}",
      "response.body:{error:string}",
      "response.body:{ok:boolean}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.error",
        "debtId": "debt.wire.arbitrary.1htcncx"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.bind.logto.user.1fe1xlz",
    "locator": "http:request_response:POST /api/bind-logto-user",
    "structuralSignatures": [
      "request.body:{state?:unknown}",
      "response.body:{actorId:string;ok:boolean;requiresProfileCompletion:boolean;userId:string}",
      "response.body:{code:any;error:any}",
      "response.body:{code:string;error:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.state",
        "debtId": "debt.wire.arbitrary.vhbjv2"
      },
      {
        "path": "response.body.code",
        "debtId": "debt.wire.arbitrary.abb0ea"
      },
      {
        "path": "response.body.error",
        "debtId": "debt.wire.arbitrary.fu32gz"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.chat.v5ssn6",
    "locator": "http:request_response:POST /api/chat",
    "structuralSignatures": [
      "request.body:{activeMiniApp?:{appId:string;appName?:string;documentPath?:string;selection?:unknown;summary?:unknown;targetKind?:\"artifact\"|\"fs\";updatedAt:number};artifactRefs?:{artifactId:string;mimeType:string;path:string;size:number}[];attachments?:{attachmentId:string}[];autoApprove?:boolean;currentFolder?:string;currentFolderRelayId?:string;focusedResources?:{artifactId:string;kind:\"workspace-artifact\"}|{kind:\"local-file\";name:string;path:string;relayId:string;rootPath:string}[];laneKey?:string;liveMiniAppSession?:{documentVersion:{kind:\"artifact_revision\";revision:number}|{kind:\"local_sha\";sha256:string};sessionId:string;sessionToken:string};mentionedHumanUserIds?:string[];message:string;model?:string;replyToMessageId?:number;roomId?:string;userTimezone?:string;voiceMode?:boolean;workspacePath?:string}",
      "response.body:void",
      "response.body:{accepted:boolean;attachments?:{code?:string;decision:\"accept\"|\"blocked\"|\"reject\"|\"stub\";filename:string;id:string;kind?:string;reason?:string;threats?:string[]}[];coalesced?:boolean;jobId:string;laneKey:string}",
      "response.body:{catch:function;finally:function;then:function}",
      "response.body:{code:string;error:string;message:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.activeMiniApp.selection",
        "debtId": "debt.wire.arbitrary.1iwm2r8"
      },
      {
        "path": "request.body.activeMiniApp.summary",
        "debtId": "debt.wire.arbitrary.1wi7odq"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.file.invoke.direct.s6nn5j",
    "locator": "http:request_response:POST /api/file/invoke-direct",
    "structuralSignatures": [
      "request.body:{args?:{[key:string]:unknown};command:string;currentFolder?:string;roomId?:string;workspacePath?:string}",
      "response.body:{code:string;error:string}",
      "response.body:{duration:number;result:string;toolCallId:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body.args",
        "debtId": "debt.wire.arbitrary.10529ck"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.mcp.servers.17jl3dh",
    "locator": "http:request_response:POST /api/mcp-servers",
    "structuralSignatures": [
      "response.body:any",
      "response.body:{error:any}",
      "response.body:{error:string;message:string}",
      "response.body:{error:string}",
      "response.body:{server:{createdAt:Date;enabled:boolean;envPassthrough:string[];excludeTools:string[];health:\"circuit-open\"|\"connected\"|\"disconnected\"|\"error\"|\"unknown\";host:string;id:string;includeTools:string[];lastCheckFailureCode:string;lastCheckMissingEnvironment:string[];lastCheckStatus:string;lastCheckedAt:Date;lastConnectedAt:Date;name:string;namespaceId:string;toolCount:number;transport:unknown;transportKind:string;trustTier:string;updatedAt:Date}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body",
        "debtId": "debt.wire.arbitrary.15w94xd"
      },
      {
        "path": "response.body.error",
        "debtId": "debt.wire.arbitrary.k03ffd"
      },
      {
        "path": "response.body.server.transport",
        "debtId": "debt.wire.arbitrary.1su234p"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.office.new.ilbp3h",
    "locator": "http:request_response:POST /api/office/new",
    "structuralSignatures": [
      "response.body:{artifactId:string;canWrite:boolean;createdAt:string;id:string;mimeType:string;namespaceIds:string[];path:string;revision:number;size:number;updatedAt:string}",
      "response.body:{error:any}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.error",
        "debtId": "debt.wire.arbitrary.ze1nr5"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.messages.s536g0",
    "locator": "http:request_response:POST /api/rooms/:roomId/messages",
    "structuralSignatures": [
      "request.body:{activeMiniApp?:{appId:string;appName?:string;documentPath?:string;selection?:unknown;summary?:unknown;targetKind?:\"artifact\"|\"fs\";updatedAt:number};artifactRefs?:unknown;attachments?:unknown;autoApprove?:boolean;content:string;currentFolder?:string;currentFolderRelayId?:string;focusedResources?:unknown;laneKey?:string;liveMiniAppSession?:{appId:string;documentVersion:{kind:\"artifact_revision\";revision:number}|{kind:\"local_sha\";sha256:string};instructions:string;sessionId:string;sessionToken:string}|{documentVersion:{kind:\"artifact_revision\";revision:number}|{kind:\"local_sha\";sha256:string};sessionId:string;sessionToken:string};mentionedHumanUserIds?:unknown;model?:string;replyToMessageId?:number;resumeMessageId?:number;resumeTurnId?:string;searchHistoryFlag?:boolean;uiSelectedBotActorId?:string;userTimezone?:string;voiceMode?:boolean;workspacePath?:string}",
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
        "path": "request.body.focusedResources",
        "debtId": "debt.wire.arbitrary.1uwofi4"
      },
      {
        "path": "request.body.mentionedHumanUserIds",
        "schema": "canonical-human-user-id[]"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.server.icon.1mm3yrt",
    "locator": "http:request_response:POST /api/server/icon",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{serverProfile:{description:string;descriptionVisibility:\"members\"|\"public\";icon:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};name:string;reviewedAt:Date}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.server.profile.1c2a5i5",
    "locator": "http:request_response:POST /api/server/profile",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{serverProfile:{description:string;descriptionVisibility:\"members\"|\"public\";icon:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};name:string;reviewedAt:Date}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.workspace.artifacts.1zbe3t",
    "locator": "http:request_response:POST /api/workspace/artifacts",
    "structuralSignatures": [
      "response.body:{artifactId:string;canWrite:boolean;createdAt:string;id:string;mimeType:string;namespaceIds:string[];path:string;revision:number;size:number;updatedAt:string}",
      "response.body:{code:any;error:any}",
      "response.body:{error:any}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.code",
        "debtId": "debt.wire.arbitrary.1afkqcw"
      },
      {
        "path": "response.body.error",
        "debtId": "debt.wire.arbitrary.evq8rh"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.put.api.mcp.servers.name.x1gysu",
    "locator": "http:request_response:PUT /api/mcp-servers/:name",
    "structuralSignatures": [
      "request.params:{name:string}",
      "response.body:any",
      "response.body:object",
      "response.body:{catch:function;finally:function;then:function}",
      "response.body:{error:any}",
      "response.body:{error:string;name:string}",
      "response.body:{server:{createdAt:Date;enabled:boolean;envPassthrough:string[];excludeTools:string[];health:\"circuit-open\"|\"connected\"|\"disconnected\"|\"error\"|\"unknown\";host:string;id:string;includeTools:string[];lastCheckFailureCode:string;lastCheckMissingEnvironment:string[];lastCheckStatus:string;lastCheckedAt:Date;lastConnectedAt:Date;name:string;namespaceId:string;toolCount:number;transport:unknown;transportKind:string;trustTier:string;updatedAt:Date}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body",
        "debtId": "debt.wire.arbitrary.uhs5jm"
      },
      {
        "path": "response.body.error",
        "debtId": "debt.wire.arbitrary.iu1dxe"
      },
      {
        "path": "response.body.server.transport",
        "debtId": "debt.wire.arbitrary.11i92o0"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.put.api.skills.y3c7r9",
    "locator": "http:request_response:PUT /api/skills",
    "structuralSignatures": [
      "request.body:{body?:string;description?:string;enabled?:boolean;name?:string;requiresTools?:string[]}",
      "response.body:{code:string;error:string;tools:string[]}",
      "response.body:{error:string}",
      "response.body:{skill:{body:string;description:string;enabled:boolean;forked:boolean;name:string;official:boolean;requiresTools:string[];source:string;tokenEstimate:number;updatedAt:string;version?:number}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.relay.declared.arbitrary.packages.relay.src.protocol.ts.relayclientmessage.jzsixz",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayClientMessage",
    "structuralSignatures": [
      "declaration.payload:unresolved<RelayAcpClientMessage>|unresolved<RelayCodexCommandResponseMessage>|unresolved<RelayCodexEventMessage>|unresolved<RelayCodexRequestMessage>|unresolved<RelayCodexStatusMessage>|{capabilities:unresolved<RelayCapabilities>;capabilitiesByProtocolVersion?:undefined|{[key:string]:unresolved<RelayCapabilities>};capabilityRevision?:number|undefined;desktopSessionId?:string|undefined;protocolRange?:undefined|{maximum:number;minimum:number};protocolVersion:number;relayId:string;token?:string|undefined;type:\"relay:register\";userId:string}|{capabilities:unresolved<RelayCapabilities>;capabilityRevision:number;desktopSessionId:string;relayId:string;type:\"relay:update-capabilities\"}|{correlationId:string;droppedBytes?:number|undefined;elapsedMs:number;endOffsetBytes:number;kind:\"exec-output\";offsetBytes:number;operation:\"exec\";phase:\"running\";sequence:number;stream:\"stderr\"|\"stdout\";text:string;type:\"relay:structured-ssh-progress\";version:1}|{correlationId:string;elapsedMs:number;kind:\"transfer\";operation:\"copy-download\"|\"copy-upload\";phase:\"starting\"|\"transferring\";sequence:number;totalBytes?:number|undefined;transferredBytes:number;type:\"relay:structured-ssh-progress\";version:1}|{correlationId:string;droppedBytes?:number|undefined;elapsedMs:number;endOffsetBytes:number;offsetBytes:number;phase:\"running\";sequence:number;stream:\"stderr\"|\"stdout\";text:string;type:\"relay:run-shell-progress\";version:1}|{correlationId:string;durationMs?:number|undefined;error?:string|undefined;errorCode?:string|undefined;networkDeniedDestination?:undefined|{host:string;port:number;reason:string};result?:unknown;status:\"error\"|\"ok\";type:\"relay:result\"}|{digest:string;environment:{name:string;present:boolean}[];failure?:undefined|{code:\"discovery_timeout\"|\"empty_toolset\"|\"internal\"|\"invalid_request\"|\"missing_environment\"|\"missing_launcher\"|\"protocol_failed\"|\"spawn_failed\"};launcher:\"missing\"|\"not-applicable\"|\"present\";machineLabel:string;requestId:string;status:\"blocked\"|\"ready\";targetName:string;type:\"relay:mcp-preflight-result\"}|{digest:string;failure?:undefined|{code:\"discovery_timeout\"|\"empty_toolset\"|\"internal\"|\"invalid_request\"|\"missing_environment\"|\"missing_launcher\"|\"protocol_failed\"|\"spawn_failed\"};operationId:string;state:\"connected\"|\"failed\"|\"stopped\";targetName:string;toolNames:string[];type:\"relay:mcp-configure-result\"}|{errorCode:\"capability_disabled\"|\"capability_unavailable\"|\"config_destination_mismatch\"|\"config_output_invalid\"|\"config_required_value_missing\"|\"config_unsafe_directive\"|\"config_value_invalid\"|\"connection_ambiguous\"|\"connection_catalog_malformed\"|\"connection_catalog_overflow\"|\"connection_catalog_unavailable\"|\"connection_catalog_unreadable\"|\"connection_not_found\"|\"connection_source_drift\"|\"destination_unavailable\"|\"host_key_ambiguous\"|\"host_key_changed\"|\"host_key_missing\"|\"invalid_destination\"|\"invalid_host\"|\"invalid_port\"|\"invalid_remote_user\"|\"invalid_request\"|\"lookup_aborted\"|\"lookup_failed\"|\"lookup_invalid_request\"|\"lookup_output_invalid\"|\"lookup_output_limited\"|\"lookup_timed_out\"|\"observer_unavailable\"|\"openssh_connection_catalog_malformed\"|\"openssh_connection_catalog_overflow\"|\"openssh_connection_catalog_unreadable\"|\"openssh_connection_catalog_unsupported_match\"|\"openssh_connection_catalog_unsupported_source\"|\"preparation_unavailable\"|\"prepare_unavailable\"|\"remote_user_missing\"|\"resolve_aborted\"|\"resolve_failed\"|\"resolve_output_limited\"|\"resolve_spawn_failed\"|\"resolve_timed_out\"|\"scan_aborted\"|\"scan_failed\"|\"scan_invalid_request\"|\"scan_output_limited\"|\"scan_timed_out\"|\"scanner_output_invalid\"|\"tool_disabled\"|\"topology_mismatch\"|\"trust_store_corrupt\"|\"trust_store_instance_mismatch\"|\"trust_store_unavailable\"|\"trust_unavailable\";failure?:undefined|{candidates?:undefined|{name:string;source:\"nautilo-profile\"|\"openssh\"}[];code:unresolved<Exclude>;completeness?:false|undefined;configuredBounds?:undefined|{bytes?:number;files?:number;includeDepth?:number;records?:number};observed?:undefined|{bytes:number;files:number;records:number};phase:\"catalog\"|\"dispatch_reresolve\"|\"host_key_scan\"|\"intent\"|\"known_hosts_lookup\"|\"parse\"|\"policy\"|\"resolve\"|\"trust_store_lookup\";recovery:\"choose_connection\"|\"correct_destination\"|\"provide_remote_user\"|\"reduce_connection_catalog\"|\"repair_connection_source\"|\"retry\";retrySafe:true;sideEffectStarted:false;source?:\"nautilo-profile\"|\"openssh\"|undefined;stateChanged:false};requestId:string;status:\"error\";type:\"relay:ssh-prepared\"}|{requestId:string;response:{approval:{host:string;hostKeyFingerprint:string;hostTrust:\"changed\"|\"trusted\"|\"unknown\";operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";port:number;previousHostKeyFingerprint?:string|undefined;remoteUser:string;requestedDestination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string}};approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";preparationId:string;requestId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_PREPARE_VERSION};status:\"ok\";type:\"relay:ssh-prepared\"}|{relayId:string;type:\"relay:disconnect\"}|{relayId:string;type:\"relay:heartbeat\"}|{serverName:string;tools:{annotations?:undefined|{[key:string]:unknown};description?:string|undefined;inputSchema:unknown;name:string}[];type:\"relay:advertise-mcp-tools\"}"
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
      "declaration.payload:{allowedRoots?:string[]|undefined;approvalObtained:boolean;args:{[key:string]:unknown};browserPageOwnerBinding?:undefined|{desktopSessionId:null|string;instanceId:string;relayId:string;userId:string};browserPageSnapshotReferencePublication?:true|undefined;correlationId:string;desktopFilesystemGrantRequest?:undefined|{grantIds:string[];operation:unresolved<DesktopFilesystemAccessOperation>;policy:{expiresAt?:string|undefined;lifetime:unresolved<DesktopFilesystemGrantLifetime>;policyVersion:number};requestedRoot:string;requiredOperations?:undefined|unresolved<DesktopFilesystemAccessOperation>[];subject:unresolved<DesktopFilesystemGrantSubject>;version:typeof RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION};executionClass?:\"browser\"|\"desktop\"|\"fs\"|\"local-file\"|\"real_workstation\"|\"structured-ssh\"|undefined;impact:\"destructive\"|\"high\"|\"low\"|\"read-only\";reportRunShellProgress?:(progress: Omit<RelayRunShellProgressMessage, \"type\" | \"correlationId\">) => void|undefined;reportStructuredSshProgress?:(progress: RelayStructuredSshProgressObservation) => void|undefined;runShellOwnerBinding?:undefined|{desktopSessionId:null|string;instanceId:string;relayId:string;userId:string};sandboxProfile?:undefined|{config:{mode:\"disabled\"|\"enabled\";networkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};passthroughEnv:string[];projectPaths:string[];protectedFileMaskPath?:string;protectedPaths?:string[];readOnlyPaths?:string[];writablePaths:string[]};dataDir:string;failIfNoBackend:boolean;mode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";toolsBin:string;workspace:string};sshBinding?:undefined|{admissionId:string;approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";preparationId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_DISPATCH_BINDING_VERSION};structuredSshOutputOwnerBinding?:undefined|{desktopSessionId:null|string;instanceId:string;relayId:string;userId:string};timeout?:number|undefined;toolName:string;workstationShellBinding?:undefined|{capabilityRevision:number;currentFolder:string;desktopSessionId:string;executionClass:typeof RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS;grantIds:string[];grantRevision:number;operation:unresolved<DesktopFilesystemAccessOperation>;pairingGeneration:string;profileId:string;profileRevision:number;protectedPolicyVersion:number;relayId:string;serverBindingId:string;subject:{agentScope:string;instanceId:string;relayId:string;userId:string};toolCallId:string;version:typeof RELAY_WORKSTATION_SHELL_BINDING_VERSION}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "args",
        "debtId": "debt.wire.arbitrary.1ezwf46"
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
      "declaration.payload:unresolved<RelayAcpServerMessage>|unresolved<RelayCodexCancelMessage>|unresolved<RelayCodexCommandMessage>|unresolved<RelayCodexCreditMessage>|unresolved<RelayCodexRequestResponseMessage>|unresolved<RelayRegisteredV8>|{allowedRoots?:string[]|undefined;approvalObtained:boolean;args:{[key:string]:unknown};correlationId:string;desktopFilesystemGrantRequest?:undefined|{grantIds:string[];operation:unresolved<DesktopFilesystemAccessOperation>;policy:{expiresAt?:string|undefined;lifetime:unresolved<DesktopFilesystemGrantLifetime>;policyVersion:number};requestedRoot:string;requiredOperations?:undefined|unresolved<DesktopFilesystemAccessOperation>[];subject:unresolved<DesktopFilesystemGrantSubject>;version:typeof RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION};executionClass?:\"browser\"|\"desktop\"|\"fs\"|\"local-file\"|\"real_workstation\"|\"structured-ssh\"|undefined;impact:\"destructive\"|\"high\"|\"low\"|\"read-only\";sandboxProfile?:undefined|{config:{mode:\"disabled\"|\"enabled\";networkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};passthroughEnv:string[];projectPaths:string[];protectedFileMaskPath?:string;protectedPaths?:string[];readOnlyPaths?:string[];writablePaths:string[]};dataDir:string;failIfNoBackend:boolean;mode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";toolsBin:string;workspace:string};sshBinding?:undefined|{admissionId:string;approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";preparationId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_DISPATCH_BINDING_VERSION};timeout?:number|undefined;toolName:string;type:\"relay:dispatch\";workstationShellBinding?:undefined|{capabilityRevision:number;currentFolder:string;desktopSessionId:string;executionClass:typeof RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS;grantIds:string[];grantRevision:number;operation:unresolved<DesktopFilesystemAccessOperation>;pairingGeneration:string;profileId:string;profileRevision:number;protectedPolicyVersion:number;relayId:string;serverBindingId:string;subject:{agentScope:string;instanceId:string;relayId:string;userId:string};toolCallId:string;version:typeof RELAY_WORKSTATION_SHELL_BINDING_VERSION}}|{capabilityRevision:number;error?:string|undefined;relayId:string;status:\"ok\"|\"rejected\";type:\"relay:capabilities-updated\"}|{correlationId:string;type:\"relay:cancel\"}|{digest:string;requestId:string;server:{envPassthrough?:null|string[]|undefined;excludeTools?:null|string[]|undefined;includeTools?:null|string[]|undefined;name:string;namespaceId?:null|string|undefined;transport:{[key:string]:unknown};transportKind:\"sse-legacy\"|\"stdio\"|\"streamable-http\";trustTier?:null|string|undefined};type:\"relay:mcp-preflight\"}|{message:string;type:\"relay:error\"}|{operation?:undefined|{digest:string;operationId:string;phase:\"rollback\"|\"start\";targetName:string};servers:{envPassthrough?:null|string[]|undefined;excludeTools?:null|string[]|undefined;includeTools?:null|string[]|undefined;name:string;namespaceId?:null|string|undefined;transport:{[key:string]:unknown};transportKind:\"sse-legacy\"|\"stdio\"|\"streamable-http\";trustTier?:null|string|undefined}[];type:\"relay:configure-mcp\"}|{protocolVersion?:number|undefined;relayId:string;type:\"relay:registered\"}|{request:{approvedRequest:{args:{argv:string[];destination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string};program:string;timeoutReason?:string|undefined;timeoutSeconds:number};toolCallId:string;toolName:\"structured_ssh_exec\";version:typeof RELAY_SSH_APPROVED_REQUEST_VERSION}|{args:{destination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string};localPath:string;remotePath:string;timeoutReason?:string|undefined;timeoutSeconds:number};toolCallId:string;toolName:\"structured_ssh_copy_download\";version:typeof RELAY_SSH_APPROVED_REQUEST_VERSION}|{args:{destination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string};localPath:string;remotePath:string;timeoutReason?:string|undefined;timeoutSeconds:number};toolCallId:string;toolName:\"structured_ssh_copy_upload\";version:typeof RELAY_SSH_APPROVED_REQUEST_VERSION}|{args:{destination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string}};toolCallId:string;toolName:\"structured_ssh_auth\";version:typeof RELAY_SSH_APPROVED_REQUEST_VERSION};approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";requestId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_PREPARE_VERSION};type:\"relay:ssh-prepare\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "args",
        "debtId": "debt.wire.arbitrary.10l7ijx"
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
    "observationId": "wire.relay.server.to.client.arbitrary.packages.relay.src.protocol.ts.relayconfiguremcpmessage.z8znmh",
    "locator": "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayConfigureMcpMessage",
    "structuralSignatures": [
      "declaration.payload:{operation?:undefined|{digest:string;operationId:string;phase:\"rollback\"|\"start\";targetName:string};servers:{envPassthrough?:null|string[]|undefined;excludeTools?:null|string[]|undefined;includeTools?:null|string[]|undefined;name:string;namespaceId?:null|string|undefined;transport:{[key:string]:unknown};transportKind:\"sse-legacy\"|\"stdio\"|\"streamable-http\";trustTier?:null|string|undefined}[];type:\"relay:configure-mcp\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "servers[].transport",
        "debtId": "debt.wire.arbitrary.2f04dp"
      }
    ]
  },
  {
    "observationId": "wire.relay.server.to.client.arbitrary.packages.relay.src.protocol.ts.relaydispatchmessage.f3am3r",
    "locator": "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage",
    "structuralSignatures": [
      "declaration.payload:{allowedRoots?:string[]|undefined;approvalObtained:boolean;args:{[key:string]:unknown};correlationId:string;desktopFilesystemGrantRequest?:undefined|{grantIds:string[];operation:unresolved<DesktopFilesystemAccessOperation>;policy:{expiresAt?:string|undefined;lifetime:unresolved<DesktopFilesystemGrantLifetime>;policyVersion:number};requestedRoot:string;requiredOperations?:undefined|unresolved<DesktopFilesystemAccessOperation>[];subject:unresolved<DesktopFilesystemGrantSubject>;version:typeof RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION};executionClass?:\"browser\"|\"desktop\"|\"fs\"|\"local-file\"|\"real_workstation\"|\"structured-ssh\"|undefined;impact:\"destructive\"|\"high\"|\"low\"|\"read-only\";sandboxProfile?:undefined|{config:{mode:\"disabled\"|\"enabled\";networkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};passthroughEnv:string[];projectPaths:string[];protectedFileMaskPath?:string;protectedPaths?:string[];readOnlyPaths?:string[];writablePaths:string[]};dataDir:string;failIfNoBackend:boolean;mode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";toolsBin:string;workspace:string};sshBinding?:undefined|{admissionId:string;approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";preparationId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_DISPATCH_BINDING_VERSION};timeout?:number|undefined;toolName:string;type:\"relay:dispatch\";workstationShellBinding?:undefined|{capabilityRevision:number;currentFolder:string;desktopSessionId:string;executionClass:typeof RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS;grantIds:string[];grantRevision:number;operation:unresolved<DesktopFilesystemAccessOperation>;pairingGeneration:string;profileId:string;profileRevision:number;protectedPolicyVersion:number;relayId:string;serverBindingId:string;subject:{agentScope:string;instanceId:string;relayId:string;userId:string};toolCallId:string;version:typeof RELAY_WORKSTATION_SHELL_BINDING_VERSION}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "args",
        "debtId": "debt.wire.arbitrary.18ha82p"
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
    "observationId": "wire.relay.server.to.client.relay.configure.mcp.1w565ft",
    "locator": "relay:server_to_client:relay:configure-mcp",
    "structuralSignatures": [
      "frame.payload:{operation?:undefined|{digest:string;operationId:string;phase:\"rollback\"|\"start\";targetName:string};servers:{envPassthrough?:null|string[]|undefined;excludeTools?:null|string[]|undefined;includeTools?:null|string[]|undefined;name:string;namespaceId?:null|string|undefined;transport:{[key:string]:unknown};transportKind:\"sse-legacy\"|\"stdio\"|\"streamable-http\";trustTier?:null|string|undefined}[];type:\"relay:configure-mcp\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "servers[].transport",
        "debtId": "debt.wire.arbitrary.cad6wt"
      }
    ]
  },
  {
    "observationId": "wire.relay.server.to.client.relay.dispatch.lnqowy",
    "locator": "relay:server_to_client:relay:dispatch",
    "structuralSignatures": [
      "frame.payload:{allowedRoots?:string[]|undefined;approvalObtained:boolean;args:{[key:string]:unknown};correlationId:string;desktopFilesystemGrantRequest?:undefined|{grantIds:string[];operation:unresolved<DesktopFilesystemAccessOperation>;policy:{expiresAt?:string|undefined;lifetime:unresolved<DesktopFilesystemGrantLifetime>;policyVersion:number};requestedRoot:string;requiredOperations?:undefined|unresolved<DesktopFilesystemAccessOperation>[];subject:unresolved<DesktopFilesystemGrantSubject>;version:typeof RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION};executionClass?:\"browser\"|\"desktop\"|\"fs\"|\"local-file\"|\"real_workstation\"|\"structured-ssh\"|undefined;impact:\"destructive\"|\"high\"|\"low\"|\"read-only\";sandboxProfile?:undefined|{config:{mode:\"disabled\"|\"enabled\";networkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};passthroughEnv:string[];projectPaths:string[];protectedFileMaskPath?:string;protectedPaths?:string[];readOnlyPaths?:string[];writablePaths:string[]};dataDir:string;failIfNoBackend:boolean;mode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";toolsBin:string;workspace:string};sshBinding?:undefined|{admissionId:string;approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";preparationId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_DISPATCH_BINDING_VERSION};timeout?:number|undefined;toolName:string;type:\"relay:dispatch\";workstationShellBinding?:undefined|{capabilityRevision:number;currentFolder:string;desktopSessionId:string;executionClass:typeof RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS;grantIds:string[];grantRevision:number;operation:unresolved<DesktopFilesystemAccessOperation>;pairingGeneration:string;profileId:string;profileRevision:number;protectedPolicyVersion:number;relayId:string;serverBindingId:string;subject:{agentScope:string;instanceId:string;relayId:string;userId:string};toolCallId:string;version:typeof RELAY_WORKSTATION_SHELL_BINDING_VERSION}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "args",
        "debtId": "debt.wire.arbitrary.1ctmkbq"
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
    "observationId": "wire.sse.accepted.post.api.profile.generate.soul.stream.soul.completed.jx54zo",
    "locator": "sse:accepted:POST /api/profile/generate-soul/stream#soul.completed",
    "structuralSignatures": [
      "consumer:apps/desktop/electron/main.ts#1:event.payload:{error?:unknown;fallback?:unknown;soulFile?:unknown;text?:unknown}"
    ],
    "arbitraryPayloads": [
      {
        "path": "event.payload.error",
        "debtId": "debt.wire.arbitrary.1y58h4n"
      },
      {
        "path": "event.payload.fallback",
        "debtId": "debt.wire.arbitrary.1sv1f85"
      },
      {
        "path": "event.payload.soulFile",
        "debtId": "debt.wire.arbitrary.l4xyji"
      },
      {
        "path": "event.payload.text",
        "debtId": "debt.wire.arbitrary.1c1wkkg"
      }
    ]
  },
  {
    "observationId": "wire.sse.accepted.post.api.profile.generate.soul.stream.soul.delta.1k2xuyj",
    "locator": "sse:accepted:POST /api/profile/generate-soul/stream#soul.delta",
    "structuralSignatures": [
      "consumer:apps/desktop/electron/main.ts#1:event.payload:{error?:unknown;fallback?:unknown;soulFile?:unknown;text?:unknown}"
    ],
    "arbitraryPayloads": [
      {
        "path": "event.payload.error",
        "debtId": "debt.wire.arbitrary.11c0hak"
      },
      {
        "path": "event.payload.fallback",
        "debtId": "debt.wire.arbitrary.1dgayd4"
      },
      {
        "path": "event.payload.soulFile",
        "debtId": "debt.wire.arbitrary.1hb1ksj"
      },
      {
        "path": "event.payload.text",
        "debtId": "debt.wire.arbitrary.bf8ukh"
      }
    ]
  },
  {
    "observationId": "wire.sse.accepted.post.api.profile.generate.soul.stream.soul.error.16oy9mr",
    "locator": "sse:accepted:POST /api/profile/generate-soul/stream#soul.error",
    "structuralSignatures": [
      "consumer:apps/desktop/electron/main.ts#1:event.payload:{error?:unknown;fallback?:unknown;soulFile?:unknown;text?:unknown}"
    ],
    "arbitraryPayloads": [
      {
        "path": "event.payload.error",
        "debtId": "debt.wire.arbitrary.1eu3p5w"
      },
      {
        "path": "event.payload.fallback",
        "debtId": "debt.wire.arbitrary.1tw5n5s"
      },
      {
        "path": "event.payload.soulFile",
        "debtId": "debt.wire.arbitrary.14x2aaj"
      },
      {
        "path": "event.payload.text",
        "debtId": "debt.wire.arbitrary.kw4ikp"
      }
    ]
  }
];

export const REVIEWED_MAIN_2026_08_11_SUPERSEDED_DTO_LOCATORS:
  ReadonlySet<string> = new Set([
  "http:accepted_arbitrary:packages/server/src/messaging/dispatch.ts#RoomPostMessageBody",
  "http:accepted_arbitrary:packages/types/src/api.ts#SendMessageRequest",
  "http:request_response:DELETE /api/mcp-servers/:name",
  "http:request_response:GET /api/mcp-servers",
  "http:request_response:GET /api/mcp-servers/:name",
  "http:request_response:GET /api/mcp-servers/:name/tools",
  "http:request_response:GET /api/profile/agent-photo-library/entries/:entryId/media",
  "http:request_response:GET /api/rooms/:id/messages",
  "http:request_response:GET /api/security/audit-log",
  "http:request_response:GET /api/sessions/latest",
  "http:request_response:GET /api/setup/status",
  "http:request_response:GET /api/tasks",
  "http:request_response:GET /api/tasks/:id",
  "http:request_response:GET /api/voices",
  "http:request_response:GET /api/workspace/artifacts/:id",
  "http:request_response:PATCH /api/mcp-servers/:name/enabled",
  "http:request_response:PATCH /api/mcp-servers/:name/tools/:tool",
  "http:request_response:PATCH /api/tasks/:id",
  "http:request_response:PATCH /api/workspace/artifacts/:id",
  "http:request_response:POST /api/apps/:appId/live-session/apply-accepted",
  "http:request_response:POST /api/auth/approval-reply",
  "http:request_response:POST /api/bind-logto-user",
  "http:request_response:POST /api/chat",
  "http:request_response:POST /api/file/invoke-direct",
  "http:request_response:POST /api/mcp-servers",
  "http:request_response:POST /api/office/new",
  "http:request_response:POST /api/rooms/:roomId/messages",
  "http:request_response:POST /api/server/icon",
  "http:request_response:POST /api/server/profile",
  "http:request_response:POST /api/workspace/artifacts",
  "http:request_response:PUT /api/mcp-servers/:name",
  "http:request_response:PUT /api/skills",
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayClientMessage",
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest",
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage",
  "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayConfigureMcpMessage",
  "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage",
  "relay:server_to_client:relay:configure-mcp",
  "relay:server_to_client:relay:dispatch",
  "sse:accepted:POST /api/profile/generate-soul/stream#soul.completed",
  "sse:accepted:POST /api/profile/generate-soul/stream#soul.delta",
  "sse:accepted:POST /api/profile/generate-soul/stream#soul.error"
]);

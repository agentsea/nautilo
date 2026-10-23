import type { DtoDeclaration } from "../src/node/dto-inventory";

export const SUPERSEDED_MAIN_2026_10_13_DTO_LOCATORS = new Set<string>([
  "http:accepted_arbitrary:packages/types/src/api.ts#ChatSearchConversationHit",
  "http:accepted_arbitrary:packages/types/src/api.ts#ChatSearchPage",
  "http:accepted_arbitrary:packages/types/src/api.ts#RoomSummaryDto",
  "http:produced_arbitrary:packages/types/src/api.ts#ListRoomsResponse",
  "http:produced_arbitrary:packages/types/src/api.ts#RoomDetailResponse",
  "http:request_response:GET /api/admin/server-models",
  "http:request_response:GET /api/apps/:appId/runtime",
  "http:request_response:GET /api/auth/whoami",
  "http:request_response:GET /api/costs",
  "http:request_response:GET /api/event-feed",
  "http:request_response:GET /api/groups/:id/members",
  "http:request_response:GET /api/health/keys",
  "http:request_response:GET /api/invites",
  "http:request_response:GET /api/profile/avatar",
  "http:request_response:GET /api/rooms",
  "http:request_response:GET /api/rooms/:id",
  "http:request_response:GET /api/rooms/:id/agents/:agentId/avatar",
  "http:request_response:GET /api/rooms/:id/manage-detail",
  "http:request_response:GET /api/rooms/:id/messages",
  "http:request_response:GET /api/rooms/:id/messages/:messageId/around",
  "http:request_response:GET /api/rooms/:roomId/agents/:agentId/model-control-selection",
  "http:request_response:GET /api/rooms/discoverable",
  "http:request_response:GET /api/rooms/manageable",
  "http:request_response:GET /api/rooms/search",
  "http:request_response:GET /api/security/audit-log",
  "http:request_response:GET /api/security/posture",
  "http:request_response:GET /api/security/uncontained-host-commands/session",
  "http:request_response:GET /api/sessions/latest",
  "http:request_response:GET /api/tasks/:id/agent/avatar",
  "http:request_response:GET /api/users/:id/avatar",
  "http:request_response:GET /api/voices",
  "http:request_response:GET /api/voices/catalog",
  "http:request_response:PATCH /api/rooms/:id",
  "http:request_response:POST /api/admin/access-control/changes/preview",
  "http:request_response:POST /api/admin/server-models",
  "http:request_response:POST /api/admin/users/provision",
  "http:request_response:POST /api/auth/approval-reply",
  "http:request_response:POST /api/auth/pin",
  "http:request_response:POST /api/chat",
  "http:request_response:POST /api/health/keys/validate",
  "http:request_response:POST /api/profile/generate-soul",
  "http:request_response:POST /api/profile/generate-soul/stream",
  "http:request_response:POST /api/rooms",
  "http:request_response:POST /api/rooms/:id/join",
  "http:request_response:POST /api/rooms/:id/visibility",
  "http:request_response:POST /api/rooms/:roomId/live-shadow/plan",
  "http:request_response:POST /api/rooms/:roomId/pending-attention",
  "http:request_response:POST /api/rooms/:roomId/pending-attention/read",
  "http:request_response:POST /api/rooms/resolve-landing",
  "http:request_response:POST /api/stt",
  "http:request_response:POST /api/voices/:voiceId/preview",
  "http:request_response:PUT /api/profile",
  "http:request_response:PUT /api/security/posture",
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest",
  "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayServerMessage",
  "relay:server_to_client:relay:dispatch",
  "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage"
]);

export const REVIEWED_MAIN_2026_10_13_DTO_REPLACEMENTS: readonly DtoDeclaration[] = [
  {
    "observationId": "wire.http.accepted.arbitrary.packages.types.src.api.ts.chatsearchconversationhit.zjhaz6",
    "locator": "http:accepted_arbitrary:packages/types/src/api.ts#ChatSearchConversationHit",
    "structuralSignatures": [
      "declaration.payload:{matchedBy:\"label\"|\"participant\";room:{createdAt:string;discoverable?:boolean;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;lastMessageAt?:null|string;memberCount:number;messageCount?:number;parentRoomId?:null|string;roster?:{actorId:string;agentAvatar?:null|unresolved<AvatarRef>;agentId?:string;displayName:string;federatedId?:string;handle?:null|string;kind:\"agent\"|\"user\";userId?:string}[];threadRootMessageId?:null|number;type:string;unreadCount?:number}}"
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
      "declaration.payload:{conversations:{matchedBy:\"label\"|\"participant\";room:{createdAt:string;discoverable?:boolean;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;lastMessageAt?:null|string;memberCount:number;messageCount?:number;parentRoomId?:null|string;roster?:{actorId:string;agentAvatar?:null|unresolved<AvatarRef>;agentId?:string;displayName:string;federatedId?:string;handle?:null|string;kind:\"agent\"|\"user\";userId?:string}[];threadRootMessageId?:null|number;type:string;unreadCount?:number}}[];conversationsTruncated:boolean;hasMoreOlderMessages:boolean;messageAsOf:null|{createdAt:string;messageId:string};messages:{parentRoomId?:string;parentRoomLabel?:string;roomId:string;roomKind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";roomLabel:string}[];nextOlderMessageCursor:null|{createdAt:string;messageId:string}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "conversations[].room.roster[].agentAvatar",
        "schema": "AvatarRef"
      }
    ]
  },
  {
    "observationId": "wire.http.accepted.arbitrary.packages.types.src.api.ts.roomsummarydto.14sn4d2",
    "locator": "http:accepted_arbitrary:packages/types/src/api.ts#RoomSummaryDto",
    "structuralSignatures": [
      "declaration.payload:{createdAt:string;discoverable?:boolean;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;lastMessageAt?:null|string;memberCount:number;messageCount?:number;parentRoomId?:null|string;roster?:{actorId:string;agentAvatar?:null|unresolved<AvatarRef>;agentId?:string;displayName:string;federatedId?:string;handle?:null|string;kind:\"agent\"|\"user\";userId?:string}[];threadRootMessageId?:null|number;type:string;unreadCount?:number}"
    ],
    "arbitraryPayloads": [
      {
        "path": "roster[].agentAvatar",
        "schema": "AvatarRef"
      }
    ]
  },
  {
    "observationId": "wire.http.produced.arbitrary.packages.types.src.api.ts.listroomsresponse.1hzt8au",
    "locator": "http:produced_arbitrary:packages/types/src/api.ts#ListRoomsResponse",
    "structuralSignatures": [
      "declaration.payload:{rooms:{createdAt:string;discoverable?:boolean;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;lastMessageAt?:null|string;memberCount:number;messageCount?:number;parentRoomId?:null|string;roster?:{actorId:string;agentAvatar?:null|unresolved<AvatarRef>;agentId?:string;displayName:string;federatedId?:string;handle?:null|string;kind:\"agent\"|\"user\";userId?:string}[];threadRootMessageId?:null|number;type:string;unreadCount?:number}[]}"
    ],
    "arbitraryPayloads": [
      {
        "path": "rooms[].roster[].agentAvatar",
        "schema": "AvatarRef"
      }
    ]
  },
  {
    "observationId": "wire.http.produced.arbitrary.packages.types.src.api.ts.roomdetailresponse.1994mda",
    "locator": "http:produced_arbitrary:packages/types/src/api.ts#RoomDetailResponse",
    "structuralSignatures": [
      "declaration.payload:{conductorMode:\"advanced\"|\"standard\";createdAt:string;discoverable?:boolean;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;members:{actorId:string;agentAvatar?:null|undefined|unresolved<AvatarRef>;agentId?:string|undefined;agentOwnerDisplayName?:null|string|undefined;agentOwnerHandle?:null|string|undefined;agentOwnerUserId?:string|undefined;agentResponseMode?:\"active\"|\"mention_only\"|\"observe\"|null|undefined;displayName:string;handle?:null|string|undefined;kind:\"agent\"|\"user\";roomRole:\"admin\"|\"member\";userId?:string|undefined}[];namespaceId?:null|string;parentRoomId?:null|string;threadRootMessageId?:null|number;type:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "members[].agentAvatar",
        "debtId": "debt.wire.arbitrary.5zfch8"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.admin.server.models.1k8b8za",
    "locator": "http:request_response:GET /api/admin/server-models",
    "structuralSignatures": [
      "response.body:{catalogModels:{availability:\"disabled\"|\"missing_credentials\"|\"routing_filtered\"|\"selectable\"|\"unknown_model\";decision:{operations:\"choice\"|\"noul\"|\"score\"[]};directAvailability:\"disabled\"|\"missing_credentials\"|\"routing_filtered\"|\"selectable\"|\"unknown_model\";directUnavailableReason?:string;displayName:string;features:{e2ee:boolean;reasoning:boolean;structuredOutputs:boolean;tools:boolean;visualGrounding:boolean;webSearch:boolean};id:string;input:\"file\"|\"image\"|\"text\"[];output:\"audio\"|\"embedding\"|\"image\"|\"text\"|\"video\"[];provider:string;unavailableReason?:string;workload:\"chat\"|\"decision\"|\"generation\"|\"speech\"}[];conductorModel:string;defaultChatModel:string;effectiveEmbeddingModel:string;effectiveImageModel:string;effectiveMusicModel:string;effectiveSpeechModel:string;effectiveVideoModel:string;embeddingModel:string;embeddingModels:{available:boolean;displayName:string;id:string}[];embeddingSelectionPending:boolean;fallbackChain:string[];imageModel:string;imageModels:{available:boolean;displayName:string;id:string;provider:string;unavailableReason?:string}[];memoryReviewModel:string;musicModel:string;musicModels:{available:boolean;displayName:string;id:string;provider:string;unavailableReason?:string}[];preferSurplus:boolean;reasoningOutput:{[key:string]:boolean};reasoningPolicy:{defaultEffort:\"high\"|\"low\"|\"max\"|\"medium\"|\"minimal\"|\"off\"|\"xhigh\";overrides:{[key:string]:\"high\"|\"low\"|\"max\"|\"medium\"|\"minimal\"|\"off\"|\"xhigh\"}};reflectionModel:string;speechModel:string;speechModels:{available:boolean;displayName:string;id:string;provider:string;unavailableReason?:string}[];stenographerModel:string;surplus:{chatStatus:\"available\"|\"not-qualified\"|\"qualified-unavailable\";keyConfigured:boolean;policyEnabled:boolean};videoModel:string;videoModels:{available:boolean;displayName:string;id:string;provider:string;unavailableReason?:string}[]}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.apps.appid.runtime.rsa41g",
    "locator": "http:request_response:GET /api/apps/:appId/runtime",
    "structuralSignatures": [
      "request.params:{appId:string}",
      "response.body:{error:string;message:any;status:any}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.message",
        "debtId": "debt.wire.arbitrary.16onp1h"
      },
      {
        "path": "response.body.status",
        "debtId": "debt.wire.arbitrary.9plc14"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.auth.whoami.1qlua20",
    "locator": "http:request_response:GET /api/auth/whoami",
    "structuralSignatures": [
      "response.body:{capabilities:\"approve_destructive_actions\"|\"approve_spending\"|\"ban_room_members\"|\"ban_server_members\"|\"control_browser\"|\"control_desktop\"|\"control_home\"|\"create_invites\"|\"create_rooms\"|\"invoke_agents\"|\"invoke_other_agents\"|\"kick_room_members\"|\"kick_server_members\"|\"manage_agents\"|\"manage_billing\"|\"manage_connection_providers\"|\"manage_groups\"|\"manage_members\"|\"manage_memories\"|\"manage_roles\"|\"manage_rooms\"|\"manage_server_enrollment\"|\"manage_server_operations\"|\"manage_server_security\"|\"manage_server_settings\"|\"manage_standing_approvals\"|\"manage_uncontained_host_commands\"|\"manage_workstation_profiles\"|\"moderate_content_reports\"|\"read_memories\"|\"read_server_settings\"|\"timeout_room_members\"|\"timeout_server_members\"|\"use_connections\"|\"use_google_workspace\"|\"use_image_generation\"|\"use_media_generation\"|\"use_personal_provider_credentials\"|\"use_project_content\"|\"use_project_execution\"|\"use_remote_hosts\"|\"use_research_tools\"|\"use_server_provider_credentials\"|\"use_share_artifact\"|\"use_transcription\"|\"use_workstation\"|\"view_audit_log\"|\"view_room_moderation\"|\"view_server_moderation\"|\"write_artifacts\"[];displayName:string;externalId:string;features?:{office:{enabled:boolean};roomDiscoverability?:boolean};groups:{id:string;label:string;roleSlug:string;type:string}[];handle:string;highestRole:string;instanceId:string;mustChangePassword:boolean;sessionActorId:string;sessionUserId:string;userIdentity:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.costs.vkk56s",
    "locator": "http:request_response:GET /api/costs",
    "structuralSignatures": [
      "request.query:{[key:string]:unknown}",
      "response.body:{byCallType:{callType:string;calls:number;totalCostUsd:number}[];byModel:{actualCostUsd:number;calls:number;displayName:string;estimatedCostUsd:number;hasActual:boolean;hasFallbackEstimate:boolean;inputTokens:number;model:string;outputTokens:number;pendingAttempts:number;provider:string;totalCostUsd:number;unknownAttempts:number}[];byProvider:{actualCostUsd:number;estimatedCostUsd:number;operation:string;operations:number;provider:string;totalCostUsd:number;unknownOperations:number}[];byUser:{actualCostUsd:number;calls:number;estimatedCostUsd:number;handle:string;label:string;name:string;providerOperations:number;totalCostUsd:number;totalTokens:number;unknownProviderOperations:number;userId:string}[];pricingVersion:string;providerCoverage:{accounted:{operation:string;provider:string}[];state:\"partial\";unavailable:string[]};providerPricingVersion:string;range:{key:string;since:string;until:string};recovery:{attempts:{attemptId:string;lastObservedAt:string;providerRoute:string;reason:string;repairAction:\"check_receipt_access\"|\"contact_operator\"|\"retry_receipt_read\"|\"review_cost\"|\"wait_for_receipt\";requestReference:string;status:\"blocked\"|\"pending\"|\"retryable\"|\"unrecoverable\";taskId:string}[];blockedAttempts:number;pendingAttempts:number;retryableAttempts:number;unknownAttempts:number};serviceOperations:{cancelled:number;failed:number;interrupted:number;legacy:number;operations:number;succeeded:number;unknown:number};serviceRecovery:{attempts:{attemptOutcome:\"cancelled\"|\"failed\"|\"interrupted\"|\"succeeded\"|\"unknown\";failureCode:string;jobId:string;occurredAt:string;operation:string;provider:string;requestReference:string;runId:string;taskId:string;workload:string}[]};timeSeries:{actualCostUsd:number;day:string;estimatedCostUsd:number;totalCostUsd:number}[];totals:{actualCostUsd:number;cachedInputTokens:number;calls:number;estimatedCostUsd:number;inputTokens:number;outputTokens:number;pendingModelAttempts:number;providerOperations:number;totalCostUsd:number;totalTokens:number;unknownModelAttempts:number;unknownProviderOperations:number}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.query",
        "debtId": "debt.wire.arbitrary.c21xww"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.event.feed.11jrf51",
    "locator": "http:request_response:GET /api/event-feed",
    "structuralSignatures": [
      "request.query:{[key:string]:unknown;cursor?:unknown;limit?:unknown;types?:unknown;unreadOnly?:unknown}",
      "response.body:{code:\"invalid_cursor\"|\"invalid_input\"|\"not_found\";error:\"event_feed_error\"}",
      "response.body:{code:string;error:string}",
      "response.body:{error:string}",
      "response.body:{events:{actorDisplayName:string;actorId?:string;actorKind:\"agent\"|\"human\";createdAt:string;data:{action:\"ban\"|\"kick\"|\"lift\";operationId?:string;userId?:string};id?:string;readAt?:string;type:\"moderation.action\"}|{actorDisplayName:string;actorId?:string;actorKind:\"agent\"|\"human\";createdAt:string;data:{artifactId:string;destination?:{kind:\"person\";userId?:string}|{kind:\"room\";roomId?:string}};id?:string;readAt?:string;type:\"artifact.shared\"}|{actorDisplayName:string;actorId?:string;actorKind:\"agent\"|\"human\";createdAt:string;data:{artifactId:string;roomId?:string};id?:string;readAt?:string;type:\"artifact.added\"}|{actorDisplayName:string;actorId?:string;actorKind:\"agent\"|\"human\";createdAt:string;data:{roomId?:string;userId?:string};id?:string;readAt?:string;type:\"room.member_joined\"}|{actorDisplayName:string;actorId?:string;actorKind:\"agent\"|\"human\";createdAt:string;data:{roomId?:string;userId?:string};id?:string;readAt?:string;type:\"room.member_left\"}|{actorId:any;actorKind:any;createdAt:string;data:__object;id:string;readAt:string;type:\"unknown\"}[];nextCursor?:string}",
      "response.body:{events:{actorDisplayName?:string;actorId?:string;actorKind:\"agent\"|\"human\";createdAt:string;data:{action:\"ban\"|\"kick\"|\"lift\";operationId?:string;userId?:string};id?:string;readAt?:string;type:\"moderation.action\"}|{actorDisplayName?:string;actorId?:string;actorKind:\"agent\"|\"human\";createdAt:string;data:{artifactId:string;destination?:{kind:\"person\";userId?:string}|{kind:\"room\";roomId?:string}};id?:string;readAt?:string;type:\"artifact.shared\"}|{actorDisplayName?:string;actorId?:string;actorKind:\"agent\"|\"human\";createdAt:string;data:{artifactId:string;roomId?:string};id?:string;readAt?:string;type:\"artifact.added\"}|{actorDisplayName?:string;actorId?:string;actorKind:\"agent\"|\"human\";createdAt:string;data:{roomId?:string;userId?:string};id?:string;readAt?:string;type:\"room.member_joined\"}|{actorDisplayName?:string;actorId?:string;actorKind:\"agent\"|\"human\";createdAt:string;data:{roomId?:string;userId?:string};id?:string;readAt?:string;type:\"room.member_left\"}|{actorId:any;actorKind:any;createdAt:string;data:__object;id:string;readAt:string;type:\"unknown\"}[];nextCursor?:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.query",
        "schema": "EventFeedHttpListQueryV1"
      },
      {
        "path": "response.body.events[].actorId",
        "schema": "EventFeedItemActorIdV1"
      },
      {
        "path": "response.body.events[].actorKind",
        "schema": "EventFeedItemActorKindV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.groups.id.members.c5exxi",
    "locator": "http:request_response:GET /api/groups/:id/members",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{error:string}",
      "response.body:{members:{displayName:string;groupType:string;handle:string;roleSlug:\"admin\"|\"community\"|\"contributor\"|\"guest\"|\"member\"|\"owner\"|\"superuser\";userId:string}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.health.keys.g9cqnd",
    "locator": "http:request_response:GET /api/health/keys",
    "structuralSignatures": [
      "response.body:{category:\"browser\"|\"conversion\"|\"decision\"|\"llm\"|\"llm+embeddings\"|\"search\"|\"voice\";envVar:string;formatHint:string;hint:string;id:string;masked:string;name:string;purpose:string;required:boolean;signupUrl:string;status:\"invalid_format\"|\"invalid_key\"|\"missing\"|\"present\"|\"unreachable\"|\"verified\"}[]",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.invites.1ucoajo",
    "locator": "http:request_response:GET /api/invites",
    "structuralSignatures": [
      "request.query:{all?:string;cursor?:string;limit?:string}",
      "response.body:{error:string}",
      "response.body:{invites:{codeAvailable:boolean;createdAt:Date;displayName:string;expiresAt:Date;id:string;kind:string;maxUses:number;revokedAt:Date;targetRoleSlug:string;targetRoomId:string;targetRoomLabel:string;usedCount:number}[];page:{complete:boolean;continuationAvailable:boolean;hasMore:boolean;nextCursor:string;returned:number}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.rooms.wqflaq",
    "locator": "http:request_response:GET /api/rooms",
    "structuralSignatures": [
      "response.body:{rooms:{createdAt:string;discoverable?:boolean;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;lastMessageAt?:string;memberCount:number;messageCount?:number;parentRoomId?:string;roster?:{actorId:string;agentAvatar?:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};agentId?:string;displayName:string;federatedId?:string;handle?:string;kind:\"agent\"|\"user\";userId?:string}[];threadRootMessageId?:number;type:string;unreadCount?:number}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.rooms.id.7993e",
    "locator": "http:request_response:GET /api/rooms/:id",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{conductorMode:\"advanced\"|\"standard\";createdAt:string;discoverable?:boolean;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;members:{actorId:string;agentAvatar?:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};agentId?:string;agentOwnerDisplayName?:string;agentOwnerHandle?:string;agentOwnerUserId?:string;agentResponseMode?:\"active\"|\"mention_only\"|\"observe\";displayName:string;handle?:string;kind:\"agent\"|\"user\";roomRole:\"admin\"|\"member\";userId?:string}[];namespaceId?:string;parentRoomId:string;threadRootMessageId:number;type:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.rooms.id.manage.detail.2anf9y",
    "locator": "http:request_response:GET /api/rooms/:id/manage-detail",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{conductorMode:\"advanced\"|\"standard\";createdAt:string;discoverable?:boolean;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;members:{actorId:string;agentAvatar?:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};agentId?:string;agentOwnerDisplayName?:string;agentOwnerHandle?:string;agentOwnerUserId?:string;agentResponseMode?:\"active\"|\"mention_only\"|\"observe\";displayName:string;handle?:string;kind:\"agent\"|\"user\";roomRole:\"admin\"|\"member\";userId?:string}[];namespaceId?:string;parentRoomId:string;threadRootMessageId:number;type:string}",
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
      "response.body:{code:string;error:string}",
      "response.body:{error:string}",
      "response.body:{messages:{artifacts:{artifactInternalId:string;basename:string;mimeType:string;roomId:string;sizeBytes:number}[];attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];authorAgentId?:string;authorHarnessId?:string;content:string;createdAt:Date;displayContent?:string;editRevision?:number;editedAt?:string;id:string;imageAssistance?:{attachmentIds:string[];modelDisplayName:string;modelId:string;status:\"completed\"};lastReplyAt?:string;logicalMessageKey?:string;reactions:{actorIds:string[];count:number;emoji:string;truncated:boolean}[];replyCount?:number;replyToMessageId?:number;role:string;sourceUserId?:string;summaryRevision?:number;toolCallId?:string;toolCalls:string;toolName?:string;toolStatus?:\"error\"|\"success\";workcardContinuation?:{kind:\"advanced_video\";referenceCount:number}}|{artifacts:{artifactInternalId:string;basename:string;mimeType:string;roomId:string;sizeBytes:number}[];attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];authorAgentId?:string;authorHarnessId?:string;content:string;createdAt:Date;displayContent?:string;editRevision?:number;editedAt?:string;id:string;imageAssistance?:{attachmentIds:string[];modelDisplayName:string;modelId:string;status:\"completed\"};lastReplyAt?:string;logicalMessageKey?:string;reactions?:undefined;replyCount?:number;replyToMessageId?:number;role:string;sourceUserId?:string;summaryRevision?:number;toolCallId?:string;toolCalls:string;toolName?:string;toolStatus?:\"error\"|\"success\";workcardContinuation?:{kind:\"advanced_video\";referenceCount:number}}|{artifacts?:undefined;attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];authorAgentId?:string;authorHarnessId?:string;content:string;createdAt:Date;displayContent?:string;editRevision?:number;editedAt?:string;id:string;imageAssistance?:{attachmentIds:string[];modelDisplayName:string;modelId:string;status:\"completed\"};lastReplyAt?:string;logicalMessageKey?:string;reactions:{actorIds:string[];count:number;emoji:string;truncated:boolean}[];replyCount?:number;replyToMessageId?:number;role:string;sourceUserId?:string;summaryRevision?:number;toolCallId?:string;toolCalls:string;toolName?:string;toolStatus?:\"error\"|\"success\";workcardContinuation?:{kind:\"advanced_video\";referenceCount:number}}|{artifacts?:undefined;attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];authorAgentId?:string;authorHarnessId?:string;content:string;createdAt:Date;displayContent?:string;editRevision?:number;editedAt?:string;id:string;imageAssistance?:{attachmentIds:string[];modelDisplayName:string;modelId:string;status:\"completed\"};lastReplyAt?:string;logicalMessageKey?:string;reactions?:undefined;replyCount?:number;replyToMessageId?:number;role:string;sourceUserId?:string;summaryRevision?:number;toolCallId?:string;toolCalls:string;toolName?:string;toolStatus?:\"error\"|\"success\";workcardContinuation?:{kind:\"advanced_video\";referenceCount:number}}[];pageInfo:{hasMoreBefore:boolean;oldestCursor:{createdAt:string;id:string}};shadowEncryption?:any}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.shadowEncryption",
        "schema": "ProtectedMessageDtoV2"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.rooms.id.messages.messageid.around.1hmvihg",
    "locator": "http:request_response:GET /api/rooms/:id/messages/:messageId/around",
    "structuralSignatures": [
      "request.params:{id:string;messageId:string}",
      "request.query:{[key:string]:string}",
      "response.body:{code:string;error:string}",
      "response.body:{error:string}",
      "response.body:{hasNewer:boolean;hasOlder:boolean;includedToolCallCompanion:boolean;messages:{authorAgentId?:string;authorHarnessId?:string;content:string;createdAt:string;displayContent?:string;editRevision?:number;editedAt?:string;id:string;imageAssistance?:{attachmentIds:string[];modelDisplayName:string;modelId:string;status:\"completed\"};lastReplyAt?:string;logicalMessageKey?:string;replyCount?:number;replyToMessageId?:number;role:string;sourceUserId?:string;summaryRevision?:number;toolCallId?:string;toolCalls:string;toolName?:string;toolStatus?:\"error\"|\"success\";workcardContinuation?:{kind:\"advanced_video\";referenceCount:number}}[];shadowEncryption?:{acknowledgement?:{expiresAt:string;issuedAt:string;status:\"required\";tokenBase64url:string}|{status:\"already_recorded\"};authorities?:{domainAuthorizationRevision:number;domainHeadDigestBase64url:string;domainId:string;domainKeyGeneration:number;hostAuthorizationRevision:number;keyClass:\"ai\"|\"human\";namespaceAccessRevision:number;namespaceBundleDigestBase64url:string;namespaceBundleRevision:number;namespaceCurrentGeneration:number;namespaceHeadDigestBase64url:string;namespaceId:string;policyRevision:number;readerDeviceId:string;readerDeviceSigningKeyGeneration:number;roomId:string;scheme:\"domain_key_v2\";subjectHumanId:string}[];authority:{domainAuthorizationRevision:number;domainHeadDigestBase64url:string;domainId:string;domainKeyGeneration:number;hostAuthorizationRevision:number;keyClass:\"ai\"|\"human\";namespaceAccessRevision:number;namespaceBundleDigestBase64url:string;namespaceBundleRevision:number;namespaceCurrentGeneration:number;namespaceHeadDigestBase64url:string;namespaceId:string;policyRevision:number;readerDeviceId:string;readerDeviceSigningKeyGeneration:number;roomId:string;scheme:\"domain_key_v2\";subjectHumanId:string};clientRequestKey:string;eligibleCount:number;operationId:string;records:{authorHumanId:string;committerDeviceSigningPublicKeyBase64url:string;coordinate:{editRevision:number;logicalMessageKey:string;messageId:number;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sessionId:string};kind:\"human_edited_representation\";ordinaryPayloadBytesBase64url:string;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};representationMode:\"ordinary-and-protected\";retainedGeneration:{accessRevision:number;audienceFingerprintBase64url:string;headDigestBase64url:string;namespaceGeneration:number;publicationDigestBase64url:string;publicationSetDigestBase64url:string}}|{authorHumanId:string;committerDeviceSigningPublicKeyBase64url:string;coordinate:{editRevision:number;logicalMessageKey:string;messageId:number;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sessionId:string};kind:\"human_edited_representation\";protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};representationMode:\"protected-only\";retainedGeneration:{accessRevision:number;audienceFingerprintBase64url:string;headDigestBase64url:string;namespaceGeneration:number;publicationDigestBase64url:string;publicationSetDigestBase64url:string};selectedSource:{authorAgentId?:string;logicalMessageKey?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sourceUserId?:string}}|{coordinate:{editRevision:number;logicalMessageKey:string;messageId:number;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sessionId:string};kind:\"existing_representation\";ordinaryPayloadBytesBase64url?:string;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};repair:{allocationDigestBase64url:string;attestationDigestBase64url:string;identityDigestBase64url:string;publisherHumanId:string;publisherKind:\"human_device\";publisherSignerKeyId:string;publisherSigningPublicKeyBase64url:string};retainedGeneration:{accessRevision:number;audienceFingerprintBase64url:string;headDigestBase64url:string;namespaceGeneration:number;publicationDigestBase64url:string;publicationSetDigestBase64url:string}}|{coordinate:{editRevision:number;logicalMessageKey:string;messageId:number;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sessionId:string};kind:\"existing_representation\";ordinaryPayloadBytesBase64url?:string;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};repair:{allocationDigestBase64url:string;attestationDigestBase64url:string;identityDigestBase64url:string;publisherKind?:\"foreground_runtime\";publisherSignerKeyId:string;publisherSigningPublicKeyBase64url:string};retainedGeneration?:{accessRevision:number;audienceFingerprintBase64url:string;headDigestBase64url:string;namespaceGeneration:number;publicationDigestBase64url:string;publicationSetDigestBase64url:string}}|{coordinate:{editRevision:number;logicalMessageKey:string;messageId:number;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sessionId:string};kind:\"existing_representation\";protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};repair:{allocationDigestBase64url:string;attestationDigestBase64url:string;identityDigestBase64url:string;publisherHumanId:string;publisherKind:\"human_device\";publisherSignerKeyId:string;publisherSigningPublicKeyBase64url:string};representationMode:\"protected-only\";retainedGeneration:{accessRevision:number;audienceFingerprintBase64url:string;headDigestBase64url:string;namespaceGeneration:number;publicationDigestBase64url:string;publicationSetDigestBase64url:string};selectedSource:{authorAgentId?:string;logicalMessageKey?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sourceUserId?:string}}|{coordinate:{editRevision:number;logicalMessageKey:string;messageId:number;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sessionId:string};kind:\"existing_representation\";protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};repair:{allocationDigestBase64url:string;attestationDigestBase64url:string;identityDigestBase64url:string;publisherKind?:\"foreground_runtime\";publisherSignerKeyId:string;publisherSigningPublicKeyBase64url:string};representationMode:\"protected-only\";retainedGeneration?:{accessRevision:number;audienceFingerprintBase64url:string;headDigestBase64url:string;namespaceGeneration:number;publicationDigestBase64url:string;publicationSetDigestBase64url:string};selectedSource:{authorAgentId?:string;logicalMessageKey?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sourceUserId?:string}}|{coordinate:{editRevision:number;logicalMessageKey:string;messageId:number;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sessionId:string};kind?:\"live_shadow\";ordinaryPayloadBytesBase64url:string;protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};retainedGeneration:{accessRevision:number;audienceFingerprintBase64url:string;headDigestBase64url:string;namespaceGeneration:number;publicationDigestBase64url:string;publicationSetDigestBase64url:string};shadowOperationFamily?:\"shared_execution\"|\"shared_human\";shadowOperationId:string;shadowTranscriptOrdinal:number}|{coordinate:{editRevision:number;logicalMessageKey:string;messageId:number;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sessionId:string};kind?:\"live_shadow\";protectedMessage:{dtoVersion:2;projection:{authorAgentId?:string;createdAt:string;deliveredAt?:string;editRevision:number;editedAt?:string;lastReplyAt?:string;logicalMessageKey?:string;messageId:string;namespaceId:string;readAt?:string;replyCount?:number;replyToMessageId?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";roomId:string;sessionId:string;sourceUserId?:string;subthreadRoomId?:string;summaryRevision?:number};protectedPayload?:{accessManifestBytesBase64url:string;cryptoObjectId:string;encryptedPayloadBytesBase64url:string;keyClass:\"ai\"|\"human\";namespaceEnvelopeBytesBase64url:string;payloadVersion:2;status:\"encrypted\"}|{cryptoObjectId?:string;reason:\"corrupt\"|\"lost_key_material\"|\"missing_grant\"|\"removed\"|\"stale_grant\"|\"unauthorized\"|\"unsupported_version\";status:\"unavailable\"}|{reason:\"backfill_pending\"|\"shadow_pending\";status:\"pending\"}};representationMode:\"protected-only\";retainedGeneration:{accessRevision:number;audienceFingerprintBase64url:string;headDigestBase64url:string;namespaceGeneration:number;publicationDigestBase64url:string;publicationSetDigestBase64url:string};selectedSource:{authorAgentId?:string;logicalMessageKey?:string;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sourceUserId?:string};shadowOperationFamily?:\"shared_execution\"|\"shared_human\";shadowOperationId:string;shadowTranscriptOrdinal:number}[];responseVersion:1;selectedCoordinateDigestBase64url:string;selectedCoordinates:{editRevision:number;logicalMessageKey:string;messageId:number;role:\"assistant\"|\"system\"|\"tool\"|\"user\";sessionId:string}[];selectedCount:number;signerEvidence:{evidenceBytesBase64url:string;kind:\"agent_runtime_publication\"|\"processor_authorization\"}|{kind:\"human_ai_readable_live_shadow_request_v1\"|\"human_ai_readable_live_shadow_request_v2\";operationId:string;planBytesBase64url:string;requestBytesBase64url:string;requestDigestBase64url:string}|{kind:\"human_live_shadow_request_v3\"|\"human_live_shadow_request_v4\";operationId:string;planBytesBase64url:string;requestBytesBase64url:string;requestDigestBase64url:string}|{kind:\"human_peer_live_shadow_request_v1\";operationId:string;planBytesBase64url:string;requestBytesBase64url:string;requestDigestBase64url:string;senderDeviceId:string;senderDeviceSigningKeyGeneration:number;senderDeviceSigningPublicKeyBase64url:string}|{kind:\"shared_agent_execution_plan_v4\";operationId:string;planBytesBase64url:string;planDigestBase64url:string}[];status:\"ready\"}|{clientRequestKey:string;eligibleCount:number;operationId:string;policyRevision:number;reason:\"client_crypto_unavailable\"|\"current_read_authority_unavailable\"|\"projection_corrupt\"|\"selection_changed\";responseVersion:1;selectedCoordinateDigestBase64url:string;selectedCount:number;status:\"unavailable\"}|{eligibleCount:0;responseVersion:1;selectedCount:number;status:\"ineligible\"}|{mode:\"plaintext_only\";responseVersion:1;status:\"disabled\"};target:{createdAt:string;messageId:string}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.rooms.roomid.agents.agentid.model.control.selection.158uoka",
    "locator": "http:request_response:GET /api/rooms/:roomId/agents/:agentId/model-control-selection",
    "structuralSignatures": [
      "request.params:{agentId:string;roomId:string}",
      "request.query:{includeEffectiveModel?:string}",
      "response.body:{effectiveModelId:string;selection:{modelId:string;reasoningEffort?:\"high\"|\"low\"|\"max\"|\"medium\"|\"minimal\"|\"off\"|\"xhigh\";servingProfileId?:string}}",
      "response.body:{error:string}",
      "response.body:{selection:{modelId:string;reasoningEffort?:\"high\"|\"low\"|\"max\"|\"medium\"|\"minimal\"|\"off\"|\"xhigh\";servingProfileId?:string}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.rooms.discoverable.1lfy0b0",
    "locator": "http:request_response:GET /api/rooms/discoverable",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{rooms:{createdAt:string;discoverable?:boolean;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;lastMessageAt?:string;memberCount:number;messageCount?:number;parentRoomId?:string;roster?:{actorId:string;agentAvatar?:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};agentId?:string;displayName:string;federatedId?:string;handle?:string;kind:\"agent\"|\"user\";userId?:string}[];threadRootMessageId?:number;type:string;unreadCount?:number}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.rooms.manageable.1anqps",
    "locator": "http:request_response:GET /api/rooms/manageable",
    "structuralSignatures": [
      "request.query:{includeArchived?:string}",
      "response.body:{rooms:{createdAt:string;discoverable?:boolean;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;lastMessageAt?:string;memberCount:number;messageCount?:number;parentRoomId?:string;roster?:{actorId:string;agentAvatar?:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};agentId?:string;displayName:string;federatedId?:string;handle?:string;kind:\"agent\"|\"user\";userId?:string}[];threadRootMessageId?:number;type:string;unreadCount?:number}[]}"
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
      "response.body:{conversations:{matchedBy:\"label\"|\"participant\";room:{createdAt:string;discoverable?:boolean;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;lastMessageAt?:string;memberCount:number;messageCount?:number;parentRoomId?:string;roster?:{actorId:string;agentAvatar?:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};agentId?:string;displayName:string;federatedId?:string;handle?:string;kind:\"agent\"|\"user\";userId?:string}[];threadRootMessageId?:number;type:string;unreadCount?:number}}[];conversationsTruncated:boolean;hasMoreOlderMessages:boolean;messageAsOf:{createdAt:string;messageId:string};messages:{authorActorId?:string;authorAgentId?:string;authorDisplayName?:string;authorHandle?:string;createdAt:string;messageId:string;parentRoomId?:string;parentRoomLabel?:string;role:string;roomId:string;roomKind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";roomLabel:string;snippet:string;sourceUserId?:string;toolName?:string}[];nextOlderMessageCursor:{createdAt:string;messageId:string}}",
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
      "response.body:{events:{action:\"ban\"|\"kick\"|\"lift\"|\"mute\"|\"timeout\";actorId:string;correlationId:string;ip:string;kind:\"moderation_action\";requesterUserId:string;roomId:string;subjectId:string;ts:string;userAgent:string}|{action:\"configure\"|\"remove\";actorId:string;clientId:string;ip:string;kind:\"google_oauth_client_config\";outcome:\"ok\";ts:string;userAgent:string}|{action:\"create\"|\"delete\"|\"disable\"|\"enable\"|\"update\";actorId:string;effectDigest?:string;ip:string;kind:\"mcp_server_config\";outcome:\"error\"|\"ok\";relayId?:string;serverName:string;ts:string;userAgent:string}|{action:\"created\"|\"deleted\"|\"replaced\"|\"validated\";actorId:string;credentialId:string;ip:string;kind:\"personal_provider_credential_changed\";provider:string;revision:number;ts:string;userAgent:string;validationStatus?:\"accepted\"|\"rejected\"|\"unavailable\"|\"unverified\"}|{action:\"delete\"|\"list\"|\"store\"|\"use\";actorId:string;connectionId?:string;errorKind?:string;field?:string;ip:string;kind:\"connection_vault_tool\";outcome:\"error\"|\"missing\"|\"ok\";service?:string;tool:string;ts:string;userAgent:string}|{action:\"deleted\";actorId:string;ip:string;kind:\"server_provider_key_changed\";provider:string;ts:string;userAgent:string}|{action:string;actorId:string;errorKind?:string;ip:string;kind:\"memory.edit\";memoryId:string;namespaceId?:string;operationId?:string;outcome:\"failure\"|\"success\";scopeId?:string;ts:string;userAgent:string}|{actorId:string;actorUserId:string;ip:string;kind:\"standing_approval_revoked\";label:string;roomId:string;route:\"DELETE /api/security/standing-approvals/:id\";ruleId:string;scope:\"room\"|\"server\";toolPattern:string;ts:string;userAgent:string}|{actorId:string;affectedPairingCount:number;correlationId:string;ip:string;kind:\"relay_pairing_lifecycle\";managementTarget:string;operation:\"group_revoke\"|\"historical_cleanup\";reason:\"confirmation_mismatch\"|\"not_found_or_foreign\"|\"revoked\"|\"store_error\";result:\"failed\"|\"not_found_or_foreign\"|\"stale\"|\"succeeded\";ts:string;userAgent:string;userId:string}|{actorId:string;after:{conductorModel:string;defaultChatModel:string;fallbackChain:string[];reflectionModel:string;stenographerModel:string};before:{conductorModel:string;defaultChatModel:string;fallbackChain:string[];reflectionModel:string;stenographerModel:string};changes?:{[key:string]:unknown};ip:string;kind:\"server_model_config_changed\";ts:string;userAgent:string}|{actorId:string;after:{mode:\"encrypted_only\"|\"plaintext_only\"|\"shadow_encryption\";revision:number;shadowBehavior:\"fallback\"|\"strict\"};before:{mode:\"encrypted_only\"|\"plaintext_only\"|\"shadow_encryption\";revision:number;shadowBehavior:\"fallback\"|\"strict\"};ip:string;kind:\"encryption_transition_policy_changed\";ts:string;userAgent:string}|{actorId:string;attemptedRoute:string;capability:string;ip:string;kind:\"capability_check_failed\";ts:string;userAgent:string}|{actorId:string;attemptedRoute:string;ip:string;kind:\"pin_check_failed\";pinOutcome:\"invalid\"|\"locked_out\";ts:string;userAgent:string}|{actorId:string;before:{mode:\"encrypted_only\"|\"plaintext_only\"|\"shadow_encryption\";revision:number;shadowBehavior:\"fallback\"|\"strict\"};ip:string;kind:\"encryption_transition_policy_change_requested\";requested:{expectedRevision:number;mode:\"encrypted_only\"|\"plaintext_only\"|\"shadow_encryption\";shadowBehavior:\"fallback\"|\"strict\"};ts:string;userAgent:string}|{actorId:string;byUserId:string;fromUserId:string;ip:string;kind:\"room_archived\";roomId:string;ts:string;userAgent:string}|{actorId:string;byUserId:string;ip:string;kind:\"room_unarchived\";roomId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail:boolean;ip:string;kind:\"agent_role_removed\";roleSlug:string;targetAgentId:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail:boolean;ip:string;kind:\"room_member_removed\";roomId:string;targetActorId:string;targetActorKind:\"agent\"|\"user\";ts:string;userAgent:string}|{actorId:string;bypassedRail?:boolean;groupId:string;groupType:string;ip:string;kind:\"group_member_removed\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;bypassedRail?:boolean;ip:string;kind:\"agent_role_added\";replacedFromGroupId:string;roleSlug:string;targetAgentId:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];groupId:string;groupType:string;ip:string;kind:\"rbac_shared_access_assigned\";memberCount:number;ownerUserId:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];groupId:string;groupType:string;ip:string;kind:\"rbac_shared_access_created\";memberCount:number;ownerUserId:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];ip:string;kind:\"rbac_role_capabilities_set\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilities:string[];ip:string;kind:\"rbac_role_created\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;capabilityRevision:number;denialCode?:string;desktopSessionId:string;ip:string;kind:\"workstation_session_activated\"|\"workstation_session_broadened\"|\"workstation_session_denied\"|\"workstation_session_disabled\"|\"workstation_session_invalidated\"|\"workstation_session_narrowed\"|\"workstation_session_switched\";outcome?:string;relayId:string;route?:string;serverBindingId:string;ts:string;userAgent:string;userId:string}|{actorId:string;capabilityRevision:number;desktopSessionId:string;executionClass:\"basic_sandbox\"|\"profile_bound_sandbox\"|\"real_workstation\"|\"typed_broker\";ip:string;kind:\"workstation_admission\";outcome:\"auto\"|\"none\";pairingGeneration:string;profileId:string;profileRevision:number;reason:\"auto_admitted\"|\"critical_or_elevation_command\"|\"no_active_session\"|\"no_admitted_plan\"|\"run_shell_required\"|\"typed_broker_not_wired\";relayId:string;serverBindingId:string;toolCallId:string;toolName:string;ts:string;userAgent:string;userId:string}|{actorId:string;capabilityRevision?:number;desktopSessionId?:string;ip:string;kind:\"uncontained_host_commands_activated\"|\"uncontained_host_commands_denied\"|\"uncontained_host_commands_disabled\"|\"uncontained_host_commands_dispatch_admitted\"|\"uncontained_host_commands_dispatch_denied\"|\"uncontained_host_commands_invalidated\"|\"uncontained_host_commands_status_invalidated\";reason?:string;relayId?:string;route?:string;serverBindingId?:string;ts:string;userAgent:string;userId:string}|{actorId:string;changes:{[key:string]:unknown};ip:string;kind:\"server_profile_changed\";ts:string;userAgent:string}|{actorId:string;changes:{[key:string]:unknown};ip:string;kind:\"server_research_provider_changed\";ts:string;userAgent:string}|{actorId:string;effective:boolean;effectiveFundingPreference:\"personal_first\"|\"server_first\";ip:string;kind:\"server_provider_policy_changed\";previous:boolean;previousFundingPreference:\"personal_first\"|\"server_first\";ts:string;userAgent:string}|{actorId:string;errorKind?:string;ip:string;kind:\"memory.delete\";memoryId:string;mode:\"archive\"|\"hard\";namespaceId?:string;operationId?:string;outcome:\"failure\"|\"success\";scopeId?:string;ts:string;userAgent:string}|{actorId:string;fromOwnerUserId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_owner_transferred\";toOwnerUserId:string;ts:string;userAgent:string}|{actorId:string;fromUserId:string;ip:string;kind:\"room_ownership_transferred\";roomId:string;toUserId:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"group_member_added\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_created\";ownerUserId:string;roleSlugs:string[];ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_deleted\";ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_renamed\";label:string;ts:string;userAgent:string}|{actorId:string;groupId:string;groupType:string;ip:string;kind:\"rbac_group_roles_set\";roleSlugs:string[];ts:string;userAgent:string}|{actorId:string;groupId:string;ip:string;kind:\"rbac_group_moderation_scopes_set\";roomIds:string[];ts:string;userAgent:string}|{actorId:string;handleHash:string;inviteKind:string;ip:string;kind:\"invite_bind_logto_user_succeeded\";logtoSub:string;targetGroupId?:string;targetRoomId?:string;tokenHash:string;ts:string;userAgent:string;userId:string}|{actorId:string;handleHash:string;ip:string;kind:\"logto_password_login_failed\";ts:string;userAgent:string;userId?:string}|{actorId:string;handleHash:string;ip:string;kind:\"logto_password_login_succeeded\";ts:string;userAgent:string;userId:string}|{actorId:string;handleHash:string;ip:string;kind:\"recovery_session_opened\";ts:string;userAgent:string}|{actorId:string;handleHash:string;ip:string;kind:\"recovery_session_rejected\";reason:\"logto_endpoint_missing\"|\"logto_unavailable\"|\"reject\"|\"unexpected_error\";ts:string;userAgent:string}|{actorId:string;handleHash?:string;inviteKind?:string;ip:string;kind:\"invite_bind_logto_user_failed\";logtoSub?:string;reason:string;targetGroupId?:string;targetRoomId?:string;tokenHash?:string;ts:string;userAgent:string}|{actorId:string;inviteId:string;inviteKind:string;ip:string;kind:\"invite_minted\";targetAgentId?:string;targetRoomId?:string;ts:string;userAgent:string}|{actorId:string;inviteId:string;ip:string;kind:\"invite_revoked\";ts:string;userAgent:string}|{actorId:string;inviteKind:string;ip:string;kind:\"invite_redeemed\";landingRoomId:string;newUserId:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"admin_password_reset_issued\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"approval_denied\"|\"approval_granted\";laneKey:string;network?:{host:string;port:number;reason:string;suggestedRule:{cidr?:string;host?:string;ports?:number[];suffix?:string;type:\"cidr\"|\"domain\"|\"wildcard\"}};route:\"POST /api/auth/approval-reply\";threadId:string;ts:string;userAgent:string;verb:\"always\"|\"deny\"|\"once\"|\"room\"}|{actorId:string;ip:string;kind:\"invite_complete_profile_failed\";reason:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"invite_redeem_cleanup_failed\";logtoSub:string;reason:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"invite_redeem_failed\";reason:string;tokenHash:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"logto_token_mint_failed\";logtoSub:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"pin_enrolled\";route:\"POST /api/auth/pin\";sessionUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"posture_changed\";next:{deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\"};prev:{deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\"};ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"rbac_role_deleted\";roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"rbac_role_renamed\";label:string;roleId:string;roleSlug:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"recovery_relay_code_unmatched\";ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"recovery_relay_read_denied\";reason:\"bad_request\"|\"not_found\";ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"resume_thread_auth_denied\";route:string;sessionUserId:string;threadId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_added\";roomId:string;roomRole:\"admin\"|\"member\";targetActorId:string;targetActorKind:\"agent\"|\"user\";targetAgentId?:string;targetUserId?:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_self_joined\";roomId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"room_member_self_left\";roomId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_deleted\";logtoRevoked:boolean;targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_disabled\";reason?:string;targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_disabled_session_blocked\";route:string;sessionUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;kind:\"user_enabled\";targetUserId:string;ts:string;userAgent:string}|{actorId:string;ip:string;ts:string;userAgent:string}&{approvalRequired:boolean;enabled:boolean;joinsPaused:boolean;kind:\"moderation_policy_changed\";requesterUserId:string;revision:number}|{actorId:string;ip:string;ts:string;userAgent:string}&{decision:\"approved\"|\"rejected\";inviteId:string;kind:\"enrollment_review_decided\";requesterUserId:string;revision:number;userId:string}[];hasMore:boolean;nextCursor:string}"
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
      "response.body:{actorRole:string;allowUncontainedHostCommands:boolean;backend:{kind:\"bubblewrap\"|\"passthrough\"|\"sandbox-exec\";procSupported?:boolean};capabilities:string[];deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";localNetworkPolicy:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};networkPolicy:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};readOnlyPaths:string[];securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";writablePaths:string[]}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.security.uncontained.host.commands.session.1767hmy",
    "locator": "http:request_response:GET /api/security/uncontained-host-commands/session",
    "structuralSignatures": [
      "request.query:{desktopSessionId?:string;relayId?:string}",
      "response.body:{activatedAt:string;activationId?:string;active:boolean;eligible:boolean;reason:\"grant_missing\"|\"pin_invalid\"|\"pin_locked_out\"|\"policy_disabled\"|\"relay_binding_unavailable\"|\"role_floor_missing\"|\"session_binding_mismatch\"|\"session_inactive\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.sessions.latest.ueq1mn",
    "locator": "http:request_response:GET /api/sessions/latest",
    "structuralSignatures": [
      "request.query:{[key:string]:string}",
      "response.body:{code:string;error:string}",
      "response.body:{error:string}",
      "response.body:{messages:undefined[];session:null}",
      "response.body:{messages:{artifacts:{artifactInternalId:string;basename:string;mimeType:string;roomId:string;sizeBytes:number}[];attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];authorAgentId?:string;authorHarnessId?:string;content:string;createdAt:Date;displayContent?:string;editRevision?:number;editedAt?:string;id:string;imageAssistance?:{attachmentIds:string[];modelDisplayName:string;modelId:string;status:\"completed\"};logicalMessageKey?:string;reactions:{actorIds:string[];count:number;emoji:string;truncated:boolean}[];replyToMessageId?:number;role:string;sourceUserId?:string;toolCallId?:string;toolCalls:string;toolName?:string;toolStatus?:\"error\"|\"success\";workcardContinuation?:{kind:\"advanced_video\";referenceCount:number}}|{artifacts:{artifactInternalId:string;basename:string;mimeType:string;roomId:string;sizeBytes:number}[];attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];authorAgentId?:string;authorHarnessId?:string;content:string;createdAt:Date;displayContent?:string;editRevision?:number;editedAt?:string;id:string;imageAssistance?:{attachmentIds:string[];modelDisplayName:string;modelId:string;status:\"completed\"};logicalMessageKey?:string;reactions?:undefined;replyToMessageId?:number;role:string;sourceUserId?:string;toolCallId?:string;toolCalls:string;toolName?:string;toolStatus?:\"error\"|\"success\";workcardContinuation?:{kind:\"advanced_video\";referenceCount:number}}|{artifacts?:undefined;attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];authorAgentId?:string;authorHarnessId?:string;content:string;createdAt:Date;displayContent?:string;editRevision?:number;editedAt?:string;id:string;imageAssistance?:{attachmentIds:string[];modelDisplayName:string;modelId:string;status:\"completed\"};logicalMessageKey?:string;reactions:{actorIds:string[];count:number;emoji:string;truncated:boolean}[];replyToMessageId?:number;role:string;sourceUserId?:string;toolCallId?:string;toolCalls:string;toolName?:string;toolStatus?:\"error\"|\"success\";workcardContinuation?:{kind:\"advanced_video\";referenceCount:number}}|{artifacts?:undefined;attachments?:{attachmentId:string;filename:string;mimeType:string;sizeBytes:number}[];authorAgentId?:string;authorHarnessId?:string;content:string;createdAt:Date;displayContent?:string;editRevision?:number;editedAt?:string;id:string;imageAssistance?:{attachmentIds:string[];modelDisplayName:string;modelId:string;status:\"completed\"};logicalMessageKey?:string;reactions?:undefined;replyToMessageId?:number;role:string;sourceUserId?:string;toolCallId?:string;toolCalls:string;toolName?:string;toolStatus?:\"error\"|\"success\";workcardContinuation?:{kind:\"advanced_video\";referenceCount:number}}[];pageInfo:{hasMoreBefore:boolean;oldestCursor:{createdAt:string;id:string}};session:{id:string;messageCount:number;startedAt:Date;threadId:string;title:string}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.voices.1ob9cop",
    "locator": "http:request_response:GET /api/voices",
    "structuralSignatures": [
      "response.body:{cachedAt:null;curated:{description:string;label:string;language:string;previewUrl:string;slug:string;voiceId:string}[];elevenLabsConfigured:boolean;error:string;voices:undefined[]}",
      "response.body:{cachedAt:number;curated:{description:string;label:string;language:string;previewUrl:string;slug:string;voiceId:string}[];elevenLabsConfigured:boolean;error?:string;voices:{description:string;labels:{[key:string]:string};name:string;voiceId:string}[]}",
      "response.body:{capability:\"approve_destructive_actions\"|\"approve_spending\"|\"ban_room_members\"|\"ban_server_members\"|\"control_browser\"|\"control_desktop\"|\"control_home\"|\"create_invites\"|\"create_rooms\"|\"invoke_agents\"|\"invoke_other_agents\"|\"kick_room_members\"|\"kick_server_members\"|\"manage_agents\"|\"manage_billing\"|\"manage_connection_providers\"|\"manage_groups\"|\"manage_members\"|\"manage_memories\"|\"manage_roles\"|\"manage_rooms\"|\"manage_server_enrollment\"|\"manage_server_operations\"|\"manage_server_security\"|\"manage_server_settings\"|\"manage_standing_approvals\"|\"manage_uncontained_host_commands\"|\"manage_workstation_profiles\"|\"moderate_content_reports\"|\"read_memories\"|\"read_server_settings\"|\"timeout_room_members\"|\"timeout_server_members\"|\"use_connections\"|\"use_google_workspace\"|\"use_image_generation\"|\"use_media_generation\"|\"use_personal_provider_credentials\"|\"use_project_content\"|\"use_project_execution\"|\"use_remote_hosts\"|\"use_research_tools\"|\"use_server_provider_credentials\"|\"use_share_artifact\"|\"use_transcription\"|\"use_workstation\"|\"view_audit_log\"|\"view_room_moderation\"|\"view_server_moderation\"|\"write_artifacts\";code:\"agent_target_unavailable\"|\"invocation_access_withdrawn\"|\"invoke_agents_required\"|\"invoke_other_agents_required\"|\"server_provider_credentials_required\"|\"write_artifacts_required\";error:\"agent_target_unavailable\"|\"invocation_access_withdrawn\"|\"invoke_agents_required\"|\"invoke_other_agents_required\"|\"server_provider_credentials_required\"|\"write_artifacts_required\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.voices.catalog.1px36j5",
    "locator": "http:request_response:GET /api/voices/catalog",
    "structuralSignatures": [
      "request.query:{[key:string]:unknown}",
      "request.query:{accent?:string;age?:string;category?:\"famous\"|\"high_quality\"|\"professional\";gender?:string;language?:string;page?:number;page_size?:number;search?:string;use_cases?:string}",
      "response.body:{cachedAt:null;elevenLabsConfigured:boolean;error:string;hasMore:boolean;languageGroups:{count:number;label:string;language:string;locale:string}[];page:number;pageSize:number;totalCount:number;voices:{accent:string;age:string;category:string;descriptive:string;gender:string;language:string;languageLabel:string;locale:string;name:string;previewUrl:string;source:\"curated\"|\"provider\";verifiedLanguages:{accent:string;language:string;locale:string;modelId:string;previewUrl:string}[];voiceId:string}[]}",
      "response.body:{cachedAt:number;elevenLabsConfigured:boolean;error?:string;hasMore:boolean;languageGroups:{count:number;label:string;language:string;locale:string}[];page:number;pageSize:number;totalCount:number;voices:{accent:string;age:string;category:string;descriptive:string;gender:string;language:string;languageLabel:string;locale:string;name:string;previewUrl:string;source:\"curated\"|\"provider\";verifiedLanguages:{accent:string;language:string;locale:string;modelId:string;previewUrl:string}[];voiceId:string}[]}",
      "response.body:{capability:\"approve_destructive_actions\"|\"approve_spending\"|\"ban_room_members\"|\"ban_server_members\"|\"control_browser\"|\"control_desktop\"|\"control_home\"|\"create_invites\"|\"create_rooms\"|\"invoke_agents\"|\"invoke_other_agents\"|\"kick_room_members\"|\"kick_server_members\"|\"manage_agents\"|\"manage_billing\"|\"manage_connection_providers\"|\"manage_groups\"|\"manage_members\"|\"manage_memories\"|\"manage_roles\"|\"manage_rooms\"|\"manage_server_enrollment\"|\"manage_server_operations\"|\"manage_server_security\"|\"manage_server_settings\"|\"manage_standing_approvals\"|\"manage_uncontained_host_commands\"|\"manage_workstation_profiles\"|\"moderate_content_reports\"|\"read_memories\"|\"read_server_settings\"|\"timeout_room_members\"|\"timeout_server_members\"|\"use_connections\"|\"use_google_workspace\"|\"use_image_generation\"|\"use_media_generation\"|\"use_personal_provider_credentials\"|\"use_project_content\"|\"use_project_execution\"|\"use_remote_hosts\"|\"use_research_tools\"|\"use_server_provider_credentials\"|\"use_share_artifact\"|\"use_transcription\"|\"use_workstation\"|\"view_audit_log\"|\"view_room_moderation\"|\"view_server_moderation\"|\"write_artifacts\";code:\"agent_target_unavailable\"|\"invocation_access_withdrawn\"|\"invoke_agents_required\"|\"invoke_other_agents_required\"|\"server_provider_credentials_required\"|\"write_artifacts_required\";error:\"agent_target_unavailable\"|\"invocation_access_withdrawn\"|\"invoke_agents_required\"|\"invoke_other_agents_required\"|\"server_provider_credentials_required\"|\"write_artifacts_required\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.query",
        "debtId": "debt.wire.arbitrary.sju7ud"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.patch.api.rooms.id.ndpplk",
    "locator": "http:request_response:PATCH /api/rooms/:id",
    "structuralSignatures": [
      "request.body:{label:string}",
      "request.params:{id:string}",
      "response.body:{conductorMode:\"advanced\"|\"standard\";createdAt:string;discoverable?:boolean;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;members:{actorId:string;agentAvatar?:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};agentId?:string;agentOwnerDisplayName?:string;agentOwnerHandle?:string;agentOwnerUserId?:string;agentResponseMode?:\"active\"|\"mention_only\"|\"observe\";displayName:string;handle?:string;kind:\"agent\"|\"user\";roomRole:\"admin\"|\"member\";userId?:string}[];namespaceId?:string;parentRoomId:string;threadRootMessageId:number;type:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.admin.access.control.changes.preview.175w5tz",
    "locator": "http:request_response:POST /api/admin/access-control/changes/preview",
    "structuralSignatures": [
      "response.body:{affectedUserDelta?:{added:string[];removed:string[];unchanged:string[];userId:string};affectedUserDeltas?:{added:string[];removed:string[];unchanged:string[];userId:string}[];auditPreview:{actorId:string;bypassedRail?:boolean;groupId:string;groupType:string;kind:\"group_member_removed\";targetUserId:string}|{actorId:string;capabilities:string[];groupId:string;groupType:string;kind:\"rbac_shared_access_assigned\";memberCount:number;ownerUserId:string;roleId:string;roleSlug:string}|{actorId:string;capabilities:string[];groupId:string;groupType:string;kind:\"rbac_shared_access_created\";memberCount:number;ownerUserId:string;roleId:string;roleSlug:string}|{actorId:string;capabilities:string[];kind:\"rbac_role_capabilities_set\";roleId:string;roleSlug:string}|{actorId:string;capabilities:string[];kind:\"rbac_role_created\";roleId:string;roleSlug:string}|{actorId:string;fromOwnerUserId:string;groupId:string;groupType:string;kind:\"rbac_group_owner_transferred\";toOwnerUserId:string}|{actorId:string;groupId:string;groupType:string;kind:\"group_member_added\";targetUserId:string}|{actorId:string;groupId:string;groupType:string;kind:\"rbac_group_created\";ownerUserId:string;roleSlugs:string[]}|{actorId:string;groupId:string;groupType:string;kind:\"rbac_group_deleted\"}|{actorId:string;groupId:string;groupType:string;kind:\"rbac_group_renamed\";label:string}|{actorId:string;groupId:string;groupType:string;kind:\"rbac_group_roles_set\";roleSlugs:string[]}|{actorId:string;groupId:string;kind:\"rbac_group_moderation_scopes_set\";roomIds:string[]}|{actorId:string;kind:\"rbac_role_deleted\";roleId:string;roleSlug:string}|{actorId:string;kind:\"rbac_role_renamed\";label:string;roleId:string;roleSlug:string};authorityDelta?:{added:string[];removed:string[];unchanged:string[]};checks:{code:\"insufficient_authority\"|\"insufficient_moderation_scope\"|\"invalid_custom_type\"|\"last_owner\"|\"missing_manage_groups\"|\"missing_manage_members\"|\"missing_manage_roles\"|\"missing_manage_uncontained_host_commands\"|\"moderation_room_unavailable\"|\"nondelegable_capability\"|\"not_found\"|\"not_member\"|\"ok\"|\"owner_required\"|\"protected_definition\"|\"reserved_slug\"|\"reserved_type\"|\"unknown_capability\"|\"user_not_found\";detail?:string;missing?:string[];passed:boolean}[];currentAuthority?:string[];deletionConsequence?:{affectedGroups?:{groupId:string;groupType:string;memberCount:number}[];approvalChallengesRemoved?:number;groupRolesRemoved?:number;membersRemoved?:number;roleAssignmentsRemoved?:number;roleCapabilitiesRemoved?:number;targetId:string;targetKind:\"group\"|\"role\";targetLabel:string};failures:{code:\"insufficient_authority\"|\"insufficient_moderation_scope\"|\"invalid_custom_type\"|\"last_owner\"|\"missing_manage_groups\"|\"missing_manage_members\"|\"missing_manage_roles\"|\"missing_manage_uncontained_host_commands\"|\"moderation_room_unavailable\"|\"nondelegable_capability\"|\"not_found\"|\"not_member\"|\"ok\"|\"owner_required\"|\"protected_definition\"|\"reserved_slug\"|\"reserved_type\"|\"unknown_capability\"|\"user_not_found\";detail?:string;missing?:string[];passed:boolean}[];fingerprint:string;ok:boolean;operation:{bypassLastOwner?:boolean;groupId:string;kind:\"membership.remove\";userId:string}|{capabilities:string[];kind:\"role.create\";label:string;slug:string}|{capabilities:string[];kind:\"role.set_capabilities\";roleId:string}|{group:{groupType:string;label:string;ownerUserId:string};kind:\"shared_access.assign_existing\";memberUserIds:string[];roleSlug:string}|{group:{groupType:string;label:string;ownerUserId:string};kind:\"shared_access.create\";memberUserIds:string[];role:{capabilities:string[];label:string;slug:string}}|{groupId:string;kind:\"group.delete\"}|{groupId:string;kind:\"group.rename\";label:string}|{groupId:string;kind:\"group.set_moderation_scopes\";roomIds:string[]}|{groupId:string;kind:\"group.set_roles\";roleSlugs:string[]}|{groupId:string;kind:\"group.transfer_owner\";newOwnerUserId:string}|{groupId:string;kind:\"membership.add\";userId:string}|{groupType:string;kind:\"group.create\";label:string;ownerUserId:string;roleSlugs:string[]}|{kind:\"role.delete\";roleId:string}|{kind:\"role.rename\";label:string;roleId:string};proposedAuthority?:string[]}",
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
    "observationId": "wire.http.request.response.post.api.admin.server.models.1nyrg5s",
    "locator": "http:request_response:POST /api/admin/server-models",
    "structuralSignatures": [
      "request.body:{[key:string]:boolean}",
      "request.body:{[key:string]:unknown}",
      "response.body:{catalogModels:{availability:\"disabled\"|\"missing_credentials\"|\"routing_filtered\"|\"selectable\"|\"unknown_model\";decision:{operations:\"choice\"|\"noul\"|\"score\"[]};directAvailability:\"disabled\"|\"missing_credentials\"|\"routing_filtered\"|\"selectable\"|\"unknown_model\";directUnavailableReason?:string;displayName:string;features:{e2ee:boolean;reasoning:boolean;structuredOutputs:boolean;tools:boolean;visualGrounding:boolean;webSearch:boolean};id:string;input:\"file\"|\"image\"|\"text\"[];output:\"audio\"|\"embedding\"|\"image\"|\"text\"|\"video\"[];provider:string;unavailableReason?:string;workload:\"chat\"|\"decision\"|\"generation\"|\"speech\"}[];conductorModel:string;defaultChatModel:string;effectiveEmbeddingModel:string;effectiveImageModel:string;effectiveMusicModel:string;effectiveSpeechModel:string;effectiveVideoModel:string;embeddingModel:string;embeddingModels:{available:boolean;displayName:string;id:string}[];embeddingSelectionPending:boolean;fallbackChain:string[];imageModel:string;imageModels:{available:boolean;displayName:string;id:string;provider:string;unavailableReason?:string}[];memoryReviewModel:string;musicModel:string;musicModels:{available:boolean;displayName:string;id:string;provider:string;unavailableReason?:string}[];preferSurplus:boolean;reasoningOutput:{[key:string]:boolean};reasoningPolicy:{defaultEffort:\"high\"|\"low\"|\"max\"|\"medium\"|\"minimal\"|\"off\"|\"xhigh\";overrides:{[key:string]:\"high\"|\"low\"|\"max\"|\"medium\"|\"minimal\"|\"off\"|\"xhigh\"}};reflectionModel:string;speechModel:string;speechModels:{available:boolean;displayName:string;id:string;provider:string;unavailableReason?:string}[];stenographerModel:string;surplus:{chatStatus:\"available\"|\"not-qualified\"|\"qualified-unavailable\";keyConfigured:boolean;policyEnabled:boolean};videoModel:string;videoModels:{available:boolean;displayName:string;id:string;provider:string;unavailableReason?:string}[]}",
      "response.body:{error:any}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "parseUpdateBody"
      },
      {
        "path": "response.body.error",
        "debtId": "debt.wire.arbitrary.zogb98"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.admin.users.provision.1ds6x6s",
    "locator": "http:request_response:POST /api/admin/users/provision",
    "structuralSignatures": [
      "request.body:{[key:string]:unknown;displayName?:unknown;email?:unknown;handle?:unknown;permanentCredential?:unknown;roleSlug?:unknown}",
      "response.body:{actorId:string;auditRecorded:boolean;credential:{disposition:\"issued\";pin:string;recoveryCodes:string[];temporaryPassword:string}|{disposition:\"not_reissued\"}|{disposition:\"provided\";recoveryCodes:string[]};idempotent:boolean;landingRoomId:string;memberId:string;ok:boolean;receiptId:string;roleSlug:\"admin\"|\"community\"|\"contributor\"|\"guest\"|\"member\"|\"owner\"|\"superuser\"}",
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
      "request.body:{approvalId?:string;authorizationDeviceId?:string;clientActionSessionId?:string;githubDigest?:string;laneKey?:string;localMcpInstallDigest?:string;mediaGenerationDigest?:string;mediaGenerationQuoteDigest?:string;mediaGenerationRevision?:number;threadId?:string;verb?:string}",
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
    "observationId": "wire.http.request.response.post.api.auth.pin.sj48n2",
    "locator": "http:request_response:POST /api/auth/pin",
    "structuralSignatures": [
      "request.body:{authorizationDeviceId?:string;clientActionSessionId?:string;currentPin?:string;laneKey?:string;newPin:string;threadId?:string}",
      "response.body:{capability:any;code:any;error:any}",
      "response.body:{code:string;error:string}",
      "response.body:{enrolled:boolean;ok:boolean;recoveryCodes:string[];resumeError?:\"approval_stale\"|\"task_approval_not_found\"}",
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
    "observationId": "wire.http.request.response.post.api.chat.v5ssn6",
    "locator": "http:request_response:POST /api/chat",
    "structuralSignatures": [
      "request.body:{activeMiniApp?:{appId:string;appName?:string;documentPath?:string;mode?:\"edit\"|\"preview\";selection?:unknown;summary?:unknown;targetKind?:\"artifact\"|\"fs\";updatedAt:number};artifactRefs?:{artifactId:string;mimeType:string;path:string;size:number}[];attachments?:{attachmentId:string}[];autoApprove?:boolean;cardContinuation?:\"advanced_video\";clientActionSessionId?:string;currentFolder?:string;currentFolderRelayId?:string;focusedResources?:{artifactId:string;kind:\"workspace-artifact\"}|{kind:\"local-file\";name:string;path:string;relayId:string;rootPath:string}[];laneKey?:string;liveMiniAppSession?:{documentVersion:{kind:\"artifact_revision\";revision:number}|{kind:\"local_sha\";sha256:string};sessionId:string;sessionToken:string};mentionEveryone?:boolean;mentionedHumanUserIds?:string[];message:string;model?:string;replyToMessageId?:number;roomId?:string;userTimezone?:string;voiceMode?:boolean;workspacePath?:string}",
      "response.body:void",
      "response.body:{accepted:boolean;attachments?:{code?:string;decision:\"accept\"|\"blocked\"|\"reject\"|\"stub\";filename:string;id:string;kind?:string;reason?:string;threats?:string[]}[];coalesced?:boolean;jobId:string;laneKey:string}",
      "response.body:{capability:\"approve_destructive_actions\"|\"approve_spending\"|\"ban_room_members\"|\"ban_server_members\"|\"control_browser\"|\"control_desktop\"|\"control_home\"|\"create_invites\"|\"create_rooms\"|\"invoke_agents\"|\"invoke_other_agents\"|\"kick_room_members\"|\"kick_server_members\"|\"manage_agents\"|\"manage_billing\"|\"manage_connection_providers\"|\"manage_groups\"|\"manage_members\"|\"manage_memories\"|\"manage_roles\"|\"manage_rooms\"|\"manage_server_enrollment\"|\"manage_server_operations\"|\"manage_server_security\"|\"manage_server_settings\"|\"manage_standing_approvals\"|\"manage_uncontained_host_commands\"|\"manage_workstation_profiles\"|\"moderate_content_reports\"|\"read_memories\"|\"read_server_settings\"|\"timeout_room_members\"|\"timeout_server_members\"|\"use_connections\"|\"use_google_workspace\"|\"use_image_generation\"|\"use_media_generation\"|\"use_personal_provider_credentials\"|\"use_project_content\"|\"use_project_execution\"|\"use_remote_hosts\"|\"use_research_tools\"|\"use_server_provider_credentials\"|\"use_share_artifact\"|\"use_transcription\"|\"use_workstation\"|\"view_audit_log\"|\"view_room_moderation\"|\"view_server_moderation\"|\"write_artifacts\";code:\"agent_target_unavailable\"|\"invocation_access_withdrawn\"|\"invoke_agents_required\"|\"invoke_other_agents_required\"|\"server_provider_credentials_required\"|\"write_artifacts_required\";error:\"agent_target_unavailable\"|\"invocation_access_withdrawn\"|\"invoke_agents_required\"|\"invoke_other_agents_required\"|\"server_provider_credentials_required\"|\"write_artifacts_required\"}",
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
    "observationId": "wire.http.request.response.post.api.health.keys.validate.1fst0pq",
    "locator": "http:request_response:POST /api/health/keys/validate",
    "structuralSignatures": [
      "response.body:{capability:\"approve_destructive_actions\"|\"approve_spending\"|\"ban_room_members\"|\"ban_server_members\"|\"control_browser\"|\"control_desktop\"|\"control_home\"|\"create_invites\"|\"create_rooms\"|\"invoke_agents\"|\"invoke_other_agents\"|\"kick_room_members\"|\"kick_server_members\"|\"manage_agents\"|\"manage_billing\"|\"manage_connection_providers\"|\"manage_groups\"|\"manage_members\"|\"manage_memories\"|\"manage_roles\"|\"manage_rooms\"|\"manage_server_enrollment\"|\"manage_server_operations\"|\"manage_server_security\"|\"manage_server_settings\"|\"manage_standing_approvals\"|\"manage_uncontained_host_commands\"|\"manage_workstation_profiles\"|\"moderate_content_reports\"|\"read_memories\"|\"read_server_settings\"|\"timeout_room_members\"|\"timeout_server_members\"|\"use_connections\"|\"use_google_workspace\"|\"use_image_generation\"|\"use_media_generation\"|\"use_personal_provider_credentials\"|\"use_project_content\"|\"use_project_execution\"|\"use_remote_hosts\"|\"use_research_tools\"|\"use_server_provider_credentials\"|\"use_share_artifact\"|\"use_transcription\"|\"use_workstation\"|\"view_audit_log\"|\"view_room_moderation\"|\"view_server_moderation\"|\"write_artifacts\";code:\"agent_target_unavailable\"|\"invocation_access_withdrawn\"|\"invoke_agents_required\"|\"invoke_other_agents_required\"|\"server_provider_credentials_required\"|\"write_artifacts_required\";error:\"agent_target_unavailable\"|\"invocation_access_withdrawn\"|\"invoke_agents_required\"|\"invoke_other_agents_required\"|\"server_provider_credentials_required\"|\"write_artifacts_required\"}",
      "response.body:{error:string}",
      "response.body:{keys:{category:\"browser\"|\"conversion\"|\"decision\"|\"llm\"|\"llm+embeddings\"|\"search\"|\"voice\";envVar:string;formatHint:string;hint:string;id:string;masked:string;name:string;purpose:string;required:boolean;signupUrl:string;status:\"invalid_format\"|\"invalid_key\"|\"missing\"|\"present\"|\"unreachable\"|\"verified\"}[];summary:{configured:number;hasConversion:boolean;hasEmbeddings:boolean;hasLlm:boolean;hasSearch:boolean;hasVoice:boolean;invalid:number;missing:number;total:number;verified:number}}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.profile.generate.soul.1f3d6ob",
    "locator": "http:request_response:POST /api/profile/generate-soul",
    "structuralSignatures": [
      "request.body:{language?:string;motherAnswer?:string;name?:string;personalityPrompt?:string;privacySpectrum?:number;voiceName?:string;workLifeMode?:\"both\"|\"life\"|\"work\"}",
      "response.body:{capability:\"approve_destructive_actions\"|\"approve_spending\"|\"ban_room_members\"|\"ban_server_members\"|\"control_browser\"|\"control_desktop\"|\"control_home\"|\"create_invites\"|\"create_rooms\"|\"invoke_agents\"|\"invoke_other_agents\"|\"kick_room_members\"|\"kick_server_members\"|\"manage_agents\"|\"manage_billing\"|\"manage_connection_providers\"|\"manage_groups\"|\"manage_members\"|\"manage_memories\"|\"manage_roles\"|\"manage_rooms\"|\"manage_server_enrollment\"|\"manage_server_operations\"|\"manage_server_security\"|\"manage_server_settings\"|\"manage_standing_approvals\"|\"manage_uncontained_host_commands\"|\"manage_workstation_profiles\"|\"moderate_content_reports\"|\"read_memories\"|\"read_server_settings\"|\"timeout_room_members\"|\"timeout_server_members\"|\"use_connections\"|\"use_google_workspace\"|\"use_image_generation\"|\"use_media_generation\"|\"use_personal_provider_credentials\"|\"use_project_content\"|\"use_project_execution\"|\"use_remote_hosts\"|\"use_research_tools\"|\"use_server_provider_credentials\"|\"use_share_artifact\"|\"use_transcription\"|\"use_workstation\"|\"view_audit_log\"|\"view_room_moderation\"|\"view_server_moderation\"|\"write_artifacts\";code:\"agent_target_unavailable\"|\"invocation_access_withdrawn\"|\"invoke_agents_required\"|\"invoke_other_agents_required\"|\"server_provider_credentials_required\"|\"write_artifacts_required\";error:\"agent_target_unavailable\"|\"invocation_access_withdrawn\"|\"invoke_agents_required\"|\"invoke_other_agents_required\"|\"server_provider_credentials_required\"|\"write_artifacts_required\"}",
      "response.body:{error:string;message:string}",
      "response.body:{error:string}",
      "response.body:{soulFile:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.profile.generate.soul.stream.5e41xw",
    "locator": "http:request_response:POST /api/profile/generate-soul/stream",
    "structuralSignatures": [
      "request.body:{language?:string;motherAnswer?:string;name?:string;personalityPrompt?:string;privacySpectrum?:number;voiceName?:string;workLifeMode?:\"both\"|\"life\"|\"work\"}",
      "response.body:{capability:\"approve_destructive_actions\"|\"approve_spending\"|\"ban_room_members\"|\"ban_server_members\"|\"control_browser\"|\"control_desktop\"|\"control_home\"|\"create_invites\"|\"create_rooms\"|\"invoke_agents\"|\"invoke_other_agents\"|\"kick_room_members\"|\"kick_server_members\"|\"manage_agents\"|\"manage_billing\"|\"manage_connection_providers\"|\"manage_groups\"|\"manage_members\"|\"manage_memories\"|\"manage_roles\"|\"manage_rooms\"|\"manage_server_enrollment\"|\"manage_server_operations\"|\"manage_server_security\"|\"manage_server_settings\"|\"manage_standing_approvals\"|\"manage_uncontained_host_commands\"|\"manage_workstation_profiles\"|\"moderate_content_reports\"|\"read_memories\"|\"read_server_settings\"|\"timeout_room_members\"|\"timeout_server_members\"|\"use_connections\"|\"use_google_workspace\"|\"use_image_generation\"|\"use_media_generation\"|\"use_personal_provider_credentials\"|\"use_project_content\"|\"use_project_execution\"|\"use_remote_hosts\"|\"use_research_tools\"|\"use_server_provider_credentials\"|\"use_share_artifact\"|\"use_transcription\"|\"use_workstation\"|\"view_audit_log\"|\"view_room_moderation\"|\"view_server_moderation\"|\"write_artifacts\";code:\"agent_target_unavailable\"|\"invocation_access_withdrawn\"|\"invoke_agents_required\"|\"invoke_other_agents_required\"|\"server_provider_credentials_required\"|\"write_artifacts_required\";error:\"agent_target_unavailable\"|\"invocation_access_withdrawn\"|\"invoke_agents_required\"|\"invoke_other_agents_required\"|\"server_provider_credentials_required\"|\"write_artifacts_required\"}",
      "response.body:{error:string;message:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.1gznwis",
    "locator": "http:request_response:POST /api/rooms",
    "structuralSignatures": [
      "request.body:{catalogueKind?:\"chat\"|\"room\";directHumanUserId?:string;discoverable?:boolean;kind?:\"group\"|\"open\"|\"private\";label:string;members?:{id:string;kind:\"agent\"|\"user\"}[];personalAgentId?:string}",
      "response.body:{code:string;error:string}",
      "response.body:{conductorMode:\"advanced\"|\"standard\";createdAt:string;discoverable?:boolean;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;members:{actorId:string;agentAvatar?:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};agentId?:string;agentOwnerDisplayName?:string;agentOwnerHandle?:string;agentOwnerUserId?:string;agentResponseMode?:\"active\"|\"mention_only\"|\"observe\";displayName:string;handle?:string;kind:\"agent\"|\"user\";roomRole:\"admin\"|\"member\";userId?:string}[];namespaceId?:string;parentRoomId:string;threadRootMessageId:number;type:string}",
      "response.body:{error:\"agent_not_found\"|\"agent_not_reachable\"|\"user_not_found\"|\"user_not_reachable\";memberId:string;memberKind:\"agent\"|\"user\"}",
      "response.body:{error:\"agent_not_found\"|\"user_not_found\";memberId:string;memberKind:\"agent\"|\"user\"}",
      "response.body:{error:\"agent_not_reachable\"|\"user_not_reachable\";memberId:string;memberKind:\"agent\"|\"user\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.id.join.7k3ppx",
    "locator": "http:request_response:POST /api/rooms/:id/join",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{code:string}",
      "response.body:{conductorMode:\"advanced\"|\"standard\";createdAt:string;discoverable?:boolean;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;members:{actorId:string;agentAvatar?:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};agentId?:string;agentOwnerDisplayName?:string;agentOwnerHandle?:string;agentOwnerUserId?:string;agentResponseMode?:\"active\"|\"mention_only\"|\"observe\";displayName:string;handle?:string;kind:\"agent\"|\"user\";roomRole:\"admin\"|\"member\";userId?:string}[];namespaceId?:string;parentRoomId:string;threadRootMessageId:number;type:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.id.visibility.ag64s9",
    "locator": "http:request_response:POST /api/rooms/:id/visibility",
    "structuralSignatures": [
      "request.body:{discoverable?:boolean;public:boolean}",
      "request.params:{id:string}",
      "response.body:{code:string;error:string}",
      "response.body:{error:string}",
      "response.body:{ok:boolean}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.live.shadow.plan.10x975p",
    "locator": "http:request_response:POST /api/rooms/:roomId/live-shadow/plan",
    "structuralSignatures": [
      "request.body:unknown",
      "request.params:{roomId:string}",
      "response.body:{authorizationScheme?:\"human_ai_readable_v1\"|\"human_ai_readable_v2\"|\"human_peer_v1\"|\"shared_agent_v1\";reason:\"agent_authority_unavailable\"|\"device_unavailable\"|\"domain_unavailable\"|\"namespace_unavailable\"|\"policy_unavailable\"|\"recipient_sync_required\"|\"reservation_unavailable\";requiredNamespaceIds?:string[];responseVersion:1;status:\"unavailable\"}|{authorizationScheme?:\"human_ai_readable_v2\";planBytesBase64url:string;representationMode?:\"full_encryption\";responseVersion:1;status:\"planned\"}|{mode:\"plaintext_only\";responseVersion:1;status:\"disabled\"}|{reason:\"client_not_browser\"|\"request_shape_unsupported\"|\"room_topology_unsupported\";responseVersion:1;status:\"ineligible\"}",
      "response.body:{capability:\"manage_rooms\";code:\"manage_rooms_required\";error:\"manage_rooms_required\";message:\"The manage_rooms permission is required to notify everyone in this room.\"}",
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
    "observationId": "wire.http.request.response.post.api.rooms.roomid.pending.attention.7bat78",
    "locator": "http:request_response:POST /api/rooms/:roomId/pending-attention",
    "structuralSignatures": [
      "request.body:{authorizationDeviceId:string;clientActionSessionId:string;cursor?:string}",
      "request.params:{roomId:string}",
      "response.body:{challenge?:{authorizationPlanBytesBase64url:string;challengeId:string;deadlineAt:number;recipientPublicKeyBase64url:string;roomId:string};events:{allowedVerbs:\"always\"|\"deny\"|\"once\"|\"room\"[];approvalId:string;github?:{approvalId:string;digest:string;prepared:{account:{id:number;login:string};digest:string;generation:string;preparationId:string;pullRequest?:{base:{ref:string;sha:string};forkNetworkId:number;head:{ref:string;sha:string};headRepository:{fullName:string;htmlUrl:string;id:number};maintainerCanModify:false};repository:{fullName:string;htmlUrl:string;id:number};request:{baseBranch:string;body:string;draft:boolean;headBranch:string;headRepository:string;operation:\"pr_create\";repository:string;title:string}|{body:string;number:number;operation:\"comment_create\";repository:string};resource:{body:string;htmlUrl:string;id:number;kind:\"issue\"|\"pull_request\";number:number;state:\"closed\"|\"open\";title:string};toolCallId:string;version:1}|{digest:string;generation:string;local:{identity:{commonDir:string;gitDir:string;isLinkedWorktree:boolean;workTree:string};indexHash:string;objectFormat:\"sha1\"|\"sha256\";repositoryStamp:string;sourceBranch:string;sourceOid:string};preparationId:string;remote:{accountId:number;accountLogin:string;branch:string;oid:string;repository:string;repositoryId:number};request:{destinationBranch:string;operation:\"push\";repository:string;sourceBranch:string};toolCallId:string;version:1};version:1};laneKey:string;localMcpInstall?:{digest:string;preview:{availabilitySummary:string;digest:string;environment:{name:string;present:boolean}[];human:string;machine:string;mayDownloadOnFirstRun:boolean;name:string;package:{name:string;version?:string};relayId:string;source:{label:string;url?:string};subprocessSandboxed:false;transport:{args:string[];command:string;kind:\"stdio\"}|{kind:\"streamable-http\";url:string};unpinnedPackage:boolean;version:\"local-mcp-install-v1\"};version:\"local-mcp-install-v1\"};mediaGeneration?:{digest:string;expiresAt:string;preview:{mediaKind:\"music\"|\"video\";model:\"minimax-h3-enhanced-text-to-video\"|\"minimax-music-v26\"|\"seedance-2-5-reference-to-video-basic\"|\"seedance-2-5-text-to-video-basic\"|\"sonilo-v1-1-music\";prompt:{characterCount:number;summary:string;truncated:boolean};quote:{amountMicros:number;currency:\"USD\";display:string};referenceAudios?:{artifactId:string;content?:{mimeType:string;sha256:string;sizeBytes:number};durationSeconds:number;index:number;label:string}[];referenceImages?:{artifactId:string;content?:{mimeType:string;sha256:string;sizeBytes:number};index:number;label:string}[];referenceVideos?:{artifactId:string;content?:{mimeType:string;sha256:string;sizeBytes:number};durationSeconds:number;index:number;label:string}[];settings:{[key:string]:false|number|string|true};spendNotice:\"Approving starts a paid generation using this exact quote.\"};quoteDigest:string;revision:1;version:\"media-generation-approval-v1\"};network?:{host:string;port:number;reason:string;suggestedRule:{cidr?:string;host?:string;ports?:number[];suffix?:string;type:\"cidr\"|\"domain\"|\"wildcard\"}};origin?:\"task\";reason:string;reasonCode:\"command-scanner-high\"|\"command-scanner-medium\"|\"destructive-tool\"|\"external-binary\"|\"network-egress-denied\"|\"tier-bump\";requiresExplicitReview?:boolean;scopeInfo?:{approvalKind?:\"capability\"|\"tool\";capabilitySlug?:string;generalizedDisplay:string;onceDisplay:string;sameAsOnce:boolean}[];structuredSsh?:{approvedRequestDigest:string;argv?:string[];host:string;hostKeyFingerprint:string;hostTrust:\"changed\"|\"trusted\"|\"unknown\";localPath?:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";port:number;preparationId:string;previousHostKeyFingerprint?:string;program?:string;remotePath?:string;remoteUser:string;timeoutReason?:string;timeoutSeconds?:number;toolCallId:string;version:\"structured-ssh-v1\"};taskId?:string;taskRunId?:string;threadId:string;tools:{args:{[key:string]:unknown};id?:string;name:string;runShellTimeout?:{reason:string;timeoutSeconds:number};shareArtifactPreview?:{artifactPathSnippet:string;mimeType:string;roomLabel:string;sensitivity:\"normal\"|\"sensitive\";size:number;targetDisplayName:string;targetHandle:string;wouldCreate:boolean};shareMemoryPreview?:{memoryContentSnippet:string;memoryType:string;projection?:{audienceWarning:string;content:string;expiresAt?:number;memberCount:number;mode:\"project\";roomKind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";roomLabel:string};protectedApprovalDigest?:string;roomLabel:string;sensitivity:\"normal\"|\"sensitive\";targetDisplayName:string;targetHandle:string;wouldCreate:boolean}}[];type:\"approval.ask\";userId?:string}|{challengeId:string;expiresAt:string;laneKey:string;mode?:\"enrollPin\"|\"verify\";origin?:\"task\";taskId?:string;taskRunId?:string;threadId:string;type:\"identity.challenge\";userId?:string}|{challengeId?:string;laneKey:string;origin?:\"task\";taskId?:string;taskRunId?:string;threadId:string;tools:{args:{[key:string]:unknown};id?:string;name:string;runShellTimeout?:{reason:string;timeoutSeconds:number};shareArtifactPreview?:{artifactPathSnippet:string;mimeType:string;roomLabel:string;sensitivity:\"normal\"|\"sensitive\";size:number;targetDisplayName:string;targetHandle:string;wouldCreate:boolean};shareMemoryPreview?:{memoryContentSnippet:string;memoryType:string;projection?:{audienceWarning:string;content:string;expiresAt?:number;memberCount:number;mode:\"project\";roomKind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";roomLabel:string};protectedApprovalDigest?:string;roomLabel:string;sensitivity:\"normal\"|\"sensitive\";targetDisplayName:string;targetHandle:string;wouldCreate:boolean}}[];type:\"prove_it.challenge\";userId?:string}[];nextCursor:string;status:\"ready\"|\"unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.events[].tools[].args",
        "schema": "TaskAttentionToolArgumentsV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.roomid.pending.attention.read.s0hx9d",
    "locator": "http:request_response:POST /api/rooms/:roomId/pending-attention/read",
    "structuralSignatures": [
      "request.body:{authorizationBytesBase64url:string;authorizationDeviceId:string;challengeId:string;clientActionSessionId:string}",
      "request.params:{roomId:string}",
      "response.body:{error:string}",
      "response.body:{events:undefined[];status:string}",
      "response.body:{events:{allowedVerbs:\"always\"|\"deny\"|\"once\"|\"room\"[];approvalId:string;github?:{approvalId:string;digest:string;prepared:{account:{id:number;login:string};digest:string;generation:string;preparationId:string;pullRequest?:{base:{ref:string;sha:string};forkNetworkId:number;head:{ref:string;sha:string};headRepository:{fullName:string;htmlUrl:string;id:number};maintainerCanModify:false};repository:{fullName:string;htmlUrl:string;id:number};request:{baseBranch:string;body:string;draft:boolean;headBranch:string;headRepository:string;operation:\"pr_create\";repository:string;title:string}|{body:string;number:number;operation:\"comment_create\";repository:string};resource:{body:string;htmlUrl:string;id:number;kind:\"issue\"|\"pull_request\";number:number;state:\"closed\"|\"open\";title:string};toolCallId:string;version:1}|{digest:string;generation:string;local:{identity:{commonDir:string;gitDir:string;isLinkedWorktree:boolean;workTree:string};indexHash:string;objectFormat:\"sha1\"|\"sha256\";repositoryStamp:string;sourceBranch:string;sourceOid:string};preparationId:string;remote:{accountId:number;accountLogin:string;branch:string;oid:string;repository:string;repositoryId:number};request:{destinationBranch:string;operation:\"push\";repository:string;sourceBranch:string};toolCallId:string;version:1};version:1};laneKey:string;localMcpInstall?:{digest:string;preview:{availabilitySummary:string;digest:string;environment:{name:string;present:boolean}[];human:string;machine:string;mayDownloadOnFirstRun:boolean;name:string;package:{name:string;version?:string};relayId:string;source:{label:string;url?:string};subprocessSandboxed:false;transport:{args:string[];command:string;kind:\"stdio\"}|{kind:\"streamable-http\";url:string};unpinnedPackage:boolean;version:\"local-mcp-install-v1\"};version:\"local-mcp-install-v1\"};mediaGeneration?:{digest:string;expiresAt:string;preview:{mediaKind:\"music\"|\"video\";model:\"minimax-h3-enhanced-text-to-video\"|\"minimax-music-v26\"|\"seedance-2-5-reference-to-video-basic\"|\"seedance-2-5-text-to-video-basic\"|\"sonilo-v1-1-music\";prompt:{characterCount:number;summary:string;truncated:boolean};quote:{amountMicros:number;currency:\"USD\";display:string};referenceAudios?:{artifactId:string;content?:{mimeType:string;sha256:string;sizeBytes:number};durationSeconds:number;index:number;label:string}[];referenceImages?:{artifactId:string;content?:{mimeType:string;sha256:string;sizeBytes:number};index:number;label:string}[];referenceVideos?:{artifactId:string;content?:{mimeType:string;sha256:string;sizeBytes:number};durationSeconds:number;index:number;label:string}[];settings:{[key:string]:false|number|string|true};spendNotice:\"Approving starts a paid generation using this exact quote.\"};quoteDigest:string;revision:1;version:\"media-generation-approval-v1\"};network?:{host:string;port:number;reason:string;suggestedRule:{cidr?:string;host?:string;ports?:number[];suffix?:string;type:\"cidr\"|\"domain\"|\"wildcard\"}};origin?:\"task\";reason:string;reasonCode:\"command-scanner-high\"|\"command-scanner-medium\"|\"destructive-tool\"|\"external-binary\"|\"network-egress-denied\"|\"tier-bump\";requiresExplicitReview?:boolean;scopeInfo?:{approvalKind?:\"capability\"|\"tool\";capabilitySlug?:string;generalizedDisplay:string;onceDisplay:string;sameAsOnce:boolean}[];structuredSsh?:{approvedRequestDigest:string;argv?:string[];host:string;hostKeyFingerprint:string;hostTrust:\"changed\"|\"trusted\"|\"unknown\";localPath?:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";port:number;preparationId:string;previousHostKeyFingerprint?:string;program?:string;remotePath?:string;remoteUser:string;timeoutReason?:string;timeoutSeconds?:number;toolCallId:string;version:\"structured-ssh-v1\"};taskId?:string;taskRunId?:string;threadId:string;tools:{args:{[key:string]:unknown};id?:string;name:string;runShellTimeout?:{reason:string;timeoutSeconds:number};shareArtifactPreview?:{artifactPathSnippet:string;mimeType:string;roomLabel:string;sensitivity:\"normal\"|\"sensitive\";size:number;targetDisplayName:string;targetHandle:string;wouldCreate:boolean};shareMemoryPreview?:{memoryContentSnippet:string;memoryType:string;projection?:{audienceWarning:string;content:string;expiresAt?:number;memberCount:number;mode:\"project\";roomKind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";roomLabel:string};protectedApprovalDigest?:string;roomLabel:string;sensitivity:\"normal\"|\"sensitive\";targetDisplayName:string;targetHandle:string;wouldCreate:boolean}}[];type:\"approval.ask\";userId?:string}|{challengeId:string;expiresAt:string;laneKey:string;mode?:\"enrollPin\"|\"verify\";origin?:\"task\";taskId?:string;taskRunId?:string;threadId:string;type:\"identity.challenge\";userId?:string}|{challengeId?:string;laneKey:string;origin?:\"task\";taskId?:string;taskRunId?:string;threadId:string;tools:{args:{[key:string]:unknown};id?:string;name:string;runShellTimeout?:{reason:string;timeoutSeconds:number};shareArtifactPreview?:{artifactPathSnippet:string;mimeType:string;roomLabel:string;sensitivity:\"normal\"|\"sensitive\";size:number;targetDisplayName:string;targetHandle:string;wouldCreate:boolean};shareMemoryPreview?:{memoryContentSnippet:string;memoryType:string;projection?:{audienceWarning:string;content:string;expiresAt?:number;memberCount:number;mode:\"project\";roomKind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";roomLabel:string};protectedApprovalDigest?:string;roomLabel:string;sensitivity:\"normal\"|\"sensitive\";targetDisplayName:string;targetHandle:string;wouldCreate:boolean}}[];type:\"prove_it.challenge\";userId?:string}[];status:\"read\"|\"unavailable\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.events[].tools[].args",
        "schema": "TaskAttentionToolArgumentsV1"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.rooms.resolve.landing.jejy9t",
    "locator": "http:request_response:POST /api/rooms/resolve-landing",
    "structuralSignatures": [
      "response.body:{code:string;error:string}",
      "response.body:{code:string}",
      "response.body:{conductorMode:\"advanced\"|\"standard\";createdAt:string;discoverable?:boolean;graphThreadId:string;id:string;kind:\"access\"|\"group\"|\"multi_agent\"|\"open\"|\"private\"|\"subthread\"|\"task\";label:string;members:{actorId:string;agentAvatar?:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};agentId?:string;agentOwnerDisplayName?:string;agentOwnerHandle?:string;agentOwnerUserId?:string;agentResponseMode?:\"active\"|\"mention_only\"|\"observe\";displayName:string;handle?:string;kind:\"agent\"|\"user\";roomRole:\"admin\"|\"member\";userId?:string}[];namespaceId?:string;parentRoomId:string;threadRootMessageId:number;type:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.stt.175obc5",
    "locator": "http:request_response:POST /api/stt",
    "structuralSignatures": [
      "response.body:{capability:\"approve_destructive_actions\"|\"approve_spending\"|\"ban_room_members\"|\"ban_server_members\"|\"control_browser\"|\"control_desktop\"|\"control_home\"|\"create_invites\"|\"create_rooms\"|\"invoke_agents\"|\"invoke_other_agents\"|\"kick_room_members\"|\"kick_server_members\"|\"manage_agents\"|\"manage_billing\"|\"manage_connection_providers\"|\"manage_groups\"|\"manage_members\"|\"manage_memories\"|\"manage_roles\"|\"manage_rooms\"|\"manage_server_enrollment\"|\"manage_server_operations\"|\"manage_server_security\"|\"manage_server_settings\"|\"manage_standing_approvals\"|\"manage_uncontained_host_commands\"|\"manage_workstation_profiles\"|\"moderate_content_reports\"|\"read_memories\"|\"read_server_settings\"|\"timeout_room_members\"|\"timeout_server_members\"|\"use_connections\"|\"use_google_workspace\"|\"use_image_generation\"|\"use_media_generation\"|\"use_personal_provider_credentials\"|\"use_project_content\"|\"use_project_execution\"|\"use_remote_hosts\"|\"use_research_tools\"|\"use_server_provider_credentials\"|\"use_share_artifact\"|\"use_transcription\"|\"use_workstation\"|\"view_audit_log\"|\"view_room_moderation\"|\"view_server_moderation\"|\"write_artifacts\";code:\"agent_target_unavailable\"|\"invocation_access_withdrawn\"|\"invoke_agents_required\"|\"invoke_other_agents_required\"|\"server_provider_credentials_required\"|\"write_artifacts_required\";error:\"agent_target_unavailable\"|\"invocation_access_withdrawn\"|\"invoke_agents_required\"|\"invoke_other_agents_required\"|\"server_provider_credentials_required\"|\"write_artifacts_required\"}",
      "response.body:{detail:string;error:string}",
      "response.body:{detail?:any;error:any}",
      "response.body:{error:string}",
      "response.body:{model:string;provider:string;text:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.detail",
        "debtId": "debt.wire.arbitrary.5tr3g"
      },
      {
        "path": "response.body.error",
        "debtId": "debt.wire.arbitrary.109j3c9"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.voices.voiceid.preview.fj0wgi",
    "locator": "http:request_response:POST /api/voices/:voiceId/preview",
    "structuralSignatures": [
      "request.body:{text?:string}",
      "request.params:{voiceId:string}",
      "response.body:{_construct?:function;_destroy:function;_read:function;addListener:function;asIndexedPairs:function;bytesRead:number;close:function;closed:boolean;compose:function;destroy:function;destroyed:boolean;drop:function;emit:function;errored:{cause?:unknown;message:string;name:string;stack?:string};eventNames:function;every:function;filter:function;find:function;flatMap:function;forEach:function;getMaxListeners:function;isPaused:function;iterator:function;listenerCount:function;listeners:function;map:function;off:function;on:function;once:function;path:Buffer|string;pause:function;pending:boolean;pipe:function;prependListener:function;prependOnceListener:function;push:function;rawListeners:function;read:function;readable:boolean;readableAborted:boolean;readableDidRead:boolean;readableEncoding:\"ascii\"|\"base64\"|\"base64url\"|\"binary\"|\"hex\"|\"latin1\"|\"ucs-2\"|\"ucs2\"|\"utf-16le\"|\"utf-8\"|\"utf16le\"|\"utf8\";readableEnded:boolean;readableFlowing:boolean;readableHighWaterMark:number;readableLength:number;readableObjectMode:boolean;reduce:function;removeAllListeners:function;removeListener:function;resume:function;setEncoding:function;setMaxListeners:function;some:function;take:function;toArray:function;unpipe:function;unshift:function;wrap:function}",
      "response.body:{capability:\"approve_destructive_actions\"|\"approve_spending\"|\"ban_room_members\"|\"ban_server_members\"|\"control_browser\"|\"control_desktop\"|\"control_home\"|\"create_invites\"|\"create_rooms\"|\"invoke_agents\"|\"invoke_other_agents\"|\"kick_room_members\"|\"kick_server_members\"|\"manage_agents\"|\"manage_billing\"|\"manage_connection_providers\"|\"manage_groups\"|\"manage_members\"|\"manage_memories\"|\"manage_roles\"|\"manage_rooms\"|\"manage_server_enrollment\"|\"manage_server_operations\"|\"manage_server_security\"|\"manage_server_settings\"|\"manage_standing_approvals\"|\"manage_uncontained_host_commands\"|\"manage_workstation_profiles\"|\"moderate_content_reports\"|\"read_memories\"|\"read_server_settings\"|\"timeout_room_members\"|\"timeout_server_members\"|\"use_connections\"|\"use_google_workspace\"|\"use_image_generation\"|\"use_media_generation\"|\"use_personal_provider_credentials\"|\"use_project_content\"|\"use_project_execution\"|\"use_remote_hosts\"|\"use_research_tools\"|\"use_server_provider_credentials\"|\"use_share_artifact\"|\"use_transcription\"|\"use_workstation\"|\"view_audit_log\"|\"view_room_moderation\"|\"view_server_moderation\"|\"write_artifacts\";code:\"agent_target_unavailable\"|\"invocation_access_withdrawn\"|\"invoke_agents_required\"|\"invoke_other_agents_required\"|\"server_provider_credentials_required\"|\"write_artifacts_required\";error:\"agent_target_unavailable\"|\"invocation_access_withdrawn\"|\"invoke_agents_required\"|\"invoke_other_agents_required\"|\"server_provider_credentials_required\"|\"write_artifacts_required\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.errored.cause",
        "debtId": "debt.wire.arbitrary.19gyh7u"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.put.api.profile.1vd6o6o",
    "locator": "http:request_response:PUT /api/profile",
    "structuralSignatures": [
      "request.body:{defaultModel?:string;language?:string;motherAnswer?:string;name?:string;onboardingCompleted?:boolean;personalityPrompt?:string;personalityTone?:string;privacySpectrum?:number;publicProfile?:boolean;soulFile?:string;timezone?:string;welcomeMessageSent?:boolean;workLifeMode?:string}",
      "response.body:{agent:{agentIdentity:string;avatar:{blobId:string;kind:\"generated\"}|{blobId:string;kind:\"uploaded\"}|{id:string;kind:\"preset\"};avatarUrl:\"/api/profile/avatar\";defaultModel:string;fallback:{chain:string[];enabled:boolean};handle:string;language:string;name:string;onboardingCompleted:boolean;personality:{motherAnswer:string;prompt:string;tone:string};privacySpectrum:number;publicProfile:boolean;soulFile:string;voices:{[key:string]:{voiceId:string;voiceName:string}};welcomeMessageSent:boolean;workLifeMode:\"both\"|\"life\"|\"work\"};ownedAgents:{agentId:string;displayName:string;handle:string}[];viewerRole:\"owner\"}|{agent:{avatar:{id:\"shell\";kind:\"preset\"};avatarUrl:\"/api/profile/avatar\";name:\"Genie\"};viewerRole:\"guest\"|\"stranger\"}",
      "response.body:{code:string;error:string;model:{availability:\"filtered\"|\"missing-key\"|\"selectable\"|\"unknown-model\"|\"unsupported-capability\";modelId:string;reason:string}}",
      "response.body:{code:string;error:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.put.api.security.posture.du15aa",
    "locator": "http:request_response:PUT /api/security/posture",
    "structuralSignatures": [
      "request.body:{allowUncontainedHostCommands?:unknown;deploymentMode?:string;localNetworkPolicy?:unknown;networkPolicy?:unknown;pin?:string;securityLevel?:string}",
      "response.body:{allowUncontainedHostCommands:boolean;capabilities:\"manage_server_security\"|\"manage_uncontained_host_commands\"[];changed:boolean;deploymentMode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";localNetworkPolicy:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};networkPolicy:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\"}",
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
        "path": "request.body.localNetworkPolicy",
        "schema": "NetworkPolicySchema"
      },
      {
        "path": "request.body.networkPolicy",
        "debtId": "debt.wire.arbitrary.29ocdw"
      }
    ]
  },
  {
    "observationId": "wire.relay.declared.arbitrary.packages.relay.src.protocol.ts.relaydispatchrequest.1xd01c2",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayDispatchRequest",
    "structuralSignatures": [
      "declaration.payload:{allowedRoots?:string[]|undefined;approvalObtained:boolean;args:{[key:string]:unknown};browserPageOwnerBinding?:undefined|{desktopSessionId:null|string;instanceId:string;relayId:string;userId:string};browserPageSnapshotReferencePublication?:true|undefined;computerUseRequest?:undefined|{arguments:unresolved<Readonly>;contract:unresolved<ComputerUseHostContract>};correlationId:string;desktopAutomationBinding?:undefined|{computerUseContextId:string;computerUseInvocationId:string;desktopSessionId:string;grantGeneration:number;installationEpoch:string;lineageId:string;originAgentId:string;originHumanId:string;originRunId:string;pairingGeneration:string;provider:\"cua\";providerGeneration:string;relayId:string;version:typeof RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION};desktopFilesystemGrantRequest?:undefined|{grantIds:string[];operation:unresolved<DesktopFilesystemAccessOperation>;policy:{expiresAt?:string|undefined;lifetime:unresolved<DesktopFilesystemGrantLifetime>;policyVersion:number};requestedRoot:string;requiredOperations?:undefined|unresolved<DesktopFilesystemAccessOperation>[];subject:unresolved<DesktopFilesystemGrantSubject>;version:typeof RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION};executionClass?:\"browser\"|\"computer_use\"|\"desktop\"|\"fs\"|\"local-file\"|\"real_workstation\"|\"structured-ssh\"|undefined;githubBinding?:undefined|unresolved<GitHubInvocationBinding>&{localNetworkPolicy:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"}};hostedBy?:string|undefined;humanTerminalBinding?:undefined|{generation:string;invocationId:string;owner:unresolved<HumanTerminalOwner>;version:1};impact:\"destructive\"|\"high\"|\"low\"|\"read-only\";localExecutionBinding?:undefined|{authority:{activationId:string;kind:\"full_mac\";roomId:string};version:3}|{authority:{capabilityRevision:number;currentFolder:string;kind:\"basic\";protectedPolicyVersion:number;roomId:string};version:2}|{authority:{delegation:unresolved<LocalExecutionDelegation>;kind:\"delegated\";roomId:string;taskId:string;taskRunId:string};version:4}|{executionId:string;generation:string;invocationId:string;localNetworkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};operation:\"cancel\"|\"input\"|\"read\"|\"start\";owner:{agentId:string;conversationId:string;desktopSessionId:string;grantIds:string[];grantRevision:null|number;humanUserId:string;instanceId:string;pairingGeneration:string;profileId:null|string;profileRevision:null|number;protectedPolicyVersion:null|number;relayId:string;runId:string;serverBindingId:string};version:1};localExecutionDelegationCapture?:undefined|{desktopSessionId:string;invocationId:string;pairingGeneration:string;source:unresolved<Omit>&{target:unresolved<Omit>};version:1};localExecutionHistoryBinding?:undefined|{executionId:string;generation:string;invocationId:string;reader:unresolved<Readonly>;sourceMessageId:number;version:1};reportRunShellProgress?:(progress: Omit<RelayRunShellProgressMessage, \"type\" | \"correlationId\">) => void|undefined;reportSecurityScanProgress?:(progress: SecurityScanProgress) => void|undefined;reportStructuredSshProgress?:(progress: RelayStructuredSshProgressObservation) => void|undefined;runShellOwnerBinding?:undefined|{desktopSessionId:null|string;instanceId:string;relayId:string;userId:string};sandboxProfile?:undefined|{config:{mode:\"disabled\"|\"enabled\";networkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};passthroughEnv:string[];projectPaths:string[];protectedFileMaskPath?:string;protectedPaths?:string[];readOnlyPaths?:string[];writablePaths:string[]};dataDir:string;failIfNoBackend:boolean;mode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";toolsBin:string;workspace:string};sshBinding?:undefined|{admissionId:string;approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";preparationId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_DISPATCH_BINDING_VERSION};structuredSshOutputOwnerBinding?:undefined|{desktopSessionId:null|string;instanceId:string;relayId:string;userId:string};timeout?:number|undefined;toolName:string;uncontainedHostCommandsSession?:true|undefined;workstationShellBinding?:undefined|{capabilityRevision:number;currentFolder:string;desktopSessionId:string;executionClass:typeof RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS;grantIds:string[];grantRevision:number;operation:unresolved<DesktopFilesystemAccessOperation>;pairingGeneration:string;profileId:string;profileRevision:number;protectedPolicyVersion:number;relayId:string;serverBindingId:string;subject:{agentScope:string;instanceId:string;relayId:string;userId:string};toolCallId:string;version:typeof RELAY_WORKSTATION_SHELL_BINDING_VERSION}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "args",
        "debtId": "debt.wire.arbitrary.1ezwf46"
      },
      {
        "path": "computerUseRequest.arguments",
        "schema": "ComputerUseHostArgumentsV1"
      },
      {
        "path": "computerUseRequest.contract",
        "schema": "ComputerUseHostContractV1"
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
        "path": "githubBinding",
        "schema": "parseRelayGitHubInvocationBinding"
      },
      {
        "path": "humanTerminalBinding.owner",
        "schema": "parseHumanTerminalOwner"
      },
      {
        "path": "localExecutionBinding.authority.delegation",
        "schema": "parseLocalExecutionDelegation"
      },
      {
        "path": "localExecutionDelegationCapture.source",
        "schema": "parseRelayLocalExecutionDelegationCapture"
      },
      {
        "path": "localExecutionDelegationCapture.source.target",
        "schema": "parseRelayLocalExecutionDelegationCapture"
      },
      {
        "path": "localExecutionHistoryBinding.reader",
        "schema": "parseRelayLocalExecutionHistoryBinding"
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
      "declaration.payload:unresolved<RelayAcpServerMessage>|unresolved<RelayClaudeConnectionDiscoverCommand>|unresolved<RelayClaudeExecutionCommand>|unresolved<RelayCodexCancelMessage>|unresolved<RelayCodexCommandMessage>|unresolved<RelayCodexCreditMessage>|unresolved<RelayCodexRequestResponseMessage>|unresolved<RelayRegisteredV8>|{allowedRoots?:string[]|undefined;approvalObtained:boolean;args:{[key:string]:unknown};computerUseRequest?:undefined|{arguments:unresolved<Readonly>;contract:unresolved<ComputerUseHostContract>};correlationId:string;desktopAutomationBinding?:undefined|{computerUseContextId:string;computerUseInvocationId:string;desktopSessionId:string;grantGeneration:number;installationEpoch:string;lineageId:string;originAgentId:string;originHumanId:string;originRunId:string;pairingGeneration:string;provider:\"cua\";providerGeneration:string;relayId:string;version:typeof RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION};desktopFilesystemGrantRequest?:undefined|{grantIds:string[];operation:unresolved<DesktopFilesystemAccessOperation>;policy:{expiresAt?:string|undefined;lifetime:unresolved<DesktopFilesystemGrantLifetime>;policyVersion:number};requestedRoot:string;requiredOperations?:undefined|unresolved<DesktopFilesystemAccessOperation>[];subject:unresolved<DesktopFilesystemGrantSubject>;version:typeof RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION};executionClass?:\"browser\"|\"computer_use\"|\"desktop\"|\"fs\"|\"local-file\"|\"real_workstation\"|\"structured-ssh\"|undefined;githubBinding?:undefined|unresolved<GitHubInvocationBinding>&{localNetworkPolicy:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"}};hostedBy?:string|undefined;humanTerminalBinding?:undefined|{generation:string;invocationId:string;owner:unresolved<HumanTerminalOwner>;version:1};impact:\"destructive\"|\"high\"|\"low\"|\"read-only\";localExecutionBinding?:undefined|{authority:{activationId:string;kind:\"full_mac\";roomId:string};version:3}|{authority:{capabilityRevision:number;currentFolder:string;kind:\"basic\";protectedPolicyVersion:number;roomId:string};version:2}|{authority:{delegation:unresolved<LocalExecutionDelegation>;kind:\"delegated\";roomId:string;taskId:string;taskRunId:string};version:4}|{executionId:string;generation:string;invocationId:string;localNetworkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};operation:\"cancel\"|\"input\"|\"read\"|\"start\";owner:{agentId:string;conversationId:string;desktopSessionId:string;grantIds:string[];grantRevision:null|number;humanUserId:string;instanceId:string;pairingGeneration:string;profileId:null|string;profileRevision:null|number;protectedPolicyVersion:null|number;relayId:string;runId:string;serverBindingId:string};version:1};localExecutionDelegationCapture?:undefined|{desktopSessionId:string;invocationId:string;pairingGeneration:string;source:unresolved<Omit>&{target:unresolved<Omit>};version:1};localExecutionHistoryBinding?:undefined|{executionId:string;generation:string;invocationId:string;reader:unresolved<Readonly>;sourceMessageId:number;version:1};sandboxProfile?:undefined|{config:{mode:\"disabled\"|\"enabled\";networkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};passthroughEnv:string[];projectPaths:string[];protectedFileMaskPath?:string;protectedPaths?:string[];readOnlyPaths?:string[];writablePaths:string[]};dataDir:string;failIfNoBackend:boolean;mode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";toolsBin:string;workspace:string};sshBinding?:undefined|{admissionId:string;approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";preparationId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_DISPATCH_BINDING_VERSION};timeout?:number|undefined;toolName:string;type:\"relay:dispatch\";uncontainedHostCommandsSession?:true|undefined;workstationShellBinding?:undefined|{capabilityRevision:number;currentFolder:string;desktopSessionId:string;executionClass:typeof RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS;grantIds:string[];grantRevision:number;operation:unresolved<DesktopFilesystemAccessOperation>;pairingGeneration:string;profileId:string;profileRevision:number;protectedPolicyVersion:number;relayId:string;serverBindingId:string;subject:{agentScope:string;instanceId:string;relayId:string;userId:string};toolCallId:string;version:typeof RELAY_WORKSTATION_SHELL_BINDING_VERSION}}|{capabilityRevision:number;error?:string|undefined;relayId:string;status:\"ok\"|\"rejected\";type:\"relay:capabilities-updated\"}|{code?:typeof import(\"./constants\").RELAY_AUTHENTICATION_REQUIRED_ERROR_CODE;message:string;type:\"relay:error\"}|{correlationId:string;type:\"relay:cancel\"}|{digest:string;requestId:string;server:{envPassthrough?:null|string[]|undefined;excludeTools?:null|string[]|undefined;includeTools?:null|string[]|undefined;name:string;namespaceId?:null|string|undefined;transport:{[key:string]:unknown};transportKind:\"sse-legacy\"|\"stdio\"|\"streamable-http\";trustTier?:null|string|undefined};type:\"relay:mcp-preflight\"}|{operation?:undefined|{digest:string;operationId:string;phase:\"rollback\"|\"start\";targetName:string};servers:{envPassthrough?:null|string[]|undefined;excludeTools?:null|string[]|undefined;includeTools?:null|string[]|undefined;name:string;namespaceId?:null|string|undefined;transport:{[key:string]:unknown};transportKind:\"sse-legacy\"|\"stdio\"|\"streamable-http\";trustTier?:null|string|undefined}[];type:\"relay:configure-mcp\"}|{protocolVersion?:number|undefined;relayId:string;type:\"relay:registered\"}|{request:{approvedRequest:{args:{argv:string[];destination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string};program:string;timeoutReason?:string|undefined;timeoutSeconds:number};toolCallId:string;toolName:\"structured_ssh_exec\";version:typeof RELAY_SSH_APPROVED_REQUEST_VERSION}|{args:{destination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string};localPath:string;remotePath:string;timeoutReason?:string|undefined;timeoutSeconds:number};toolCallId:string;toolName:\"structured_ssh_copy_download\";version:typeof RELAY_SSH_APPROVED_REQUEST_VERSION}|{args:{destination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string};localPath:string;remotePath:string;timeoutReason?:string|undefined;timeoutSeconds:number};toolCallId:string;toolName:\"structured_ssh_copy_upload\";version:typeof RELAY_SSH_APPROVED_REQUEST_VERSION}|{args:{destination:{connection:string;host?:undefined;port?:undefined;user?:undefined}|{connection?:undefined;host:string;port?:number|undefined;user:string}};toolCallId:string;toolName:\"structured_ssh_auth\";version:typeof RELAY_SSH_APPROVED_REQUEST_VERSION};approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";requestId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_PREPARE_VERSION};type:\"relay:ssh-prepare\"}"
    ],
    "arbitraryPayloads": [
      {
        "path": "args",
        "debtId": "debt.wire.arbitrary.10l7ijx"
      },
      {
        "path": "computerUseRequest.arguments",
        "schema": "ComputerUseHostArgumentsV1"
      },
      {
        "path": "computerUseRequest.contract",
        "schema": "ComputerUseHostContractV1"
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
        "path": "githubBinding",
        "schema": "parseRelayGitHubInvocationBinding"
      },
      {
        "path": "humanTerminalBinding.owner",
        "schema": "parseHumanTerminalOwner"
      },
      {
        "path": "localExecutionBinding.authority.delegation",
        "schema": "parseLocalExecutionDelegation"
      },
      {
        "path": "localExecutionDelegationCapture.source",
        "schema": "parseRelayLocalExecutionDelegationCapture"
      },
      {
        "path": "localExecutionDelegationCapture.source.target",
        "schema": "parseRelayLocalExecutionDelegationCapture"
      },
      {
        "path": "localExecutionHistoryBinding.reader",
        "schema": "parseRelayLocalExecutionHistoryBinding"
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
    "observationId": "wire.relay.server.to.client.relay.dispatch.lnqowy",
    "locator": "relay:server_to_client:relay:dispatch",
    "structuralSignatures": [
      "frame.payload:{allowedRoots?:string[]|undefined;approvalObtained:boolean;args:{[key:string]:unknown};computerUseRequest?:undefined|{arguments:unresolved<Readonly>;contract:unresolved<ComputerUseHostContract>};correlationId:string;desktopAutomationBinding?:undefined|{computerUseContextId:string;computerUseInvocationId:string;desktopSessionId:string;grantGeneration:number;installationEpoch:string;lineageId:string;originAgentId:string;originHumanId:string;originRunId:string;pairingGeneration:string;provider:\"cua\";providerGeneration:string;relayId:string;version:typeof RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION};desktopFilesystemGrantRequest?:undefined|{grantIds:string[];operation:unresolved<DesktopFilesystemAccessOperation>;policy:{expiresAt?:string|undefined;lifetime:unresolved<DesktopFilesystemGrantLifetime>;policyVersion:number};requestedRoot:string;requiredOperations?:undefined|unresolved<DesktopFilesystemAccessOperation>[];subject:unresolved<DesktopFilesystemGrantSubject>;version:typeof RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION};executionClass?:\"browser\"|\"computer_use\"|\"desktop\"|\"fs\"|\"local-file\"|\"real_workstation\"|\"structured-ssh\"|undefined;githubBinding?:undefined|unresolved<GitHubInvocationBinding>&{localNetworkPolicy:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"}};hostedBy?:string|undefined;humanTerminalBinding?:undefined|{generation:string;invocationId:string;owner:unresolved<HumanTerminalOwner>;version:1};impact:\"destructive\"|\"high\"|\"low\"|\"read-only\";localExecutionBinding?:undefined|{authority:{activationId:string;kind:\"full_mac\";roomId:string};version:3}|{authority:{capabilityRevision:number;currentFolder:string;kind:\"basic\";protectedPolicyVersion:number;roomId:string};version:2}|{authority:{delegation:unresolved<LocalExecutionDelegation>;kind:\"delegated\";roomId:string;taskId:string;taskRunId:string};version:4}|{executionId:string;generation:string;invocationId:string;localNetworkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};operation:\"cancel\"|\"input\"|\"read\"|\"start\";owner:{agentId:string;conversationId:string;desktopSessionId:string;grantIds:string[];grantRevision:null|number;humanUserId:string;instanceId:string;pairingGeneration:string;profileId:null|string;profileRevision:null|number;protectedPolicyVersion:null|number;relayId:string;runId:string;serverBindingId:string};version:1};localExecutionDelegationCapture?:undefined|{desktopSessionId:string;invocationId:string;pairingGeneration:string;source:unresolved<Omit>&{target:unresolved<Omit>};version:1};localExecutionHistoryBinding?:undefined|{executionId:string;generation:string;invocationId:string;reader:unresolved<Readonly>;sourceMessageId:number;version:1};sandboxProfile?:undefined|{config:{mode:\"disabled\"|\"enabled\";networkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};passthroughEnv:string[];projectPaths:string[];protectedFileMaskPath?:string;protectedPaths?:string[];readOnlyPaths?:string[];writablePaths:string[]};dataDir:string;failIfNoBackend:boolean;mode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";toolsBin:string;workspace:string};sshBinding?:undefined|{admissionId:string;approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";preparationId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_DISPATCH_BINDING_VERSION};timeout?:number|undefined;toolName:string;type:\"relay:dispatch\";uncontainedHostCommandsSession?:true|undefined;workstationShellBinding?:undefined|{capabilityRevision:number;currentFolder:string;desktopSessionId:string;executionClass:typeof RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS;grantIds:string[];grantRevision:number;operation:unresolved<DesktopFilesystemAccessOperation>;pairingGeneration:string;profileId:string;profileRevision:number;protectedPolicyVersion:number;relayId:string;serverBindingId:string;subject:{agentScope:string;instanceId:string;relayId:string;userId:string};toolCallId:string;version:typeof RELAY_WORKSTATION_SHELL_BINDING_VERSION}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "args",
        "debtId": "debt.wire.arbitrary.1ctmkbq"
      },
      {
        "path": "computerUseRequest.arguments",
        "schema": "ComputerUseHostArgumentsV1"
      },
      {
        "path": "computerUseRequest.contract",
        "schema": "ComputerUseHostContractV1"
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
        "path": "githubBinding",
        "schema": "parseRelayGitHubInvocationBinding"
      },
      {
        "path": "humanTerminalBinding.owner",
        "schema": "parseHumanTerminalOwner"
      },
      {
        "path": "localExecutionBinding.authority.delegation",
        "schema": "parseLocalExecutionDelegation"
      },
      {
        "path": "localExecutionDelegationCapture.source",
        "schema": "parseRelayLocalExecutionDelegationCapture"
      },
      {
        "path": "localExecutionDelegationCapture.source.target",
        "schema": "parseRelayLocalExecutionDelegationCapture"
      },
      {
        "path": "localExecutionHistoryBinding.reader",
        "schema": "parseRelayLocalExecutionHistoryBinding"
      },
      {
        "path": "workstationShellBinding.operation",
        "debtId": "debt.wire.arbitrary.1aip35m"
      }
    ]
  },
  {
    "observationId": "wire.relay.server.to.client.arbitrary.packages.relay.src.protocol.ts.relaydispatchmessage.f3am3r",
    "locator": "relay:server_to_client_arbitrary:packages/relay/src/protocol.ts#RelayDispatchMessage",
    "structuralSignatures": [
      "declaration.payload:{allowedRoots?:string[]|undefined;approvalObtained:boolean;args:{[key:string]:unknown};computerUseRequest?:undefined|{arguments:unresolved<Readonly>;contract:unresolved<ComputerUseHostContract>};correlationId:string;desktopAutomationBinding?:undefined|{computerUseContextId:string;computerUseInvocationId:string;desktopSessionId:string;grantGeneration:number;installationEpoch:string;lineageId:string;originAgentId:string;originHumanId:string;originRunId:string;pairingGeneration:string;provider:\"cua\";providerGeneration:string;relayId:string;version:typeof RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION};desktopFilesystemGrantRequest?:undefined|{grantIds:string[];operation:unresolved<DesktopFilesystemAccessOperation>;policy:{expiresAt?:string|undefined;lifetime:unresolved<DesktopFilesystemGrantLifetime>;policyVersion:number};requestedRoot:string;requiredOperations?:undefined|unresolved<DesktopFilesystemAccessOperation>[];subject:unresolved<DesktopFilesystemGrantSubject>;version:typeof RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION};executionClass?:\"browser\"|\"computer_use\"|\"desktop\"|\"fs\"|\"local-file\"|\"real_workstation\"|\"structured-ssh\"|undefined;githubBinding?:undefined|unresolved<GitHubInvocationBinding>&{localNetworkPolicy:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"}};hostedBy?:string|undefined;humanTerminalBinding?:undefined|{generation:string;invocationId:string;owner:unresolved<HumanTerminalOwner>;version:1};impact:\"destructive\"|\"high\"|\"low\"|\"read-only\";localExecutionBinding?:undefined|{authority:{activationId:string;kind:\"full_mac\";roomId:string};version:3}|{authority:{capabilityRevision:number;currentFolder:string;kind:\"basic\";protectedPolicyVersion:number;roomId:string};version:2}|{authority:{delegation:unresolved<LocalExecutionDelegation>;kind:\"delegated\";roomId:string;taskId:string;taskRunId:string};version:4}|{executionId:string;generation:string;invocationId:string;localNetworkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};operation:\"cancel\"|\"input\"|\"read\"|\"start\";owner:{agentId:string;conversationId:string;desktopSessionId:string;grantIds:string[];grantRevision:null|number;humanUserId:string;instanceId:string;pairingGeneration:string;profileId:null|string;profileRevision:null|number;protectedPolicyVersion:null|number;relayId:string;runId:string;serverBindingId:string};version:1};localExecutionDelegationCapture?:undefined|{desktopSessionId:string;invocationId:string;pairingGeneration:string;source:unresolved<Omit>&{target:unresolved<Omit>};version:1};localExecutionHistoryBinding?:undefined|{executionId:string;generation:string;invocationId:string;reader:unresolved<Readonly>;sourceMessageId:number;version:1};sandboxProfile?:undefined|{config:{mode:\"disabled\"|\"enabled\";networkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};passthroughEnv:string[];projectPaths:string[];protectedFileMaskPath?:string;protectedPaths?:string[];readOnlyPaths?:string[];writablePaths:string[]};dataDir:string;failIfNoBackend:boolean;mode:\"desktop-locked\"|\"desktop-permissive\"|\"server\";securityLevel:\"cautious\"|\"paranoid\"|\"permissive\"|\"standard\"|\"yolo\";toolsBin:string;workspace:string};sshBinding?:undefined|{admissionId:string;approvedRequestDigest:string;operation:\"auth\"|\"copy-download\"|\"copy-upload\"|\"exec\";preparationId:string;subject:{actorId:string;actorRole:\"admin\"|\"owner\";agentId:string;capabilityRevision:number;desktopSessionId:string;executionEntrypoint:\"foreground.main\";instanceId:string;pairingGenerationRef:string;relayId:string;relaySessionId:string;userId:string};toolCallId:string;version:typeof RELAY_SSH_DISPATCH_BINDING_VERSION};timeout?:number|undefined;toolName:string;type:\"relay:dispatch\";uncontainedHostCommandsSession?:true|undefined;workstationShellBinding?:undefined|{capabilityRevision:number;currentFolder:string;desktopSessionId:string;executionClass:typeof RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS;grantIds:string[];grantRevision:number;operation:unresolved<DesktopFilesystemAccessOperation>;pairingGeneration:string;profileId:string;profileRevision:number;protectedPolicyVersion:number;relayId:string;serverBindingId:string;subject:{agentScope:string;instanceId:string;relayId:string;userId:string};toolCallId:string;version:typeof RELAY_WORKSTATION_SHELL_BINDING_VERSION}}"
    ],
    "arbitraryPayloads": [
      {
        "path": "args",
        "debtId": "debt.wire.arbitrary.18ha82p"
      },
      {
        "path": "computerUseRequest.arguments",
        "schema": "ComputerUseHostArgumentsV1"
      },
      {
        "path": "computerUseRequest.contract",
        "schema": "ComputerUseHostContractV1"
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
        "path": "githubBinding",
        "schema": "parseRelayGitHubInvocationBinding"
      },
      {
        "path": "humanTerminalBinding.owner",
        "schema": "parseHumanTerminalOwner"
      },
      {
        "path": "localExecutionBinding.authority.delegation",
        "schema": "parseLocalExecutionDelegation"
      },
      {
        "path": "localExecutionDelegationCapture.source",
        "schema": "parseRelayLocalExecutionDelegationCapture"
      },
      {
        "path": "localExecutionDelegationCapture.source.target",
        "schema": "parseRelayLocalExecutionDelegationCapture"
      },
      {
        "path": "localExecutionHistoryBinding.reader",
        "schema": "parseRelayLocalExecutionHistoryBinding"
      },
      {
        "path": "workstationShellBinding.operation",
        "debtId": "debt.wire.arbitrary.2ylip7"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.profile.avatar.1y0j4kt",
    "locator": "http:request_response:GET /api/profile/avatar",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.rooms.id.agents.agentid.avatar.1rbwbik",
    "locator": "http:request_response:GET /api/rooms/:id/agents/:agentId/avatar",
    "structuralSignatures": [
      "request.params:{agentId:string;id:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.tasks.id.agent.avatar.1bxh1fe",
    "locator": "http:request_response:GET /api/tasks/:id/agent/avatar",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.users.id.avatar.1yatmfu",
    "locator": "http:request_response:GET /api/users/:id/avatar",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  }
];

export const REVIEWED_MAIN_2026_10_13_NEW_DTO_DECLARATIONS: readonly DtoDeclaration[] = [
  {
    "observationId": "wire.http.request.response.delete.api.account.provider.credentials.provider.14x7zpv",
    "locator": "http:request_response:DELETE /api/account/provider-credentials/:provider",
    "structuralSignatures": [
      "response.body:unknown",
      "response.body:{committed:boolean;deleted:boolean}",
      "response.body:{committed:boolean;error:\"authentication_required\"|\"credential_conflict\"|\"credential_custody_unavailable\"|\"credential_destination_changed\"|\"credential_destination_unavailable\"|\"credential_not_found\"|\"credential_reenrollment_required\"|\"invalid_credential_request\"|\"invalid_provider\"|\"personal_credentials_disabled\"|\"personal_credentials_forbidden\"|\"personal_credentials_unavailable\";repair:string;retryable:boolean}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body",
        "schema": "DeleteProviderCredentialResponse"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.delete.api.setup.keys.provider.19zjpdz",
    "locator": "http:request_response:DELETE /api/setup/keys/:provider",
    "structuralSignatures": [
      "request.params:{provider?:unknown}",
      "response.body:{applied:number;details:{action:\"applied\"|\"failed\"|\"skipped\";key:string;reason?:string}[];skipped:number;snapshot:string;success:boolean}",
      "response.body:{details:{action:\"applied\"|\"failed\"|\"skipped\";key:string;reason?:string}[];error:string;rolledBack:boolean;snapshot:string;success:boolean}",
      "response.body:{details:{action:\"applied\"|\"failed\"|\"skipped\";key:string;reason?:string}[];error:string;snapshot:string;success:boolean}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.params.provider",
        "schema": "providerId"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.account.capability.preferences.ytabe3",
    "locator": "http:request_response:GET /api/account/capability-preferences",
    "structuralSignatures": [
      "response.body:{capabilities:{description:string;label:string;options:{displayName:string;modelId:string;provider:string;readiness:{fundingSource:\"personal\"|\"server\";providerRoute:string;reason:string;status:\"missing-credentials\"|\"ready\"|\"unavailable\"}}[];readiness:{fundingSource:\"personal\"|\"server\";providerRoute:string;reason:string;status:\"missing-credentials\"|\"ready\"|\"unavailable\"};role:\"decision\"|\"deepResearchCompression\"|\"deepResearchFinalReport\"|\"deepResearchResearcher\"|\"deepResearchSummarization\"|\"deepResearchSupervisor\"|\"webSearchSynthesis\";selection:{displayName:string;modelId:string;source:\"inherited\"|\"personal\"}}[];fundingPreference:\"personal_first\"|\"server_first\";overrides:{decision?:string;deepResearchCompression?:string;deepResearchFinalReport?:string;deepResearchResearcher?:string;deepResearchSummarization?:string;deepResearchSupervisor?:string;webSearchSynthesis?:string};revision:number}",
      "response.body:{error:string;retryable:boolean}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.account.costs.6xc82g",
    "locator": "http:request_response:GET /api/account/costs",
    "structuralSignatures": [
      "request.query:{[key:string]:unknown}",
      "response.body:{byCallType:{callType:string;calls:number;totalCostUsd:number}[];byModel:{actualCostUsd:number;blockedAttempts:number;calls:number;displayName:string;estimatedCostUsd:number;hasActual:boolean;hasFallbackEstimate:boolean;inputTokens:number;model:string;outputTokens:number;pendingAttempts:number;provider:string;totalCostUsd:number;unknownAttempts:number}[];byProvider:{actualCostUsd:number;estimatedCostUsd:number;measuredUnits?:number;operation:string;operations:number;provider:string;totalCostUsd:number;unitType?:string;unknownOperations:number}[];byTask:{actualCostUsd:number;calls:number;estimatedCostUsd:number;pendingAttempts:number;providerOperations:number;taskId:string;totalCostUsd:number;unknownAttempts:number;unknownProviderOperations:number}[];currency:\"USD\";entry:{available:boolean;hasHistory:boolean;hasPersonalCredentials:boolean};pricingVersion:string;range:{key:\"30d\"|\"7d\"|\"90d\";since:string;until:string};recovery:{attempts:{attemptId:string;lastObservedAt:string;providerRoute:string;reason:string;repairAction:\"check_receipt_access\"|\"contact_operator\"|\"retry_receipt_read\"|\"review_cost\"|\"wait_for_receipt\";requestReference:string;status:\"blocked\"|\"pending\"|\"retryable\"|\"unrecoverable\";taskId:string}[];blockedAttempts:number;pendingAttempts:number;retryableAttempts:number;unknownAttempts:number};serviceOperations?:{cancelled:number;failed:number;interrupted:number;legacy:number;operations:number;succeeded:number;unknown:number};serviceRecovery?:{attempts:{attemptOutcome:\"cancelled\"|\"failed\"|\"interrupted\"|\"succeeded\"|\"unknown\";failureCode:string;jobId:string;occurredAt:string;operation:string;provider:string;requestReference:string;runId:string;taskId:string;workload:string}[]};timeSeries:{actualCostUsd:number;day:string;estimatedCostUsd:number;totalCostUsd:number}[];totals:{actualCostUsd:number;blockedAttempts:number;cachedInputTokens:number;calls:number;estimatedCostUsd:number;inputTokens:number;outputTokens:number;pendingAttempts:number;providerOperations:number;retryableAttempts:number;totalCostUsd:number;totalTokens:number;unknownAttempts:number;unknownProviderOperations:number}}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.query",
        "schema": "PersonalCostsQuery"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.account.provider.credentials.xu03qw",
    "locator": "http:request_response:GET /api/account/provider-credentials",
    "structuralSignatures": [
      "response.body:unknown",
      "response.body:{allowPersonalProviderKeys:boolean;credentials:{createdAt:string;destination:string;id:string;masked:any;provider:\"anthropic\"|\"browser-use\"|\"cloudconvert\"|\"elevenlabs\"|\"fireworks\"|\"gateway\"|\"google\"|\"groq\"|\"nautilo-gateway\"|\"openai\"|\"openrouter\"|\"surplus\"|\"tavily\"|\"together\"|\"typesafe\"|\"venice\"|\"xai\";receiptReadStatus:\"available\"|\"unavailable\"|\"unknown\";requiresReplacement:boolean;revision:number;updatedAt:string;validatedAt:string;validationStatus:\"accepted\"|\"rejected\"|\"unavailable\"|\"unverified\"}[];providers:{formatHint?:string;id:string;name:string;personalCapabilities:\"browsing\"|\"chat\"|\"conversion\"|\"decision\"|\"research\"[];purpose:string;signupUrl?:string}[]}",
      "response.body:{allowPersonalProviderKeys:boolean;credentials:{createdAt:string;destination:string;id:string;masked:string;provider:\"anthropic\"|\"browser-use\"|\"cloudconvert\"|\"elevenlabs\"|\"fireworks\"|\"gateway\"|\"google\"|\"groq\"|\"nautilo-gateway\"|\"openai\"|\"openrouter\"|\"surplus\"|\"tavily\"|\"together\"|\"typesafe\"|\"venice\"|\"xai\";receiptReadStatus:\"available\"|\"unavailable\"|\"unknown\";requiresReplacement:boolean;revision:number;updatedAt:string;validatedAt:string;validationStatus:\"accepted\"|\"rejected\"|\"unavailable\"|\"unverified\"}[];providers:{formatHint?:string;id:string;name:string;personalCapabilities:\"browsing\"|\"chat\"|\"conversion\"|\"decision\"|\"research\"[];purpose:string;signupUrl?:string}[]}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body",
        "schema": "PersonalProviderCredentialListResponse"
      },
      {
        "path": "response.body.credentials[].masked",
        "schema": "nullableMaskedCredentialPreview"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.admin.public.join.1190v42",
    "locator": "http:request_response:GET /api/admin/public-join",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{inviteId:string;joinUrl:string;revision:number}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.admin.server.provider.policy.1y2633y",
    "locator": "http:request_response:GET /api/admin/server-provider-policy",
    "structuralSignatures": [
      "response.body:{allowPersonalProviderKeys:boolean;fundingPreference:\"personal_first\"|\"server_first\"}",
      "response.body:{error:\"server_provider_policy_unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.config.models.caller.1ckgk0r",
    "locator": "http:request_response:GET /api/config/models/caller",
    "structuralSignatures": [
      "request.query:{[key:string]:unknown}",
      "response.body:{availability:\"filtered\"|\"missing-key\"|\"selectable\"|\"unknown-model\"|\"unsupported-capability\";capabilities:{e2ee:boolean;reasoning:boolean;tools:boolean;vision:boolean;webSearch:boolean};controls?:{reasoning?:{canDisable:boolean;defaultLevel:\"high\"|\"low\"|\"max\"|\"medium\"|\"minimal\"|\"off\"|\"xhigh\";levels:\"high\"|\"low\"|\"max\"|\"medium\"|\"minimal\"|\"xhigh\"[];mandatory:boolean};serving?:{defaultProfile:string;profiles:{description?:string;id:string;intent:\"balanced\"|\"reliability\"|\"throughput\";label:string;pricing?:{cachedInputPerMtok:number;inputPerMtok:number;outputPerMtok:number}}[]}};costCoefficient:number;displayName:string;enabled:boolean;fundingProviderRoute?:string;fundingSource?:\"personal\"|\"server\";id:string;imageInput?:\"assisted\"|\"direct\"|\"unavailable\";priority:number;provider:string;routing?:\"china-anonymized\"|\"unknown\"|\"venice-hosted\"|\"western-anonymized\";unavailableReason?:string}[]",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.query",
        "schema": "CallerModelCatalogQuery"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.get.api.health.personal.provider.custody.dledrb",
    "locator": "http:request_response:GET /api/health/personal-provider-custody",
    "structuralSignatures": [
      "response.body:{code?:string;keyId?:string;recordsExist:boolean;status:\"degraded\"|\"ready\"|\"unavailable\"}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.invites.id.share.15r5lqs",
    "locator": "http:request_response:GET /api/invites/:id/share",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{code:string;error:string}",
      "response.body:{code:string;url:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.invites.token.enrollment.review.nvyema",
    "locator": "http:request_response:GET /api/invites/:token/enrollment-review",
    "structuralSignatures": [
      "request.params:{token:string}",
      "response.body:{error:\"active_ban\"|\"admission_withdrawn\"|\"enrollment_paused\"|\"enrollment_rejected\"|\"enrollment_review_required\"|\"forbidden_scope\"|\"idempotency_conflict\"|\"invalid_request\"|\"join_message_required\"|\"moderation_disabled\"|\"protected_target\"|\"restriction_inactive\"|\"stale_revision\"|\"target_unavailable\"|\"unsupported_identity\"}",
      "response.body:{error:string}",
      "response.body:{message:string;paused:boolean;required:boolean;revision:number;state:\"approved\"|\"completed\"|\"not_requested\"|\"pending\"|\"rejected\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.moderation.actions.operationid.1gmj4fx",
    "locator": "http:request_response:GET /api/moderation/actions/:operationId",
    "structuralSignatures": [
      "request.params:{operationId:string}",
      "response.body:{catch:function;finally:function;then:function}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.moderation.enrollment.1xv0lt7",
    "locator": "http:request_response:GET /api/moderation/enrollment",
    "structuralSignatures": [
      "response.body:{catch:function;finally:function;then:function}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.moderation.people.7jf1dk",
    "locator": "http:request_response:GET /api/moderation/people",
    "structuralSignatures": [
      "response.body:{catch:function;finally:function;then:function}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.moderation.person.15pmyla",
    "locator": "http:request_response:GET /api/moderation/person",
    "structuralSignatures": [
      "response.body:{catch:function;finally:function;then:function}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.moderation.policy.6m9nlx",
    "locator": "http:request_response:GET /api/moderation/policy",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.rooms.id.presence.1zr9ym",
    "locator": "http:request_response:GET /api/rooms/:id/presence",
    "structuralSignatures": [
      "request.params:{id:string}",
      "response.body:{error:string}",
      "response.body:{error:string}|{members:{actorId:string;status:\"idle\"|\"offline\"|\"online\"}[]}",
      "response.body:{members:{actorId:string;status:\"idle\"|\"offline\"|\"online\"}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.api.security.message.deletions.5dytze",
    "locator": "http:request_response:GET /api/security/message-deletions",
    "structuralSignatures": [
      "request.query:{cursor?:string;limit?:string;messageId?:string;operationId?:string;roomId?:string}",
      "response.body:{error:string}",
      "response.body:{nextCursor:string;receipts:{actorId:string;actorUserId:string;authority:\"author\"|\"manage_rooms\"|\"report_action\"|\"room_owner\"|\"room_steward\"|\"server_ban\";committedAt:Date;messageId:number;moderationOperationId:string;operationId:string;outcome:\"deleted\";reportId:string;roomId:string;source:\"content_report\"|\"moderation_ban\"|\"room_message\"}[]}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.get.join.f8d1n3",
    "locator": "http:request_response:GET /join",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.account.provider.credentials.provider.validate.1tl3cod",
    "locator": "http:request_response:POST /api/account/provider-credentials/:provider/validate",
    "structuralSignatures": [
      "response.body:unknown",
      "response.body:{committed:boolean;credential:{createdAt:string;destination:string;id:string;masked:string;provider:\"anthropic\"|\"browser-use\"|\"cloudconvert\"|\"elevenlabs\"|\"fireworks\"|\"gateway\"|\"google\"|\"groq\"|\"nautilo-gateway\"|\"openai\"|\"openrouter\"|\"surplus\"|\"tavily\"|\"together\"|\"typesafe\"|\"venice\"|\"xai\";receiptReadStatus:\"available\"|\"unavailable\"|\"unknown\";requiresReplacement:boolean;revision:number;updatedAt:string;validatedAt:string;validationStatus:\"accepted\"|\"rejected\"|\"unavailable\"|\"unverified\"}}",
      "response.body:{committed:boolean;error:\"authentication_required\"|\"credential_conflict\"|\"credential_custody_unavailable\"|\"credential_destination_changed\"|\"credential_destination_unavailable\"|\"credential_not_found\"|\"credential_reenrollment_required\"|\"invalid_credential_request\"|\"invalid_provider\"|\"personal_credentials_disabled\"|\"personal_credentials_forbidden\"|\"personal_credentials_unavailable\";repair:string;retryable:boolean}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body",
        "schema": "ValidateProviderCredentialResponse"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.admin.server.provider.policy.tzd4v0",
    "locator": "http:request_response:POST /api/admin/server-provider-policy",
    "structuralSignatures": [
      "response.body:{allowPersonalProviderKeys:boolean;fundingPreference:\"personal_first\"|\"server_first\"}",
      "response.body:{error:\"server_provider_policy_unavailable\"}",
      "response.body:{error:any}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body.error",
        "schema": "ServerProviderPolicyErrorResponse"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.invites.token.enrollment.review.jqkc2w",
    "locator": "http:request_response:POST /api/invites/:token/enrollment-review",
    "structuralSignatures": [
      "request.params:{token:string}",
      "response.body:{error:\"active_ban\"|\"admission_withdrawn\"|\"enrollment_paused\"|\"enrollment_rejected\"|\"enrollment_review_required\"|\"forbidden_scope\"|\"idempotency_conflict\"|\"invalid_request\"|\"join_message_required\"|\"moderation_disabled\"|\"protected_target\"|\"restriction_inactive\"|\"stale_revision\"|\"target_unavailable\"|\"unsupported_identity\"}",
      "response.body:{error:string}",
      "response.body:{message:string;paused:boolean;required:boolean;revision:number;state:\"approved\"|\"completed\"|\"not_requested\"|\"pending\"|\"rejected\"}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.post.api.moderation.actions.1c7qme8",
    "locator": "http:request_response:POST /api/moderation/actions",
    "structuralSignatures": [
      "request.body:{[key:string]:unknown}",
      "response.body:{catch:function;finally:function;then:function}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": [
      {
        "path": "request.body",
        "schema": "normalizeModerationCommand"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.post.api.moderation.enrollment.decision.azl8f4",
    "locator": "http:request_response:POST /api/moderation/enrollment/decision",
    "structuralSignatures": [
      "response.body:{auditRecorded:boolean;ok:boolean}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.put.api.account.capability.preferences.1qcipxq",
    "locator": "http:request_response:PUT /api/account/capability-preferences",
    "structuralSignatures": [
      "response.body:{capabilities:{description:string;label:string;options:{displayName:string;modelId:string;provider:string;readiness:{fundingSource:\"personal\"|\"server\";providerRoute:string;reason:string;status:\"missing-credentials\"|\"ready\"|\"unavailable\"}}[];readiness:{fundingSource:\"personal\"|\"server\";providerRoute:string;reason:string;status:\"missing-credentials\"|\"ready\"|\"unavailable\"};role:\"decision\"|\"deepResearchCompression\"|\"deepResearchFinalReport\"|\"deepResearchResearcher\"|\"deepResearchSummarization\"|\"deepResearchSupervisor\"|\"webSearchSynthesis\";selection:{displayName:string;modelId:string;source:\"inherited\"|\"personal\"}}[];fundingPreference:\"personal_first\"|\"server_first\";overrides:{decision?:string;deepResearchCompression?:string;deepResearchFinalReport?:string;deepResearchResearcher?:string;deepResearchSummarization?:string;deepResearchSupervisor?:string;webSearchSynthesis?:string};revision:number}",
      "response.body:{currentRevision:number;error:string}",
      "response.body:{error:string;retryable:boolean}",
      "response.body:{error:string;role:string}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.put.api.account.provider.credentials.provider.1x7kek1",
    "locator": "http:request_response:PUT /api/account/provider-credentials/:provider",
    "structuralSignatures": [
      "response.body:unknown",
      "response.body:{committed:boolean;credential:{createdAt:string;destination:string;id:string;masked:string;provider:\"anthropic\"|\"browser-use\"|\"cloudconvert\"|\"elevenlabs\"|\"fireworks\"|\"gateway\"|\"google\"|\"groq\"|\"nautilo-gateway\"|\"openai\"|\"openrouter\"|\"surplus\"|\"tavily\"|\"together\"|\"typesafe\"|\"venice\"|\"xai\";receiptReadStatus:\"available\"|\"unavailable\"|\"unknown\";requiresReplacement:boolean;revision:number;updatedAt:string;validatedAt:string;validationStatus:\"accepted\"|\"rejected\"|\"unavailable\"|\"unverified\"}}",
      "response.body:{committed:boolean;error:\"authentication_required\"|\"credential_conflict\"|\"credential_custody_unavailable\"|\"credential_destination_changed\"|\"credential_destination_unavailable\"|\"credential_not_found\"|\"credential_reenrollment_required\"|\"invalid_credential_request\"|\"invalid_provider\"|\"personal_credentials_disabled\"|\"personal_credentials_forbidden\"|\"personal_credentials_unavailable\";repair:string;retryable:boolean}"
    ],
    "arbitraryPayloads": [
      {
        "path": "response.body",
        "schema": "PutProviderCredentialResponse"
      }
    ]
  },
  {
    "observationId": "wire.http.request.response.put.api.admin.public.join.7z7bjh",
    "locator": "http:request_response:PUT /api/admin/public-join",
    "structuralSignatures": [
      "response.body:{error:string}",
      "response.body:{inviteId:string;joinUrl:string;revision:number}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.http.request.response.put.api.moderation.policy.znhy4q",
    "locator": "http:request_response:PUT /api/moderation/policy",
    "structuralSignatures": [
      "response.body:{approvalRequired:boolean;auditRecorded:boolean;enabled:boolean;joinsPaused:boolean;revision:number}",
      "response.body:{error:string}"
    ],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.relay.declared.arbitrary.packages.relay.src.protocol.ts.relayhumanterminalbinding.jul4xp",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayHumanTerminalBinding",
    "structuralSignatures": [
      "declaration.payload:{generation:string;invocationId:string;owner:unresolved<HumanTerminalOwner>;version:1}"
    ],
    "arbitraryPayloads": [
      {
        "path": "owner",
        "schema": "parseHumanTerminalOwner"
      }
    ]
  },
  {
    "observationId": "wire.relay.declared.arbitrary.packages.relay.src.protocol.ts.relaylocalexecutionbinding.1fl2t2l",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayLocalExecutionBinding",
    "structuralSignatures": [
      "declaration.payload:{authority:{activationId:string;kind:\"full_mac\";roomId:string};version:3}|{authority:{capabilityRevision:number;currentFolder:string;kind:\"basic\";protectedPolicyVersion:number;roomId:string};version:2}|{authority:{delegation:unresolved<LocalExecutionDelegation>;kind:\"delegated\";roomId:string;taskId:string;taskRunId:string};version:4}|{executionId:string;generation:string;invocationId:string;localNetworkPolicy?:{allow:{cidr:string;ports?:number[];type:\"cidr\"}|{host:string;ports?:number[];type:\"domain\"}|{ports?:number[];suffix:string;type:\"wildcard\"}[];defaultPort?:443;mode:\"proxy-allowlist\"}|{mode:\"host\"}|{mode:\"isolated\"};operation:\"cancel\"|\"input\"|\"read\"|\"start\";owner:{agentId:string;conversationId:string;desktopSessionId:string;grantIds:string[];grantRevision:null|number;humanUserId:string;instanceId:string;pairingGeneration:string;profileId:null|string;profileRevision:null|number;protectedPolicyVersion:null|number;relayId:string;runId:string;serverBindingId:string};version:1}"
    ],
    "arbitraryPayloads": [
      {
        "path": "authority.delegation",
        "schema": "parseLocalExecutionDelegation"
      }
    ]
  },
  {
    "observationId": "wire.relay.declared.arbitrary.packages.relay.src.protocol.ts.relaylocalexecutionbindingv4.b8ox73",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayLocalExecutionBindingV4",
    "structuralSignatures": [
      "declaration.payload:{authority:{delegation:unresolved<LocalExecutionDelegation>;kind:\"delegated\";roomId:string;taskId:string;taskRunId:string};version:4}"
    ],
    "arbitraryPayloads": [
      {
        "path": "authority.delegation",
        "schema": "parseLocalExecutionDelegation"
      }
    ]
  },
  {
    "observationId": "wire.relay.declared.arbitrary.packages.relay.src.protocol.ts.relaylocalexecutiondelegationcapture.1abpiao",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayLocalExecutionDelegationCapture",
    "structuralSignatures": [
      "declaration.payload:{desktopSessionId:string;invocationId:string;pairingGeneration:string;source:unresolved<Omit>&{target:unresolved<Omit>};version:1}"
    ],
    "arbitraryPayloads": [
      {
        "path": "source",
        "schema": "parseRelayLocalExecutionDelegationCapture"
      },
      {
        "path": "source.target",
        "schema": "parseRelayLocalExecutionDelegationCapture"
      }
    ]
  },
  {
    "observationId": "wire.relay.declared.arbitrary.packages.relay.src.protocol.ts.relaylocalexecutionhistorybindingv1.9j8rww",
    "locator": "relay:declared_arbitrary:packages/relay/src/protocol.ts#RelayLocalExecutionHistoryBindingV1",
    "structuralSignatures": [
      "declaration.payload:{executionId:string;generation:string;invocationId:string;reader:unresolved<Readonly>;sourceMessageId:number;version:1}"
    ],
    "arbitraryPayloads": [
      {
        "path": "reader",
        "schema": "parseRelayLocalExecutionHistoryBinding"
      }
    ]
  },
  {
    "observationId": "wire.ws.client.to.server.voice.consumed.ptlb9a",
    "locator": "ws:client_to_server:voice.consumed",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.ws.client.to.server.voice.listen.kp8hxf",
    "locator": "ws:client_to_server:voice.listen",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  },
  {
    "observationId": "wire.ws.server.to.client.voice.turn.end.1r2ay5c",
    "locator": "ws:server_to_client:voice.turn.end",
    "structuralSignatures": [],
    "arbitraryPayloads": []
  }
];

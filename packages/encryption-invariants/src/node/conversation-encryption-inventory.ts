import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ConversationEncryptionOwnership =
  | "wave9_active"
  | "wave10_background"
  | "wave12_autonomous"
  | "wave13_client"
  | "wave14_mobile"
  | "disabled_legacy";

export type ConversationEncryptionDuty =
  | "canonical_write"
  | "canonical_read"
  | "structural_projection"
  | "protected_realtime"
  | "protected_client_hydration"
  | "fts_unavailable"
  | "deny_foreground_grant_handoff"
  | "legacy_unmapped_only";

export type ConversationEncryptionSurface = Readonly<{
  id: string;
  sourcePath: string;
  anchor: string;
  ownership: ConversationEncryptionOwnership;
  requiredDuties: readonly ConversationEncryptionDuty[];
}>;

const WRITE = ["canonical_write"] as const;
const READ = ["canonical_read"] as const;
const STRUCTURAL = ["structural_projection"] as const;
const REALTIME = ["protected_realtime"] as const;
const CLIENT = ["protected_client_hydration"] as const;
const SEARCH = ["fts_unavailable"] as const;
const BACKGROUND = ["deny_foreground_grant_handoff"] as const;

/**
 * Executable Wave 9 ownership inventory. Source anchors deliberately identify
 * every independently reachable plaintext conversation chokepoint found in
 * the M237 Phase-0 audit. A protected composition may reach these paths only
 * through the canonical repository/projection seam required by each entry.
 */
export const CONVERSATION_ENCRYPTION_SURFACES = Object.freeze([
  {
    id: "write.session_store",
    sourcePath: "packages/agent/src/store/session-store.ts",
    anchor: "export async function appendTranscriptMessages",
    ownership: "wave9_active",
    requiredDuties: WRITE,
  },
  {
    id: "write.runtime_persist",
    sourcePath: "packages/runtime/src/executors/persist-messages.ts",
    anchor: "export async function persistMessages",
    ownership: "wave9_active",
    requiredDuties: [...WRITE, ...REALTIME],
  },
  {
    id: "write.human_peer",
    sourcePath: "packages/server/src/messaging/peer-broadcast.ts",
    anchor: "export async function peerBroadcastHumanMessage",
    ownership: "wave9_active",
    requiredDuties: [...WRITE, ...REALTIME],
  },
  {
    id: "write.foreground",
    sourcePath: "packages/runtime/src/executors/langgraph-executor.ts",
    anchor: "export async function* langgraphExecutor",
    ownership: "wave9_active",
    requiredDuties: WRITE,
  },
  {
    id: "write.fork",
    sourcePath: "packages/runtime/src/executors/fork-langgraph-executor.ts",
    anchor: "export async function* forkLanggraphExecutor",
    ownership: "wave9_active",
    requiredDuties: WRITE,
  },
  {
    id: "write.processor",
    sourcePath: "packages/runtime/src/executors/persisting-processor.ts",
    anchor: "export function createPersistingProcessor",
    ownership: "wave9_active",
    requiredDuties: WRITE,
  },
  {
    id: "write.subagent",
    sourcePath: "packages/agent/src/subagents/scope-subagent/run.ts",
    anchor: "export function runScopeSubagentUntilPause",
    ownership: "wave9_active",
    requiredDuties: [...WRITE, ...REALTIME],
  },
  {
    id: "write.protected_agent_crypto",
    sourcePath:
      "packages/lattice-bridge/src/message/protected-agent-conversation-preparer.ts",
    anchor:
      "export function createProtectedAgentConversationSessionCryptoPreparer",
    ownership: "wave9_active",
    requiredDuties: WRITE,
  },
  {
    id: "write.protected_agent_coordinator",
    sourcePath:
      "packages/runtime/src/conversation/protected-agent-message-write-coordinator.ts",
    anchor: "export function createProtectedAgentMessageWriteCoordinator",
    ownership: "wave9_active",
    requiredDuties: [...WRITE, ...STRUCTURAL],
  },
  {
    id: "write.membership_system",
    sourcePath: "packages/trust/src/queries.ts",
    anchor: "async function appendRoomMembershipSystemMessagesInTx",
    ownership: "wave9_active",
    requiredDuties: [...WRITE, ...STRUCTURAL],
  },
  {
    id: "write.silence_system",
    sourcePath: "packages/trust/src/room-silence.ts",
    anchor: "async function appendRoomSilenceSystemMessages",
    ownership: "wave9_active",
    requiredDuties: [...WRITE, ...STRUCTURAL],
  },
  {
    id: "mutation.edit",
    sourcePath: "packages/trust/src/message-edit.ts",
    anchor: "export async function editHumanRoomMessage",
    ownership: "wave9_active",
    requiredDuties: [...READ, ...WRITE, ...REALTIME],
  },
  {
    id: "mutation.delete",
    sourcePath: "packages/trust/src/message-delete.ts",
    anchor: "export async function deleteMessageHard",
    ownership: "wave9_active",
    requiredDuties: [...WRITE, ...STRUCTURAL],
  },
  {
    id: "read.session",
    sourcePath: "packages/agent/src/store/session-store.ts",
    anchor: "export async function getSessionMessages",
    ownership: "wave9_active",
    requiredDuties: READ,
  },
  {
    id: "read.session_latest",
    sourcePath: "packages/agent/src/store/session-store.ts",
    anchor: "export async function getLatestSessionMessages",
    ownership: "wave9_active",
    requiredDuties: READ,
  },
  {
    id: "read.room_before",
    sourcePath: "packages/agent/src/store/session-store.ts",
    anchor: "export async function getRoomMessagesBeforeCursor",
    ownership: "wave9_active",
    requiredDuties: READ,
  },
  {
    id: "read.room_members",
    sourcePath: "packages/agent/src/store/session-store.ts",
    anchor: "export async function getRoomMessagesAcrossMemberSessions",
    ownership: "wave9_active",
    requiredDuties: READ,
  },
  {
    id: "read.foreground_history",
    sourcePath: "packages/runtime/src/executors/langgraph-executor.ts",
    anchor: "export async function resolveForegroundHistoryMessages",
    ownership: "wave9_active",
    requiredDuties: READ,
  },
  {
    id: "read.history_all",
    sourcePath: "packages/runtime/src/conductor/history-search.ts",
    anchor: "export async function allRoomMessages",
    ownership: "wave9_active",
    requiredDuties: READ,
  },
  {
    id: "read.history_recent",
    sourcePath: "packages/runtime/src/conductor/history-search.ts",
    anchor: "export async function recentBoundedRoomMessages",
    ownership: "wave9_active",
    requiredDuties: READ,
  },
  {
    id: "read.history_parent",
    sourcePath: "packages/runtime/src/conductor/history-search.ts",
    anchor: "export async function parentMessagesUpToAnchor",
    ownership: "wave9_active",
    requiredDuties: READ,
  },
  {
    id: "read.history_subthread",
    sourcePath: "packages/runtime/src/conductor/history-search.ts",
    anchor: "export async function subthreadContextWindow",
    ownership: "wave9_active",
    requiredDuties: READ,
  },
  {
    id: "read.subthread_detail",
    sourcePath: "packages/trust/src/queries.ts",
    anchor: "export async function getSubthreadDetailForMember",
    ownership: "wave9_active",
    requiredDuties: READ,
  },
  {
    id: "read.http_history",
    sourcePath: "packages/server/src/routes/sessions.ts",
    anchor: "app.get<{ Params: { id: string } }>(\"/api/rooms/:id/messages\"",
    ownership: "wave9_active",
    requiredDuties: READ,
  },
  {
    id: "read.http_around",
    sourcePath: "packages/server/src/routes/sessions.ts",
    anchor:
      "app.get<{ Params: { id: string; messageId: string } }>(\"/api/rooms/:id/messages/:messageId/around\"",
    ownership: "wave9_active",
    requiredDuties: READ,
  },
  {
    id: "read.protected_agent_content",
    sourcePath:
      "packages/lattice-bridge/src/server/message/protected-conversation-agent-content-opener.ts",
    anchor: "export function createProtectedConversationAgentContentOpener",
    ownership: "wave9_active",
    requiredDuties: READ,
  },
  {
    id: "repository.protected_active",
    sourcePath:
      "packages/runtime/src/conversation/protected-active-conversation-repository.ts",
    anchor: "export function createProtectedActiveConversationRepository",
    ownership: "wave9_active",
    requiredDuties: [...WRITE, ...READ, ...STRUCTURAL],
  },
  {
    id: "search.session",
    sourcePath: "packages/agent/src/store/session-store.ts",
    anchor: "export async function searchSessions",
    ownership: "wave9_active",
    requiredDuties: SEARCH,
  },
  {
    id: "search.room",
    sourcePath: "packages/agent/src/store/room-message-search.ts",
    anchor: "export async function searchRoomMessages",
    ownership: "wave9_active",
    requiredDuties: SEARCH,
  },
  {
    id: "search.room_index",
    sourcePath: "packages/agent/src/store/room-message-search.ts",
    anchor: "export async function queryRoomMessageContentIndex",
    ownership: "wave9_active",
    requiredDuties: SEARCH,
  },
  {
    id: "search.conductor",
    sourcePath: "packages/runtime/src/conductor/history-search.ts",
    anchor: "export async function searchRoomHistory",
    ownership: "wave9_active",
    requiredDuties: SEARCH,
  },
  {
    id: "search.http",
    sourcePath: "packages/server/src/routes/sessions.ts",
    anchor:
      "app.get<{ Params: { id: string } }>(\"/api/rooms/:id/messages/search\"",
    ownership: "wave9_active",
    requiredDuties: SEARCH,
  },
  {
    id: "projection.notification_classification",
    sourcePath: "packages/trust/src/notification-classification.ts",
    anchor: "export async function persistNotificationClassification",
    ownership: "wave9_active",
    requiredDuties: STRUCTURAL,
  },
  {
    id: "projection.notification_state",
    sourcePath: "packages/trust/src/notification-state.ts",
    anchor: "export async function getNotificationState",
    ownership: "wave9_active",
    requiredDuties: STRUCTURAL,
  },
  {
    id: "projection.reply_count",
    sourcePath: "packages/agent/src/store/session-store.ts",
    anchor: "export function isCountedReplyRow",
    ownership: "wave9_active",
    requiredDuties: STRUCTURAL,
  },
  {
    id: "projection.root_affinity",
    sourcePath: "packages/server/src/lib/subthread-root-affinity.ts",
    anchor: "export async function resolveSubthreadRootAffinity",
    ownership: "wave9_active",
    requiredDuties: STRUCTURAL,
  },
  {
    id: "projection.routing_packet",
    sourcePath: "packages/runtime/src/conductor/routing-packet.ts",
    anchor: "export async function loadRoutingPacket",
    ownership: "wave9_active",
    requiredDuties: STRUCTURAL,
  },
  {
    id: "realtime.types",
    sourcePath: "packages/types/src/realtime.ts",
    anchor: "export interface MessageTokensEvent",
    ownership: "wave9_active",
    requiredDuties: REALTIME,
  },
  {
    id: "realtime.publisher",
    sourcePath: "packages/server/src/realtime/ws-publisher.ts",
    anchor: "export async function recomputeAndPublishNotificationState",
    ownership: "wave9_active",
    requiredDuties: [...REALTIME, ...STRUCTURAL],
  },
  {
    id: "realtime.protected_job_runner",
    sourcePath:
      "packages/runtime/src/conversation/protected-conversation-job-runner.ts",
    anchor: "export function createProtectedConversationJobRunner",
    ownership: "wave9_active",
    requiredDuties: [...WRITE, ...READ, ...REALTIME],
  },
  {
    id: "client.workbench_hydration",
    sourcePath: "apps/workbench/src/adapters/session-rehydrate.ts",
    anchor: "export function restoreSessionMessages",
    ownership: "wave9_active",
    requiredDuties: CLIENT,
  },
  {
    id: "client.workbench_reconciliation",
    sourcePath: "apps/workbench/src/adapters/message-new-reconciliation.ts",
    anchor: "export function reconcileCanonicalHumanMessage",
    ownership: "wave9_active",
    requiredDuties: CLIENT,
  },
  {
    id: "client.disconnect_cache",
    sourcePath: "apps/workbench/src/lib/disconnect-cache/index.ts",
    anchor: "export function createDisconnectCache",
    ownership: "wave9_active",
    requiredDuties: CLIENT,
  },
  {
    id: "background.stenographer",
    sourcePath: "packages/runtime/src/stenographer/repository.ts",
    anchor: "async function loadPriorContextRows",
    ownership: "wave10_background",
    requiredDuties: BACKGROUND,
  },
  {
    id: "background.review",
    sourcePath: "packages/runtime/src/memory-review/admission.ts",
    anchor: "export async function memoryReviewAdmission",
    ownership: "wave10_background",
    requiredDuties: BACKGROUND,
  },
  {
    id: "autonomous.task_report",
    sourcePath: "packages/runtime/src/tasks/report-back.ts",
    anchor: "export async function reportBackTaskCompletion",
    ownership: "wave12_autonomous",
    requiredDuties: BACKGROUND,
  },
  {
    id: "client.mobile",
    sourcePath: "apps/mobile/src/lib/messages.ts",
    anchor: "export function fromHistoryMessages",
    ownership: "wave14_mobile",
    requiredDuties: CLIENT,
  },
  {
    id: "legacy.membership_dedupe",
    sourcePath:
      "packages/db/src/utils/dedupe-membership-system-messages.ts",
    anchor: "export async function",
    ownership: "disabled_legacy",
    requiredDuties: ["legacy_unmapped_only"],
  },
] satisfies readonly ConversationEncryptionSurface[]);

export function validateConversationEncryptionInventory(
  repositoryRoot: string,
  surfaces: readonly ConversationEncryptionSurface[] =
    CONVERSATION_ENCRYPTION_SURFACES,
): string[] {
  const violations: string[] = [];
  const ids = new Set<string>();
  const anchors = new Set<string>();

  for (const surface of surfaces) {
    if (ids.has(surface.id)) {
      violations.push(`duplicate conversation surface id: ${surface.id}`);
    }
    ids.add(surface.id);
    const sourceAnchor = `${surface.sourcePath}#${surface.anchor}`;
    if (anchors.has(sourceAnchor)) {
      violations.push(`duplicate conversation source anchor: ${sourceAnchor}`);
    }
    anchors.add(sourceAnchor);

    const path = resolve(repositoryRoot, surface.sourcePath);
    if (!existsSync(path)) {
      violations.push(`missing conversation source: ${surface.sourcePath}`);
      continue;
    }
    if (!readFileSync(path, "utf8").includes(surface.anchor)) {
      violations.push(`missing conversation source anchor: ${sourceAnchor}`);
    }
  }

  return violations.sort();
}

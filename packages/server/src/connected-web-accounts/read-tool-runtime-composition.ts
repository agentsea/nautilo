import type { ConnectedWebOperationToolRuntime } from "@nautilo/agent";
import type { ConnectedWebOperationDirectRuntime } from "./operation-direct-runtime";
import {
  actors,
  and,
  eq,
  isNull,
  roomMembers,
  rooms,
  type DirectDatabase,
} from "@nautilo/db";
import { parseDesktopAutomationOpaqueId } from "@nautilo/types";
import {
  type BrowserUseCloudAdapter,
  type BrowserUseServerFundingAdmission,
} from "../browser-use/browser-use-cloud";
import {
  type ConnectedWebAccountReadPolicy,
  type ConnectedWebAccountReadServerRuntime,
  type ConnectedWebAccountReadRuntimeActor,
} from "./read-tool-runtime";
import { createConnectedWebAccountReadAdmissionRuntime } from "./read-operation-admission-runtime";
import type { ConnectedWebOperationSecrets } from "./operation-secrets";
import {
  createConnectedWebAccountActionServerRuntime,
  type ConnectedWebAccountActionPolicy,
  type ConnectedWebAccountActionServerRuntime,
} from "./action-tool-runtime";
import {
  createConnectedWebOperationManagementServerRuntime,
  type ConnectedWebOperationManagementSecrets,
} from "./operation-management-runtime";
import type { ConnectedWebAccountStore } from "./store";
import { connectedWebBrowserFunding, withFundedBrowserUse } from "./browser-use-funding";
import {
  beginServerProviderCostAttempt,
  settleServerProviderCostAttempt,
} from "../costs/provider-cost-recorder";

interface AgentMirrorRow {
  readonly ownerId: unknown;
  readonly agentId: unknown;
  readonly kind: unknown;
}

export interface ConnectedWebAccountReadPersonalRoomRow {
  readonly roomOwnerId: unknown;
  readonly roomKind: unknown;
  readonly roomType: unknown;
  readonly roomArchivedAt: unknown;
  readonly actorOwnerId: unknown;
  readonly actorKind: unknown;
  readonly actorAgentId: unknown;
}

/** Pure fail-closed evaluation, kept separately so its authority shape is testable. */
export function isExactOwnersPersonalPrivateRoom(
  input: { readonly ownerUserId: string; readonly agentId: string },
  rows: readonly ConnectedWebAccountReadPersonalRoomRow[],
): boolean {
  // Phase 1 authority is deliberately one-to-one: exactly the owning Human
  // and the calling owned Genie. An additional Human or Genie changes the
  // audience and must require a future explicit connection grant.
  if (rows.length !== 2) return false;
  if (rows.some((row) => row.roomOwnerId !== input.ownerUserId || row.roomKind !== "private" || row.roomType !== "private" || row.roomArchivedAt !== null)) return false;
  const humanMembers = rows.filter((row) => row.actorKind === "user");
  if (humanMembers.length !== 1 || humanMembers[0]!.actorOwnerId !== input.ownerUserId) return false;
  const callingAgentMembers = rows.filter((row) => row.actorKind === "agent"
    && row.actorOwnerId === input.ownerUserId
    && row.actorAgentId === input.agentId);
  const agentMembers = rows.filter((row) => row.actorKind === "agent");
  return agentMembers.length === 1 && callingAgentMembers.length === 1;
}

/**
 * Checks the Agent actor mirror from canonical current DB facts.  This is the
 * same exact-one-mirror rule used by Computer Use: a duplicate is an anomaly,
 * never a reason to choose one row by order.
 */
export async function hasExactOwnedConnectedWebGenie(
  db: DirectDatabase,
  input: { readonly ownerUserId: string; readonly agentId: string },
): Promise<boolean> {
  const ownerUserId = parseDesktopAutomationOpaqueId(input.ownerUserId);
  const agentId = parseDesktopAutomationOpaqueId(input.agentId);
  if (ownerUserId === null || agentId === null) return false;
  try {
    const rows = await db.select({
      ownerId: actors.ownerId,
      agentId: actors.agentId,
      kind: actors.kind,
    }).from(actors).where(and(eq(actors.kind, "agent"), eq(actors.agentId, agentId)));
    if (rows.length !== 1) return false;
    const row: AgentMirrorRow = rows[0]!;
    return row.kind === "agent" && row.ownerId === ownerUserId && row.agentId === agentId;
  } catch {
    return false;
  }
}

/**
 * A personal connected website is usable only in the owning Human's private
 * Room.  Joining all members lets us reject a second Human while still
 * requiring the current owned Genie to actually be a member of this Room.
 */
export async function isOwnersPersonalConnectedWebPrivateRoom(
  db: DirectDatabase,
  input: { readonly ownerUserId: string; readonly agentId: string; readonly roomId: string },
): Promise<boolean> {
  const ownerUserId = parseDesktopAutomationOpaqueId(input.ownerUserId);
  const agentId = parseDesktopAutomationOpaqueId(input.agentId);
  const roomId = parseDesktopAutomationOpaqueId(input.roomId);
  if (ownerUserId === null || agentId === null || roomId === null) return false;
  try {
    const rows = await db.select({
      roomOwnerId: rooms.ownerId,
      roomKind: rooms.kind,
      roomType: rooms.type,
      roomArchivedAt: rooms.archivedAt,
      actorId: actors.id,
      actorOwnerId: actors.ownerId,
      actorKind: actors.kind,
      actorAgentId: actors.agentId,
    }).from(rooms)
      .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
      .innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(eq(rooms.id, roomId));
    if (rows.length === 0) return false;

    return isExactOwnersPersonalPrivateRoom({ ownerUserId, agentId }, rows);
  } catch {
    return false;
  }
}

/** Public browsing requires current Room membership, not personal website ownership. */
export async function canResearchPublicWebsite(db: DirectDatabase, actor: ConnectedWebAccountReadRuntimeActor, toolName: "browse_web" | "run_website_task" = "browse_web"): Promise<boolean> {
  const envelope = actor.memoryAccessEnvelope;
  if (!envelope || envelope.ownerId !== actor.userId || envelope.agentId !== actor.agentId
    || envelope.roomId !== actor.roomId || !envelope.actorId
    || !(toolName === "run_website_task" ? envelope.toolPolicy[toolName] === "allow"
      : ["allow", "read_only"].includes(envelope.toolPolicy[toolName] ?? "forbidden"))) return false;
  try {
    const rows = await db.select({ actorId: actors.id, kind: actors.kind, ownerId: actors.ownerId, agentId: actors.agentId })
      .from(roomMembers).innerJoin(actors, eq(roomMembers.actorId, actors.id))
      .innerJoin(rooms, eq(roomMembers.roomId, rooms.id)).where(and(eq(rooms.id, actor.roomId), isNull(rooms.archivedAt)));
    return rows.some((row) => row.actorId === envelope.actorId && row.kind === "user" && row.ownerId === actor.userId)
      && rows.some((row) => row.kind === "agent" && row.agentId === actor.agentId);
  } catch { return false; }
}

export interface ConnectedWebAccountReadProductionRuntimeOptions {
  readonly db: DirectDatabase;
  readonly store: ConnectedWebAccountStore;
  readonly provider: BrowserUseCloudAdapter;
  readonly policy: ConnectedWebAccountReadPolicy;
  /** Null before server listen; only the listener may load durable secret material. */
  readonly secrets: () => ConnectedWebOperationSecrets | null;
  readonly assertServerFunding?: BrowserUseServerFundingAdmission;
}

/** Workspace remains on the existing terminal artifact-custody path. */
export function usesAsyncConnectedWebReadAdmission(delivery: "text" | "workspace"): boolean {
  return delivery === "text" || delivery === "workspace";
}

/**
 * Real server composition.  It remains separate from app.ts so that only the
 * invocation bridge decides when it has a foreground roomId/callingRoomId.
 */
export function createConnectedWebAccountReadProductionRuntime(
  options: ConnectedWebAccountReadProductionRuntimeOptions,
): ConnectedWebAccountReadServerRuntime {
  const facts = {
    canResearchPublic: (actor: ConnectedWebAccountReadRuntimeActor, toolName?: "browse_web" | "run_website_task") => canResearchPublicWebsite(options.db, actor, toolName),
    hasExactOwnedGenie: (input: { readonly ownerUserId: string; readonly agentId: string }) => hasExactOwnedConnectedWebGenie(options.db, input),
    isOwnersPersonalPrivateRoom: (input: { readonly ownerUserId: string; readonly agentId: string; readonly roomId: string }) => isOwnersPersonalConnectedWebPrivateRoom(options.db, input),
  };
  const asynchronousText = createConnectedWebAccountReadAdmissionRuntime({
    facts,
    accounts: {
      listForOwner: options.store.listForOwner.bind(options.store),
      getBindingForOwner: options.store.getBindingForOwner.bind(options.store),
    },
    store: {
      admitReadOperation: options.store.admitReadOperation.bind(options.store),
      activateReadOperation: options.store.activateReadOperation.bind(options.store),
      failAdmittedReadOperation: options.store.failAdmittedReadOperation.bind(options.store),
      completeIdleBrowserCleanup: options.store.completeIdleBrowserCleanup.bind(options.store),
    },
    provider: {
      health: options.provider.health.bind(options.provider),
      createHostedReadRun: options.provider.createHostedReadRun.bind(options.provider),
      cancelHostedReadRun: options.provider.cancelHostedReadRun.bind(options.provider),
      findHostedBrowsers: options.provider.findHostedBrowsers.bind(options.provider),
      stopBrowser: options.provider.stopBrowser.bind(options.provider),
    },
    policy: { maxCostUsd: options.policy.maxCostUsd },
    secrets: () => options.secrets(),
    funding: {
      admit: (humanUserId, prior) => connectedWebBrowserFunding.admit(humanUserId, prior),
      admitLegacyServer: (humanUserId) => connectedWebBrowserFunding.admitLegacyServer(humanUserId),
      run: (binding, intent, callback) => withFundedBrowserUse(
        connectedWebBrowserFunding,
        options.provider,
        binding,
        intent,
        (provider, usageFunding) => callback(provider, usageFunding),
      ),
    },
    beginCostAttempt: beginServerProviderCostAttempt,
    settleCostAttempt: settleServerProviderCostAttempt,
    ...(options.assertServerFunding === undefined ? {} : { assertServerFunding: options.assertServerFunding }),
  });
  return {
    listAvailable: (actor) => asynchronousText.listAvailable(actor),
    publicAvailable: () => options.secrets() !== null,
    readPublic: (actor, input) => asynchronousText.readPublic!(actor, input),
    read: async (actor, input) => {
      return asynchronousText.read(actor, input);
    },
  };
}

export interface ConnectedWebAccountActionProductionRuntimeOptions {
  readonly db: DirectDatabase;
  readonly store: ConnectedWebAccountStore;
  readonly provider: BrowserUseCloudAdapter;
  readonly policy: ConnectedWebAccountActionPolicy;
  readonly assertServerFunding?: BrowserUseServerFundingAdmission;
}

/** Reuses the exact Phase 1 owned-Genie + private-Room admission facts. */
export function createConnectedWebAccountActionProductionRuntime(
  options: ConnectedWebAccountActionProductionRuntimeOptions,
): ConnectedWebAccountActionServerRuntime {
  const runtime = createConnectedWebAccountActionServerRuntime({
    facts: {
    hasExactOwnedGenie: (input) => hasExactOwnedConnectedWebGenie(options.db, input),
      isOwnersPersonalPrivateRoom: (input) => isOwnersPersonalConnectedWebPrivateRoom(options.db, input),
    },
    accounts: {
      listForOwner: options.store.listForOwner.bind(options.store),
      getBindingForOwner: options.store.getBindingForOwner.bind(options.store),
    },
    executions: {
      reserveExecutionCheckpoint: options.store.reserveExecutionCheckpoint.bind(options.store),
      activateExecutionCheckpoint: options.store.activateExecutionCheckpoint.bind(options.store),
      completeExecution: options.store.completeExecution.bind(options.store),
      releaseExecutionReservation: options.store.releaseExecutionReservation.bind(options.store),
      claimActionOperation: options.store.claimActionOperation.bind(options.store),
      activateActionOperation: options.store.activateActionOperation.bind(options.store),
      quarantineActionCreate: options.store.quarantineActionCreate.bind(options.store),
      finishActionOperation: options.store.finishActionOperation.bind(options.store),
      getActionOperationForOwnerDelivery: options.store.getActionOperationForOwnerDelivery.bind(options.store),
      resumeActionOperation: options.store.resumeActionOperation.bind(options.store),
      cancelActionAuthentication: options.store.cancelActionAuthentication.bind(options.store),
    },
    provider: {
      health: options.provider.health.bind(options.provider),
      createHostedReadRun: options.provider.createHostedReadRun.bind(options.provider),
      pollHostedReadRun: options.provider.pollHostedReadRun.bind(options.provider),
      getHostedReadResult: options.provider.getHostedReadResult.bind(options.provider),
      cancelHostedReadRun: options.provider.cancelHostedReadRun.bind(options.provider),
      stopHostedReadBrowser: options.provider.stopHostedReadBrowser.bind(options.provider),
      stopHostedReadBrowserWithCost: options.provider.stopHostedReadBrowserWithCost.bind(options.provider),
      collectHostedReadOutputs: options.provider.collectHostedReadOutputs.bind(options.provider),
    },
    funding: {
      admit: (humanUserId, prior) => connectedWebBrowserFunding.admit(humanUserId, prior),
      admitLegacyServer: (humanUserId) => connectedWebBrowserFunding.admitLegacyServer(humanUserId),
      run: (binding, intent, callback) => withFundedBrowserUse(
        connectedWebBrowserFunding, options.provider, binding, intent,
        (provider, usageFunding) => callback(provider, usageFunding),
      ),
    },
    policy: options.policy,
    beginCostAttempt: beginServerProviderCostAttempt,
    settleCostAttempt: settleServerProviderCostAttempt,
  });
  return {
    listAvailable: (actor) => runtime.listAvailable(actor),
    act: (actor, input) => runtime.act(actor, input),
    resumeAfterAuthentication: (actor, input) => runtime.resumeAfterAuthentication(actor, input),
    cancelAuthentication: (actor, input) => runtime.cancelAuthentication(actor, input),
  };
}

export interface ConnectedWebOperationManagementProductionRuntimeOptions {
  readonly db: DirectDatabase;
  readonly store: ConnectedWebAccountStore;
  readonly provider: BrowserUseCloudAdapter;
  readonly secrets: ConnectedWebOperationManagementSecrets;
  readonly direct?: ConnectedWebOperationDirectRuntime;
  readonly assertServerFunding?: BrowserUseServerFundingAdmission;
}

/** Reuses the exact current DB authority facts used by website reads/actions. */
export function createConnectedWebOperationManagementProductionRuntime(
  options: ConnectedWebOperationManagementProductionRuntimeOptions,
): ConnectedWebOperationToolRuntime {
  const runtime = createConnectedWebOperationManagementServerRuntime({
    facts: {
      canResearchPublic: (actor: ConnectedWebAccountReadRuntimeActor, toolName?: "browse_web" | "run_website_task") => canResearchPublicWebsite(options.db, actor, toolName),
    hasExactOwnedGenie: (input) => hasExactOwnedConnectedWebGenie(options.db, input),
      isOwnersPersonalPrivateRoom: (input) => isOwnersPersonalConnectedWebPrivateRoom(options.db, input),
    },
    store: options.store,
    provider: options.provider,
    withProvider: async (operation, intent, callback) => {
      const binding = operation.fundingBinding
        ?? await connectedWebBrowserFunding.admitLegacyServer(operation.ownerUserId);
      return withFundedBrowserUse(
        connectedWebBrowserFunding,
        options.provider,
        binding,
        intent,
        (provider, usageFunding) => callback(provider, usageFunding),
      );
    },
    secrets: options.secrets,
    ...(options.direct === undefined ? {} : { direct: options.direct }),
  });
  return {
    manage: (actor, input) => runtime.manage(actor, input),
  };
}

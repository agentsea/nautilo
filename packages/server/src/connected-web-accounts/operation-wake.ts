import { createHash } from "node:crypto";
import { actors, and, eq, type DirectDatabase } from "@nautilo/db";
import { warn } from "@nautilo/logger";
import {
  createMaintenanceAcceptanceAuthority,
  jobManager,
  langgraphExecutor,
  type JobExecutor,
} from "@nautilo/runtime";
import {
  createAcceptedInvocationAuthority,
  getPolicyResolver,
} from "@nautilo/trust";
import {
  createConnectedWebAccountStore,
  type ConnectedWebOperation,
  type ConnectedWebAccountStore,
} from "./store";

import type { ConnectedWebOperationSecrets } from "./operation-secrets";

const DEFAULT_BATCH = 4;
const DEFAULT_LEASE_MS = 60_000;

type ConnectedWebOperationWakeJobManager = Pick<typeof jobManager, "createSystemForegroundJob">;

export type ConnectedWebOperationWakeOperations = Readonly<{
  claim: ConnectedWebAccountStore["claimDueOperationWakes"];
  load: ConnectedWebAccountStore["getOperationForOwner"];
  complete: ConnectedWebAccountStore["completeOperationWake"];
  release: ConnectedWebAccountStore["releaseOperationWakeClaim"];
}>;

/**
 * A server-authored, provider-free wake. This intentionally does not mention
 * provider topology, page content, account label, original intent, or a
 * browser capability. The foreground task re-reads the operation by id.
 */
function connectedWebOperationWakeMessage(operation: ConnectedWebOperation): string {
  return `[CONNECTED WEBSITE UPDATE] Internal supervision checkpoint, not a new Human message. Inspect operation ${operation.id} at control epoch ${operation.controlEpoch}. ${operation.safeActivity.summary}\nInspect the latest evidence and take any needed control action. Useful work already continues without a continue call. If no intervention or meaningful update is needed, call skip with no target_handle to finish quietly. Do not narrate inspections or unchanged status. Speak only for a useful finding, strategy change, Human input, actionable failure, or the completed answer. A delayed checkpoint must not repeat an answer already delivered. Do not start another read to check this operation.`;
}

/** Stable causal id, but not a runtime dedupe key (see at-least-once note below). */
export function connectedWebOperationWakeTurnId(operationId: string, fingerprint: string): string {
  const bytes = createHash("sha256")
    .update(`nautilo:connected-web-operation:wake:${operationId}:${fingerprint}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Revalidate after the foreground queue, before any Genie or voice events. */
export function createConnectedWebOperationWakeExecutor(options: {
  readonly expected: ConnectedWebOperation;
  readonly load: ConnectedWebAccountStore["getOperationForOwner"];
  readonly resolveEnvelope: (operation: ConnectedWebOperation) => Promise<unknown>;
  readonly secrets?: Pick<ConnectedWebOperationSecrets, "unsealIntent">;
  readonly execute?: JobExecutor;
}): JobExecutor {
  return async function* (input, jobId, laneKey, signal) {
    if (signal.aborted) return;
    const expected = options.expected;
    const current = await options.load({ ownerUserId: expected.ownerUserId, operationId: expected.id });
    if (current.id !== expected.id || current.ownerUserId !== expected.ownerUserId || current.accountId !== expected.accountId
      || current.initiatingAgentId !== expected.initiatingAgentId || current.initiatingRoomId !== expected.initiatingRoomId
      || current.initiatingThreadId !== expected.initiatingThreadId || current.initiatingLane !== expected.initiatingLane
      || current.controlEpoch !== expected.controlEpoch || current.wakeFingerprint !== expected.wakeFingerprint) return;
    const envelope = await options.resolveEnvelope(current);
    let voiceMode = false;
    if (options.secrets) {
      try {
        const intent = JSON.parse(options.secrets.unsealIntent({
          context: { operationId: current.id, ownerUserId: current.ownerUserId, accountId: current.accountId },
          sealedIntent: current.sealedIntent,
        })) as Record<string, unknown>;
        voiceMode = intent["version"] === 1 && (intent["kind"] === "read_connected_web_account" || intent["kind"] === "browse_web" || intent["kind"] === "run_website_task") && intent["voiceMode"] === true;
      } catch { /* Older or unreadable response preferences do not enable speech. */ }
    }
    if (signal.aborted) return;
    yield* (options.execute ?? langgraphExecutor)({
      ...input, message: connectedWebOperationWakeMessage(current), voiceMode, memoryAccessEnvelope: envelope,
      metadata: {
        originatedBy: "connected_web_operation", operationId: current.id, controlEpoch: current.controlEpoch,
        activity: current.safeActivity, receipt: current.terminalReceipt,
      },
    }, jobId, laneKey, signal);
  };
}

/**
 * One at-least-once foreground wake pass. `createSystemForegroundJob` accepts
 * a deterministic turn id but presently mints a fresh virtual acceptance id
 * on every call; it does not prove turn-id deduplication. Therefore a process
 * crash after accepted enqueue and before `complete` can redeliver once the
 * durable lease expires. The exact fingerprint fence prevents an old wake
 * from consuming a newer checkpoint, but not that acceptance-gap duplicate.
 */
export async function deliverConnectedWebOperationWakes(input: {
  readonly db: DirectDatabase;
  readonly workerId: string;
  readonly now?: () => Date;
  readonly batch?: number;
  readonly leaseMs?: number;
  readonly jobs?: ConnectedWebOperationWakeJobManager;
  readonly secrets?: Pick<ConnectedWebOperationSecrets, "unsealIntent">;
  readonly resolveEnvelope?: (operation: ConnectedWebOperation) => Promise<unknown>;
  readonly operations?: ConnectedWebOperationWakeOperations;
}): Promise<{ readonly claimed: number; readonly accepted: number; readonly delivered: number }> {
  const now = input.now ?? (() => new Date());
  const store = input.operations === undefined ? createConnectedWebAccountStore(input.db) : null;
  const operations = input.operations ?? {
    claim: store!.claimDueOperationWakes.bind(store),
    load: store!.getOperationForOwner.bind(store),
    complete: store!.completeOperationWake.bind(store),
    release: store!.releaseOperationWakeClaim.bind(store),
  };
  const claimed = await operations.claim({
    workerId: input.workerId,
    now: now(),
    batch: input.batch ?? DEFAULT_BATCH,
    leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
  });
  let accepted = 0;
  let delivered = 0;
  for (const operation of claimed) {
    const fingerprint = operation.wakeFingerprint;
    if (!fingerprint) {
      // Store selection is supposed to make this impossible. Do not let a
      // malformed row become an un-fenced wake.
      continue;
    }
    try {
      const resolveEnvelope = input.resolveEnvelope ?? (async (operation: ConnectedWebOperation) => {
        const resolver = getPolicyResolver();
        if (!resolver) throw new Error("policy resolver unavailable");
        const resolveHumanActor = async (): Promise<string> => {
          const humanActors = await input.db.select({ id: actors.id }).from(actors).where(and(
            eq(actors.ownerId, operation.ownerUserId),
            eq(actors.kind, "user"),
          )).limit(2);
          // There is no unique DB constraint for Human mirrors. Two rows
          // are sufficient to disprove singular authority; never pick an
          // arbitrary actor and wake under its access envelope.
          if (humanActors.length !== 1) throw new Error("connected website owner actor unavailable");
          return humanActors[0]!.id;
        };
        return resolver.buildEnvelope(
          await resolveHumanActor(),
          operation.initiatingLane,
          operation.initiatingAgentId,
          operation.initiatingRoomId,
        );
      });
      const envelope = await resolveEnvelope(operation);
      await (input.jobs ?? jobManager).createSystemForegroundJob(
        operation.ownerUserId,
        operation.ownerUserId,
        operation.initiatingLane,
        {
          message: connectedWebOperationWakeMessage(operation),
          ownerId: operation.ownerUserId,
          requestorId: operation.ownerUserId,
          agentId: operation.initiatingAgentId,
          roomId: operation.initiatingRoomId,
          roomRoster: [],
          graphThreadId: operation.initiatingThreadId,
          threadId: operation.initiatingThreadId,
          voiceMode: false,
          memoryAccessEnvelope: envelope,
          actorRole: "owner",
          turnId: connectedWebOperationWakeTurnId(operation.id, fingerprint),
          currentFolder: "",
          workspacePath: "",
          metadata: {
            originatedBy: "connected_web_operation",
            operationId: operation.id,
            controlEpoch: operation.controlEpoch,
            activity: operation.safeActivity,
            receipt: operation.terminalReceipt,
          },
        },
        createConnectedWebOperationWakeExecutor({
          expected: operation, load: operations.load, resolveEnvelope,
          ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
        }),
        createMaintenanceAcceptanceAuthority(),
        undefined,
        createAcceptedInvocationAuthority(operation.ownerUserId),
      );
      accepted += 1;
      if (await operations.complete({
        operationId: operation.id,
        workerId: input.workerId,
        expectedWakeFingerprint: fingerprint,
        now: now(),
      })) delivered += 1;
    } catch {
      await operations.release({
        operationId: operation.id,
        workerId: input.workerId,
        expectedWakeFingerprint: fingerprint,
        now: now(),
      }).catch(() => false);
      warn("[connected-web-operation] foreground wake failed; the durable wake will retry");
    }
  }
  return { claimed: claimed.length, accepted, delivered };
}

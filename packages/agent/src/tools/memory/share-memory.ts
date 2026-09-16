import type { ToolCall } from "@langchain/core/messages/tool";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { coerceHybridSensitivity } from "@nautilo/security";
import {
  and,
  agentDb as db,
  eq,
  inArray,
  memories,
  memoryNamespaces,
} from "@nautilo/db";
import type { ShareMemoryApprovalPreview } from "@nautilo/types";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  createSharedRoomForPair,
  envelopeReadableNamespaces,
  findActorByOwnerId,
  findOrCreateAccessNamespace,
  findShareTargetRoom,
  findUserDisplayInfo,
} from "@nautilo/trust";
import { attachMemoryToNamespace, getMemoryNamespaces } from "../../store/memory-store";
import { withAgentTrustContext, type TrustAgentTx } from "../../store/trust-agent-db";
import {
  collapseWhitespaceShareApprovalSnippet,
  normalizeShareTargetHandle,
  resolveLocalShareTargetByHandle,
  resolveShareApprovalTargetRoomPreview,
} from "../../post-model/share-approval-preview";
import { protectedMemoryAuthorityFromEnvelope } from "./protected-memory-authority";
import { emitAuthoredMemorySemanticChange } from "../../store/authored-memory-semantic-change";
import {
  protectedMemoryToolOperationId,
  protectedMemoryToolRequestId,
  ProtectedMemoryToolUnavailableError,
  type ProtectedAgentMemoryAccessPort,
} from "./protected-memory-ports";
import type { OrdinaryContentAccessExecution } from "../../runtime/ordinary-content-access";
import { ordinaryShareTargetSchema } from "../content-access-intent";

/** @deprecated Prefer {@link normalizeShareTargetHandle} from share-approval-preview; kept for M078 tests + call sites. */
export { normalizeShareTargetHandle as stripAtHandle } from "../../post-model/share-approval-preview";

interface ShareMemoryContext {
  /** Authenticated requester user id (tool catalog passes `userId`). */
  userId?: string;
  memoryAccessEnvelope?: MemoryAccessEnvelope | null;
  protectedMemoryAccessPort?: ProtectedAgentMemoryAccessPort;
  ordinaryContentAccessRequired?: boolean;
  ordinaryContentAccess?: OrdinaryContentAccessExecution;
}

const protectedShareApprovalReferences = new WeakMap<
  ProtectedAgentMemoryAccessPort,
  Map<string, NonNullable<Parameters<ProtectedAgentMemoryAccessPort["change"]>[0]["approvalReference"]>>
>();
type ProtectedShareApprovalReference = NonNullable<
  Parameters<ProtectedAgentMemoryAccessPort["change"]>[0]["approvalReference"]
>;

function protectedShareApprovalKey(toolCallId: string, memoryId: string, handle: string): string {
  return JSON.stringify([toolCallId, memoryId, handle]);
}

function asShareMemoryDb(tx: TrustAgentTx): typeof db {
  return tx as unknown as typeof db;
}

/** Same semantics as `share_memory` execution — avoids leaking rows outside readable Namespace overlap + agent scope. */
export async function loadMemoryRowIfShareable(
  memoryId: string,
  readableNamespaceIds: string[],
  agentId: string,
  userId?: string,
): Promise<{ content: string | null; type: string | null } | null> {
  if (readableNamespaceIds.length === 0) return null;

  // M127: Memory access is namespace-only; peer-authored memories in any
  // Namespace the caller can read are now shareable. The `agentId`
  // parameter is preserved on the signature for `withAgentTrustContext`
  // routing only.
  const run = async (handle: typeof db) => {
    const [row] = await handle
      .select({ content: memories.content, type: memories.type })
      .from(memories)
      .innerJoin(memoryNamespaces, eq(memoryNamespaces.memoryId, memories.id))
      .where(
        and(
          eq(memories.id, memoryId),
          inArray(memoryNamespaces.namespaceId, readableNamespaceIds),
        ),
      )
      .limit(1);
    return row ?? null;
  };
  const row = await withAgentTrustContext(
    {
      userId: userId ?? "",
      ...(agentId ? { agentId } : {}),
    },
    async (tx) => run(asShareMemoryDb(tx)),
  );
  return row ?? null;
}

/**
 * M078 — enrich ask / prove_it interrupts with memory + room context for clients.
 * Memory snippet is loaded only after Namespace / agent guards match execution (`loadMemoryRowIfShareable`).
 * Target room details are computed only when `target_handle` is on `list_my_users` roster.
 */
export async function computeShareMemoryApprovalPreview(
  tc: Pick<ToolCall, "name" | "args" | "id">,
  ctx: {
    memoryAccessEnvelope?: MemoryAccessEnvelope | null;
    userId?: string;
    protectedMemoryAccessPort?: ProtectedAgentMemoryAccessPort;
  },
): Promise<ShareMemoryApprovalPreview | null> {
  if (tc.name !== "share_memory") return null;
  const args = (tc.args ?? {}) as Record<string, unknown>;
  const memoryId = typeof args["memory_id"] === "string" ? args["memory_id"] : "";
  const rawHandle = typeof args["target_handle"] === "string" ? args["target_handle"] : "";
  if (!memoryId || !rawHandle.trim()) return null;

  const envelope = ctx.memoryAccessEnvelope;
  const agentId = envelope?.agentId ?? "";
  const readableNamespaces = envelopeReadableNamespaces(envelope);
  const requesterUserId = ctx.userId ?? "";
  if (!agentId || readableNamespaces.length === 0 || !requesterUserId) return null;

  const hybrid = coerceHybridSensitivity(args["sensitivity"]);

  if (ctx.protectedMemoryAccessPort !== undefined) {
    const authority = protectedMemoryAuthorityFromEnvelope(envelope);
    if (authority === null) return null;
    const toolCallId = typeof tc.id === "string" ? tc.id : "";
    if (toolCallId.length === 0
      || ctx.protectedMemoryAccessPort.prepareApproval === undefined) return null;
    const prepared = await ctx.protectedMemoryAccessPort.prepareApproval({
      operationId: protectedMemoryToolOperationId({
        requestId: toolCallId,
        action: "grant_user_approval",
        subjectId: memoryId,
      }),
      toolCallId,
      authority,
      memoryId,
      action: {
        kind: "grant_user",
        userHandle: normalizeShareTargetHandle(rawHandle),
      },
    });
    if (prepared.status === "unavailable") {
      throw new ProtectedMemoryToolUnavailableError(prepared.reason);
    }
    const handle = normalizeShareTargetHandle(rawHandle);
    const retained = protectedShareApprovalReferences.get(ctx.protectedMemoryAccessPort)
      ?? new Map<string, ProtectedShareApprovalReference>();
    retained.set(protectedShareApprovalKey(toolCallId, memoryId, handle), prepared.value.reference);
    protectedShareApprovalReferences.set(ctx.protectedMemoryAccessPort, retained);
    const target = await resolveLocalShareTargetByHandle(handle);
    const roomPreview = await resolveShareApprovalTargetRoomPreview({
      agentId,
      requesterUserId,
      handle,
      rosterRow: target
        ? { userId: target.userId, displayName: target.displayName }
        : null,
    });
    return {
      protectedApprovalDigest: prepared.value.reference.referenceId,
      memoryContentSnippet: collapseWhitespaceShareApprovalSnippet(
        prepared.value.preview.content,
      ),
      memoryType: prepared.value.preview.type,
      targetHandle: handle,
      targetDisplayName: roomPreview.targetDisplayName,
      roomLabel: roomPreview.roomLabel,
      wouldCreate: roomPreview.wouldCreate,
      sensitivity: hybrid.value,
    };
  }

  // M082: visibility gate is read scope (`readableNamespaces`). Today
  // that set equals `mutableNamespaces`; attaching uses a separate path.
  const memRow = await loadMemoryRowIfShareable(memoryId, readableNamespaces, agentId, requesterUserId);
  // INTENTIONAL vs share_artifact: memory preview shows text snippet + row type;
  // artifact preview shows workspace path + mime + byte size (see @nautilo/types realtime).
  const memoryContentSnippet = memRow?.content != null
    ? collapseWhitespaceShareApprovalSnippet(memRow.content)
    : memRow
      ? "Memory ordinary content is unavailable."
      : "Memory not found or not shareable by you.";
  const memoryType = memRow ? memRow.type : null;

  const handle = normalizeShareTargetHandle(rawHandle);
  const target = await resolveLocalShareTargetByHandle(handle);
  const roomPreview = await resolveShareApprovalTargetRoomPreview({
    agentId,
    requesterUserId,
    handle,
    rosterRow: target
      ? { userId: target.userId, displayName: target.displayName }
      : null,
  });

  return {
    memoryContentSnippet,
    memoryType,
    targetHandle: handle,
    targetDisplayName: roomPreview.targetDisplayName,
    roomLabel: roomPreview.roomLabel,
    wouldCreate: roomPreview.wouldCreate,
    sensitivity: hybrid.value,
  };
}

export type ShareMemoryOutcome =
  | {
      ok: true;
      roomLabel: string;
      minted: boolean;
      namespaceId: string;
      already: boolean;
    }
  | { ok: false; reason: string };

/**
 * The public, model-facing contract for the one sharing operation.  `attach`
 * keeps M078 byte-for-byte compatible; `project` is deliberately a separate
 * copy semantic and is never allowed to fall through to the attach executor.
 */
const legacyAttachShareMemorySchema = z.object({
  mode: z.literal("attach").optional()
    .describe("Attach the exact existing Memory. This is the default when the Human asks to share this Memory."),
  memory_id: z.string().min(1).describe("The ID of the exact existing Memory to attach, from search_memory."),
  target_handle: z
    .string()
    .min(1)
    .describe("The handle of the user to share with — must appear in list_my_users, do not guess."),
  sensitivity: z
    .enum(["normal", "sensitive"])
    .describe(
      "Choose sensitive for credentials, financial, medical, or similarly harmful private data; normal for ordinary facts.",
    ),
}).strict();

const ordinaryAttachShareMemorySchema = z.object({
  mode: z.literal("attach").optional()
    .describe("Attach the exact existing Memory. This is the default when the Human asks to share this Memory."),
  memory_id: z.string().min(1).describe("The ID of the exact existing Memory to attach, from search_memory."),
  target_handle: z
    .string()
    .min(1)
    .optional()
    .describe("Legacy person target. Use either target_handle or target, never both."),
  target: ordinaryShareTargetSchema.optional()
    .describe("Person or named Room that should gain access to the existing Memory. Use instead of target_handle."),
  sensitivity: z
    .enum(["normal", "sensitive"])
    .describe(
      "Choose sensitive for credentials, financial, medical, or similarly harmful private data; normal for ordinary facts.",
    ),
}).strict().superRefine((value, ctx) => {
  if ((value.target_handle === undefined) === (value.target === undefined)) {
    ctx.addIssue({ code: "custom", message: "Choose exactly one of target_handle or target." });
  }
});

const projectShareMemorySchema = z.object({
  mode: z.literal("project")
    .describe("Create a new sanitized, distilled, or rewritten Memory. Use only when the Human explicitly requests new wording."),
  source_memory_ids: z.array(z.string().min(1)).min(1).max(8)
    .refine((ids) => new Set(ids).size === ids.length, "source_memory_ids must not contain duplicates")
    .describe("Concrete Memory IDs returned by search_memory in this conversation; never invent IDs."),
  proposed_content: z.string().trim().min(1).max(8_000)
    .describe("The smallest public-safe memory text to create. This exact text is shown for approval."),
  target_room_name: z.string().trim().min(1).max(128)
    .describe("The human-readable destination Room name, such as pub-room. Never use a Room or Namespace ID."),
  room_choice_token: z.string().min(1).max(256).optional()
    .describe("Only include the opaque choice token returned after an ambiguous Room-name result."),
}).strict();

export const shareMemoryInputSchema = z.union([ordinaryAttachShareMemorySchema, projectShareMemorySchema]);
export type ShareMemoryInput = z.infer<typeof shareMemoryInputSchema>;

export function parseShareMemoryInput(input: unknown):
  | { ok: true; value: ShareMemoryInput }
  | { ok: false; reason: string } {
  const parsed = shareMemoryInputSchema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: parsed.error.issues.map((issue) => issue.message).join("; ") };
}

/**
 * M173 — single source of truth for "attach a memory to the shared room of
 * {requester, target}." Used by the `share_memory` tool AND the M173 grant
 * route so the two never drift on the shared parts (requester actor lookup,
 * roster gate, target resolution, read-scope gate, attach).
 *
 * `mintKind` controls BOTH the room lookup and the mint:
 *   - "conversational" (agent tool, unchanged): reuse the smallest existing
 *     room containing both humans (`findShareTargetRoom`, superset OK), else
 *     mint a conversational pair room (`createSharedRoomForPair`).
 *   - "access" (panel grant): reuse a room of EXACTLY {requester, target} of
 *     any kind, else mint an invisible `kind='access'` room — both via
 *     `findOrCreateAccessNamespace` (§3.5). Exact-set so a targeted grant never
 *     over-shares into a larger room.
 *
 * `readableNamespaces` gates which memories are shareable. Failure modes return
 * `{ ok: false, reason }` (a user-facing string the tool surfaces verbatim).
 * On success, `already` reports the attach was a no-op (memory already in that
 * namespace) and `minted` reports whether a new room was created.
 */
export async function shareMemoryToUser(params: {
  memoryId: string;
  requesterUserId: string;
  agentId: string;
  targetHandle: string;
  readableNamespaces: string[];
  mintKind: "conversational" | "access";
}): Promise<ShareMemoryOutcome> {
  const {
    memoryId,
    requesterUserId,
    agentId,
    targetHandle,
    readableNamespaces,
    mintKind,
  } = params;

  const requesterActor = await findActorByOwnerId(requesterUserId);
  if (!requesterActor) {
    return { ok: false, reason: "Cannot share memory: requester actor not found." };
  }

  // M173 (hive-mind): any local Human on this Server can receive a share —
  // no per-agent roster, no Group-membership requirement. Resolve by existence.
  const handle = normalizeShareTargetHandle(targetHandle);
  const target = await resolveLocalShareTargetByHandle(handle);
  if (!target) {
    return { ok: false, reason: `No local user @${handle} on this server.` };
  }
  if (target.userId === requesterUserId) {
    return { ok: false, reason: "Cannot share a memory with yourself." };
  }

  // M082: read-scope gate — see `computeShareMemoryApprovalPreview`.
  const memRow = await loadMemoryRowIfShareable(
    memoryId,
    readableNamespaces,
    agentId,
    requesterUserId,
  );
  if (!memRow) {
    return {
      ok: false,
      reason: `No memory found with id ${memoryId}, or it is not yours to share for this agent.`,
    };
  }
  if (memRow.content === null) {
    return { ok: false, reason: "Memory ordinary content is unavailable." };
  }

  let namespaceId: string;
  let roomLabel: string;
  let minted = false;

  if (mintKind === "conversational") {
    const roomHit = await findShareTargetRoom({
      requesterActorId: requesterActor.id,
      targetActorId: target.actorId,
      agentId,
    });
    if (roomHit) {
      namespaceId = roomHit.namespaceId;
      roomLabel = roomHit.label;
    } else {
      const reqUser = await findUserDisplayInfo(requesterUserId);
      const tgtUser = await findUserDisplayInfo(target.userId);
      roomLabel = `${reqUser?.name ?? "You"} & ${tgtUser?.name ?? handle}`;
      const created = await createSharedRoomForPair({
        ownerUserId: requesterUserId,
        requesterActorId: requesterActor.id,
        targetActorId: target.actorId,
        agentId,
        label: roomLabel,
      });
      namespaceId = created.namespaceId;
      minted = true;
    }
  } else {
    // mintKind === "access": exact-set {requester, target} room (any kind),
    // else an invisible kind='access' room — never a conversation.
    const reqUser = await findUserDisplayInfo(requesterUserId);
    const tgtUser = await findUserDisplayInfo(target.userId);
    roomLabel = `${reqUser?.name ?? "You"} & ${tgtUser?.name ?? handle}`;
    const resolved = await findOrCreateAccessNamespace(
      [requesterActor.id, target.actorId],
      { requesterUserId, requesterActorId: requesterActor.id, label: roomLabel },
    );
    namespaceId = resolved.namespaceId;
    minted = resolved.minted;
  }

  const trust = { userId: requesterUserId, agentId };
  const attached = await getMemoryNamespaces(memoryId, trust);
  if (attached.includes(namespaceId)) {
    return { ok: true, roomLabel, minted, namespaceId, already: true };
  }

  await attachMemoryToNamespace(memoryId, namespaceId, trust);
  return { ok: true, roomLabel, minted, namespaceId, already: false };
}

export function createShareMemoryTool(context?: ShareMemoryContext) {
  const ordinaryContentAccessRequired = context?.ordinaryContentAccessRequired === true;
  return new DynamicStructuredTool({
    name: "share_memory",
    description: ordinaryContentAccessRequired
      ? `Share Memory in one of two modes. Attach gives a person or named Room access to the exact existing Memory by adding its immutable person boundary or dynamic Room Namespace. When the Human says "share this Memory," default to attach. Project creates a new, deliberately sanitized or distilled Memory in a named Room after exact-text approval; it never attaches the private source Memory.

Before calling this tool: use list_my_users when the user names a person; disambiguate handles in conversation and never guess. Use either the legacy target_handle or target (a person handle or explicit Room name), never both. A Room target is still attach, not a reason to project. If the exact Memory is already attached to the requested destination, the operation is idempotent; Room membership or readability through another source does not replace that attachment.

This is NOT manage_memory(action: "promote"). Use project only when the Human explicitly asks for a new sanitized, distilled, or rewritten copy — never as fallback for a Room target, denied attach, or unavailable attach. For project, first search_memory for readable evidence, cite at least one returned Memory ID, draft only what is safe for the Room audience, and target the Room by name. Do not ask the Human for opaque IDs. Sharing is additive only for attach; project creates a destination-only copy.`
      : `Share Memory in one of two modes. In this encrypted-compatible path, attach gives one named person access to the exact existing Memory by adding an additional Namespace; Room attachment is not available here. When the Human says "share this Memory," use attach with a person target. Project creates a new, deliberately sanitized or distilled Memory in a named Room after exact-text approval; it never attaches the private source Memory.

Before calling this tool: use list_my_users when the user names a person; disambiguate handles in conversation — never guess a target_handle. Only users returned by list_my_users can receive a share. If the exact Memory is already attached to the person's access boundary, the operation is idempotent; other shared Room membership or readability does not replace that attachment.

This is NOT manage_memory(action: "promote"). Use project only when the Human explicitly asks for a new sanitized, distilled, or rewritten copy — never as fallback for a denied or unavailable attach. For project, first search_memory for readable evidence, cite at least one returned Memory ID, draft only what is safe for the Room audience, and target the Room by name. Do not ask the Human for opaque IDs. Sharing is additive only for attach; project creates a destination-only copy.`,
    schema: z.union([
      ordinaryContentAccessRequired
        ? ordinaryAttachShareMemorySchema
        : legacyAttachShareMemorySchema,
      projectShareMemorySchema,
    ]),
    func: async (input, runManager, runConfig) => {
      try {
        // Projection calls are executed exclusively by toolsNode from a
        // checkpointed server snapshot. A direct DynamicStructuredTool call
        // has no trusted snapshot and must fail closed rather than trusting
        // model-authored destination/source fields.
        if (input.mode === "project") {
          return "Cannot create a projected Memory without the server-approved projection snapshot.";
        }
        const { memory_id, target_handle } = input;
        const userId = context?.userId ?? "";
        const envelope = context?.memoryAccessEnvelope;
        const agentId = envelope?.agentId ?? "";
        const readableNamespaces = envelopeReadableNamespaces(envelope);
        if (!userId || !agentId || readableNamespaces.length === 0) {
          if (context?.protectedMemoryAccessPort) throw new ProtectedMemoryToolUnavailableError("authorization_required");
          return "Cannot share memory: missing user, agent, or readable namespace context.";
        }

        if (context?.protectedMemoryAccessPort) {
          if (!target_handle) {
            throw new ProtectedMemoryToolUnavailableError("authorization_required");
          }
          const authority = protectedMemoryAuthorityFromEnvelope(envelope);
          if (!authority) {
            throw new ProtectedMemoryToolUnavailableError("authorization_required");
          }
          const requestId = protectedMemoryToolRequestId(
            runManager?.runId,
            runConfig?.configurable?.["memoryToolMutationRequestId"],
          );
          if (!requestId) {
            throw new ProtectedMemoryToolUnavailableError("authorization_required");
          }
          const operationId = protectedMemoryToolOperationId({
              requestId,
              action: "grant_user",
              subjectId: memory_id,
            });
          const handle = normalizeShareTargetHandle(target_handle);
          const retained = protectedShareApprovalReferences.get(
            context.protectedMemoryAccessPort,
          );
          const approvalKey = protectedShareApprovalKey(requestId, memory_id, handle);
          const approvalReference = retained?.get(approvalKey);
          retained?.delete(approvalKey);
          if (approvalReference === undefined) {
            throw new ProtectedMemoryToolUnavailableError("authorization_required");
          }
          const result = await context.protectedMemoryAccessPort.change({
            operationId,
            authority,
            memoryId: memory_id,
            action: {
              kind: "grant_user",
              userHandle: handle,
            },
            approvalReference,
          });
          if (result.status === "unavailable") {
            throw new ProtectedMemoryToolUnavailableError(result.reason);
          }
          if (result.value.memoryId !== memory_id) {
            throw new ProtectedMemoryToolUnavailableError("integrity_failure");
          }
          if (result.value.status !== "unchanged") {
            await emitAuthoredMemorySemanticChange(
              memory_id,
              "scope",
              operationId,
            );
          }
          return result.value.status === "unchanged"
            ? "Memory is already shared with that person."
            : `Shared memory ${memory_id} with @${
              handle
            }${result.value.status === "replayed" ? " (replayed)." : "."}`;
        }

        if (context?.ordinaryContentAccessRequired) {
          if (!context.ordinaryContentAccess) {
            return "Cannot share memory: approved ordinary content-access execution is unavailable.";
          }
          const result = await context.ordinaryContentAccess.commit();
          if (result.status === "error") {
            return JSON.stringify({ status: "error", message: result.message,
              ...(result.recovery ? { recovery: result.recovery } : {}) });
          }
          return result.message;
        }

        if (!target_handle) {
          return "Cannot share memory to a Room without approved ordinary content access.";
        }

        // M173 — the agent's tool keeps minting a CONVERSATIONAL pair room (it
        // is proactively sharing for discussion). The panel grant route uses
        // the same helper with `mintKind: "access"`.
        const outcome = await shareMemoryToUser({
          memoryId: memory_id,
          requesterUserId: userId,
          agentId,
          targetHandle: target_handle,
          readableNamespaces,
          mintKind: "conversational",
        });
        if (!outcome.ok) {
          return outcome.reason;
        }
        if (outcome.already) {
          return "Memory is already attached to that room.";
        }
        const handle = normalizeShareTargetHandle(target_handle);
        return (
          `Shared memory ${memory_id} with @${handle} in room '${outcome.roomLabel}'` +
          (outcome.minted ? " (newly created)." : ".")
        );
      } catch (error) {
        if (error instanceof ProtectedMemoryToolUnavailableError) throw error;
        if (context?.protectedMemoryAccessPort) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        return `Share memory failed: ${msg}`;
      }
    },
  });
}

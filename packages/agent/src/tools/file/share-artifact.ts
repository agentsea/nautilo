import type { ToolCall } from "@langchain/core/messages/tool";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { coerceHybridSensitivity } from "@nautilo/security";
import {
  agentDb,
  attachArtifactToNamespace,
  findArtifactByIdForNamespaces,
  getArtifactNamespaces,
} from "@nautilo/db";
import type { ShareArtifactApprovalPreview } from "@nautilo/types";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  assertCanWriteArtifacts,
  envelopeReadableNamespaces,
  findActorByOwnerId,
  findOrCreateAccessNamespace,
} from "@nautilo/trust";
import { withAgentTrustContext } from "../../store/trust-agent-db";
import {
  collapseWhitespaceShareApprovalSnippet,
  normalizeShareTargetHandle,
  resolveLocalShareTargetByHandle,
} from "../../post-model/share-approval-preview";
import type { OrdinaryContentAccessExecution } from "../../runtime/ordinary-content-access";
import { ordinaryShareTargetSchema } from "../content-access-intent";

interface ShareArtifactContext {
  /** Authenticated requester user id (tool catalog passes `userId`). */
  userId?: string;
  memoryAccessEnvelope?: MemoryAccessEnvelope | null;
  ordinaryContentAccessRequired?: boolean;
  ordinaryContentAccess?: OrdinaryContentAccessExecution;
}

export type ExactArtifactUserGrantResult =
  | Readonly<{
      ok: true;
      alreadyGranted: boolean;
      namespaceId: string;
      targetUserId: string;
      targetActorId: string;
      artifact: {
        artifactId: string;
        path: string;
        mimeType: string;
        size: number;
      };
    }>
  | Readonly<{ ok: false; message: string }>;

/**
 * Grant one local Human exact access to an existing Artifact. The destination
 * is an exact Human-set access Namespace, never the smallest common Room.
 */
export async function grantArtifactExactUserAccess(args: {
  userId: string;
  agentId: string;
  readableNamespaces: readonly string[];
  artifactId: string;
  targetHandle: string;
}): Promise<ExactArtifactUserGrantResult> {
  const requesterActor = await findActorByOwnerId(args.userId);
  if (!requesterActor) return { ok: false, message: "requester actor not found" };

  const handle = normalizeShareTargetHandle(args.targetHandle);
  const target = await resolveLocalShareTargetByHandle(handle);
  if (!target) return { ok: false, message: `No local user @${handle} on this server.` };
  if (target.userId === args.userId) {
    return { ok: false, message: "Cannot share an artifact with yourself." };
  }

  const artifact = await withAgentTrustContext(
    { userId: args.userId, agentId: args.agentId },
    async (tx) => findArtifactByIdForNamespaces(
      {
        artifactId: args.artifactId,
        readableNamespaceIds: [...args.readableNamespaces],
      },
      tx as unknown as typeof agentDb,
    ),
  );
  if (!artifact) {
    return {
      ok: false,
      message: `No artifact found with id ${args.artifactId}, or it is not yours to share for this agent.`,
    };
  }

  await assertCanWriteArtifacts({ humanUserId: args.userId, artifactId: artifact.id });
  const destination = await findOrCreateAccessNamespace(
    [requesterActor.id, target.actorId],
    {
      requesterUserId: args.userId,
      requesterActorId: requesterActor.id,
      label: `Exact Artifact access: @${handle}`,
    },
  );
  const attachedNamespaces = await withAgentTrustContext(
    { userId: args.userId, agentId: args.agentId },
    async (tx) => getArtifactNamespaces(artifact.id, tx as unknown as typeof agentDb),
  );
  const alreadyGranted = attachedNamespaces.includes(destination.namespaceId);
  if (!alreadyGranted) {
    await withAgentTrustContext({ userId: args.userId, agentId: args.agentId }, async (tx) => {
      await attachArtifactToNamespace(
        { artifactId: artifact.id, namespaceId: destination.namespaceId },
        tx as unknown as typeof agentDb,
      );
    });
  }
  return {
    ok: true,
    alreadyGranted,
    namespaceId: destination.namespaceId,
    targetUserId: target.userId,
    targetActorId: target.actorId,
    artifact: {
      artifactId: artifact.artifactId,
      path: artifact.path,
      mimeType: artifact.mimeType ?? "application/octet-stream",
      size: typeof artifact.size === "number" ? artifact.size : Number(artifact.size ?? 0),
    },
  };
}

/**
 * M088A — enrich ask / prove_it interrupts with artifact + room context for clients.
 * Artifact metadata is loaded only after Namespace / agent guards match execution
 * (`findArtifactByIdForNamespaces`). Target room details are computed only when
 * `target_handle` is on `list_my_users` roster.
 */
export async function computeShareArtifactApprovalPreview(
  tc: Pick<ToolCall, "name" | "args">,
  ctx: {
    memoryAccessEnvelope?: MemoryAccessEnvelope | null;
    userId?: string;
  },
): Promise<ShareArtifactApprovalPreview | null> {
  if (tc.name !== "share_artifact") return null;
  const args = (tc.args ?? {}) as Record<string, unknown>;
  const artifactId = typeof args["artifact_id"] === "string" ? args["artifact_id"] : "";
  const rawHandle = typeof args["target_handle"] === "string" ? args["target_handle"] : "";
  if (!artifactId || !rawHandle.trim()) return null;

  const envelope = ctx.memoryAccessEnvelope;
  const agentId = envelope?.agentId ?? "";
  const readableNamespaces = envelopeReadableNamespaces(envelope);
  const requesterUserId = ctx.userId ?? "";
  if (!agentId || readableNamespaces.length === 0 || !requesterUserId) return null;

  const hybrid = coerceHybridSensitivity(args["sensitivity"]);

  const artifactRow = await withAgentTrustContext(
    { userId: requesterUserId, agentId },
    async (tx) => {
      const conn = tx as unknown as typeof agentDb;
      return findArtifactByIdForNamespaces(
        {
          artifactId,
          readableNamespaceIds: readableNamespaces,
        },
        conn,
      );
    },
  );
  // INTENTIONAL vs share_memory: artifact card shows path + mime + size, not memory body/type.
  const artifactPathSnippet = artifactRow
    ? collapseWhitespaceShareApprovalSnippet(artifactRow.path)
    : "Artifact not found or not shareable by you.";
  const mimeType = artifactRow?.mimeType ?? "";
  const size = artifactRow?.size ?? 0;

  const handle = normalizeShareTargetHandle(rawHandle);
  const target = await resolveLocalShareTargetByHandle(handle);
  const targetDisplayName = target?.displayName ?? `@${handle}`;

  return {
    artifactPathSnippet,
    mimeType,
    size,
    targetHandle: handle,
    targetDisplayName,
    // Compatibility fields for the existing approval card. Artifact sharing
    // now grants exact person access and never selects or creates a visible
    // conversation Room.
    roomLabel: `Exact access for ${targetDisplayName}`,
    wouldCreate: false,
    sensitivity: hybrid.value,
  };
}

const legacyShareArtifactSchema = z.object({
  artifact_id: z
    .string()
    .describe("The external artifact id to share (from file.list zone=\"workspace\" or similar)."),
  target_handle: z
    .string()
    .describe("The handle of the user to share with — must appear in list_my_users, do not guess."),
  sensitivity: z
    .enum(["normal", "sensitive"])
    .describe(
      [
        "Choose 'sensitive' if the artifact contains data that should require proof of identity",
        "before release: passport numbers, government IDs, credentials, financial data, private",
        "medical information, or similarly harmful personal details. Choose 'normal' for",
        "ordinary workspace files or low-sensitivity content.",
      ].join(" "),
    ),
});

const ordinaryShareArtifactSchema = z.object({
  artifact_id: z
    .string()
    .describe("The external artifact id to share (from file.list zone=\"workspace\" or similar)."),
  target_handle: z
    .string()
    .optional()
    .describe("Legacy person target. Use either target_handle or target, never both."),
  target: ordinaryShareTargetSchema.optional()
    .describe("Person or Room target for ordinary content access. Use instead of target_handle."),
  sensitivity: z
    .enum(["normal", "sensitive"])
    .describe(
      [
        "Choose 'sensitive' if the artifact contains data that should require proof of identity",
        "before release: passport numbers, government IDs, credentials, financial data, private",
        "medical information, or similarly harmful personal details. Choose 'normal' for",
        "ordinary workspace files or low-sensitivity content.",
      ].join(" "),
    ),
}).superRefine((value, ctx) => {
  if ((value.target_handle === undefined) === (value.target === undefined)) {
    ctx.addIssue({ code: "custom", message: "Choose exactly one of target_handle or target." });
  }
});

export function createShareArtifactTool(context?: ShareArtifactContext) {
  const ordinaryContentAccessRequired = context?.ordinaryContentAccessRequired === true;
  return new DynamicStructuredTool({
    name: "share_artifact",
    description: ordinaryContentAccessRequired
      ? `Attach an existing artifact (returned by file.list zone="workspace" or referenced by artifact_id) to an additional Namespace, making it visible to every participant in that Namespace.

Before calling: use list_my_users when the user names a person; disambiguate handles in conversation and never guess. Use either the legacy target_handle or target (a person handle or explicit Room name), never both.

Person-targeted sharing grants exact access to that Human and does not select a broader common Room. A Room target explicitly grants that named Room's audience through ordinary content access.

This is NOT file.copy. Copy creates a new artifact; share_artifact ATTACHES the existing artifact to an exact access Namespace. The original attachment stays — sharing is additive.`
      : `Attach an existing artifact (returned by file.list zone="workspace" or referenced by artifact_id) to an additional Namespace, making it visible to every participant in that Namespace.

Before calling: use list_my_users when the user names a person; disambiguate handles in conversation — never guess a target_handle. Only users returned by list_my_users can receive a share.

Person-targeted sharing grants exact access to that Human. It does not select a broader common Room and does not ask the Human to create a conversation Room.

This is NOT file.copy. Copy creates a new artifact; share_artifact ATTACHES the existing artifact to an exact access Namespace. The original attachment stays — sharing is additive.`,
    schema: ordinaryContentAccessRequired
      ? ordinaryShareArtifactSchema
      : legacyShareArtifactSchema,
    func: async ({ artifact_id, target_handle }) => {
      try {
        const userId = context?.userId ?? "";
        const envelope = context?.memoryAccessEnvelope;
        const agentId = envelope?.agentId ?? "";
        const readableNamespaces = envelopeReadableNamespaces(envelope);
        if (!userId || !agentId || readableNamespaces.length === 0) {
          return "Cannot share artifact: missing user, agent, or readable namespace context.";
        }

        if (context?.ordinaryContentAccessRequired) {
          if (!context.ordinaryContentAccess) {
            return "Cannot share artifact: approved ordinary content-access execution is unavailable.";
          }
          const result = await context.ordinaryContentAccess.commit();
          if (result.status === "error") {
            return JSON.stringify({ status: "error", message: result.message,
              ...(result.recovery ? { recovery: result.recovery } : {}) });
          }
          return result.message;
        }
        if (!target_handle) {
          return "Cannot share an artifact to a Room without approved ordinary content access.";
        }
        const handle = normalizeShareTargetHandle(target_handle);
        const result = await grantArtifactExactUserAccess({
          userId,
          agentId,
          readableNamespaces,
          artifactId: artifact_id,
          targetHandle: handle,
        });
        if (!result.ok) return result.message;
        return result.alreadyGranted
          ? `Artifact already grants @${handle} exact access.`
          : `Granted @${handle} exact access to artifact ${artifact_id}. No shared Room was created; the original attachment is preserved.`;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Share artifact failed: ${msg}`;
      }
    },
  });
}

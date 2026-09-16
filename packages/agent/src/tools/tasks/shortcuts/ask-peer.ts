import { DynamicStructuredTool } from "@langchain/core/tools";
import { log } from "@nautilo/logger";
import type { ChatArtifactRef, ResolvedFocusedResource } from "@nautilo/types";
import { envelopeReadableNamespaces } from "@nautilo/trust";
import { z } from "zod";
import {
  getTaskToolRuntime,
  type TaskToolCreateInput,
} from "../task-tool-runtime";
import {
  shortcutContextFromUnknown,
  modelSelectionParam,
  modelIdParam,
  type ShortcutContext,
} from "./shortcut-context";
import { validateTaskModelSelectionForCreate } from "../selection-validation";
import { grantArtifactExactUserAccess } from "../../file/share-artifact";

/**
 * M151 (Phase 7b) — `ask_peer` intent shortcut. Sends the agent to DM another
 * person, parks the run awaiting their human reply, and reports the answer back
 * to the calling room. A thin `TaskCreateInput` builder: the DM room resolution
 * + await/resume substrate live at the dispatch seam (`resolveDm`) and the
 * `await_reply` graph node. Gated on `invoke_agents` in register-all.ts +
 * tool-policies.ts.
 */
const askPeerSchema = z.object({
  peer_handle: z
    .string()
    .min(1)
    .describe("The @handle of the person to ask (without the @ is fine)."),
  message_to_peer: z
    .string()
    .min(1)
    .describe(
      "The EXACT message to send to the peer — this literal text is delivered to them. It is NOT a question for you to answer; do not answer it yourself. E.g. \"How are you feeling today?\"",
    ),
  return_instructions: z
    .string()
    .optional()
    .describe(
      "Optional: how to report the peer's reply back (default: report their answer back to this chat). E.g. \"summarize how they're doing in one line\".",
    ),
  tools: z
    .array(z.string())
    .optional()
    .describe("Optional tool whitelist for the DM subagent (default: no tools)."),
  include_focused_artifacts: z
    .boolean()
    .optional()
    .describe(
      "Set true when the request refers to the currently focused document/artifact (for example: 'take this doc to Elias'). ask_peer grants the peer exact access and sends the Artifact card with the message; no separate share_artifact call or shared Room is needed.",
    ),
  artifact_ids: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional exact workspace artifact ids to share and attach to the peer message. Use authoritative ids from focused resources or file.list; never guess.",
    ),
  sensitivity: z
    .enum(["normal", "sensitive"])
    .default("normal")
    .describe(
      "Sensitivity of any included artifacts. Use sensitive for credentials, financial, medical, government-ID, or similarly harmful private content; otherwise normal.",
    ),
  model_selection: modelSelectionParam,
  model_id: modelIdParam,
});

type AskPeerArgs = z.infer<typeof askPeerSchema>;

const ASK_PEER_DESCRIPTION =
  "Start a DM subagent that asks any local server PERSON something and brings their reply back here. Put the EXACT text to send in `message_to_peer` — it is delivered to the peer verbatim; you do NOT answer it yourself. For 'take this document to <person>' requests, set `include_focused_artifacts: true` (or pass `artifact_ids`): this one call grants the exact person access and sends Artifact cards with the DM, without a separate share call or a user-created Room. The subagent delivers the message, WAITS for the peer's human reply, then reports back to this chat.";

function focusedWorkspaceArtifactIds(
  resources: readonly ResolvedFocusedResource[],
): string[] {
  const ids: string[] = [];
  for (const resource of resources) {
    if (resource.kind !== "workspace-artifact") continue;
    const locator = resource.locator;
    const id = locator && typeof locator === "object"
      ? (locator as { artifactId?: unknown }).artifactId
      : undefined;
    if (typeof id === "string" && id.trim() && !ids.includes(id.trim())) {
      ids.push(id.trim());
    }
  }
  return ids;
}

/**
 * Build the DM subagent's brief from the split params. Deterministic + explicit
 * so the run sends the message and waits for the human, rather than answering
 * it itself (the ambiguity the old single `question` field caused).
 */
function buildAskPeerBrief(args: {
  handle: string;
  messageToPeer: string;
  returnInstructions?: string | undefined;
}): string {
  const ret = args.returnInstructions?.trim();
  return [
    `You are now talking DIRECTLY to @${args.handle} in THIS conversation — they are the other participant here, not the person who sent you. Whatever you say in this turn is delivered straight to them; you do NOT need any tool to message them, and you must NOT try to use one.`,
    `Reply now with EXACTLY this message to @${args.handle} — no preamble, nothing added, and do NOT answer it yourself or speak on their behalf:`,
    ``,
    `"${args.messageToPeer.trim()}"`,
    ``,
    `You will then receive @${args.handle}'s own human reply in this same conversation. ${
      ret
        ? `Once they reply: ${ret}`
        : `Once they reply, report their answer back to the chat where this was requested.`
    }`,
  ].join("\n");
}

export function createAskPeerTool(context?: unknown) {
  const ctx: ShortcutContext = shortcutContextFromUnknown(context);

  return new DynamicStructuredTool({
    name: "ask_peer",
    description: ASK_PEER_DESCRIPTION,
    schema: askPeerSchema,
    func: async (args: AskPeerArgs) => {
      log(`[ask_peer]`);
      if (!ctx.ownerId || !ctx.agentId) {
        return "Cannot start ask_peer task: missing owner or agent context.";
      }
      const hasTools = Array.isArray(args.tools) && args.tools.length > 0;
      const selectionError = validateTaskModelSelectionForCreate({
        requestedModelId: args.model_id,
        profile: args.model_selection,
        // ask_peer defaults to tool-free (none); a non-empty tools list → whitelist.
        toolsMode: hasTools ? "whitelist" : "none",
        toolsWhitelist: args.tools ?? [],
      });
      if (selectionError) return selectionError;
      const handle = args.peer_handle.trim().replace(/^@/, "");
      const requestedArtifactIds = Array.from(new Set([
        ...(args.artifact_ids ?? []).map((id) => id.trim()).filter(Boolean),
        ...(args.include_focused_artifacts
          ? focusedWorkspaceArtifactIds(ctx.focusedResources)
          : []),
      ]));
      if (args.include_focused_artifacts && requestedArtifactIds.length === 0) {
        return JSON.stringify({
          status: "not_contacted",
          message: "No focused workspace Artifact is available to share. Focus the document or pass its exact artifact_id, then retry ask_peer.",
        });
      }

      const sharedArtifacts: ChatArtifactRef[] = [];
      let expectedArtifactPeerActorId: string | undefined;
      if (requestedArtifactIds.length > 0) {
        const shareAccess = ctx.memoryAccessEnvelope?.toolPolicy["share_artifact"];
        if (shareAccess === undefined || shareAccess === "forbidden" || shareAccess === "read_only") {
          return JSON.stringify({
            status: "not_contacted",
            message: "You can contact this peer, but you do not have permission to share Artifacts with them.",
          });
        }
        const readableNamespaces = envelopeReadableNamespaces(ctx.memoryAccessEnvelope);
        if (ctx.ordinaryContentAccessRequired) {
          if (!ctx.ordinaryContentAccess) {
            return JSON.stringify({
              status: "not_contacted",
              message: "Approved ordinary content-access execution is unavailable. Prepare a new ask_peer call.",
            });
          }
          const access = await ctx.ordinaryContentAccess.commit();
          sharedArtifacts.push(...access.artifacts);
          if (access.status !== "success") {
            return JSON.stringify({
              status: sharedArtifacts.length > 0 ? "shared_but_not_contacted" : "not_contacted",
              sharedArtifactIds: sharedArtifacts.map((artifact) => artifact.artifactId),
              ...(access.recovery ? { recovery: access.recovery } : {}),
              message: access.message,
            });
          }
          if (!access.peerActorId) return JSON.stringify({ status: "shared_but_not_contacted",
            message: "The exact approved Artifact recipient is unavailable. The peer was not contacted." });
          expectedArtifactPeerActorId = access.peerActorId;
        } else {
          for (const artifactId of requestedArtifactIds) {
            try {
              const grant = await grantArtifactExactUserAccess({
                userId: ctx.ownerId,
                agentId: ctx.agentId,
                readableNamespaces,
                artifactId,
                targetHandle: handle,
              });
              if (!grant.ok) {
                return JSON.stringify({
                  status: sharedArtifacts.length > 0 ? "shared_but_not_contacted" : "not_contacted",
                  sharedArtifactIds: sharedArtifacts.map((artifact) => artifact.artifactId),
                  failedArtifactId: artifactId,
                  message: grant.message,
                });
              }
              sharedArtifacts.push(grant.artifact);
            } catch (error) {
              return JSON.stringify({
                status: sharedArtifacts.length > 0 ? "shared_but_not_contacted" : "not_contacted",
                sharedArtifactIds: sharedArtifacts.map((artifact) => artifact.artifactId),
                failedArtifactId: artifactId,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      }
      const rt = getTaskToolRuntime();
      const metadata: Record<string, unknown> = {
        ...(expectedArtifactPeerActorId === undefined ? {} : {
          ordinaryArtifactPeer: true, expectedArtifactPeerActorId,
        }),
        ...(sharedArtifacts.length > 0
          ? {
              artifactAwareAskPeer: true,
              artifactRefs: sharedArtifacts,
              artifactOperationId: [
                "ask-peer-artifacts-v1",
                ctx.turnId || "unbound-turn",
                handle,
                ...sharedArtifacts.map((artifact) => artifact.artifactId).sort(),
              ].join(":"),
            }
          : {}),
      };
      const input: TaskToolCreateInput = {
        ownerId: ctx.ownerId,
        requestorId: ctx.ownerId,
        agentId: ctx.agentId,
        prompt: buildAskPeerBrief({
          handle,
          messageToPeer: args.message_to_peer,
          returnInstructions: args.return_instructions,
        }),
        preset: "ask_peer",
        scheduleKind: "now",
        useScope: false,
        toolsMode: hasTools ? "whitelist" : "none",
        toolsWhitelist: args.tools ?? [],
        targetChat: "last_dm",
        targetChatHandle: `@${handle}`,
        awaitResponse: true,
        callingRoomId: ctx.roomId || null,
        // The requester is element 0 (existing invariant). The peer's user id
        // is appended at the dispatch seam (`resolveDm`) once the handle is
        // resolved, so `findAwaitingTaskForRoom` matches the peer's reply.
        targetUserIds: [ctx.ownerId],
        depth: 0,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...(args.model_selection !== undefined
          ? { selectionProfile: args.model_selection }
          : {}),
        ...(args.model_id !== undefined ? { requestedModelId: args.model_id } : {}),
      };
      let created: Awaited<ReturnType<typeof rt.createTask>>;
      try {
        created = await rt.createTask(input);
      } catch (error) {
        if (sharedArtifacts.length === 0) throw error;
        return JSON.stringify({
          status: "shared_but_not_contacted",
          sharedArtifactIds: sharedArtifacts.map((artifact) => artifact.artifactId),
          message: `The Artifact access grant succeeded, but the peer task could not be created: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      const { taskId, status } = created;
      return JSON.stringify({
        taskId,
        status,
        ...(sharedArtifacts.length > 0
          ? { sharedArtifactIds: sharedArtifacts.map((artifact) => artifact.artifactId) }
          : {}),
        message: `I've reached out to @${handle}; I'll report back here when they reply.`,
      });
    },
  });
}

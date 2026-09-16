import type { ToolCall } from "@langchain/core/messages/tool";
import type { ResolvedFocusedResource } from "@nautilo/types";
import { z } from "zod";
import { normalizeShareTargetHandle } from "../post-model/share-approval-preview";

export type OrdinaryShareTarget =
  | Readonly<{ kind: "person"; handle: string }>
  | Readonly<{ kind: "room"; name: string; choiceToken?: string }>;

export type OrdinaryContentAccessIntent = Readonly<{
  toolName: "share_memory" | "share_artifact" | "ask_peer";
  objects: readonly Readonly<{ kind: "memory" | "artifact"; id: string }>[];
  target: OrdinaryShareTarget;
}>;

export const ordinaryShareTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), handle: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("room"), name: z.string().trim().min(1),
    choiceToken: z.string().min(1).optional() }).strict(),
]);

function targetFromArgs(
  args: Record<string, unknown>,
  legacyField: "target_handle" | "peer_handle",
): OrdinaryShareTarget {
  const parsedTarget = args["target"] === undefined
    ? null : ordinaryShareTargetSchema.safeParse(args["target"]);
  const legacySupplied = typeof args[legacyField] === "string" && Boolean(args[legacyField].trim());
  const legacy = legacySupplied ? normalizeShareTargetHandle(args[legacyField] as string) : "";
  if (parsedTarget && !parsedTarget.success) throw new Error("Invalid content-access target.");
  if (parsedTarget && legacySupplied) throw new Error("Choose either the legacy target or target, not both.");
  if (parsedTarget) {
    if (parsedTarget.data.kind === "person") {
      const handle = normalizeShareTargetHandle(parsedTarget.data.handle);
      if (!handle) throw new Error("A person handle is required for content access.");
      return { kind: "person", handle };
    }
    return { kind: "room", name: parsedTarget.data.name.trim(),
        ...(parsedTarget.data.choiceToken
          ? { choiceToken: parsedTarget.data.choiceToken } : {}) };
  }
  if (!legacy) throw new Error("A content-access target is required.");
  return { kind: "person", handle: legacy };
}

function focusedArtifactIds(resources: readonly ResolvedFocusedResource[]): string[] {
  const ids: string[] = [];
  for (const resource of resources) {
    if (resource.kind !== "workspace-artifact") continue;
    const artifactId = resource.locator && typeof resource.locator === "object"
      ? (resource.locator as { artifactId?: unknown }).artifactId : undefined;
    if (typeof artifactId === "string" && artifactId.trim() && !ids.includes(artifactId.trim())) {
      ids.push(artifactId.trim());
    }
  }
  return ids;
}

export function parseOrdinaryContentAccessIntent(
  call: ToolCall,
  focusedResources: readonly ResolvedFocusedResource[],
): OrdinaryContentAccessIntent | null {
  const args = call.args && typeof call.args === "object"
    ? call.args as Record<string, unknown> : {};
  if (call.name === "share_memory") {
    if (args["mode"] === "project") return null;
    if (args["mode"] !== undefined && args["mode"] !== "attach") {
      throw new Error("Invalid share_memory mode for content access.");
    }
    const memoryId = typeof args["memory_id"] === "string" ? args["memory_id"].trim() : "";
    if (!memoryId) throw new Error("A Memory id is required for content access.");
    return { toolName: "share_memory", objects: [{ kind: "memory", id: memoryId }],
      target: targetFromArgs(args, "target_handle") };
  }
  if (call.name === "share_artifact") {
    const artifactId = typeof args["artifact_id"] === "string" ? args["artifact_id"].trim() : "";
    if (!artifactId) throw new Error("An Artifact id is required for content access.");
    return { toolName: "share_artifact", objects: [{ kind: "artifact", id: artifactId }],
      target: targetFromArgs(args, "target_handle") };
  }
  if (call.name !== "ask_peer") return null;
  if (args["artifact_ids"] !== undefined && (!Array.isArray(args["artifact_ids"])
    || args["artifact_ids"].some((id) => typeof id !== "string" || !id.trim()))) {
    throw new Error("Invalid ask_peer Artifact ids for content access.");
  }
  if (args["include_focused_artifacts"] !== undefined
    && typeof args["include_focused_artifacts"] !== "boolean") {
    throw new Error("Invalid focused Artifact selection for content access.");
  }
  const explicit = Array.isArray(args["artifact_ids"])
    ? (args["artifact_ids"] as string[]).map((id) => id.trim()) : [];
  const includeFocused = args["include_focused_artifacts"] === true;
  const artifactIds = [...new Set([...explicit, ...(includeFocused
    ? focusedArtifactIds(focusedResources) : [])])];
  if (!explicit.length && !includeFocused) return null;
  if (!artifactIds.length) throw new Error("No workspace Artifact is available for content access.");
  return { toolName: "ask_peer",
    objects: artifactIds.map((id) => ({ kind: "artifact" as const, id })),
    target: targetFromArgs(args, "peer_handle") };
}

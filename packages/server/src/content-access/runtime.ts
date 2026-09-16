import {
  createContentAccessCoordinator,
  createContentAccessPreviewCodec,
  type ContentAccessCoordinatorOptions,
} from "@nautilo/trust";
import { resolveContentAccessPreviewKey } from "./preview-key";
import { invalidateWorkspaceArtifactAccess } from "../lib/workspace-artifact-access-invalidation";

/** One lazy instance-bound owner for the Server's ordinary sharing adapters. */
export function createServerContentAccessRuntime(
  options: ContentAccessCoordinatorOptions = {},
): ReturnType<typeof createContentAccessCoordinator> {
  let coordinator: ReturnType<typeof createContentAccessCoordinator> | undefined;
  const current = () => coordinator ??= createContentAccessCoordinator(
    createContentAccessPreviewCodec(resolveContentAccessPreviewKey()),
    options,
  );
  return {
    verifyPreparedGrantForContact: (...args: Parameters<ReturnType<typeof createContentAccessCoordinator>["verifyPreparedGrantForContact"]>) =>
      current().verifyPreparedGrantForContact(...args),
    prepare: (...args: Parameters<ReturnType<typeof createContentAccessCoordinator>["prepare"]>) =>
      current().prepare(...args),
    commit: async (...args: Parameters<ReturnType<typeof createContentAccessCoordinator>["commit"]>) => {
      const result = await current().commit(...args);
      if (args[1].object.kind === "artifact" && ["applied", "already_applied", "partial"].includes(result.outcome)) {
        await invalidateWorkspaceArtifactAccess(args[1].object.id);
      }
      return result;
    },
    executeLegacyHuman: async (...args: Parameters<ReturnType<typeof createContentAccessCoordinator>["executeLegacyHuman"]>) => {
      const result = await current().executeLegacyHuman(...args);
      if (args[1].object.kind === "artifact" && "kind" in result
        && ["applied", "already_applied", "partial"].includes(result.receipt.outcome)) {
        await invalidateWorkspaceArtifactAccess(args[1].object.id);
      }
      return result;
    },
  };
}

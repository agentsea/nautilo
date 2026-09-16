/**
 * M054 — default deps for `createPostModelNode`.
 *
 * Lazily instantiates a `PinChallengeProvider` singleton so the
 * post-model node can check "is this user enrolled?" without every
 * caller having to thread an injected helper through.
 *
 * Each `isEnrolled` call opens a short-lived DB connection (see
 * `packages/trust/src/challenge.ts:69`); the singleton pattern is
 * just to avoid re-running the lockout-file load on every call,
 * not to share connections.
 *
 * Tests use the explicit-deps overload of `createPostModelNode`
 * (back-compat: omitting deps disables the enrollPin pre-step
 * entirely, which matches pre-M054 behavior).
 *
 * D418 task 3.2.5 — `defaultPostModelDeps` is ALSO the dependency-
 * injection seam for the Full Workstation approval override resolver
 * (`resolveWorkstationApprovalOverride` on `PostModelDeps`). The
 * resolver is NOT defaulted here: the agent package cannot construct
 * it (it has no access to the live `InMemoryWorkstationSessionRegistry`
 * or the relay / profile / OS evidence machinery, which live in the
 * server). Instead `packages/server/src/app.ts` mutates this exported
 * object once at boot —
 *
 *   defaultPostModelDeps.resolveWorkstationApprovalOverride =
 *     createWorkstationApprovalOverrideResolver({ registry, ... });
 *
 * — and every graph constructed downstream (the foreground
 * `langgraphExecutor`, the fork executor, subagent runs, and the
 * resume paths) picks it up because they all build the graph with
 * this same `defaultPostModelDeps` object. Until that mutation lands
 * the field stays `undefined` and Pass 2 behavior is byte-for-byte
 * identical to pre-D418 (the override consultation is skipped). The
 * fail-closed contract — `none` / throw / anonymous- turn / `block`
 * never widen approval — is enforced in `post-model.ts`, NOT here.
 */
import { PinChallengeProvider } from "@nautilo/trust";
import type { PostModelDeps } from "../nodes/post-model";

let cachedProvider: PinChallengeProvider | null = null;

function getProvider(): PinChallengeProvider {
  if (!cachedProvider) {
    cachedProvider = new PinChallengeProvider();
  }
  return cachedProvider;
}

export const defaultPostModelDeps: PostModelDeps = {
  isPinEnrolled: (userId) => getProvider().isEnrolled(userId),
};

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { interrupt } from "@langchain/langgraph";
import { PinChallengeProvider, type MemoryAccessEnvelope } from "@nautilo/trust";

// D168 P3 — credentials chokepoint. Direct `credentials` schema
// queries are banned from this file by the ESLint rule
// `d168-credentials-chokepoint`. PIN existence checks go through
// `PinChallengeProvider.isEnrolled()` which wraps the read in
// `withTrustContext({ userId })` so FORCE-RLS on credentials gates
// the SELECT correctly.

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * M125 Phase 1.1: factory is context-free. The PIN subject is the user
 * driving the current turn, sourced from the runtime envelope on every
 * invocation (`envelope.ownerId` — same field `manage_memory` uses to
 * attribute writes). Pre-M125 the subject came from the
 * `bootstrap-state-cache` global (the first claimer's `users.id`),
 * which meant a non-operator user's `prove_it` always prompted for the
 * operator's PIN.
 */
interface VerifyIdentityToolContext {
  memoryAccessEnvelope?: MemoryAccessEnvelope | null;
}

export const IDENTITY_VERIFIED_MESSAGE =
  "Identity verified successfully for the current user. " +
  "Verification does not change or prove any owner, admin, member, or other role.";

/** Pure seam for the result resumed by LangGraph after the PIN challenge. */
export function identityVerificationResult(decision: unknown): string {
  if (
    decision &&
    typeof decision === "object" &&
    (decision as Record<string, unknown>)["verified"] === true
  ) {
    return IDENTITY_VERIFIED_MESSAGE;
  }
  return "Identity verification failed or was cancelled.";
}

export function createVerifyIdentityTool(context?: VerifyIdentityToolContext) {
  return new DynamicStructuredTool({
    name: "verify_identity",
    description:
      "Verify the current user's identity with their own PIN. " +
      "This confirms the current user only; it does not prove or change their owner, admin, member, or other role. " +
      "Use this when a user makes an identity claim, asks to verify, or needs verification for a restricted action. " +
      "Do not call it proactively.",
    // The PIN subject comes exclusively from the trusted runtime envelope.
    // No model-supplied role or identity label can affect who is verified.
    schema: z.object({}),
    func: async () => {
      const envelope = context?.memoryAccessEnvelope;
      const pinSubjectUserId =
        typeof envelope?.ownerId === "string" && envelope.ownerId.length > 0
          ? envelope.ownerId
          : "";
      if (!pinSubjectUserId) {
        // Fail-closed: never borrow the operator's PIN for an
        // anonymous/stranger-shaped turn. The LLM surfaces this
        // message to the caller.
        return "verify_identity unavailable without authenticated user context.";
      }

      const provider = new PinChallengeProvider({ persistPath: null });
      let enrolled = false;
      try {
        enrolled = await provider.isEnrolled(pinSubjectUserId);
      } catch {
        enrolled = false;
      }
      if (!enrolled) {
        return "No PIN credential is configured. Identity verification is not available.";
      }

      const challengeId = randomUUID();
      const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();

      // Pause the graph and surface the challenge to the client.
      // The graph will remain paused until the server resumes it
      // with Command({ resume: { verified: true/false } }).
      const decision: unknown = interrupt({
        type: "identity_challenge",
        challengeId,
        expiresAt,
        userId: pinSubjectUserId,
      });

      return identityVerificationResult(decision);
    },
  });
}

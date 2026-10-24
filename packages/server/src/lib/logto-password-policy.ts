import { passwordPolicyGuard } from "@logto/core-kit";

/** Preserve nested identity-policy defaults when using Zod's output defaults. */
export function parseLogtoPasswordPolicy(rawPolicy: unknown) {
  // Zod 4 returns a default object without parsing its nested fields. The
  // second pass validates those objects and applies their canonical defaults.
  // Fully specified policies remain unchanged; invalid input still fails closed.
  return passwordPolicyGuard.parse(passwordPolicyGuard.parse(rawPolicy));
}

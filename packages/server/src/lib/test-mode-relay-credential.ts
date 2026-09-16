import { createHmac } from "node:crypto";

// Synthetic identity owned exclusively by the isolated smoke harness.
export const TEST_MODE_RELAY_USER_ID = "c7d9b8b8-2c33-4e80-9498-65f32c18b38a";

/** Separate credential from the scanner bearer; stable across isolated VM boots. */
export function deriveTestModeRelayCredential(testToken: string): string {
  if (testToken.length === 0 || testToken.trim() !== testToken) {
    throw new Error("A nonempty test-mode bearer is required");
  }
  return `rty_${createHmac("sha256", testToken)
    .update("nautilo.security-smoke.relay-credential.v1")
    .digest().subarray(0, 24).toString("base64url")}`;
}

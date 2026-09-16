import { createHash, randomUUID } from "node:crypto";
import { getRelayTokenStore, setRelayTokenStore, type RelayTokenStore } from "./relay-token-store";
import { deriveTestModeRelayCredential, TEST_MODE_RELAY_USER_ID } from "./test-mode-relay-credential";

/** Only the explicit DB-less smoke app may install this single paired identity. */
export function installTestModeRelayFixture(testToken: string): () => void {
  if (process.env["NODE_ENV"] === "production"
    || process.env["NAUTILO_TEST_MODE"] !== "1"
    || process.env["NAUTILO_TEST_MODE_ONLY"] !== "1") {
    throw new Error("Relay fixture requires the isolated test-mode-only server");
  }
  const tokenHash = createHash("sha256").update(deriveTestModeRelayCredential(testToken)).digest("hex");
  const row = { id: randomUUID(), userId: TEST_MODE_RELAY_USER_ID, actorId: "security-smoke-relay" };
  const unsupported = (): Promise<never> =>
    Promise.reject(new Error("The isolated Relay fixture does not provide device-management routes"));
  const fixture: RelayTokenStore = {
    findActiveByHash: (hash) => Promise.resolve(hash === tokenHash ? row : null),
    touchLastSeen: async () => {},
    insertToken: unsupported,
    pairForInstallation: unsupported,
    listForUser: () => Promise.resolve([]),
    revokeForUser: () => Promise.resolve(false),
  };
  const previous = getRelayTokenStore();
  setRelayTokenStore(fixture);
  return () => {
    if (getRelayTokenStore() === fixture) setRelayTokenStore(previous);
  };
}

/** Guest-only smoke setup. Never print or accept a credential in argv. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createKeyringRelayCredentialStore, type RelayCredentialStore } from "../../bin/nautilo-relay/src/credential-store";
import { resolveRelayDataDir } from "../../bin/nautilo-relay/src/bootstrap";
import { deriveTestModeRelayCredential, TEST_MODE_RELAY_USER_ID } from "../../packages/server/src/lib/test-mode-relay-credential";

export async function provisionSmokeRelayPairing(input: {
  tokenPath: string;
  store: RelayCredentialStore;
}): Promise<void> {
  if (process.env["NODE_ENV"] === "production"
    || process.env["NAUTILO_TEST_MODE"] !== "1"
    || process.env["NAUTILO_TEST_MODE_ONLY"] !== "1") {
    throw new Error("Pairing fixture requires explicit isolated test mode");
  }
  const server = new URL(input.store.serverUrl);
  if (server.origin !== "http://127.0.0.1:3001" || server.href !== `${server.origin}/`) {
    throw new Error("Pairing fixture requires the isolated loopback smoke server");
  }
  const handle = await open(input.tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let testToken: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
      throw new Error("Smoke bearer file must be owned by the current user and owner-only");
    }
    testToken = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const relayToken = deriveTestModeRelayCredential(testToken);
  const identity = await input.store.getOrCreatePairingIdentity();
  const existing = await input.store.load();
  if (existing !== null && (existing.relayToken !== relayToken || existing.userId !== TEST_MODE_RELAY_USER_ID)) {
    throw new Error("Refusing to overwrite a different Relay pairing");
  }
  await input.store.save({ ...identity, userId: TEST_MODE_RELAY_USER_ID, relayToken });
  const reloaded = await input.store.load();
  if (reloaded?.relayToken !== relayToken || reloaded.installationId !== identity.installationId) {
    throw new Error("Relay credential-store readback failed");
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error("Pass only the smoke bearer file path");
    const store = await createKeyringRelayCredentialStore({
      serverUrl: "http://127.0.0.1:3001",
      dataDir: resolveRelayDataDir(),
    });
    await provisionSmokeRelayPairing({ tokenPath: process.argv[2]!, store });
    process.stdout.write("Smoke Relay credential stored and verified through the OS keychain.\n");
  } catch {
    process.stderr.write("Smoke Relay pairing provisioning failed; no credentials were printed.\n");
    process.exitCode = 1;
  }
}

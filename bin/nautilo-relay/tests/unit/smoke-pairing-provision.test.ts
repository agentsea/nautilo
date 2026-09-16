import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyringRelayCredentialStore, relayPairingMetadataPath } from "../../src/credential-store";
import { provisionSmokeRelayPairing } from "../../../../scripts/security-test-env/provision-relay-pairing";

async function rejection(promise: Promise<void>): Promise<Error> {
  const error: unknown = await promise.then(() => null, (reason: unknown) => reason);
  if (!(error instanceof Error)) throw new Error("Expected provisioning to reject");
  return error;
}

describe("smoke pairing provisions the regular credential store", () => {
  let root: string;
  let keyringValue: string | null;
  let store: KeyringRelayCredentialStore;
  const original = { ...process.env };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "smoke-pairing-"));
    keyringValue = null;
    store = new KeyringRelayCredentialStore({
      serverUrl: "http://127.0.0.1:3001", dataDir: join(root, "data"),
      entry: {
        getPassword: async () => keyringValue,
        setPassword: async (value) => { keyringValue = value; },
        deleteCredential: async () => { keyringValue = null; return true; },
      },
    });
    process.env["NODE_ENV"] = "test";
    process.env["NAUTILO_TEST_MODE"] = "1";
    process.env["NAUTILO_TEST_MODE_ONLY"] = "1";
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    for (const key of ["NODE_ENV", "NAUTILO_TEST_MODE", "NAUTILO_TEST_MODE_ONLY"]) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  test("round trips pairing, stays restart-stable, and leaves no plaintext credential in metadata", async () => {
    const tokenPath = join(root, "token");
    const testToken = randomBytes(24).toString("base64url");
    await writeFile(tokenPath, testToken, { mode: 0o600 });
    await provisionSmokeRelayPairing({ tokenPath, store });
    const credential = await store.load();
    expect(credential?.relayToken).toMatch(/^rty_[A-Za-z0-9_-]{32}$/);
    expect(credential?.userId).toBe("c7d9b8b8-2c33-4e80-9498-65f32c18b38a");
    const metadata = await readFile(relayPairingMetadataPath(join(root, "data"), store.serverUrl), "utf8");
    expect(metadata).not.toContain(testToken);
    expect(metadata).not.toContain(credential!.relayToken);
    await provisionSmokeRelayPairing({ tokenPath, store });
    expect(await store.load()).toEqual(credential);
    await writeFile(tokenPath, randomBytes(24).toString("base64url"));
    expect((await rejection(provisionSmokeRelayPairing({ tokenPath, store }))).message).toContain("different Relay pairing");
    expect(await store.load()).toEqual(credential);
  });
  test("refuses a public or symlink bearer file and production execution", async () => {
    const tokenPath = join(root, "token");
    await writeFile(tokenPath, "fixture-bearer", { mode: 0o600 });
    await chmod(tokenPath, 0o644);
    expect((await rejection(provisionSmokeRelayPairing({ tokenPath, store }))).message).toContain("owner-only");
    await chmod(tokenPath, 0o600);
    const link = join(root, "link");
    await symlink(tokenPath, link);
    expect(await rejection(provisionSmokeRelayPairing({ tokenPath: link, store }))).toBeInstanceOf(Error);
    process.env["NODE_ENV"] = "production";
    expect((await rejection(provisionSmokeRelayPairing({ tokenPath, store }))).message).toContain("isolated test mode");
    expect(keyringValue).toBeNull();
  });

  test("guest openssl capture and printf produce an exact usable bearer file", async () => {
    const tokenPath = join(root, "generated-token");
    const status = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("bash", ["-c", 'set -eu; umask 077; SMOKE_TOKEN="$(openssl rand -hex 32)"; printf \'%s\' "$SMOKE_TOKEN" > "$1"; unset SMOKE_TOKEN', "smoke-token-fixture", tokenPath], {
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(status).toBe(0);
    const bearer = await readFile(tokenPath, "utf8");
    expect(bearer).toMatch(/^[0-9a-f]{64}$/);
    expect(bearer).not.toContain("\n");
    await provisionSmokeRelayPairing({ tokenPath, store });
    expect((await store.load())?.relayToken).toMatch(/^rty_[A-Za-z0-9_-]{32}$/);
  });
});

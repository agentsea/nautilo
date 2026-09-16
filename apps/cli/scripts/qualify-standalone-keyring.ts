import { randomBytes } from "node:crypto";

const { AsyncEntry } = await import("@napi-rs/keyring");

const service = `dev.nautilo.cli.standalone-qualification.${randomBytes(12).toString("hex")}`;
const account = randomBytes(12).toString("hex");
const secret = randomBytes(32).toString("base64url");
const entry = new AsyncEntry(service, account);

let credentialMayExist = false;
let passed = false;
let failureStage: "set" | "read" | "delete" | "absence" | "cleanup" = "set";
try {
  await entry.setPassword(secret);
  credentialMayExist = true;
  failureStage = "read";
  const observed = await entry.getPassword();
  if (observed !== secret) throw new Error("readback");
  failureStage = "delete";
  if (await entry.deleteCredential() !== true) throw new Error("delete");
  credentialMayExist = false;
  failureStage = "absence";
  const absent = await entry.getPassword();
  if (absent !== null && absent !== undefined) throw new Error("absence");
  passed = true;
} catch {
  // Never print native errors: they may contain qualification identifiers.
} finally {
  if (credentialMayExist) {
    try {
      await entry.deleteCredential();
      const remaining = await entry.getPassword();
      credentialMayExist = remaining !== null && remaining !== undefined;
      if (credentialMayExist) failureStage = "cleanup";
    } catch {
      // The fixed failure below makes cleanup uncertainty explicit.
      failureStage = "cleanup";
    }
  }
}

if (!passed || credentialMayExist) {
  process.stderr.write(`Standalone Keychain qualification failed at redacted stage: ${failureStage}.\n`);
  process.exitCode = 2;
} else {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    platform: `${process.platform}-${process.arch}`,
    keychainWriteRead: true,
    keychainDeleteVerified: true,
  })}\n`);
}

import { VaultSchemaError } from "./errors.ts";
import { VAULT_DISK_SCHEMA_VERSION } from "./constants.ts";

import type { VaultDiskEnvelope } from "./disk-types.ts";

export function validateVaultEnvelope(candidate: unknown): VaultDiskEnvelope {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    throw new VaultSchemaError("vault envelope malformed");
  }

  const envelope = candidate as Partial<VaultDiskEnvelope>;

  if (envelope.schema_version !== VAULT_DISK_SCHEMA_VERSION) {
    throw new VaultSchemaError("unsupported persisted schema revision");
  }

  if (
    typeof envelope.config !== "object" ||
    envelope.config === null ||
    envelope.config.encryption_mode === undefined
  ) {
    throw new VaultSchemaError("vault envelope missing encryption config");
  }

  const modeOk =
    envelope.config.encryption_mode === "none" ||
    envelope.config.encryption_mode === "aes_256_gcm";

  if (!modeOk) {
    throw new VaultSchemaError("unknown encryption_mode");
  }

  if (typeof envelope.metadata !== "object" || envelope.metadata === null) {
    throw new VaultSchemaError("vault metadata shape invalid");
  }

  if (typeof envelope.secrets !== "object" || envelope.secrets === null) {
    throw new VaultSchemaError("vault secrets shape invalid");
  }

  const env = envelope as VaultDiskEnvelope;

  /** Ensure sentinel exists when ciphertext mode persisted. */
  if (env.config.encryption_mode === "aes_256_gcm") {
    const sent = env.encryption?.sentinel?.blob;
    const nonce = env.encryption?.sentinel?.n;
    if (typeof sent !== "string" || typeof nonce !== "string") {
      throw new VaultSchemaError("encrypted envelope missing sentinel");
    }
  }

  return env;
}

export function emptyVaultEnvelope(): VaultDiskEnvelope {
  return {
    schema_version: VAULT_DISK_SCHEMA_VERSION,
    config: { encryption_mode: "none" },
    metadata: {},
    secrets: {},
  };
}

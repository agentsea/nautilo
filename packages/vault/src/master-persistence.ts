import { randomBytes, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import argon2 from "argon2";

import { warn } from "@nautilo/logger";

import { VAULT_ARGON2_WRAP } from "./constants.ts";
import { atomicWriteJsonFile } from "./atomic-fs.ts";
import { VaultCryptoError } from "./errors.ts";
import { aesGcmDecrypt, aesGcmEncrypt } from "./payload-crypto.ts";

/** OS keychain grouping for the vault master key (TASK D041 semantics). */
export const VAULT_MASTER_BUN_SERVICE = "nautilo:vault-master-key" as const;

/**
 * Persist and load the AES-256 master key backing Connection ciphertexts.
 */
export interface VaultMasterPersistence {
  persist(installId: string, key: Buffer): Promise<void>;
  load(installId: string, pinUtf8?: string  ): Promise<Buffer | null>;
  loadCandidates?(
    installId: string,
    pinUtf8?: string  ,
  ): Promise<Buffer[]>;
  persistPrevious?(installId: string, key: Buffer): Promise<void>;
  clearPrevious?(installId: string): Promise<void>;
  probeKeychainLikelyUnavailable?(): Promise<boolean>;
}

type BunSecretsApi = {
  set: (options: { name: string; service: string; value: string }) => Promise<void>;
  get: (options: { name: string; service: string }) => Promise<string | null>;
  delete: (options: { name: string; service: string }) => Promise<boolean>;
};

function bunSecretsApi(): BunSecretsApi | undefined {
  const g = globalThis as typeof globalThis & { Bun?: { secrets?: BunSecretsApi } };

  return g.Bun?.secrets;
}

export async function probeBunSecretsRoundTrip(): Promise<boolean> {
  const api = bunSecretsApi();

  if (!api) return false;

  const token = randomUUID();

  const service = `_nautilo_vault_probe_svc_${token}`;
  const name = `_nautilo_vault_probe_nm_${token}`;

  try {
    await api.set({
      name,
      service,
      value: "ok",
    });

    const got = await api.get({
      name,
      service,
    });

    await api.delete({
      name,
      service,
    });

    return got === "ok";
  } catch {
    return false;
  }
}

interface BunMasterEnvelope {
  readonly current_b64: string;
  readonly previous_b64?: string | undefined;
}

function parseBunMasterEnvelope(text: string): BunMasterEnvelope | null {
  try {
    const parsed = JSON.parse(text) as Partial<BunMasterEnvelope>;
    if (typeof parsed.current_b64 === "string") return parsed as BunMasterEnvelope;
  } catch {
    /* Bun.secrets value may be legacy base64 from early D041 work. */
  }

  const legacy = Buffer.from(text, "base64");
  if (legacy.byteLength === 32) {
    return { current_b64: text };
  }
  return null;
}

async function bunGetVaultEnvelope(installId: string): Promise<BunMasterEnvelope | null> {
  const api = bunSecretsApi();

  if (!api) {
    return null;
  }

  try {
    const text = await api.get({
      name: installId,
      service: VAULT_MASTER_BUN_SERVICE,
    });

    return text ? parseBunMasterEnvelope(text) : null;
  } catch {
    return null;
  }
}

function decodeKey(value: string | undefined): Buffer | null {
  if (!value) return null;
  const raw = Buffer.from(value, "base64");
  return raw.byteLength === 32 ? raw : null;
}

async function bunSetVaultEnvelope(
  installId: string,
  envelope: BunMasterEnvelope,
): Promise<void> {
  const api = bunSecretsApi();

  if (!api) {
    throw new VaultCryptoError("Bun.secrets unavailable after probe");
  }

  await api.set({
    name: installId,
    service: VAULT_MASTER_BUN_SERVICE,
    value: JSON.stringify(envelope),
  });
}

async function bunGetVaultCandidates(installId: string): Promise<Buffer[]> {
  const envelope = await bunGetVaultEnvelope(installId);
  if (!envelope) return [];

  return [decodeKey(envelope.current_b64), decodeKey(envelope.previous_b64)].filter(
    (item): item is Buffer => item !== null,
  );
}

async function bunSetVaultKey(installId: string, key: Buffer): Promise<void> {
  if (key.byteLength !== 32) {
    throw new VaultCryptoError("invalid vault master key shape");
  }

  const previous = await bunGetVaultEnvelope(installId);
  await bunSetVaultEnvelope(installId, {
    current_b64: key.toString("base64"),
    previous_b64: previous?.previous_b64,
  });
}

async function bunDeleteVaultKey(installId: string): Promise<void> {
  const api = bunSecretsApi();

  if (!api) {
    return;
  }

  try {
    await api.delete({
      name: installId,
      service: VAULT_MASTER_BUN_SERVICE,
    });
  } catch {
    /* probe cleanup */
  }
}

interface PinEnvelopeV1 {
  readonly version: 1;
  readonly salt_b64: string;
  readonly n: string;
  readonly blob_b64: string;
}

function pinEnvelopePath(vaultDirectory: string): string {
  return join(vaultDirectory, "vault-master-pin-envelope.json");
}

async function unwrapPinEnvelope(
  envelopePath: string,
  pinUtf8: string,
): Promise<Buffer | null> {
  let parsed: PinEnvelopeV1;

  try {
    const txt = await readFile(envelopePath, "utf8");

    parsed = JSON.parse(txt) as PinEnvelopeV1;
  } catch {
    return null;
  }

  if (
    parsed.version !== 1 ||
    typeof parsed.salt_b64 !== "string" ||
    typeof parsed.n !== "string" ||
    typeof parsed.blob_b64 !== "string"
  ) {
    return null;
  }

  const salt = Buffer.from(parsed.salt_b64, "base64");

  const wrappingKey = (await argon2.hash(pinUtf8, {
    type: argon2.argon2id,
    raw: true,
    salt,
    hashLength: VAULT_ARGON2_WRAP.hashLength,
    memoryCost: VAULT_ARGON2_WRAP.memoryCost,
    parallelism: VAULT_ARGON2_WRAP.parallelism,
    timeCost: VAULT_ARGON2_WRAP.timeCost,
  }));

  try {
    return aesGcmDecrypt(wrappingKey, parsed.n, parsed.blob_b64);
  } catch {
    throw new VaultCryptoError(
      "PIN unlock failed — wrong PIN or truncated envelope",
    );
  }
}

async function writePinEnvelope(
  envelopePath: string,
  master: Buffer,

  pinUtf8: string,

): Promise<void> {
  const salt = randomBytes(16);

  const wrappingKey = (await argon2.hash(pinUtf8, {
    type: argon2.argon2id,
    raw: true,
    salt,
    hashLength: VAULT_ARGON2_WRAP.hashLength,
    memoryCost: VAULT_ARGON2_WRAP.memoryCost,
    parallelism: VAULT_ARGON2_WRAP.parallelism,
    timeCost: VAULT_ARGON2_WRAP.timeCost,
  }));

  const packed = aesGcmEncrypt(wrappingKey, master);
  const env: PinEnvelopeV1 = {
    version: 1,
    blob_b64: packed.blobB64,
    salt_b64: salt.toString("base64"),
    n: packed.nonceB64,
  };

  await atomicWriteJsonFile(envelopePath, env);
}

export class MemoryVaultMasterPersistence implements VaultMasterPersistence {
  private _buf: Buffer | undefined;
  private _previous: Buffer | undefined;

  persist(_installId: string, key: Buffer): Promise<void> {
    this._buf = Buffer.from(key);

    return Promise.resolve();
  }

  load(
    _installId: string,
    _pinUtf8?: string  ,
  ): Promise<Buffer | null> {
    return Promise.resolve(this._buf ? Buffer.from(this._buf) : null);
  }

  loadCandidates(
    _installId: string,
    _pinUtf8?: string  ,
  ): Promise<Buffer[]> {
    return Promise.resolve(
      [this._buf, this._previous]
        .filter((item): item is Buffer => item !== undefined)
        .map((item) => Buffer.from(item)),
    );
  }

  persistPrevious(_installId: string, key: Buffer): Promise<void> {
    this._previous = Buffer.from(key);
    return Promise.resolve();
  }

  clearPrevious(_installId: string): Promise<void> {
    this._previous?.fill(0);
    this._previous = undefined;
    return Promise.resolve();
  }

  probeKeychainLikelyUnavailable(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

export class BunOrPinVaultMasterPersistence implements VaultMasterPersistence {
  constructor(private readonly vaultDirectory: string) {}

  async persist(installId: string, key: Buffer): Promise<void> {
    const usable = await probeBunSecretsRoundTrip();

    if (usable) {
      await bunSetVaultKey(installId, key);
      return;
    }

    warn(
      "vault: Bun.secrets probe failed — PIN envelope persistence required when headless",
    );

    throw new VaultCryptoError(
      "no OS keychain — cannot persist master without PIN envelope path",
    );
  }

  async persistWithPin(installId: string, key: Buffer, pinUtf8: string): Promise<void> {
    const usable = await probeBunSecretsRoundTrip();

    if (usable) {
      await bunSetVaultKey(installId, key);
      return;
    }

    await writePinEnvelope(pinEnvelopePath(this.vaultDirectory), key, pinUtf8);
  }

  async load(installId: string, pinUtf8?: string  ): Promise<Buffer | null> {
    const fromBun = (await bunGetVaultCandidates(installId))[0];

    if (fromBun) {
      return fromBun;
    }

    if (!pinUtf8) return null;

    return unwrapPinEnvelope(pinEnvelopePath(this.vaultDirectory), pinUtf8);
  }

  async loadCandidates(
    installId: string,
    pinUtf8?: string  ,
  ): Promise<Buffer[]> {
    const candidates = await bunGetVaultCandidates(installId);
    if (candidates.length > 0) return candidates;

    const fallback = pinUtf8
      ? await unwrapPinEnvelope(pinEnvelopePath(this.vaultDirectory), pinUtf8)
      : null;
    return fallback ? [fallback] : [];
  }

  async persistPrevious(installId: string, key: Buffer): Promise<void> {
    const usable = await probeBunSecretsRoundTrip();
    if (!usable) return;

    const existing = await bunGetVaultEnvelope(installId);
    await bunSetVaultEnvelope(installId, {
      current_b64: existing?.current_b64 ?? key.toString("base64"),
      previous_b64: key.toString("base64"),
    });
  }

  async clearPrevious(installId: string): Promise<void> {
    const existing = await bunGetVaultEnvelope(installId);
    if (!existing) return;

    await bunSetVaultEnvelope(installId, {
      current_b64: existing.current_b64,
    });
  }

  async probeKeychainLikelyUnavailable(): Promise<boolean> {
    return !(await probeBunSecretsRoundTrip());
  }
}

export async function deletePinEnvelopeForTests(vaultDirectory: string): Promise<void> {
  await unlink(pinEnvelopePath(vaultDirectory)).catch(() => {});
}

export async function deleteBunKeyForTests(installId: string): Promise<void> {
  await bunDeleteVaultKey(installId);
}

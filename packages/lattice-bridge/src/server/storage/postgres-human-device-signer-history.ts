import { eq, humanCryptoDevices } from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";

import type {
  ResolveHistoricalHumanObjectAccessGenesisSigner,
} from "./postgres-conversation-crypto-completion.ts";
import type {
  ResolveHistoricalAgentRuntimeSignerManagerAuthority,
} from "./agent-runtime-signer-history.ts";
import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresHandle,
} from "./postgres-lattice-storage.ts";

function one<Row>(rows: readonly Row[]): Row | null {
  if (rows.length > 1) throw new Error("Human device signer history is duplicated");
  return rows[0] ?? null;
}

function bytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError("Human device signer history key is invalid");
  }
  return value.slice();
}

function count(value: unknown): number {
  const result = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError("Human device signer history revision is invalid");
  }
  return result;
}

/** Retained active-or-revoked Human device signing authority. */
export class PostgresHumanDeviceSignerHistory {
  readonly #handle: CryptoPostgresHandle;
  readonly #crypto: LatticeCrypto;

  constructor(input: Readonly<{
    handle: CryptoPostgresHandle;
    crypto: LatticeCrypto;
  }>) {
    assertVerifiedCryptoPostgresHandle(input.handle);
    this.#handle = input.handle;
    this.#crypto = input.crypto;
  }

  async #device(deviceId: string) {
    return one(await executeTypedCryptoQuery(
      this.#handle,
      cryptoTypedDb.select({
        device_id: humanCryptoDevices.deviceId,
        human_id: humanCryptoDevices.humanId,
        signing_public_key: humanCryptoDevices.signingPublicKey,
        state: humanCryptoDevices.state,
        revision: humanCryptoDevices.revision,
      }).from(humanCryptoDevices).where(eq(
        humanCryptoDevices.deviceId,
        deviceId,
      )).limit(2),
    ));
  }

  readonly resolveHistoricalObjectSigner:
    ResolveHistoricalHumanObjectAccessGenesisSigner = async (context) => {
      const row = await this.#device(context.committerDeviceId);
      if (
        row === null
        || (row.state !== "active" && row.state !== "revoked")
        || count(row.revision) < context.hostAuthorizationRevision
      ) return null;
      return Object.freeze({
        ...context,
        committerSigningPublicKey: bytes(row.signing_public_key),
      });
    };

  readonly resolveAgentRuntimeSignerManager:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority = async (context) => {
      const row = await this.#device(context.managerDeviceId);
      if (
        row === null
        || row.human_id !== context.managerHumanId
        || (row.state !== "active" && row.state !== "revoked")
        || count(row.revision) < context.managerAuthorizationRevision
      ) return null;
      const publicKey = bytes(row.signing_public_key);
      const digest = this.#crypto.hash(publicKey);
      const matches = digest.length === context.managerSigningPublicKeyHash.length
        && digest.every((value, index) =>
          value === context.managerSigningPublicKeyHash[index]
        );
      digest.fill(0);
      if (!matches) {
        publicKey.fill(0);
        return null;
      }
      return Object.freeze({
        ...context,
        managerSigningPublicKey: publicKey,
      });
    };
}

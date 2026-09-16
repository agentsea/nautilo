import { randomBytes, timingSafeEqual } from "node:crypto";

const FORMAT_VERSION = 1 as const;
// Reuse the server's established mint-claim-invite token format exactly.
const CLAIM_BYTES = 24;
const MAX_ENVELOPE_BYTES = 8 * 1024;

export const RAILWAY_OWNER_CLAIM_KEYRING_SERVICE =
  "dev.nautilo.cli.railway-owner-claim" as const;

export interface RailwayOwnerClaimKeyringEntry {
  getPassword(): Promise<string | null | undefined>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

interface RailwayOwnerClaimEnvelope {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly launchId: string;
  readonly releaseId: string;
  readonly claim: string;
}

function safeIdentity(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function equal(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function parse(raw: string | null | undefined): RailwayOwnerClaimEnvelope | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (Buffer.byteLength(raw, "utf8") > MAX_ENVELOPE_BYTES) throw new Error("Railway owner claim custody failed");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Railway owner claim custody failed");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Railway owner claim custody failed");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== ["formatVersion", "launchId", "releaseId", "claim"].sort().join("\0")
    || record["formatVersion"] !== FORMAT_VERSION
    || typeof record["launchId"] !== "string" || !safeIdentity(record["launchId"])
    || typeof record["releaseId"] !== "string" || !safeIdentity(record["releaseId"])
    || typeof record["claim"] !== "string" || !/^inv_[A-Za-z0-9_-]{32}$/.test(record["claim"])) {
    throw new Error("Railway owner claim custody failed");
  }
  return value as RailwayOwnerClaimEnvelope;
}

/**
 * The plaintext owner claim belongs only in its own per-launch operating-system
 * credential entry. It is never added to receipt/state JSON or shared with the
 * generated infrastructure-secret envelope.
 */
export class KeyringRailwayOwnerClaimStore {
  readonly #entry: RailwayOwnerClaimKeyringEntry;

  constructor(entry: RailwayOwnerClaimKeyringEntry) {
    this.#entry = entry;
  }

  async getOrCreate(input: {
    readonly launchId: string;
    readonly releaseId: string;
    readonly generate?: () => string;
  }): Promise<string> {
    if (!safeIdentity(input.launchId) || !safeIdentity(input.releaseId)) {
      throw new Error("Railway owner claim custody failed");
    }
    const existing = parse(await this.#entry.getPassword());
    if (existing !== undefined) {
      if (!equal(existing.launchId, input.launchId) || !equal(existing.releaseId, input.releaseId)) {
        throw new Error("Railway owner claim custody failed");
      }
      return existing.claim;
    }
    const claim = input.generate?.() ?? `inv_${randomBytes(CLAIM_BYTES).toString("base64url")}`;
    if (!/^inv_[A-Za-z0-9_-]{32}$/.test(claim)) throw new Error("Railway owner claim custody failed");
    const envelope: RailwayOwnerClaimEnvelope = {
      formatVersion: FORMAT_VERSION,
      launchId: input.launchId,
      releaseId: input.releaseId,
      claim,
    };
    await this.#entry.setPassword(JSON.stringify(envelope));
    const confirmed = parse(await this.#entry.getPassword());
    if (confirmed === undefined || !equal(confirmed.launchId, input.launchId)
      || !equal(confirmed.releaseId, input.releaseId) || !equal(confirmed.claim, claim)) {
      throw new Error("Railway owner claim custody failed");
    }
    return confirmed.claim;
  }

  /** Replaces a stale/expired controller claim before target installation. */
  async rotate(input: {
    readonly launchId: string;
    readonly releaseId: string;
    readonly generate?: () => string;
  }): Promise<string> {
    if (!safeIdentity(input.launchId) || !safeIdentity(input.releaseId)) {
      throw new Error("Railway owner claim custody failed");
    }
    const claim = input.generate?.() ?? `inv_${randomBytes(CLAIM_BYTES).toString("base64url")}`;
    if (!/^inv_[A-Za-z0-9_-]{32}$/.test(claim)) throw new Error("Railway owner claim custody failed");
    const envelope: RailwayOwnerClaimEnvelope = {
      formatVersion: FORMAT_VERSION,
      launchId: input.launchId,
      releaseId: input.releaseId,
      claim,
    };
    await this.#entry.setPassword(JSON.stringify(envelope));
    const confirmed = parse(await this.#entry.getPassword());
    if (confirmed === undefined || !equal(confirmed.launchId, input.launchId)
      || !equal(confirmed.releaseId, input.releaseId) || !equal(confirmed.claim, claim)) {
      throw new Error("Railway owner claim custody failed");
    }
    return confirmed.claim;
  }

  async clear(): Promise<void> {
    await this.#entry.deleteCredential();
  }
}

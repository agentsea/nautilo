import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

export const COMPOSE_OWNER_CLAIM_KEYRING_SERVICE =
  "dev.nautilo.cli.compose-owner-claim" as const;

const FORMAT_VERSION = 1 as const;
const CLAIM_BYTES = 24;
const MAX_ENVELOPE_BYTES = 8 * 1024;

export interface ComposeOwnerClaimKeyringEntry {
  getPassword(): Promise<string | null | undefined>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

interface ComposeOwnerClaimEnvelopeBase {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly profileName: string;
  readonly instanceId: string;
  readonly controlFingerprint: string;
  readonly claim: string;
}

type ComposeOwnerClaimEnvelope =
  | (ComposeOwnerClaimEnvelopeBase & {
      readonly mode: "claim";
      readonly seedResultPath?: never;
    })
  | (ComposeOwnerClaimEnvelopeBase & {
      readonly mode: "owner-config";
      readonly seedResultPath: string;
    });

interface ComposeOwnerClaimIdentityBase {
  readonly profileName: string;
  readonly instanceId: string;
  /** SHA-256 of the canonical Compose control identity. */
  readonly controlFingerprint: string;
}

export type ComposeOwnerClaimIdentity =
  | (ComposeOwnerClaimIdentityBase & {
      readonly mode: "claim";
      readonly seedResultPath?: never;
    })
  | (ComposeOwnerClaimIdentityBase & {
      readonly mode: "owner-config";
      readonly seedResultPath: string;
    });

export type ComposeOwnerClaimControlIdentity =
  | {
      readonly transport: "local";
      readonly instanceId: string;
      readonly projectName: string;
    }
  | {
      readonly transport: "remote";
      readonly instanceId: string;
      readonly projectName: string;
      readonly sshHost: string;
      readonly sshUser: string;
      readonly sshPort: number;
      readonly remoteRoot: string;
    };

function safeProfileName(value: string): boolean {
  return value.length > 0 && value.length <= 256
    && [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    });
}

function safeInstanceId(value: string): boolean {
  return /^[a-z0-9-]{0,16}$/.test(value);
}

function safeFingerprint(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function safeClaim(value: string): boolean {
  return /^inv_[A-Za-z0-9_-]{32}$/.test(value);
}

function safeResultPath(value: string): boolean {
  return isAbsolute(value) && resolve(value) === value;
}

function safeControlText(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength
    && [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    });
}

function equal(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function assertIdentity(identity: ComposeOwnerClaimIdentity): void {
  if (!safeProfileName(identity.profileName)
    || !safeInstanceId(identity.instanceId)
    || !safeFingerprint(identity.controlFingerprint)
    || (identity.mode !== "claim" && identity.mode !== "owner-config")
    || (identity.mode === "claim" && identity.seedResultPath !== undefined)
    || (identity.mode === "owner-config"
      && (identity.seedResultPath === undefined || !safeResultPath(identity.seedResultPath)))) {
    throw new Error("Compose owner claim custody failed");
  }
}

function matchesIdentity(
  envelope: ComposeOwnerClaimEnvelope,
  identity: ComposeOwnerClaimIdentity,
): boolean {
  return equal(envelope.profileName, identity.profileName)
    && equal(envelope.instanceId, identity.instanceId)
    && equal(envelope.controlFingerprint, identity.controlFingerprint)
    && envelope.mode === identity.mode
    && (envelope.mode === "claim"
      || (identity.mode === "owner-config"
        && equal(envelope.seedResultPath, identity.seedResultPath)));
}

function parse(raw: string | null | undefined): ComposeOwnerClaimEnvelope | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (Buffer.byteLength(raw, "utf8") > MAX_ENVELOPE_BYTES) {
    throw new Error("Compose owner claim custody failed");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Compose owner claim custody failed");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Compose owner claim custody failed");
  }
  const record = value as Record<string, unknown>;
  const commonKeys = [
    "claim",
    "controlFingerprint",
    "formatVersion",
    "instanceId",
    "mode",
    "profileName",
  ];
  if (record["mode"] !== "claim" && record["mode"] !== "owner-config") {
    throw new Error("Compose owner claim custody failed");
  }
  const expectedKeys = record["mode"] === "claim"
    ? commonKeys
    : [...commonKeys, "seedResultPath"];
  if (Object.keys(record).sort().join("\0") !== expectedKeys.sort().join("\0")
    || record["formatVersion"] !== FORMAT_VERSION
    || typeof record["profileName"] !== "string"
    || typeof record["instanceId"] !== "string"
    || typeof record["controlFingerprint"] !== "string"
    || typeof record["claim"] !== "string"
    || (record["mode"] === "owner-config" && typeof record["seedResultPath"] !== "string")) {
    throw new Error("Compose owner claim custody failed");
  }
  const envelope = value as ComposeOwnerClaimEnvelope;
  assertIdentity(envelope);
  if (!safeClaim(envelope.claim)) throw new Error("Compose owner claim custody failed");
  return envelope;
}

function newClaim(generate?: () => string): string {
  const claim = generate?.() ?? `inv_${randomBytes(CLAIM_BYTES).toString("base64url")}`;
  if (!safeClaim(claim)) throw new Error("Compose owner claim custody failed");
  return claim;
}

/**
 * A profile's Keychain account is a deterministic opaque name. The plaintext
 * profile still lives inside the credential envelope so reuse remains exact,
 * while account metadata does not disclose a customer deployment name.
 */
export function composeOwnerClaimKeyringAccount(profileName: string): string {
  if (!safeProfileName(profileName)) throw new Error("Compose owner claim custody failed");
  return createHash("sha256").update(profileName, "utf8").digest("hex");
}

/**
 * Hash the stable Compose control identity, not the public target URL. Remote
 * SSH lifecycle calls can all use the same loopback origin, so origin alone
 * would let a claim for one host/root be reused against another deployment.
 */
export function composeOwnerClaimControlFingerprint(
  identity: ComposeOwnerClaimControlIdentity,
): string {
  if (!safeInstanceId(identity.instanceId) || !safeControlText(identity.projectName, 256)) {
    throw new Error("Compose owner claim control identity is invalid");
  }
  if (identity.transport === "remote") {
    if (!safeControlText(identity.sshHost, 255)
      || !safeControlText(identity.sshUser, 255)
      || !Number.isInteger(identity.sshPort) || identity.sshPort < 1 || identity.sshPort > 65_535
      || !identity.remoteRoot.startsWith("/") || !safeControlText(identity.remoteRoot, 1024)) {
      throw new Error("Compose owner claim control identity is invalid");
    }
  }
  // Property order is intentionally literal and versioned: this is a stable
  // comparison identity, not an ad-hoc object serialization.
  const canonical = identity.transport === "local"
    ? JSON.stringify({ v: 1, transport: "local", instanceId: identity.instanceId, projectName: identity.projectName })
    : JSON.stringify({
        v: 1,
        transport: "remote",
        instanceId: identity.instanceId,
        projectName: identity.projectName,
        sshHost: identity.sshHost,
        sshUser: identity.sshUser,
        sshPort: identity.sshPort,
        remoteRoot: identity.remoteRoot,
      });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Compose-specific plaintext claim custody. It is deliberately not a Railway
 * launch envelope: profile, instance, control identity, and owner mode must all match
 * before an interrupted server-admin workflow can reuse a capability.
 */
export class KeyringComposeOwnerClaimStore {
  readonly #entry: ComposeOwnerClaimKeyringEntry;

  constructor(entry: ComposeOwnerClaimKeyringEntry) {
    this.#entry = entry;
  }

  async getOrCreate(
    identity: ComposeOwnerClaimIdentity,
    generate?: () => string,
  ): Promise<string> {
    assertIdentity(identity);
    const existing = parse(await this.#entry.getPassword());
    if (existing !== undefined) {
      if (!matchesIdentity(existing, identity)) {
        throw new Error("Compose owner claim custody failed");
      }
      return existing.claim;
    }
    return this.#write(identity, newClaim(generate));
  }

  async rotate(
    identity: ComposeOwnerClaimIdentity,
    generate?: () => string,
  ): Promise<string> {
    assertIdentity(identity);
    return this.#write(identity, newClaim(generate));
  }

  async clear(): Promise<void> {
    await this.#entry.deleteCredential();
  }

  async #write(identity: ComposeOwnerClaimIdentity, claim: string): Promise<string> {
    const common: ComposeOwnerClaimEnvelopeBase = {
      formatVersion: FORMAT_VERSION,
      profileName: identity.profileName,
      instanceId: identity.instanceId,
      controlFingerprint: identity.controlFingerprint,
      claim,
    };
    const envelope: ComposeOwnerClaimEnvelope = identity.mode === "claim"
      ? { ...common, mode: "claim" }
      : { ...common, mode: "owner-config", seedResultPath: identity.seedResultPath };
    await this.#entry.setPassword(JSON.stringify(envelope));
    const confirmed = parse(await this.#entry.getPassword());
    if (confirmed === undefined || !matchesIdentity(confirmed, identity)
      || !equal(confirmed.claim, claim)) {
      throw new Error("Compose owner claim custody failed");
    }
    return confirmed.claim;
  }
}

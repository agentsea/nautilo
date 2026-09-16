import { randomBytes, timingSafeEqual } from "node:crypto";

import type {
  RailwayBootstrapHandoffOutput,
  RailwayGeneratedSecretSlotName,
} from "@nautilo/railway-hosting";

const FORMAT_VERSION = 2 as const;
const SECRET_BYTES = 32;
const MAX_ENVELOPE_BYTES = 16 * 1024;

export const RAILWAY_LAUNCH_SECRET_KEYRING_SERVICE =
  "dev.nautilo.cli.railway-launch" as const;

export const RAILWAY_GENERATED_SECRET_SLOTS = [
  "app-postgres-superuser-password",
  "app-nautilo-db-password",
  "app-nautilo-agent-db-password",
  "app-nautilo-crypto-db-password",
  "logto-postgres-superuser-password",
  "logto-db-password",
  "logto-bootstrap-handoff-token",
  "nautilo-bootstrap-token",
  "nautilo-logto-email-webhook-secret",
] as const satisfies readonly RailwayGeneratedSecretSlotName[];

export interface RailwayLaunchSecretKeyringEntry {
  getPassword(): Promise<string | null | undefined>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

export interface RailwayBootstrapOutputBinding {
  readonly launchId: string;
  readonly releaseId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly domainId: string;
}

interface RailwayLaunchSecretEnvelopeV1 {
  readonly formatVersion: 1;
  readonly launchId: string;
  readonly releaseId: string;
  readonly secrets: Readonly<Record<RailwayGeneratedSecretSlotName, string>>;
}

interface RailwayLaunchSecretEnvelopeV2 {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly launchId: string;
  readonly releaseId: string;
  readonly secrets: Readonly<Record<RailwayGeneratedSecretSlotName, string>>;
  readonly bootstrap?: { readonly binding: RailwayBootstrapOutputBinding; readonly output: RailwayBootstrapHandoffOutput } | undefined;
}

type RailwayLaunchSecretEnvelope = RailwayLaunchSecretEnvelopeV1 | RailwayLaunchSecretEnvelopeV2;

const BOOTSTRAP_KEYS = [
  "logto-workbench-app-id", "logto-tui-app-id", "logto-tui-loopback-app-id", "logto-desktop-app-id",
  "logto-mobile-app-id", "logto-mobile-web-app-id", "logto-m2m-app-id", "logto-m2m-app-secret", "logto-resource",
] as const satisfies readonly (keyof RailwayBootstrapHandoffOutput)[];

function safeIdentity(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function secretMap(envelope: RailwayLaunchSecretEnvelope): ReadonlyMap<RailwayGeneratedSecretSlotName, string> {
  return new Map(RAILWAY_GENERATED_SECRET_SLOTS.map((slot) => [slot, envelope.secrets[slot]]));
}

function validBootstrapBinding(value: unknown): value is RailwayBootstrapOutputBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = ["launchId", "releaseId", "projectId", "environmentId", "serviceId", "domainId"] as const;
  return Object.keys(record).sort().join("\0") === [...keys].sort().join("\0")
    && keys.every((key) => typeof record[key] === "string" && safeIdentity(record[key]));
}

function validBootstrapOutput(value: unknown): value is RailwayBootstrapHandoffOutput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join("\0") === [...BOOTSTRAP_KEYS].sort().join("\0")
    && BOOTSTRAP_KEYS.every((key) => typeof record[key] === "string" && Buffer.byteLength(record[key], "utf8") >= 1
      && Buffer.byteLength(record[key], "utf8") <= 2048 && record[key].trim() === record[key]);
}

function parseEnvelope(raw: string | null | undefined): RailwayLaunchSecretEnvelope | null {
  if (raw === null || raw === undefined) return null;
  if (Buffer.byteLength(raw, "utf8") > MAX_ENVELOPE_BYTES) throw new Error("Railway launch secret custody failed");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Railway launch secret custody failed");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Railway launch secret custody failed");
  }
  const record = value as Record<string, unknown>;
  const version = record["formatVersion"];
  const keys = version === 1 ? ["formatVersion", "launchId", "releaseId", "secrets"]
    : ["formatVersion", "launchId", "releaseId", "secrets", ...(record["bootstrap"] === undefined ? [] : ["bootstrap"])];
  if (Object.keys(record).sort().join("\0") !== keys.sort().join("\0")
    || (version !== 1 && version !== FORMAT_VERSION)
    || typeof record["launchId"] !== "string" || !safeIdentity(record["launchId"])
    || typeof record["releaseId"] !== "string" || !safeIdentity(record["releaseId"])
    || typeof record["secrets"] !== "object" || record["secrets"] === null || Array.isArray(record["secrets"])) {
    throw new Error("Railway launch secret custody failed");
  }
  const secrets = record["secrets"] as Record<string, unknown>;
  if (Object.keys(secrets).sort().join("\0") !== [...RAILWAY_GENERATED_SECRET_SLOTS].sort().join("\0")) {
    throw new Error("Railway launch secret custody failed");
  }
  for (const slot of RAILWAY_GENERATED_SECRET_SLOTS) {
    const secret = secrets[slot];
    if (typeof secret !== "string" || secret.length < 32 || secret.length > 256) {
      throw new Error("Railway launch secret custody failed");
    }
  }
  if (version === FORMAT_VERSION && record["bootstrap"] !== undefined) {
    const bootstrap = record["bootstrap"];
    if (typeof bootstrap !== "object" || bootstrap === null || Array.isArray(bootstrap)) throw new Error("Railway launch secret custody failed");
    const child = bootstrap as Record<string, unknown>;
    if (Object.keys(child).sort().join("\0") !== ["binding", "output"].sort().join("\0")
      || !validBootstrapBinding(child["binding"]) || !validBootstrapOutput(child["output"])) throw new Error("Railway launch secret custody failed");
  }
  return value as RailwayLaunchSecretEnvelope;
}

function serializeEnvelope(envelope: RailwayLaunchSecretEnvelope): string {
  const raw = JSON.stringify(envelope);
  if (Buffer.byteLength(raw, "utf8") > MAX_ENVELOPE_BYTES) {
    throw new Error("Railway launch secret custody failed");
  }
  return raw;
}

function same(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Generated stack credentials live in the operating-system credential vault,
 * never Nautilo's application vault or a filesystem checkpoint. One envelope
 * is bound to one launch and immutable release so an interrupted deploy can
 * resume with exactly the same database credentials.
 */
export class KeyringRailwayLaunchSecretStore {
  readonly #entry: RailwayLaunchSecretKeyringEntry;

  constructor(entry: RailwayLaunchSecretKeyringEntry) {
    this.#entry = entry;
  }

  /** Read existing launch custody only; never mint replacement bootstrap authority. */
  async load(input: {
    readonly launchId: string;
    readonly releaseId: string;
  }): Promise<ReadonlyMap<RailwayGeneratedSecretSlotName, string> | undefined> {
    if (!safeIdentity(input.launchId) || !safeIdentity(input.releaseId)) {
      throw new Error("Railway launch secret custody failed");
    }
    const existing = parseEnvelope(await this.#entry.getPassword());
    if (existing === null) return undefined;
    if (!same(existing.launchId, input.launchId) || !same(existing.releaseId, input.releaseId)) {
      throw new Error("Railway launch secret custody failed");
    }
    return secretMap(existing);
  }

  async getOrCreate(input: {
    readonly launchId: string;
    readonly releaseId: string;
  }): Promise<ReadonlyMap<RailwayGeneratedSecretSlotName, string>> {
    if (!safeIdentity(input.launchId) || !safeIdentity(input.releaseId)) {
      throw new Error("Railway launch secret custody failed");
    }
    const existing = parseEnvelope(await this.#entry.getPassword());
    if (existing !== null) {
      if (!same(existing.launchId, input.launchId) || !same(existing.releaseId, input.releaseId)) {
        throw new Error("Railway launch secret custody failed");
      }
      return secretMap(existing);
    }
    const secrets = Object.fromEntries(RAILWAY_GENERATED_SECRET_SLOTS.map((slot) => [
      slot,
      randomBytes(SECRET_BYTES).toString("base64url"),
    ])) as Record<RailwayGeneratedSecretSlotName, string>;
    const envelope: RailwayLaunchSecretEnvelopeV2 = {
      formatVersion: FORMAT_VERSION,
      launchId: input.launchId,
      releaseId: input.releaseId,
      secrets,
    };
    await this.#entry.setPassword(serializeEnvelope(envelope));
    const confirmed = parseEnvelope(await this.#entry.getPassword());
    if (confirmed === null || !same(confirmed.launchId, input.launchId)
      || !same(confirmed.releaseId, input.releaseId)) {
      throw new Error("Railway launch secret custody failed");
    }
    return secretMap(confirmed);
  }

  /**
   * Adopt provider-generated template values without ever minting replacements.
   * The caller has already persisted the non-secret exact-resource receipt.
   */
  async storeGeneratedSecrets(input: {
    readonly launchId: string;
    readonly releaseId: string;
    readonly secrets: ReadonlyMap<RailwayGeneratedSecretSlotName, string>;
  }): Promise<void> {
    if (!safeIdentity(input.launchId) || !safeIdentity(input.releaseId)
      || input.secrets.size !== RAILWAY_GENERATED_SECRET_SLOTS.length
      || RAILWAY_GENERATED_SECRET_SLOTS.some((slot) => {
        const value = input.secrets.get(slot);
        return value === undefined || value.length < 32 || value.length > 256;
      })) throw new Error("Railway launch secret custody failed");
    const intendedSecrets = Object.fromEntries(
      RAILWAY_GENERATED_SECRET_SLOTS.map((slot) => [slot, input.secrets.get(slot)!]),
    ) as Record<RailwayGeneratedSecretSlotName, string>;
    const existing = parseEnvelope(await this.#entry.getPassword());
    if (existing !== null) {
      if (!same(existing.launchId, input.launchId) || !same(existing.releaseId, input.releaseId)
        || RAILWAY_GENERATED_SECRET_SLOTS.some((slot) => !same(existing.secrets[slot], intendedSecrets[slot]))) {
        throw new Error("Railway launch secret custody failed");
      }
      return;
    }
    const envelope: RailwayLaunchSecretEnvelopeV2 = {
      formatVersion: FORMAT_VERSION,
      launchId: input.launchId,
      releaseId: input.releaseId,
      secrets: intendedSecrets,
    };
    await this.#entry.setPassword(serializeEnvelope(envelope));
    const confirmed = parseEnvelope(await this.#entry.getPassword());
    if (confirmed === null || !same(confirmed.launchId, input.launchId) || !same(confirmed.releaseId, input.releaseId)
      || RAILWAY_GENERATED_SECRET_SLOTS.some((slot) => !same(confirmed.secrets[slot], intendedSecrets[slot]))) {
      throw new Error("Railway launch secret custody failed");
    }
  }

  async storeBootstrapOutputs(binding: RailwayBootstrapOutputBinding, output: RailwayBootstrapHandoffOutput): Promise<void> {
    if (!validBootstrapBinding(binding) || !validBootstrapOutput(output)) throw new Error("Railway launch secret custody failed");
    const existing = parseEnvelope(await this.#entry.getPassword());
    if (existing === null || !same(existing.launchId, binding.launchId) || !same(existing.releaseId, binding.releaseId)) {
      throw new Error("Railway launch secret custody failed");
    }
    const intended = { binding: structuredClone(binding), output: structuredClone(output) };
    if (existing.formatVersion === 2 && existing.bootstrap !== undefined) {
      if (JSON.stringify(existing.bootstrap) !== JSON.stringify(intended)) throw new Error("Railway launch secret custody failed");
      return;
    }
    const next: RailwayLaunchSecretEnvelopeV2 = { ...existing, formatVersion: 2, bootstrap: intended };
    await this.#entry.setPassword(serializeEnvelope(next));
    const confirmed = parseEnvelope(await this.#entry.getPassword());
    if (confirmed?.formatVersion !== 2 || JSON.stringify(confirmed.bootstrap) !== JSON.stringify(intended)) {
      throw new Error("Railway launch secret custody failed");
    }
  }

  async loadBootstrapOutputs(binding: RailwayBootstrapOutputBinding): Promise<RailwayBootstrapHandoffOutput | undefined> {
    if (!validBootstrapBinding(binding)) throw new Error("Railway launch secret custody failed");
    const existing = parseEnvelope(await this.#entry.getPassword());
    if (existing === null || !same(existing.launchId, binding.launchId) || !same(existing.releaseId, binding.releaseId)) {
      throw new Error("Railway launch secret custody failed");
    }
    if (existing.formatVersion === 1 || existing.bootstrap === undefined) return undefined;
    if (JSON.stringify(existing.bootstrap.binding) !== JSON.stringify(binding)) throw new Error("Railway launch secret custody failed");
    return structuredClone(existing.bootstrap.output);
  }

  /**
   * Copy or rebind an exact V2 envelope before launch promotion. Lost writes
   * recover by observing the byte-identical target; source custody is retained.
   */
  async promoteTo(input: {
    readonly source: RailwayBootstrapOutputBinding;
    readonly target: RailwayBootstrapOutputBinding;
    readonly targetStore: KeyringRailwayLaunchSecretStore;
  }): Promise<void> {
    if (!validBootstrapBinding(input.source) || !validBootstrapBinding(input.target)) failCustody();
    const source = parseEnvelope(await this.#entry.getPassword());
    const targetExisting = parseEnvelope(await input.targetStore.#entry.getPassword());
    if (targetExisting !== null) {
      const exactTarget = targetExisting.formatVersion === 2
        && same(targetExisting.launchId, input.target.launchId) && same(targetExisting.releaseId, input.target.releaseId)
        && targetExisting.bootstrap !== undefined
        && JSON.stringify(targetExisting.bootstrap.binding) === JSON.stringify(input.target)
        && (input.targetStore === this || source?.formatVersion === 2 && source.bootstrap !== undefined
          && JSON.stringify(targetExisting.secrets) === JSON.stringify(source.secrets)
          && JSON.stringify(targetExisting.bootstrap.output) === JSON.stringify(source.bootstrap.output));
      if (exactTarget) return;
      if (input.targetStore !== this) failCustody();
    }
    if (source?.formatVersion !== 2 || source.bootstrap === undefined
      || !same(source.launchId, input.source.launchId) || !same(source.releaseId, input.source.releaseId)
      || JSON.stringify(source.bootstrap.binding) !== JSON.stringify(input.source)) failCustody();
    const next: RailwayLaunchSecretEnvelopeV2 = { ...source, launchId: input.target.launchId, releaseId: input.target.releaseId,
      bootstrap: { binding: structuredClone(input.target), output: structuredClone(source.bootstrap.output) } };
    await input.targetStore.#entry.setPassword(serializeEnvelope(next));
    const confirmed = parseEnvelope(await input.targetStore.#entry.getPassword());
    if (confirmed?.formatVersion !== 2 || !same(confirmed.launchId, input.target.launchId)
      || !same(confirmed.releaseId, input.target.releaseId)
      || JSON.stringify(confirmed.bootstrap) !== JSON.stringify(next.bootstrap)
      || JSON.stringify(confirmed.secrets) !== JSON.stringify(source.secrets)) failCustody();
  }

  async clear(): Promise<void> {
    await this.#entry.deleteCredential();
  }
}

function failCustody(): never { throw new Error("Railway launch secret custody failed"); }

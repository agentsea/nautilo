import { timingSafeEqual } from "node:crypto";

import { KEY_REGISTRY, type KeyDefinition } from "@nautilo/config-guard";

import {
  RAILWAY_RUNTIME_PROVIDERS,
  type RailwayRuntimeProvider,
} from "./host-provider-config";

const FORMAT_VERSION = 1 as const;
const MAX_ENVELOPE_BYTES = 32 * 1024;

export const RAILWAY_PROVIDER_CUSTODY_KEYRING_SERVICE =
  "dev.nautilo.cli.railway-provider-custody" as const;

export interface RailwayProviderCustodyKeyringEntry {
  getPassword(): Promise<string | null | undefined>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

export type RailwayProviderCustody = ReadonlyMap<RailwayRuntimeProvider, string>;

interface RailwayProviderCustodyEnvelope {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly launchId: string;
  readonly releaseId: string;
  readonly providers: Readonly<Partial<Record<RailwayRuntimeProvider, string>>>;
}

const providerSet = new Set<string>(RAILWAY_RUNTIME_PROVIDERS);
const providerDefinitions = new Map<RailwayRuntimeProvider, KeyDefinition>(
  KEY_REGISTRY.flatMap((definition) => providerSet.has(definition.id)
    ? [[definition.id as RailwayRuntimeProvider, definition] as const]
    : []),
);

function safeIdentity(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function same(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function fail(): never {
  throw new Error("Railway provider custody failed");
}

function parseProviders(value: unknown): RailwayProviderCustody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  const providers = new Map<RailwayRuntimeProvider, string>();
  for (const [provider, secret] of Object.entries(record)) {
    if (!providerSet.has(provider) || typeof secret !== "string") fail();
    const definition = providerDefinitions.get(provider as RailwayRuntimeProvider);
    if (definition === undefined || secret.trim() !== secret || !definition.formatCheck(secret)) fail();
    providers.set(provider as RailwayRuntimeProvider, secret);
  }
  return providers;
}

function parseEnvelope(raw: string | null | undefined): RailwayProviderCustodyEnvelope | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (Buffer.byteLength(raw, "utf8") > MAX_ENVELOPE_BYTES) fail();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== ["formatVersion", "launchId", "releaseId", "providers"].sort().join("\0")
    || record["formatVersion"] !== FORMAT_VERSION
    || typeof record["launchId"] !== "string" || !safeIdentity(record["launchId"])
    || typeof record["releaseId"] !== "string" || !safeIdentity(record["releaseId"])) {
    fail();
  }
  const providers = parseProviders(record["providers"]);
  return {
    formatVersion: FORMAT_VERSION,
    launchId: record["launchId"],
    releaseId: record["releaseId"],
    providers: Object.fromEntries(providers),
  };
}

function custodyMap(envelope: RailwayProviderCustodyEnvelope): RailwayProviderCustody {
  return parseProviders(envelope.providers);
}

function equalCustody(left: RailwayProviderCustody, right: RailwayProviderCustody): boolean {
  return left.size === right.size && [...left].every(([provider, value]) => {
    const other = right.get(provider);
    return other !== undefined && same(value, other);
  });
}

function assertIdentity(input: { readonly launchId: string; readonly releaseId: string }): void {
  if (!safeIdentity(input.launchId) || !safeIdentity(input.releaseId)) fail();
}

/**
 * Provider keys are intentionally separate from generated infrastructure
 * credentials. This temporary envelope is one launch/release only and never
 * serializes into the Railway receipt or launch state.
 */
export class KeyringRailwayProviderCustodyStore {
  readonly #entry: RailwayProviderCustodyKeyringEntry;

  constructor(entry: RailwayProviderCustodyKeyringEntry) {
    this.#entry = entry;
  }

  async load(input: {
    readonly launchId: string;
    readonly releaseId: string;
  }): Promise<RailwayProviderCustody | undefined> {
    assertIdentity(input);
    const envelope = parseEnvelope(await this.#entry.getPassword());
    if (envelope === undefined) return undefined;
    if (!same(envelope.launchId, input.launchId) || !same(envelope.releaseId, input.releaseId)) fail();
    return custodyMap(envelope);
  }

  /** Write once, then read back and compare exact values before use. */
  async writeOrConfirm(input: {
    readonly launchId: string;
    readonly releaseId: string;
    readonly providers: RailwayProviderCustody;
  }): Promise<RailwayProviderCustody> {
    assertIdentity(input);
    const requested = parseProviders(Object.fromEntries(input.providers));
    const existing = await this.load(input);
    if (existing !== undefined) {
      if (!equalCustody(existing, requested)) fail();
      return existing;
    }
    const envelope: RailwayProviderCustodyEnvelope = {
      formatVersion: FORMAT_VERSION,
      launchId: input.launchId,
      releaseId: input.releaseId,
      providers: Object.fromEntries(requested),
    };
    await this.#entry.setPassword(JSON.stringify(envelope));
    const confirmed = await this.load(input);
    if (confirmed === undefined || !equalCustody(confirmed, requested)) fail();
    return confirmed;
  }

  /** Reject a supplied repair source that disagrees with existing custody. */
  assertCompatible(existing: RailwayProviderCustody, candidate: RailwayProviderCustody): void {
    for (const [provider, value] of candidate) {
      const retained = existing.get(provider);
      if (retained !== undefined && !same(retained, value)) fail();
    }
  }

  /** Response-loss-safe day-two custody rotation; the source is never cleared here. */
  async promoteTo(input: {
    readonly source: { readonly launchId: string; readonly releaseId: string };
    readonly target: { readonly launchId: string; readonly releaseId: string };
    readonly targetStore: KeyringRailwayProviderCustodyStore;
  }): Promise<void> {
    assertIdentity(input.source); assertIdentity(input.target);
    const sourceEnvelope = parseEnvelope(await this.#entry.getPassword());
    const targetEnvelope = parseEnvelope(await input.targetStore.#entry.getPassword());
    if (targetEnvelope !== undefined && same(targetEnvelope.launchId, input.target.launchId)
      && same(targetEnvelope.releaseId, input.target.releaseId)
      && (input.targetStore === this || sourceEnvelope !== undefined
        && equalCustody(custodyMap(targetEnvelope), custodyMap(sourceEnvelope)))) return;
    if (targetEnvelope !== undefined && input.targetStore !== this) fail();
    if (sourceEnvelope === undefined || !same(sourceEnvelope.launchId, input.source.launchId)
      || !same(sourceEnvelope.releaseId, input.source.releaseId)) fail();
    const next: RailwayProviderCustodyEnvelope = { ...sourceEnvelope,
      launchId: input.target.launchId, releaseId: input.target.releaseId };
    await input.targetStore.#entry.setPassword(JSON.stringify(next));
    const confirmed = parseEnvelope(await input.targetStore.#entry.getPassword());
    if (confirmed === undefined || !same(confirmed.launchId, input.target.launchId)
      || !same(confirmed.releaseId, input.target.releaseId)
      || !equalCustody(custodyMap(confirmed), custodyMap(sourceEnvelope))) fail();
  }

  async clear(): Promise<void> {
    await this.#entry.deleteCredential();
  }
}

/** Active Railway launches retain provider custody for exact day-two maintenance; destroy is the sole erasure path. */
export function providerCustodyMayBeErased(workflowStage: string | undefined): boolean {
  void workflowStage;
  return false;
}

export function providerCustodyHasExactly(
  custody: RailwayProviderCustody,
  providers: readonly string[],
): boolean {
  return custody.size === providers.length && providers.every((provider) => custody.has(provider as RailwayRuntimeProvider));
}

import * as nodePath from "node:path";
import { isCanonicalNautiloInstanceId } from "@nautilo/config";
import {
  createStructuredSshStorage,
  hasExactKeys,
  isUtcIso,
  parseSshCapability,
  parseSshCapabilityTools,
  parseSshCapabilitySubject,
  sameSshCapabilitySubject,
  SSH_CAPABILITY_STORE_VERSION,
  SSH_CAPABILITY_VERSION,
  type SshCapability,
  type SshCapabilityTools,
  type SshCapabilitySubject,
  type StructuredSshStorage,
  type StructuredSshStorageDependencies,
} from "./contracts.ts";

interface SshCapabilityEnvelope {
  readonly version: typeof SSH_CAPABILITY_STORE_VERSION;
  readonly instanceId: string;
  /** Electron-local URL-derived scope; never relay or server authority. */
  readonly serverBindingId: string;
  readonly revision: number;
  readonly capabilities: readonly SshCapability[];
  readonly updatedAt: string;
}

const MAX_REVISION = 2 ** 31 - 1;
const SERVER_BINDING = /^ssh-server-binding-[A-Za-z0-9_-]{16,128}$/;
const serializedTailByFilePath = new Map<string, Promise<void>>();

export interface SshCapabilityMutation {
  readonly subject: SshCapabilitySubject;
  readonly expectedRevision: number;
}

export interface SshCapabilityDesktopSessionSelection {
  readonly instanceId: string;
  readonly userId: string;
  readonly relayId: string;
  readonly desktopSessionId: string;
}

export interface EnableSshCapability extends SshCapabilityMutation {
  readonly tools: SshCapabilityTools;
}

export interface UpdateSshCapability extends SshCapabilityMutation {
  readonly enabled?: boolean;
  readonly tools?: SshCapabilityTools;
}

export type SshCapabilityStoreErrorCode =
  | "store_unavailable"
  | "store_corrupt"
  | "store_instance_mismatch"
  | "store_server_mismatch"
  | "invalid_capability"
  | "capability_unavailable"
  | "capability_subject_mismatch"
  | "capability_revoked"
  | "capability_revision_mismatch"
  | "capability_revision_exhausted";

export type SshCapabilityStoreResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: SshCapabilityStoreErrorCode; readonly message: string };

export interface SshCapabilityStoreOptions {
  readonly instanceId: string;
  readonly serverBindingId: string;
  readonly filePath: string;
  readonly storage?: StructuredSshStorage;
  readonly storageDependencies?: StructuredSshStorageDependencies;
  readonly clock?: () => Date;
}

function failed<T>(code: SshCapabilityStoreErrorCode, message: string): SshCapabilityStoreResult<T> {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_REVISION;
}

function nextRevision(revision: number): number | null {
  return revision < MAX_REVISION ? revision + 1 : null;
}

function isMutation(value: unknown): value is SshCapabilityMutation {
  return isRecord(value)
    && hasExactKeys(value, ["subject", "expectedRevision"])
    && parseSshCapabilitySubject(value["subject"]) !== null
    && isRevision(value["expectedRevision"]);
}

function isDesktopSessionSelection(value: unknown): value is SshCapabilityDesktopSessionSelection {
  return isRecord(value)
    && hasExactKeys(value, ["instanceId", "userId", "relayId", "desktopSessionId"])
    && isCanonicalNautiloInstanceId(value["instanceId"])
    && typeof value["userId"] === "string" && value["userId"].length > 0
    && typeof value["relayId"] === "string" && value["relayId"].length > 0
    && typeof value["desktopSessionId"] === "string" && value["desktopSessionId"].length > 0;
}

function isEnable(value: unknown): value is EnableSshCapability {
  return isRecord(value)
    && hasExactKeys(value, ["subject", "expectedRevision", "tools"])
    && isMutation({ subject: value["subject"], expectedRevision: value["expectedRevision"] })
    && parseSshCapabilityTools(value["tools"]) !== null;
}

function isUpdate(value: unknown): value is UpdateSshCapability {
  if (!isRecord(value)) return false;
  const optional = [
    ...(value["enabled"] === undefined ? [] : ["enabled"]),
    ...(value["tools"] === undefined ? [] : ["tools"]),
  ];
  return hasExactKeys(value, ["subject", "expectedRevision", ...optional])
    && isMutation({ subject: value["subject"], expectedRevision: value["expectedRevision"] })
    && (value["enabled"] === undefined || typeof value["enabled"] === "boolean")
    && (value["tools"] === undefined || parseSshCapabilityTools(value["tools"]) !== null)
    && (value["enabled"] !== undefined || value["tools"] !== undefined);
}

/**
 * Electron-local authority for SSH on this Mac. Every current capability is
 * scoped to one exact subject and this server binding. This is deliberately a
 * compact SSH-specific collection, not a generalized capability framework.
 */
export class SshCapabilityStore {
  private readonly instanceId: string;
  private readonly serverBindingId: string;
  private readonly storage: StructuredSshStorage;
  private readonly clock: () => Date;
  private readonly filePath: string;

  constructor(options: SshCapabilityStoreOptions) {
    this.instanceId = options.instanceId;
    this.serverBindingId = options.serverBindingId;
    this.filePath = nodePath.resolve(options.filePath);
    this.storage = options.storage ?? createStructuredSshStorage(this.filePath, options.storageDependencies);
    this.clock = options.clock ?? (() => new Date());
  }

  private async serialized<T>(operation: () => Promise<SshCapabilityStoreResult<T>>): Promise<SshCapabilityStoreResult<T>> {
    const previous = serializedTailByFilePath.get(this.filePath) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    serializedTailByFilePath.set(this.filePath, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (serializedTailByFilePath.get(this.filePath) === tail) serializedTailByFilePath.delete(this.filePath);
    }
  }

  private now(): string | null {
    try {
      const value = this.clock();
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    } catch {
      return null;
    }
  }

  private empty(): SshCapabilityStoreResult<SshCapabilityEnvelope> {
    const now = this.now();
    if (now === null) return failed("store_unavailable", "structured SSH capability clock is unavailable");
    return {
      ok: true,
      data: {
        version: SSH_CAPABILITY_STORE_VERSION,
        instanceId: this.instanceId,
        serverBindingId: this.serverBindingId,
        revision: 0,
        capabilities: [],
        updatedAt: now,
      },
    };
  }

  private decode(raw: string): SshCapabilityStoreResult<SshCapabilityEnvelope> {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return failed("store_corrupt", "structured SSH capability contains invalid JSON");
    }
    if (!isRecord(value) || !hasExactKeys(value, ["version", "instanceId", "serverBindingId", "revision", "capabilities", "updatedAt"]) || value["version"] !== SSH_CAPABILITY_STORE_VERSION || typeof value["instanceId"] !== "string" || typeof value["serverBindingId"] !== "string" || !SERVER_BINDING.test(value["serverBindingId"]) || !isRevision(value["revision"]) || !Array.isArray(value["capabilities"]) || !isUtcIso(value["updatedAt"])) return failed("store_corrupt", "structured SSH capability has an invalid envelope");
    if (value["instanceId"] !== this.instanceId) return failed("store_instance_mismatch", "structured SSH capability belongs to another instance");
    if (value["serverBindingId"] !== this.serverBindingId) return failed("store_server_mismatch", "structured SSH capability belongs to another active server");
    const capabilities: SshCapability[] = [];
    const currentSubjects = new Set<string>();
    for (const candidate of value["capabilities"]) {
      const capability = parseSshCapability(candidate);
      if (capability === null || capability.subject.instanceId !== this.instanceId || capability.updatedAt > value["updatedAt"]) return failed("store_corrupt", "structured SSH capability has an invalid record");
      if (capability.revokedAt === undefined) {
        const subjectKey = this.subjectKey(capability.subject);
        if (currentSubjects.has(subjectKey)) return failed("store_corrupt", "structured SSH capability has ambiguous current authority");
        currentSubjects.add(subjectKey);
      }
      capabilities.push(capability);
    }
    return { ok: true, data: { version: SSH_CAPABILITY_STORE_VERSION, instanceId: this.instanceId, serverBindingId: this.serverBindingId, revision: value["revision"], capabilities, updatedAt: value["updatedAt"] } };
  }

  private async read(): Promise<SshCapabilityStoreResult<SshCapabilityEnvelope>> {
    if (!isCanonicalNautiloInstanceId(this.instanceId) || !SERVER_BINDING.test(this.serverBindingId)) return failed("invalid_capability", "structured SSH capability store scope is invalid");
    let raw: string | null;
    try {
      raw = await this.storage.read();
    } catch {
      return failed("store_unavailable", "structured SSH capability could not be read");
    }
    return raw === null ? this.empty() : this.decode(raw);
  }

  private async write(envelope: SshCapabilityEnvelope): Promise<SshCapabilityStoreResult<SshCapabilityEnvelope>> {
    try {
      await this.storage.writeAtomic(`${JSON.stringify(envelope, null, 2)}\n`);
      return { ok: true, data: envelope };
    } catch {
      return failed("store_unavailable", "structured SSH capability could not be persisted");
    }
  }

  private subjectKey(subject: SshCapabilitySubject): string {
    return [subject.instanceId, subject.userId, subject.agentId, subject.relayId, subject.desktopSessionId].join("\u0000");
  }

  private currentForMutation(envelope: SshCapabilityEnvelope, input: SshCapabilityMutation): SshCapabilityStoreResult<{ readonly capability: SshCapability; readonly index: number }> {
    if (envelope.revision !== input.expectedRevision) return failed("capability_revision_mismatch", "structured SSH capability revision no longer matches");
    const index = envelope.capabilities.findIndex((candidate) => sameSshCapabilitySubject(candidate.subject, input.subject) && candidate.revokedAt === undefined);
    if (index < 0) return failed("capability_unavailable", "structured SSH capability is not enabled for this Human, Genie, relay, and Desktop session");
    return { ok: true, data: { capability: envelope.capabilities[index]!, index } };
  }

  private async mutate(input: SshCapabilityMutation, change: (capability: SshCapability, now: string) => SshCapability): Promise<SshCapabilityStoreResult<{ readonly capability: SshCapability; readonly revision: number }>> {
    if (!isMutation({ subject: input.subject, expectedRevision: input.expectedRevision }) || input.subject.instanceId !== this.instanceId) return failed("invalid_capability", "structured SSH capability mutation is invalid");
    const current = await this.read();
    if (!current.ok) return current;
    const capability = this.currentForMutation(current.data, input);
    if (!capability.ok) return capability;
    const revision = nextRevision(current.data.revision);
    const now = this.now();
    if (revision === null) return failed("capability_revision_exhausted", "structured SSH capability revision is exhausted");
    if (now === null) return failed("store_unavailable", "structured SSH capability clock is unavailable");
    const updated = change(capability.data.capability, now);
    const capabilities = current.data.capabilities.map((candidate, index) => index === capability.data.index ? updated : candidate);
    const written = await this.write({ ...current.data, revision, capabilities, updatedAt: now });
    return written.ok ? { ok: true, data: { capability: updated, revision: written.data.revision } } : written;
  }

  async get(subject: SshCapabilitySubject): Promise<SshCapabilityStoreResult<{ readonly capability: SshCapability | null; readonly revision: number }>> {
    return this.serialized(async () => {
      if (parseSshCapabilitySubject(subject) === null || subject.instanceId !== this.instanceId) return failed("invalid_capability", "structured SSH capability subject is invalid");
      const current = await this.read();
      if (!current.ok) return current;
      const capability = current.data.capabilities.find((candidate) => sameSshCapabilitySubject(candidate.subject, subject) && candidate.revokedAt === undefined) ?? null;
      return { ok: true, data: { capability, revision: current.data.revision } };
    });
  }

  /** Human-only management projection for the active local Desktop session. */
  async listForDesktopSession(input: SshCapabilityDesktopSessionSelection): Promise<SshCapabilityStoreResult<{ readonly capabilities: readonly SshCapability[]; readonly revision: number }>> {
    return this.serialized(async () => {
      if (!isDesktopSessionSelection(input) || input.instanceId !== this.instanceId) return failed("invalid_capability", "structured SSH capability desktop session selection is invalid");
      const current = await this.read();
      if (!current.ok) return current;
      const capabilities = current.data.capabilities.filter((capability) =>
        capability.subject.instanceId === input.instanceId
          && capability.subject.userId === input.userId
          && capability.subject.relayId === input.relayId
          && capability.subject.desktopSessionId === input.desktopSessionId
          && capability.revokedAt === undefined,
      );
      return { ok: true, data: { capabilities, revision: current.data.revision } };
    });
  }

  async enable(input: EnableSshCapability): Promise<SshCapabilityStoreResult<{ readonly capability: SshCapability; readonly revision: number }>> {
    return this.serialized(async () => {
      if (!isEnable(input) || input.subject.instanceId !== this.instanceId) return failed("invalid_capability", "structured SSH capability enablement is invalid");
      const current = await this.read();
      if (!current.ok) return current;
      if (current.data.revision !== input.expectedRevision) return failed("capability_revision_mismatch", "structured SSH capability revision no longer matches");
      const revision = nextRevision(current.data.revision);
      const now = this.now();
      if (revision === null) return failed("capability_revision_exhausted", "structured SSH capability revision is exhausted");
      if (now === null) return failed("store_unavailable", "structured SSH capability clock is unavailable");
      // A capability never follows a stale relay/Desktop session. Prune those
      // records on the next enablement instead of accumulating dead authority.
      const currentSession = current.data.capabilities.filter((candidate) =>
        candidate.subject.userId === input.subject.userId
        && candidate.subject.relayId === input.subject.relayId
        && candidate.subject.desktopSessionId === input.subject.desktopSessionId,
      );
      const currentIndex = currentSession.findIndex((candidate) => sameSshCapabilitySubject(candidate.subject, input.subject));
      const existing = currentIndex < 0 ? undefined : currentSession[currentIndex];
      const capability: SshCapability = {
        version: SSH_CAPABILITY_VERSION,
        subject: input.subject,
        enabled: true,
        tools: input.tools,
        issuedAt: existing?.revokedAt === undefined && existing !== undefined ? existing.issuedAt : now,
        updatedAt: now,
      };
      const capabilities = currentIndex < 0
        ? [...currentSession, capability]
        : currentSession.map((candidate, index) => index === currentIndex ? capability : candidate);
      const written = await this.write({ ...current.data, revision, capabilities, updatedAt: now });
      return written.ok ? { ok: true, data: { capability, revision: written.data.revision } } : written;
    });
  }

  async update(input: UpdateSshCapability): Promise<SshCapabilityStoreResult<{ readonly capability: SshCapability; readonly revision: number }>> {
    return this.serialized(() => {
      if (!isUpdate(input)) return Promise.resolve(failed("invalid_capability", "structured SSH capability update is invalid"));
      return this.mutate(input, (capability, now) => {
        if (input.enabled === true) return {
          version: capability.version,
          subject: capability.subject,
          enabled: true,
          tools: input.tools ?? capability.tools,
          issuedAt: capability.issuedAt,
          updatedAt: now,
        };
        return {
          ...capability,
          ...(input.enabled === undefined ? {} : { enabled: false, disabledAt: now }),
          ...(input.tools === undefined ? {} : { tools: input.tools }),
          updatedAt: now,
        };
      });
    });
  }

  async disable(input: SshCapabilityMutation): Promise<SshCapabilityStoreResult<{ readonly capability: SshCapability; readonly revision: number }>> {
    return this.serialized(() => {
      if (!isMutation(input)) return Promise.resolve(failed("invalid_capability", "structured SSH capability disablement is invalid"));
      return this.mutate(input, (capability, now) => ({ ...capability, enabled: false, disabledAt: now, updatedAt: now }));
    });
  }

  async revoke(input: SshCapabilityMutation): Promise<SshCapabilityStoreResult<{ readonly capability: SshCapability; readonly revision: number }>> {
    return this.serialized(() => {
      if (!isMutation(input)) return Promise.resolve(failed("invalid_capability", "structured SSH capability revocation is invalid"));
      return this.mutate(input, (capability, now) => ({ ...capability, enabled: false, disabledAt: now, revokedAt: now, updatedAt: now }));
    });
  }
}

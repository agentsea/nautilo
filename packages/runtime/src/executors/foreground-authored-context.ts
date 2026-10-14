import { createHmac } from "node:crypto";
import type { AuthoredMemoryBriefExposure, PromptBriefMemory } from "@nautilo/agent";
import type { DurableModelExposureDependency } from "@nautilo/reflection/durable";
import type { OrdinarySourceFingerprintPort } from "../reflection/canonical-room-sources";

export type ForegroundExecutionConfig = Readonly<{
  profileId: string;
  userId: string;
  agentId: string;
  name: string;
  defaultModel: string | null;
  soulFile: string | null;
  soulRevision: number;
}>;

export type ForegroundSoulSourceReceipt = Readonly<{
  sourceKind: "profile_soul";
  logicalSourceRef: string;
  observedRevision: string;
  observedContentFingerprint: string;
  terminalAuthorityLeafHandle: string;
  namespaceId: string;
  agentId: string;
  profileId: string;
  userId: string;
  soulRevision: number;
  soulFile: string;
}>;

export type ForegroundModelInputDependency = Readonly<{
  kind: "source";
  sourceKind: "profile_soul";
  logicalSourceRef: string;
  observedRevision: string;
  observedContentFingerprint: string;
  terminalAuthorityLeafHandle: string;
}>;

export type ProfileSoulFingerprintInput = Pick<ForegroundExecutionConfig,
  "agentId" | "profileId" | "userId" | "soulRevision" | "soulFile"> & { soulFile: string };

/** HMAC content commitment for an exact canonical Profile Soul observation. */
export function createHmacProfileSoulFingerprint(
  key: Uint8Array,
): (input: ProfileSoulFingerprintInput) => string {
  if (key.byteLength < 32) throw new TypeError("Profile Soul fingerprint key must contain at least 32 bytes");
  const owned = key.slice();
  return (input) => {
    const hmac = createHmac("sha256", owned);
    for (const value of [
      "nautilo/profile-soul-observation/v1",
      input.agentId,
      input.profileId,
      input.userId,
      String(input.soulRevision),
      input.soulFile,
    ]) {
      const bytes = Buffer.from(value, "utf8");
      hmac.update(String(bytes.byteLength), "utf8");
      hmac.update(":", "utf8");
      hmac.update(bytes);
    }
    return `hmac-sha256:${hmac.digest("base64url")}`;
  };
}

export type ForegroundSkillBody = Readonly<{
  id: string;
  name: string;
  description: string;
  body: string;
  requiresTools: readonly string[];
}>;

export type ForegroundAuthoredContext = Readonly<{
  profile: ForegroundExecutionConfig | null;
  soulFile: string;
  soulSourceReceipt: ForegroundSoulSourceReceipt | null;
  modelInputDependencies: readonly ForegroundModelInputDependency[];
  skills: readonly ForegroundSkillBody[];
}>;

export async function loadForegroundAuthoredContext(input: Readonly<{
  agentId: string;
  ownerId: string;
  isGuest: boolean;
  externalContext?: boolean;
  /** Exact Room namespace authorized by the trusted foreground caller. */
  namespaceId?: string;
}>, deps: Readonly<{
  getExecutionConfigByAgentId(agentId: string): Promise<ForegroundExecutionConfig | null>;
  resolveEnabledBodies(
    agentId: string,
    ownerId: string,
    options: { isGuest: boolean },
  ): Promise<readonly ForegroundSkillBody[]>;
  fingerprintProfileSoul?(input: ProfileSoulFingerprintInput): string;
}>): Promise<ForegroundAuthoredContext> {
  if (input.isGuest || input.externalContext === true) {
    return Object.freeze({
      profile: null,
      soulFile: "",
      soulSourceReceipt: null,
      modelInputDependencies: Object.freeze([]),
      skills: Object.freeze([]),
    });
  }
  const profile = input.agentId
    ? await deps.getExecutionConfigByAgentId(input.agentId).catch(() => null)
    : null;
  const skills = input.agentId && input.ownerId
    ? await deps.resolveEnabledBodies(
      input.agentId,
      input.ownerId,
      { isGuest: false },
    ).catch(() => [])
    : [];
  const soulFile = profile?.soulFile ?? "";
  const canonicalSoul = profile !== null
    && profile.agentId === input.agentId
    && soulFile.length > 0
    && typeof input.namespaceId === "string"
    && input.namespaceId.length > 0
    && deps.fingerprintProfileSoul !== undefined;
  const soulSourceReceipt: ForegroundSoulSourceReceipt | null = canonicalSoul
    ? Object.freeze({
      sourceKind: "profile_soul",
      logicalSourceRef: `agent-soul:${profile.agentId}`,
      observedRevision: String(profile.soulRevision),
      observedContentFingerprint: deps.fingerprintProfileSoul({
        agentId: profile.agentId,
        profileId: profile.profileId,
        userId: profile.userId,
        soulRevision: profile.soulRevision,
        soulFile,
      }),
      terminalAuthorityLeafHandle: input.namespaceId,
      namespaceId: input.namespaceId,
      agentId: profile.agentId,
      profileId: profile.profileId,
      userId: profile.userId,
      soulRevision: profile.soulRevision,
      soulFile,
    })
    : null;
  const modelInputDependencies: readonly ForegroundModelInputDependency[] = soulSourceReceipt === null
    ? Object.freeze([])
    : Object.freeze([Object.freeze({
      kind: "source" as const,
      sourceKind: soulSourceReceipt.sourceKind,
      logicalSourceRef: soulSourceReceipt.logicalSourceRef,
      observedRevision: soulSourceReceipt.observedRevision,
      observedContentFingerprint: soulSourceReceipt.observedContentFingerprint,
      terminalAuthorityLeafHandle: soulSourceReceipt.terminalAuthorityLeafHandle,
    })]);
  return Object.freeze({
    profile,
    soulFile,
    soulSourceReceipt,
    modelInputDependencies,
    skills,
  });
}

let installedFingerprint: ((input: ProfileSoulFingerprintInput) => string) | undefined;
let installedMemoryFingerprint: OrdinarySourceFingerprintPort["memory"] | undefined;

/** The server owns commitment custody; graph state never carries its key. */
export function installForegroundAuthoredFingerprintPort(fingerprint: (input: ProfileSoulFingerprintInput) => string, memoryFingerprint?: OrdinarySourceFingerprintPort["memory"]): void {
  if (installedFingerprint && installedFingerprint !== fingerprint) throw new Error("foreground_authored_fingerprint_port_already_installed");
  installedFingerprint = fingerprint;
  installedMemoryFingerprint = memoryFingerprint;
}
export function uninstallForegroundAuthoredFingerprintPort(): void { installedFingerprint = undefined; installedMemoryFingerprint = undefined; }
export function foregroundProfileSoulFingerprint(): ((input: ProfileSoulFingerprintInput) => string) | undefined { return installedFingerprint; }

/** Receipt for precisely the selected rows rendered by the current brief reader. */
export function foregroundMemoryBriefExposure(
  rows: readonly PromptBriefMemory[],
  fingerprint: OrdinarySourceFingerprintPort["memory"] | undefined = installedMemoryFingerprint,
): AuthoredMemoryBriefExposure {
  const content = rows.map((memory) => `- [${memory.type}] ${memory.content}`).join("\n");
  const dependencies: DurableModelExposureDependency[] = [];
  for (const row of rows) {
    if (fingerprint === undefined || !Number.isSafeInteger(row.contentRevision)
      || (row.contentRevision ?? 0) < 1 || !row.namespaceId) {
      return { content, exposure: { status: "incomplete" } };
    }
    dependencies.push({ kind: "source", sourceKind: "memory", logicalSourceRef: `memory:${row.id}`,
      observedRevision: String(row.contentRevision),
      observedContentFingerprint: fingerprint({ id: row.id, type: row.type, content: row.content, contentRevision: row.contentRevision! }),
      terminalAuthorityLeafHandle: row.namespaceId });
  }
  return { content, exposure: { status: "complete", dependencies } };
}

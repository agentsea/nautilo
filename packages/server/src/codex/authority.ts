import type { CodexPosture } from "@nautilo/types";
import { isCodexRelayProtocolVersion } from "@nautilo/relay";

const MAX_OPAQUE_BYTES = 512;
const encoder = new TextEncoder();
const safeGeneration = (value: number) =>
  Number.isSafeInteger(value) && value >= 0;
const opaque = (value: string) =>
  value.trim().length > 0 && encoder.encode(value).byteLength <= MAX_OPAQUE_BYTES;

export type CodexAuthorityError =
  | "CODEX_UNAVAILABLE"
  | "CODEX_PROFILE_UNAVAILABLE"
  | "CODEX_FORBIDDEN"
  | "CODEX_STALE"
  | "CODEX_CONFLICT";

export class CodexAuthorityFailure extends Error {
  constructor(readonly code: CodexAuthorityError) {
    super(code);
    this.name = "CodexAuthorityFailure";
  }
}

type CodexCompatibility =
  | "certified"
  | "compatible_uncertified"
  | "limited"
  | "incompatible";
type CodexFeatures = {
  readonly stableConversation: boolean;
  readonly explicitSteer: boolean;
  readonly codexApprovals: boolean;
  readonly requestUserInput: boolean;
  /** Optional so a pre-Plan v8 peer remains usable for Work turns. */
  readonly collaborationMode?: boolean;
};
type SocketCorrelation = {
  readonly relayId: string;
  readonly relaySessionId: string;
  readonly desktopSessionId: string;
  readonly pairingGenerationRef: string;
  readonly selectedProtocolVersion: number;
  readonly capabilityRevision: number;
};
type LiveProfile = {
  readonly profileHandle: string;
  readonly profileGeneration: number;
  readonly accountGeneration: number;
  readonly childGeneration: number;
  readonly state:
    | "signed_in"
    | "signed_out"
    | "reauth_required"
    | "busy"
    | "draining";
};
export type CodexWorkspaceReceipt = {
  readonly workspaceRef: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
};
type CodexLiveSession = {
  readonly relayId: string;
  readonly userId: string;
  readonly relaySessionId: string;
  readonly pairingGenerationRef: string;
  readonly desktopSessionId: string;
  readonly selectedProtocolVersion: number;
  readonly capability: {
    readonly version: number;
    readonly hostKind: string;
  };
  readonly capabilityRevision: number;
  readonly currentCapabilityRevision: number;
  readonly currentRuntimeGeneration: number;
  readonly statusCorrelation: SocketCorrelation;
  readonly status: {
    readonly state:
      | "ready"
      | "limited"
      | "runtime_unavailable"
      | "runtime_incompatible"
      | "supervisor_unavailable"
      | "workspace_unavailable";
    readonly compatibility?: CodexCompatibility;
    readonly features?: CodexFeatures;
    readonly runtimeGeneration?: number;
    readonly profiles?: readonly LiveProfile[];
    readonly workspace:
      | { readonly state: "bound"; readonly receipt: CodexWorkspaceReceipt }
      | { readonly state: "unavailable" | "stale" };
  } | null;
};

export interface CodexRelaySessionAuthorityPort {
  getCodexSession(relayId: string, userId: string): CodexLiveSession | null;
}

export type CodexSemanticAuthorityRequest = {
  actorId: string;
  agentId: string;
  taskId: string;
  taskRunId: string;
  jobId: string;
  roomId: string;
  profileId: string;
  laneKey: string;
  posture: CodexPosture;
  /** Per-turn provider setting; deliberately absent from binding identity. */
  collaborationMode: "work" | "plan";
};

export type CodexCanonicalBindingFacts = {
  userId: string;
  agentId: string;
  taskId: string;
  taskRunId: string;
  jobId: string;
  parentTaskId: string | null;
  roomId: string;
  laneKey: string;
  profileId: string;
  relayId: string;
  profileHandle: string;
  profileGeneration: number;
  accountGeneration: number;
};
export interface CodexCanonicalFactsPort {
  resolve(
    input: Omit<CodexSemanticAuthorityRequest, "posture" | "collaborationMode">,
  ): Promise<CodexCanonicalBindingFacts>;
}

export type CodexDerivedBindingScope = CodexCanonicalBindingFacts & {
  posture: CodexPosture;
  /** Live compatibility fact captured with this exact relay capability revision. */
  explicitSteer: boolean;
  relaySessionId: string;
  desktopSessionId: string;
  pairingGenerationRef: string;
  selectedProtocolVersion: number;
  capabilityRevision: number;
  runtimeGeneration: number;
  childGeneration: number;
  workspace: CodexWorkspaceReceipt;
  codexSandboxMode: "default" | "workspace-write" | "danger-full-access";
  codexApprovalPolicy: "default" | "on-request" | "never";
};
export type CodexProfileReadinessReceipt = Pick<
  CodexDerivedBindingScope,
  "relayId" | "pairingGenerationRef" | "capabilityRevision"
>;
export type CodexInternalBindingMutation = {
  bindingId?: string;
  bindingKind: "task";
  codexThreadId: string;
  selectedModel: string | null;
};
export type CodexInternalOperationalMutation = {
  state:
    | "opening"
    | "active"
    | "queued"
    | "awaiting_approval"
    | "awaiting_input"
    | "needs_rebind"
    | "completed"
    | "cancelled"
    | "errored"
    | "recovery_required";
  lastTurnId?: string | null;
  lastItemCursor?: string | null;
};
export type CodexPersistedBindingIdentity = {
  bindingKind: "task";
  codexThreadId: string;
  selectedModel: string | null;
};

export interface CodexBindingMutationPort {
  insert(
    scope: CodexDerivedBindingScope,
    mutation: CodexInternalBindingMutation,
  ): Promise<unknown>;
  replace(
    scope: CodexDerivedBindingScope,
    currentId: string,
    expectedRevision: number,
    mutation: CodexInternalBindingMutation,
  ): Promise<unknown>;
  update(
    scope: CodexDerivedBindingScope,
    bindingId: string,
    expectedRevision: number,
    mutation: CodexInternalOperationalMutation,
  ): Promise<unknown>;
  archive(
    scope: CodexDerivedBindingScope,
    bindingId: string,
    expectedRevision: number,
  ): Promise<unknown>;
  rebind(
    scope: CodexDerivedBindingScope,
    bindingId: string,
    expectedRevision: number,
    expectedBindingGeneration: number,
    persisted: CodexPersistedBindingIdentity,
  ): Promise<unknown>;
}

type VerifiedCodexAdmission = { readonly scope: CodexDerivedBindingScope };
const verifiedAdmissions = new WeakSet<object>();
function assertVerified(admission: VerifiedCodexAdmission) {
  if (!verifiedAdmissions.has(admission)) {
    throw new CodexAuthorityFailure("CODEX_FORBIDDEN");
  }
}

function posturePolicy(posture: CodexPosture): Pick<
  CodexDerivedBindingScope,
  "codexSandboxMode" | "codexApprovalPolicy"
> {
  if (posture === "prompted_workspace") {
    return {
      codexSandboxMode: "workspace-write",
      codexApprovalPolicy: "on-request",
    };
  }
  if (posture === "full_access_headless") {
    return {
      codexSandboxMode: "danger-full-access",
      codexApprovalPolicy: "never",
    };
  }
  return { codexSandboxMode: "default", codexApprovalPolicy: "default" };
}

function exactSocket(session: CodexLiveSession): boolean {
  const correlation = session.statusCorrelation;
  return (
    isCodexRelayProtocolVersion(session.selectedProtocolVersion) &&
    session.capability.version === 1 &&
    session.capability.hostKind === "electron" &&
    safeGeneration(session.capabilityRevision) &&
    session.capabilityRevision === session.currentCapabilityRevision &&
    correlation.relayId === session.relayId &&
    correlation.relaySessionId === session.relaySessionId &&
    correlation.desktopSessionId === session.desktopSessionId &&
    correlation.pairingGenerationRef === session.pairingGenerationRef &&
    correlation.selectedProtocolVersion === session.selectedProtocolVersion &&
    correlation.capabilityRevision === session.capabilityRevision &&
    opaque(session.relayId) &&
    opaque(session.relaySessionId) &&
    opaque(session.desktopSessionId) &&
    opaque(session.pairingGenerationRef)
  );
}

function validateLiveBaseline(
  session: CodexLiveSession,
  expected: { userId: string; relayId: string },
): asserts session is CodexLiveSession & { status: NonNullable<CodexLiveSession["status"]> } {
  if (
    session.userId !== expected.userId ||
    session.relayId !== expected.relayId ||
    !exactSocket(session) ||
    !session.status
  ) {
    throw new CodexAuthorityFailure("CODEX_UNAVAILABLE");
  }
  const status = session.status;
  if (
    (status.state !== "ready" && status.state !== "limited") ||
    !status.compatibility ||
    status.compatibility === "incompatible" ||
    !["certified", "compatible_uncertified", "limited"].includes(
      status.compatibility,
    ) ||
    !status.features?.stableConversation ||
    !safeGeneration(session.currentRuntimeGeneration) ||
    !safeGeneration(status.runtimeGeneration ?? -1) ||
    status.runtimeGeneration !== session.currentRuntimeGeneration
  ) {
    throw new CodexAuthorityFailure("CODEX_STALE");
  }
}

function validateCollaborationMode(
  features: CodexFeatures,
  collaborationMode: CodexSemanticAuthorityRequest["collaborationMode"],
): void {
  // Work is the stable baseline and must continue to run against older v8
  // desktops that do not publish the experimental feature gate.
  if (collaborationMode === "work") return;
  if (collaborationMode !== "plan" || features.collaborationMode !== true) {
    throw new CodexAuthorityFailure("CODEX_STALE");
  }
}

function validateReceipt(
  receipt: CodexWorkspaceReceipt,
  now: number,
): void {
  const issuedAt = Date.parse(receipt.issuedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  if (
    !opaque(receipt.workspaceRef) ||
    !opaque(receipt.fingerprint) ||
    !safeGeneration(receipt.revision) ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    new Date(issuedAt).toISOString() !== receipt.issuedAt ||
    new Date(expiresAt).toISOString() !== receipt.expiresAt ||
    issuedAt >= now ||
    now >= expiresAt
  ) {
    throw new CodexAuthorityFailure("CODEX_STALE");
  }
}

export class CodexAuthorityService {
  constructor(
    private readonly facts: CodexCanonicalFactsPort,
    private readonly sessions: CodexRelaySessionAuthorityPort,
    private readonly mutations: CodexBindingMutationPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async insertBinding(
    request: CodexSemanticAuthorityRequest,
    mutation: CodexInternalBindingMutation,
  ) {
    const admission = await this.admit(request);
    assertVerified(admission);
    return this.mutations.insert(admission.scope, mutation);
  }
  async deriveScope(request: CodexSemanticAuthorityRequest) {
    const admission = await this.admit(request);
    assertVerified(admission);
    return admission.scope;
  }

  /**
   * Non-writing admission proof used before a Codex Task exists. The profile
   * already binds one exact paired host; execution later derives canonical
   * Task facts and must match this receipt before opening the provider turn.
   */
  checkProfileReadiness(
    profile: {
      readonly userId: string;
      readonly relayId: string;
      readonly profileHandle: string;
      readonly profileGeneration: number;
      readonly accountGeneration: number;
    },
    collaborationMode: "work" | "plan",
  ): CodexProfileReadinessReceipt {
    const session = this.sessions.getCodexSession(profile.relayId, profile.userId);
    if (!session) throw new CodexAuthorityFailure("CODEX_UNAVAILABLE");
    try {
      validateLiveBaseline(session, profile);
      validateCollaborationMode(session.status.features!, collaborationMode);
    } catch (error) {
      console.warn(`[codex] readiness unavailable: host baseline state=${session.status?.state ?? "missing"}`);
      throw error;
    }
    if (session.status.workspace.state !== "bound") {
      console.warn(`[codex] readiness unavailable: paired-host routing receipt is ${session.status.workspace.state}`);
      throw new CodexAuthorityFailure("CODEX_UNAVAILABLE");
    }
    try {
      validateReceipt(session.status.workspace.receipt, this.now().getTime());
    } catch {
      console.warn("[codex] readiness unavailable: paired-host routing receipt is stale");
      throw new CodexAuthorityFailure("CODEX_UNAVAILABLE");
    }
    const liveProfile = session.status.profiles?.find(
      (candidate) => candidate.profileHandle === profile.profileHandle,
    );
    if (
      !liveProfile ||
      liveProfile.state !== "signed_in" ||
      liveProfile.profileGeneration !== profile.profileGeneration ||
      liveProfile.accountGeneration !== profile.accountGeneration
    ) {
      console.warn(`[codex] readiness unavailable: selected account state=${liveProfile?.state ?? "missing"}`);
      throw new CodexAuthorityFailure("CODEX_PROFILE_UNAVAILABLE");
    }
    return Object.freeze({
      relayId: session.relayId,
      pairingGenerationRef: session.pairingGenerationRef,
      capabilityRevision: session.capabilityRevision,
    });
  }
  async replaceBinding(
    request: CodexSemanticAuthorityRequest,
    currentId: string,
    expectedRevision: number,
    mutation: CodexInternalBindingMutation,
  ) {
    const admission = await this.admit(request);
    assertVerified(admission);
    return this.mutations.replace(
      admission.scope,
      currentId,
      expectedRevision,
      mutation,
    );
  }
  async updateBinding(
    request: CodexSemanticAuthorityRequest,
    bindingId: string,
    expectedRevision: number,
    mutation: CodexInternalOperationalMutation,
  ) {
    const admission = await this.admit(request);
    assertVerified(admission);
    return this.mutations.update(
      admission.scope,
      bindingId,
      expectedRevision,
      mutation,
    );
  }
  async archiveBinding(
    request: CodexSemanticAuthorityRequest,
    bindingId: string,
    expectedRevision: number,
  ) {
    const admission = await this.admit(request);
    assertVerified(admission);
    return this.mutations.archive(
      admission.scope,
      bindingId,
      expectedRevision,
    );
  }
  async rebindBinding(
    request: CodexSemanticAuthorityRequest,
    bindingId: string,
    expectedRevision: number,
    expectedBindingGeneration: number,
    persisted: CodexPersistedBindingIdentity,
  ) {
    const admission = await this.admit(request);
    assertVerified(admission);
    return this.mutations.rebind(
      admission.scope,
      bindingId,
      expectedRevision,
      expectedBindingGeneration,
      persisted,
    );
  }

  private async admit(
    input: CodexSemanticAuthorityRequest,
  ): Promise<VerifiedCodexAdmission> {
    let facts: CodexCanonicalBindingFacts;
    try {
      facts = await this.facts.resolve(input);
    } catch {
      throw new CodexAuthorityFailure("CODEX_FORBIDDEN");
    }
    for (const value of [
      facts.relayId,
      facts.profileHandle,
      facts.laneKey,
      facts.userId,
      facts.agentId,
      facts.taskId,
      facts.taskRunId,
      facts.jobId,
      facts.roomId,
      facts.profileId,
    ]) {
      if (!opaque(value)) throw new CodexAuthorityFailure("CODEX_FORBIDDEN");
    }
    if (
      !safeGeneration(facts.profileGeneration) ||
      !safeGeneration(facts.accountGeneration)
    ) {
      throw new CodexAuthorityFailure("CODEX_FORBIDDEN");
    }

    const session = this.sessions.getCodexSession(
      facts.relayId,
      facts.userId,
    );
    if (!session) throw new CodexAuthorityFailure("CODEX_UNAVAILABLE");
    validateLiveBaseline(session, facts);
    validateCollaborationMode(session.status.features!, input.collaborationMode);
    if (session.status.workspace.state !== "bound") {
      throw new CodexAuthorityFailure("CODEX_STALE");
    }
    validateReceipt(session.status.workspace.receipt, this.now().getTime());

    const profile = session.status.profiles?.find(
      (item) => item.profileHandle === facts.profileHandle,
    );
    if (
      !profile ||
      profile.state !== "signed_in" ||
      profile.profileGeneration !== facts.profileGeneration ||
      profile.accountGeneration !== facts.accountGeneration ||
      !safeGeneration(profile.childGeneration)
    ) {
      throw new CodexAuthorityFailure("CODEX_STALE");
    }

    const scope = Object.freeze({
      ...facts,
      posture: input.posture,
      explicitSteer: session.status.features!.explicitSteer,
      relaySessionId: session.relaySessionId,
      desktopSessionId: session.desktopSessionId,
      pairingGenerationRef: session.pairingGenerationRef,
      selectedProtocolVersion: session.selectedProtocolVersion,
      capabilityRevision: session.capabilityRevision,
      runtimeGeneration: session.currentRuntimeGeneration,
      childGeneration: profile.childGeneration,
      workspace: Object.freeze({ ...session.status.workspace.receipt }),
      ...posturePolicy(input.posture),
    });
    const admission = Object.freeze({ scope });
    verifiedAdmissions.add(admission);
    return admission;
  }
}

export type CodexCanonicalProfileFacts = {
  userId: string;
  relayId: string;
  profileId: string;
  profileHandle: string;
  profileGeneration: number;
  accountGeneration: number;
};
export interface CodexProfileCanonicalFactsPort {
  resolveRelay(input: {
    actorId: string;
  }): Promise<Pick<CodexCanonicalProfileFacts, "userId" | "relayId">>;
  resolveProfile(input: {
    actorId: string;
    profileId: string;
  }): Promise<CodexCanonicalProfileFacts>;
}
export type CodexCorrelatedProfileResult = SocketCorrelation & {
  profileHandle: string;
  homeHandle: string;
  profileGeneration: number;
  accountGeneration: number;
  authState: "signed_out" | "login_pending" | "signed_in" | "expired" | "error";
};
export interface CodexProfilePersistencePort {
  createProfile(input: {
    userId: string;
    relayId: string;
    label: string;
    result: CodexCorrelatedProfileResult;
  }): Promise<unknown>;
  updateProfileStatus(input: {
    facts: CodexCanonicalProfileFacts;
    result: CodexCorrelatedProfileResult;
    expectedRevision: number;
  }): Promise<unknown>;
}

function validateCorrelatedResult(
  session: CodexLiveSession,
  result: CodexCorrelatedProfileResult,
) {
  if (
    result.relayId !== session.relayId ||
    result.relaySessionId !== session.relaySessionId ||
    result.desktopSessionId !== session.desktopSessionId ||
    result.pairingGenerationRef !== session.pairingGenerationRef ||
    result.selectedProtocolVersion !== session.selectedProtocolVersion ||
    result.capabilityRevision !== session.capabilityRevision ||
    !opaque(result.profileHandle) ||
    !opaque(result.homeHandle) ||
    !safeGeneration(result.profileGeneration) ||
    !safeGeneration(result.accountGeneration)
  ) {
    throw new CodexAuthorityFailure("CODEX_STALE");
  }
}

export class CodexProfileAuthorityService {
  constructor(
    private readonly facts: CodexProfileCanonicalFactsPort,
    private readonly sessions: CodexRelaySessionAuthorityPort,
    private readonly persistence: CodexProfilePersistencePort,
  ) {}

  async createProfile(input: {
    actorId: string;
    label: string;
    result: CodexCorrelatedProfileResult;
  }) {
    let facts: Awaited<
      ReturnType<CodexProfileCanonicalFactsPort["resolveRelay"]>
    >;
    try {
      facts = await this.facts.resolveRelay(input);
    } catch {
      throw new CodexAuthorityFailure("CODEX_FORBIDDEN");
    }
    const session = this.sessions.getCodexSession(facts.relayId, facts.userId);
    if (!session) throw new CodexAuthorityFailure("CODEX_UNAVAILABLE");
    validateLiveBaseline(session, facts);
    validateCorrelatedResult(session, input.result);
    return this.persistence.createProfile({
      ...facts,
      label: input.label,
      result: input.result,
    });
  }

  async updateProfileStatus(input: {
    actorId: string;
    profileId: string;
    expectedRevision: number;
    result: CodexCorrelatedProfileResult;
  }) {
    let facts: CodexCanonicalProfileFacts;
    try {
      facts = await this.facts.resolveProfile(input);
    } catch {
      throw new CodexAuthorityFailure("CODEX_FORBIDDEN");
    }
    const session = this.sessions.getCodexSession(facts.relayId, facts.userId);
    if (!session) throw new CodexAuthorityFailure("CODEX_UNAVAILABLE");
    validateLiveBaseline(session, facts);
    validateCorrelatedResult(session, input.result);
    if (
      input.result.profileHandle !== facts.profileHandle ||
      input.result.profileGeneration < facts.profileGeneration ||
      input.result.accountGeneration < facts.accountGeneration
    ) {
      throw new CodexAuthorityFailure("CODEX_STALE");
    }
    return this.persistence.updateProfileStatus({
      facts,
      result: input.result,
      expectedRevision: input.expectedRevision,
    });
  }
}

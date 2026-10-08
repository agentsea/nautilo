import { createHash } from "node:crypto";
import { localExecutionDelegationGrantScope, parseLocalExecutionDelegation, type LocalExecutionDelegation } from "@nautilo/types";
import type { DesktopFilesystemGrant, DesktopFilesystemGrantFilesystemIdentity } from "@nautilo/desktop-filesystem-grants";
import type { DesktopFilesystemGrantAuthority } from "./desktop-filesystem-grants/authority";
import { revalidateDesktopFilesystemGrantRootIdentity } from "./desktop-filesystem-grants/identity";

type Capture = Omit<LocalExecutionDelegation, "projectGrantId">;
export interface DelegationLocalIdentity {
  readonly humanUserId: string;
  readonly target: LocalExecutionDelegation["target"];
  readonly profile: LocalExecutionDelegation["profile"];
  /** Current local authority generation, including pending reductions. */
  readonly epoch: string;
}
export interface LocalExecutionDelegationAuthorityOptions {
  readonly grants: Pick<DesktopFilesystemGrantAuthority, "list" | "create" | "revoke" | "getRevision">;
  readIdentity(): DelegationLocalIdentity | null;
  /** Resolve only the selected local root through the ordinary canonical owner. */
  resolveSelectedProject(): Promise<{ readonly canonicalRoot: string; readonly filesystemIdentity: DesktopFilesystemGrantFilesystemIdentity;
    /** Effective permissions already admitted by the canonical local resolver. */
    readonly access: DesktopFilesystemGrant["access"];
    readonly authorityExpiresAt?: number;
    /** Exact selected-root authority; unrelated additive grants do not revoke it. */
    isCurrent(): boolean;
  } | null>;
  /** Exact server-authenticated source request, not renderer/model fields. */
  assertCaptureSource(request: Capture): Promise<void>;
  revalidateRoot?: typeof revalidateDesktopFilesystemGrantRootIdentity;
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
    : value;
const same = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const unavailable = () => new Error("LOCAL_EXECUTION_DELEGATION_UNAVAILABLE");

/** Composition over the existing grant owner. No separate consent or process
 * registry: a Task reference must always resolve the exact retained grant. */
export function createLocalExecutionDelegationAuthority(options: LocalExecutionDelegationAuthorityOptions) {
  const inspect = (request: Capture | LocalExecutionDelegation) => {
    const identity = options.readIdentity();
    if (!identity || identity.humanUserId !== request.humanUserId || !same(identity.target, request.target)
      || (request.ceiling === "development" && !same(identity.profile, request.profile))) throw unavailable();
    return identity;
  };
  const check = (identity: DelegationLocalIdentity) => {
    if (!same(identity, options.readIdentity())) throw unavailable();
  };
  const revalidateRoot = options.revalidateRoot ?? revalidateDesktopFilesystemGrantRootIdentity;
  return {
    async capture(input: Capture): Promise<LocalExecutionDelegation> {
      const request = parseLocalExecutionDelegation({ ...input, projectGrantId: "pending" });
      if (!request) throw unavailable();
      const { projectGrantId: _pending, ...capture } = request;
      const identity = inspect(request);
      await options.assertCaptureSource(capture); check(identity);
      const project = await options.resolveSelectedProject(); check(identity);
      if (!project || !project.isCurrent() || !["read", "create_modify", "execute"].every(access => project.access.includes(access as typeof project.access[number]))) throw unavailable();
      if (project.authorityExpiresAt !== undefined && (!Number.isFinite(project.authorityExpiresAt) || project.authorityExpiresAt <= Date.now())) throw unavailable();
      const root = await revalidateRoot(project.filesystemIdentity); check(identity);
      if (!root.ok || root.canonicalRoot !== project.canonicalRoot || !same(root.filesystemIdentity, project.filesystemIdentity)) throw unavailable();
      const listed = await options.grants.list({ userId: request.humanUserId, includeHistory: true }); check(identity);
      if (!listed.ok) throw unavailable();
      const scope = localExecutionDelegationGrantScope(request.rootTaskId);
      const previous = listed.data.grants.filter(item => item.grant.subject.agentScope === scope);
      const grantId = createHash("sha256").update(JSON.stringify([
        canonical(request.target), request.humanUserId, request.rootTaskId,
      ])).digest("hex");
      const finish = async (items: typeof previous, revision: number) => {
        if (items.length !== 1) throw unavailable();
        const item = items[0]!;
        const grant = item.grant;
        if (item.status !== "active" || grant.lifetime !== "durable" || grant.id !== grantId
          || grant.canonicalRoot !== project.canonicalRoot
          || !same(grant.filesystemIdentity, project.filesystemIdentity)
          || grant.subject.userId !== request.humanUserId
          || grant.subject.relayId !== request.target.relayId
          || grant.subject.instanceId !== request.target.instanceId
          || grant.subject.agentScope !== scope
          || !same([...grant.access].sort(), [...project.access].sort())
          || (grant.expiresAt ? Date.parse(grant.expiresAt) : undefined) !== project.authorityExpiresAt) throw unavailable();
        await options.assertCaptureSource(capture); check(identity);
        const currentRoot = await revalidateRoot(project.filesystemIdentity); check(identity);
        if (!currentRoot.ok || !same(currentRoot.filesystemIdentity, project.filesystemIdentity)
          || revision !== options.grants.getRevision() || !project.isCurrent()
          || (project.authorityExpiresAt !== undefined && project.authorityExpiresAt <= Date.now())) throw unavailable();
        return { ...request, projectGrantId: grant.id };
      };
      // Deterministic identity makes concurrent replay share the existing grant
      // owner's exclusive insert. Revoked or changed capture is never repaired.
      if (previous.length > 0) return finish(previous, listed.data.revision);
      const grant: DesktopFilesystemGrant = { schemaVersion: 1, id: grantId,
        canonicalRoot: project.canonicalRoot, filesystemIdentity: project.filesystemIdentity,
        access: [...project.access], origin: "approval", lifetime: "durable",
        subject: { userId: request.humanUserId, instanceId: request.target.instanceId,
          relayId: request.target.relayId, agentScope: scope },
        createdBy: request.humanUserId, createdAt: new Date().toISOString(), policyVersion: 1,
        ...(project.authorityExpiresAt === undefined ? {} : { expiresAt: new Date(project.authorityExpiresAt).toISOString() }) };
      await options.assertCaptureSource(capture); check(identity);
      if (!project.isCurrent()) throw unavailable();
      const saved = await options.grants.create({ userId: request.humanUserId, grant, expectedRevision: listed.data.revision });
      // A concurrent identical capture can win the insert. Read the canonical
      // record and apply exactly the same final fences; other errors still deny.
      const current = await options.grants.list({ userId: request.humanUserId, includeHistory: true });
      if (!current.ok) throw unavailable();
      try { return await finish(current.data.grants.filter(item => item.grant.subject.agentScope === scope), current.data.revision); }
      catch (error) {
        if (saved.ok) await options.grants.revoke({ userId: request.humanUserId, grantId: grant.id });
        throw error;
      }
    },
    async resolve(value: unknown) {
      const request = parseLocalExecutionDelegation(value);
      if (!request) throw unavailable();
      const identity = inspect(request);
      const revision = options.grants.getRevision();
      const listed = await options.grants.list({ userId: request.humanUserId }); check(identity);
      if (!listed.ok) throw unavailable();
      const item = listed.data.grants.find(candidate => candidate.grant.id === request.projectGrantId);
      const grant = item?.grant;
      if (item?.status !== "active" || !grant?.filesystemIdentity || grant.lifetime !== "durable"
        || grant.subject.agentScope !== localExecutionDelegationGrantScope(request.rootTaskId)
        || grant.subject.relayId !== request.target.relayId || grant.subject.instanceId !== request.target.instanceId
        || grant.subject.userId !== request.humanUserId
        || !["read", "create_modify", "execute"].every(access => grant.access.includes(access as typeof grant.access[number]))) throw unavailable();
      const root = await revalidateRoot(grant.filesystemIdentity); check(identity);
      if (!root.ok || root.canonicalRoot !== grant.canonicalRoot || options.grants.getRevision() !== revision) throw unavailable();
      const authorityExpiresAt = grant.expiresAt === undefined ? undefined : Date.parse(grant.expiresAt);
      if (authorityExpiresAt !== undefined && (!Number.isFinite(authorityExpiresAt) || authorityExpiresAt <= Date.now())) throw unavailable();
      return { ...(authorityExpiresAt === undefined ? {} : { authorityExpiresAt }), delegation: request, access: [...grant.access], canonicalRoot: root.canonicalRoot, filesystemIdentity: root.filesystemIdentity,
        grantRevision: revision, isCurrent: () => same(identity, options.readIdentity()) && options.grants.getRevision() === revision
          && (authorityExpiresAt === undefined || authorityExpiresAt > Date.now()) };
    },
  };
}

/** Live connection facts supplied by Electron's existing authenticated server
 * and profile owners. Pairing here is the opaque transport reference. */
export interface LocalExecutionDelegationConnection {
  readonly humanUserId: string;
  readonly instanceId: string;
  readonly relayId: string;
  readonly desktopSessionId: string;
  readonly pairingGeneration: string;
  readonly serverOrigin: string;
  readonly serverFingerprint: string;
  readonly profile: LocalExecutionDelegation["profile"];
  readonly epoch: string;
}

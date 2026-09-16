export type VideoHostBinding = Readonly<{
  targetKey: string; userId: string; sourceHash: string; roomId: string;
}>;
export type VideoHostProject = Readonly<{ projectArtifactId: string; projectRevision: number; roomId?: string }>;
export type VideoHostSession = Readonly<VideoHostBinding & VideoHostProject & {
  token: string; expiresAt: number;
}>;

/** Parent-only authority cache. Every use checks the saved project's revision;
 * issuance is shared by concurrent readers and never follows a changed target.
 */
export function createVideoHostSessionManager(deps: {
  readProject(binding: VideoHostBinding): Promise<VideoHostProject | null>;
  issue(binding: VideoHostBinding, project: VideoHostProject): Promise<{ attestationToken: string; expiresAt: string }>;
  revoke(token: string): Promise<unknown>;
  now?: () => number;
}) {
  let current: VideoHostSession | null = null;
  let bindingKey: string | null = null;
  let epoch = 0;
  let pending: Promise<VideoHostSession | null> | null = null;
  const now = deps.now ?? Date.now;
  const revoke = (token: string) => { void deps.revoke(token).catch(() => {}); };
  const clear = () => {
    epoch += 1;
    if (current) revoke(current.token);
    current = null;
    bindingKey = null;
    pending = null;
  };
  const get = (binding: VideoHostBinding): Promise<VideoHostSession | null> => {
    const key = JSON.stringify([binding.targetKey, binding.userId, binding.sourceHash, binding.roomId]);
    if (bindingKey !== key) { clear(); bindingKey = key; }
    if (pending) return pending;
    const started = epoch;
    const isCurrent = () => epoch === started && bindingKey === key;
    const work = (async () => {
      const project = await deps.readProject(binding);
      if (!isCurrent() || !project) return null;
      if (current && current.projectArtifactId === project.projectArtifactId &&
          current.projectRevision === project.projectRevision && current.roomId === (project.roomId ?? binding.roomId) && current.expiresAt > now()) return current;
      const issued = await deps.issue(binding, project);
      if (!isCurrent()) { revoke(issued.attestationToken); return null; }
      // The server binds the revision when it issues. A save racing issuance
      // must fail closed, not label that token with a guessed client revision.
      let after: VideoHostProject | null;
      try { after = await deps.readProject(binding); }
      catch (error) { revoke(issued.attestationToken); throw error; }
      const expiresAt = Date.parse(issued.expiresAt);
      if (!isCurrent() || !after || after.projectArtifactId !== project.projectArtifactId ||
          (after.roomId ?? binding.roomId) !== (project.roomId ?? binding.roomId) ||
          after.projectRevision !== project.projectRevision || !Number.isFinite(expiresAt) || expiresAt <= now()) {
        revoke(issued.attestationToken);
        return null;
      }
      const prior = current;
      current = { ...binding, ...project, roomId: project.roomId ?? binding.roomId, token: issued.attestationToken, expiresAt };
      if (prior) revoke(prior.token);
      return current;
    })();
    pending = work;
    void work.finally(() => { if (pending === work) pending = null; }).catch(() => {});
    return work;
  };
  return { get, clear };
}

import type { OpenFileTarget } from "../components/browser-column/open-file-target";

export type AppRecoveryDraft = {
  version: 1;
  content: string;
  exact: boolean;
  baseSha256: string | null;
  baseRevision: number | null;
};
export type AppRecoveryRead = { revision: string | null; draft: AppRecoveryDraft | null };
export type AppRecoveryWrite = { expectedRevision: string | null; draft: AppRecoveryDraft | null };

export interface AppDraftRecoveryPort {
  read(target: OpenFileTarget): Promise<AppRecoveryRead>;
  write(target: OpenFileTarget, input: AppRecoveryWrite): Promise<{ revision: string | null }>;
  dispose(): void;
}

export function isAppRecoveryDraft(value: unknown): value is AppRecoveryDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every(key => ["version", "content", "exact", "baseSha256", "baseRevision"].includes(key))
    && record.version === 1 && typeof record.content === "string" && typeof record.exact === "boolean"
    && (record.baseSha256 === null || typeof record.baseSha256 === "string")
    && (record.baseRevision === null || (typeof record.baseRevision === "number" && Number.isSafeInteger(record.baseRevision) && record.baseRevision >= 0));
}

type NativeRecoveryTarget =
  | { kind: "workspace_artifact"; artifactInternalId: string }
  | { kind: "local_file"; relayId: string; candidatePath: string };
type NativeRecoveryAppId = "nautilo-presentation" | "nautilo-board";
export type NativeAppRecovery = {
  open(input: { expectedViewerId: string; appId: NativeRecoveryAppId; target: NativeRecoveryTarget }): Promise<{ handle: string }>;
  read(handle: string): Promise<AppRecoveryRead>;
  write(handle: string, input: AppRecoveryWrite): Promise<{ revision: string }>;
  close(handle: string): Promise<void>;
};

/** The sandbox never supplies a user, filesystem path, storage key or handle.
 * Native main authenticates the binding; later writes need no server request. */
export function createAppDraftRecovery(options: {
  appId: string;
  viewerKey: string | null;
  native: NativeAppRecovery | null | undefined;
  getRelayId(): Promise<string | null>;
}): AppDraftRecoveryPort {
  const handles = new Map<string, Promise<string>>();
  let disposed = false;
  function assertActive(): void {
    if (disposed) throw new Error("This recovery session is closed.");
  }
  async function resolveHandle(target: OpenFileTarget): Promise<string> {
    assertActive();
    const { native, viewerKey } = options;
    if (!native || !viewerKey) throw new Error("Crash recovery requires a signed-in Desktop with recovery support.");
    if (options.appId !== "nautilo-presentation" && options.appId !== "nautilo-board") throw new Error("Crash recovery is unavailable for this app.");
    const appId: NativeRecoveryAppId = options.appId === "nautilo-presentation" ? "nautilo-presentation" : "nautilo-board";
    const identity = target.kind === "artifact"
      ? JSON.stringify(["artifact", target.id])
      : JSON.stringify(["fs", target.rootPath, target.path]);
    let pending = handles.get(identity);
    if (!pending) {
      pending = (async () => {
        const relayId = target.kind === "fs" ? await options.getRelayId() : null;
        assertActive();
        if (target.kind === "fs" && !relayId) throw new Error("The local filesystem relay is unavailable for recovery.");
        const binding: NativeRecoveryTarget = target.kind === "artifact"
          ? { kind: "workspace_artifact", artifactInternalId: target.id }
          : { kind: "local_file", relayId: relayId!, candidatePath: target.path };
        const result = await native.open({ expectedViewerId: viewerKey, appId, target: binding });
        if (disposed) {
          await native.close(result.handle);
          throw new Error("This recovery session is closed.");
        }
        return result.handle;
      })();
      handles.set(identity, pending);
      // Failed initialization can be retried by a later explicit bridge call.
      void pending.catch(() => { if (handles.get(identity) === pending) handles.delete(identity); });
    }
    return pending;
  }
  return {
    async read(target) {
      const handle = await resolveHandle(target);
      assertActive();
      const result = await options.native!.read(handle);
      assertActive();
      return result;
    },
    async write(target, input) {
      const handle = await resolveHandle(target);
      assertActive();
      return options.native!.write(handle, input);
    },
    dispose() {
      disposed = true;
      for (const pending of handles.values()) void pending.then(handle => options.native!.close(handle)).catch(() => {});
      handles.clear();
    },
  };
}

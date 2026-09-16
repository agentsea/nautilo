/**
 * Discriminate the editor's / mini-app's own coordinator saves from external
 * committed events. The historical export names are retained while both
 * Workspace artifacts and Desktop local files migrate to this exact ledger.
 *
 * Legacy producers can emit both `changed` and `document.patch.applied`, while
 * the coordinator emits one `document.mutation.committed` editor-save receipt.
 * Recognition is non-consuming with a short TTL so either compatibility shape
 * is safely suppressed. The shell and patch hook read the same registry;
 * WorkbenchShell resolves own-save outside React updaters to stay StrictMode-safe.
 */
type LocalSaveState =
  | "pending"
  | "committed"
  | "echoed_pending"
  | "echoed_committed"
  | "finalized";
const localArtifactSaveMutations = new Map<string, LocalSaveState>();

export function registerLocalArtifactSaveMutation(id: string): void {
  localArtifactSaveMutations.set(id, "pending");
}

/** Resolve the request lifecycle without using wall-clock time as correctness. */
export function settleLocalArtifactSaveMutation(id: string, committed: boolean): void {
  const state = localArtifactSaveMutations.get(id);
  if (!committed) {
    localArtifactSaveMutations.delete(id);
  } else if (state === "finalized" || state === "echoed_committed") {
    localArtifactSaveMutations.delete(id);
  } else if (state === "echoed_pending") {
    localArtifactSaveMutations.set(id, "echoed_committed");
  } else {
    localArtifactSaveMutations.set(id, "committed");
  }
}

export function isLocalArtifactSaveMutation(id: string | undefined): boolean {
  return classifyLocalArtifactSaveMutation(id);
}

function classifyLocalArtifactSaveMutation(id: string | undefined): boolean {
  if (!id) return false;
  const state = localArtifactSaveMutations.get(id);
  if (state === undefined) return false;
  if (state === "pending") localArtifactSaveMutations.set(id, "echoed_pending");
  if (state === "committed") localArtifactSaveMutations.set(id, "echoed_committed");
  return true;
}

export function consumeLocalArtifactSaveMutation(id: string | undefined): boolean {
  return classifyLocalArtifactSaveMutation(id);
}

/** Called once after every subscriber has classified the exact coordinator event. */
export function finalizeLocalArtifactSaveMutationEvent(id: string | undefined): void {
  if (!id) return;
  const state = localArtifactSaveMutations.get(id);
  if (state === "echoed_pending") localArtifactSaveMutations.set(id, "finalized");
  if (state === "echoed_committed") localArtifactSaveMutations.delete(id);
}

/** Test-only helper to avoid cross-test registry bleed. */
export function clearLocalArtifactSaveMutationsForTests(): void {
  localArtifactSaveMutations.clear();
}

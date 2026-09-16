/** Refresh paid-media clients only when the effective Venice credential changes. */
export function createMediaGenerationCredentialRefresh(options: {
  resolveKey: () => string | null;
  installRuntime: () => boolean;
  installWorker: () => boolean;
}): () => void {
  let previousKey = options.resolveKey()?.trim() || null;
  return () => {
    const currentKey = options.resolveKey()?.trim() || null;
    if (currentKey === previousKey) return;
    // Reset-first installers remove stale admission and worker credentials.
    // Record the new state only after both succeed, allowing a later retry.
    const runtimeAvailable = options.installRuntime();
    const workerAvailable = options.installWorker();
    if (currentKey === null || (runtimeAvailable && workerAvailable)) previousKey = currentKey;
  };
}

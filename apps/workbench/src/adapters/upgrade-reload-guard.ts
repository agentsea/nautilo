/**
 * Cross-tree signal for the deployment refresh affordance. The notice lives
 * in the shell while the Composer is deeper in the conversation tree.
 */
let hasUnsentComposerText = false;
const listeners = new Set<() => void>();

export function setHasUnsentComposerText(value: boolean): void {
  if (hasUnsentComposerText === value) return;
  hasUnsentComposerText = value;
  for (const listener of listeners) listener();
}

export function getHasUnsentComposerText(): boolean {
  return hasUnsentComposerText;
}

export function subscribeUpgradeReloadGuard(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Device-local microphone priority; does not stop server work or other devices. */
const listeners = new Set<() => void>();
export function subscribeMediaInterruption(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function interruptMediaForRecording(): void {
  for (const listener of listeners) {
    // A decoder already torn down must not prevent other players from pausing
    // or leave the user's microphone request stranded.
    try { listener(); } catch { /* Native playback may have ended concurrently. */ }
  }
}

/** Only producer-attested continuation work is automatic. A partial result or
 * a model's NONE answer alone is not permission to repeat an observation. */
export function nextChoiceContinuation<T>(coverage: {
  complete: boolean;
  continuation: { key: string; request: T } | null;
}, attempted: readonly string[]):
  | { kind: "none" }
  | { kind: "stalled" }
  | { kind: "continue"; request: T; attempted: string[] } {
  if (coverage.complete || !coverage.continuation) return { kind: "none" };
  if (!coverage.continuation.key || attempted.includes(coverage.continuation.key)) return { kind: "stalled" };
  return { kind: "continue", request: coverage.continuation.request, attempted: [...attempted, coverage.continuation.key] };
}

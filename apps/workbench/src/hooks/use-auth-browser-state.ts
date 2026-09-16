/**
 * Pure browser auth-state derivation kept outside `use-auth.ts`.
 *
 * Several Workbench unit tests partially mock `use-auth.ts`; Bun's module
 * mocks are process-persistent, so helper tests that import named exports
 * from that module can fail when a sibling mock omits the helper. Keep this
 * leaf module unmocked and dependency-free.
 */
export type AuthSessionState = "unknown" | "signed-out" | "signing-in" | "signed-in";

export function computeBrowserAuthState(input: {
  previous: AuthSessionState;
  isLoading: boolean;
  isAuthenticated: boolean;
}): AuthSessionState {
  if (input.isLoading) return input.previous;
  const next: AuthSessionState = input.isAuthenticated ? "signed-in" : "signed-out";
  if (input.previous === "signing-in" && !input.isAuthenticated) return input.previous;
  return next;
}

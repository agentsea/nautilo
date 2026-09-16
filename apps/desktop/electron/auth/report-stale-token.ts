/**
 * M097 — stale-token recovery: clear persisted Logto bundle + broadcast
 * signed-out. Default `clearTokens` is resolved lazily so unit tests can
 * inject a mock without loading `electron`.
 */
export function reportStaleToken(
  broadcastAuthState: (state: "signed-in" | "signed-out") => void,
  clearTokensImpl?: () => void,
): void {
  const clear =
    clearTokensImpl ??
    (() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./token-store-electron") as typeof import("./token-store-electron");
      mod.clearTokens();
    });
  clear();
  broadcastAuthState("signed-out");
}

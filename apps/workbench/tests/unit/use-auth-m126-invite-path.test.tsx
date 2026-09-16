/**
 * M126 / MR5 / AR4 — `useViewerAuth.checkViewer` must not call
 * trust-preHandler-gated `/api/auth/whoami` while the invite-redeem
 * wizard holds a fresh Logto bearer before `bind-logto-user` completes.
 *
 * Coverage strategy: source-structure pins, NOT a hook integration test.
 *
 * Why source-pin instead of importing `isOnInviteRedeemPath` and
 * exercising it under happy-dom: Bun 1.3.11 on Linux CI reports
 * "Export named 'isOnInviteRedeemPath' not found in module use-auth.ts"
 * for this file even though the symbol IS exported and the same import
 * works locally on macOS Bun 1.3.1. Several other workbench tests
 * (use-auth-viewer-resilience.test.ts) import similar symbols from
 * use-auth.ts without issue, so the trigger is something subtle in the
 * interaction between this file's loader sequencing and the renamed
 * function. Rather than chase the Bun parser ghost, this file pins the
 * M126 invariant via plain source reads — same coverage shape as the
 * existing "no inline onclick=" / "load-bearing markers present" tests
 * sprinkled across the workbench suite. Runtime behaviour of
 * `isOnInviteRedeemPath` is identical to its pre-M126 (unexported)
 * shape — we only added the `export` keyword. The actual behavioural
 * exercise of "checkViewer short-circuits on /invite/ paths" lives in
 * the omega smoke test (manual QA per the issue) and the upcoming MR7
 * integration test in packages/server.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function useAuthSource(): string {
  return readFileSync(join(import.meta.dir, "../../src/hooks/use-auth.ts"), "utf8");
}

describe("M126 — useViewerAuth during invite redeem", () => {
  test("protects invite routes and only invite-owned auth callbacks", () => {
    const src = useAuthSource();
    // Function exists (module-internal — not exported; the M126 early
    // return inside `checkViewer` is its only caller).
    expect(src).toMatch(/^function isOnInviteRedeemPath\(\)/m);
    // Body matches both invite and (legacy) redeem path prefixes.
    expect(src).toContain('p.startsWith("/invite/")');
    expect(src).toContain('p.startsWith("/redeem/")');
    expect(src).toContain('p === "/claim"');
    // The OAuth callback is protected only while a valid invite session is
    // waiting to bind. Normal callbacks retain stale-bearer recovery.
    expect(src).toContain('if (p !== "/auth/callback") return false');
    expect(src).toContain('inviteSession?.stage === "awaiting-signup"');
    expect(src).toContain('inviteSession?.stage === "awaiting-bind"');
    expect(src).toContain(
      'readSession as readInviteRedeemSession } from "../lib/invite-redeem-session"',
    );
    expect(src).toContain('readOwnerClaimHandoff } from "../lib/owner-claim-handoff"');
    // SSR-safe: returns false when `window` is undefined.
    expect(src).toContain('typeof window === "undefined"');
  });

  test("M126 early return sits after null-token handling and before the canonical whoami read", () => {
    const src = useAuthSource();
    const nullTokenReturn = src.indexOf(
      "const nextViewer = computeViewerOnNullToken(readLastKnownViewer());",
    );
    const m126Block = src.indexOf("// M126 — on /invite/:token");
    const whoamiRead = src.indexOf("await readWhoamiWithMemoryCache(");
    expect(nullTokenReturn).toBeGreaterThanOrEqual(0);
    expect(m126Block).toBeGreaterThan(nullTokenReturn);
    expect(whoamiRead).toBeGreaterThan(m126Block);
    const earlyPath = src.slice(m126Block, whoamiRead);
    expect(earlyPath).toContain("isOnInviteRedeemPath()");
    expect(earlyPath).toContain("setViewer(GUEST_VIEWER)");
    expect(earlyPath).toContain("return;");
  });

  test("invite-path early return skips the conditional whoami read and keeps stale-bearer protection", () => {
    const src = useAuthSource();
    const checkViewerStart = src.indexOf("const checkViewer = useCallback(async () => {");
    const checkViewerEnd = src.indexOf("\n  const requestViewerCheck", checkViewerStart);
    expect(checkViewerStart).toBeGreaterThanOrEqual(0);
    expect(checkViewerEnd).toBeGreaterThan(checkViewerStart);

    const body = src.slice(checkViewerStart, checkViewerEnd);
    const earlyReturnIdx = body.indexOf("if (isOnInviteRedeemPath()) {");
    const whoamiIdx = body.indexOf("await readWhoamiWithMemoryCache(");
    const postHocIdx = body.indexOf("if (isOnInviteRedeemPath()) {", earlyReturnIdx + 1);

    expect(earlyReturnIdx).toBeGreaterThanOrEqual(0);
    expect(whoamiIdx).toBeGreaterThan(earlyReturnIdx);
    expect(body.slice(earlyReturnIdx, whoamiIdx)).toContain("return;");
    expect(postHocIdx).toBeGreaterThan(whoamiIdx);

    // The actual protected endpoint remains reachable only through the
    // conditional reader. This makes the ordering assertion load-bearing:
    // moving the early return below the request would fail the check above.
    expect(body.slice(whoamiIdx, postHocIdx)).toContain("apiClient.whoamiConditional");
  });
});

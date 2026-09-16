/**
 * Stack 19 Phase 4 (D157) — pin the load-bearing invariants of the D157
 * patches in setup-instance.ts:
 *
 * Phase 1 (4.7) — auto-source instance.env BEFORE config-guard validation.
 *   Implemented via `loadConfigEnvIntoProcess()` from `lib/config-env.ts`
 *   (M053-era helper; M107 fixed its underlying `resolveDotenvPath` to
 *   target `~/.nautilo${suffix}/instance.env` post-M091). Stack 19's
 *   contribution is wiring it into `setupInstanceCmd`'s entry-point
 *   alongside the existing migrate-to-username-identity / verify-user-link
 *   call sites. The loader itself has its own M053-era unit tests at
 *   `bin/nautilo-dev/tests/unit/config-env.test.ts`; here we pin the
 *   WIRING (structural inspection that setupInstanceCmd calls it).
 *
 *   Original D157 Phase 1 shipped `loadInstanceEnvIntoProcessEnv` as a
 *   net-new helper. Post-M107 audit (Stack 19 phase-4-task-doc post-rebase
 *   audit item) showed it was redundant with `loadConfigEnvIntoProcess` —
 *   same file, same semantics, same purpose. Refactored to single-source
 *   the canonical loader. The 6 phase-1-specific test cases here got
 *   dropped because they were testing the deleted helper; the wiring
 *   pin below is what's load-bearing.
 *
 * Phase 2 (4.8) — claimed-needs-auth recovery via re-redeem path:
 *   - `tryRedeemClaimAndExtractBearer` is NOT directly exported (it's a
 *     module-internal helper); we test the OBSERVABLE BEHAVIOR via the
 *     `claimed-needs-auth` setupState branch in `runSetupInstance`.
 *   - Pre-D157 behavior: claimed-needs-auth → exit 2 + a vague owner
 *     sign-in warning. The branch never attempted
 *     re-redeem.
 *   - Post-D157 behavior:
 *       (a) claimed-needs-auth + readClaimInvite returns token +
 *           redeemInvite resolves + setAuthFromRedeem returns true →
 *           continue to consumeProviders + stamp deployConfigConsumedAt.
 *       (b) claimed-needs-auth + readClaimInvite returns null (no token
 *           on disk) → exit 2 + IMPROVED message naming Workbench /
 *           ISSUE-D157 (NOT the pre-D157 generic message).
 *       (c) claimed-needs-auth + redeemInvite throws → exit 2 + IMPROVED
 *           message mentioning idempotency invariant + recovery paths.
 *
 * We don't exercise Path (a) end-to-end here because the
 * consumeProviders + postReloadEnv + stamp chain has substantial
 * dependencies that are already covered by setup-instance.test.ts's
 * fresh-unclaimed happy path (the new code reuses the SAME helper as
 * fresh-unclaimed, so by structural equivalence the same chain runs).
 * We pin Paths (b) + (c) at the entry-point level.
 */
import { describe, expect, test } from "bun:test";
import { runSetupInstance } from "../../src/commands/setup-instance";
import type {
  SetupInstanceDeps,
  SetupInstanceStatus,
} from "../../src/commands/setup-instance";
import type { RedeemResult } from "@nautilo/api-client";

// ---------------------------------------------------------------------------
// D157 Phase 2 — claimed-needs-auth recovery via runSetupInstance
// ---------------------------------------------------------------------------

/**
 * Minimal SetupInstanceDeps fixture for the D157 Phase 2 branch.
 *
 * We exercise the `claimed-needs-auth` setupState branch via:
 *   - resolveStatus returns claimed-needs-auth + deployConfigConsumedAt: null
 *   - loadDeployConfig / resolveSecrets stubbed to a minimal valid shape
 *   - readClaimInvite + redeemInvite are the under-test injection points
 */
type Captured = { warns: string[]; logs: string[] };

function makeDeps(opts: {
  setupState: SetupInstanceStatus["setupState"];
  readClaimInvite?: () => string | null;
  redeemInvite?: SetupInstanceDeps["redeemInvite"];
  setAuthFromRedeem?: SetupInstanceDeps["setAuthFromRedeem"];
  consumeProviders?: SetupInstanceDeps["consumeProviders"];
}): { deps: SetupInstanceDeps; captured: Captured } {
  const captured: Captured = { warns: [], logs: [] };
  const status: SetupInstanceStatus = {
    setupState: opts.setupState,
    instanceId: "d157-test",
    deploymentMode: "local-self-host",
    claimRequired: false,
    serverUrl: "http://127.0.0.1:3001",
    recommendedSetupSurface: { kind: "cli", url: null },
    deployConfigConsumedAt: null,
  };
  const deps: SetupInstanceDeps = {
    resolveStatus: async () => status,
    redeemInvite:
      opts.redeemInvite ??
      ((async () => ({}) as unknown as RedeemResult) as SetupInstanceDeps["redeemInvite"]),
    setAuthFromRedeem: opts.setAuthFromRedeem ?? (() => true),
    consumeProviders: opts.consumeProviders ?? (async () => []),
    postReloadEnv: async () => ({ ok: true, status: 200 }),
    stampDeployConsumed: () => {},
    readConsumedStamp: () => null,
    readClaimInvite: opts.readClaimInvite ?? (() => null),
    loadDeployConfig: () => ({
      schemaVersion: 1,
      admin: { handle: "owner", displayName: "Owner", passwordEnv: "PW" },
      providers: {},
    }) as unknown as ReturnType<SetupInstanceDeps["loadDeployConfig"]>,
    resolveSecrets: (cfg) =>
      ({
        ...cfg,
        admin: { ...((cfg as unknown as Record<string, Record<string, unknown>>)["admin"] ?? {}), password: "test-pw" },
      }) as unknown as ReturnType<SetupInstanceDeps["resolveSecrets"]>,
    envLookup: () => undefined,
    log: (s) => captured.logs.push(s),
    warn: (s) => captured.warns.push(s),
  };
  return { deps, captured };
}

describe("runSetupInstance — claimed-needs-auth recovery (D157 Phase 2)", () => {
  test("Path (b): no claim invite on disk → exit 2 + IMPROVED message mentioning workbench + cli + ISSUE-D157", async () => {
    const { deps, captured } = makeDeps({
      setupState: "claimed-needs-auth",
      readClaimInvite: () => null,
    });
    const code = await runSetupInstance(deps, {
      instanceId: "d157-test",
      serverUrl: "http://127.0.0.1:3001",
    });
    expect(code).toBe(2);
    const joined = captured.warns.join("\n");
    expect(joined).toContain("claimed-needs-auth");
    expect(joined).toContain("claim invite not available for re-redeem");
    // LOAD-BEARING: the IMPROVED message must mention recovery options + ISSUE pointer.
    expect(joined).toContain("workbench");
    expect(joined).toContain("ISSUE-D157");
  });

  test("Path (c): redeemInvite throws → exit 2 + IMPROVED message mentioning idempotency invariant", async () => {
    const { deps, captured } = makeDeps({
      setupState: "claimed-needs-auth",
      readClaimInvite: () => "valid-claim-token-shape",
      redeemInvite: async () => {
        throw new Error("HTTP 409: invite already redeemed");
      },
    });
    const code = await runSetupInstance(deps, {
      instanceId: "d157-test",
      serverUrl: "http://127.0.0.1:3001",
    });
    expect(code).toBe(2);
    const joined = captured.warns.join("\n");
    expect(joined).toContain("claimed-needs-auth re-redeem attempt FAILED");
    expect(joined).toContain("HTTP 409: invite already redeemed");
    expect(joined).toContain("idempotency invariant");
    expect(joined).toContain("ISSUE-D157");
  });

  test("Pre-D157 regression guard: claimed-needs-auth no longer returns the pre-D157 generic message", async () => {
    // Pre-D157: warn message was
    //   "setupState=claimed-needs-auth — complete owner sign-in, then retry."
    // Post-D157: that exact phrase is NOT in the new failure messages.
    // (Workbench is still mentioned, but as "Sign in via the workbench...", not the old phrasing.)
    const { deps, captured } = makeDeps({
      setupState: "claimed-needs-auth",
      readClaimInvite: () => null,
    });
    await runSetupInstance(deps, { instanceId: "d157-test", serverUrl: "http://127.0.0.1:3001" });
    const joined = captured.warns.join("\n");
    expect(joined).not.toContain("complete owner sign-in, then retry");
    expect(joined).not.toContain("NOT stamping deployConfigConsumedAt");
  });
});

describe("D157 Phase 1 entry-point wiring (auto-source instance.env)", () => {
  test("setupInstanceCmd calls loadConfigEnvIntoProcess from lib/config-env (structural pin)", async () => {
    // Static text inspection rather than runtime exercise — setupInstanceCmd
    // depends on resolveNautiloRootDir + a real instance.env layout, which
    // is too heavy for a unit-level pin. If a future refactor accidentally
    // drops the loadConfigEnvIntoProcess call from setupInstanceCmd,
    // this assertion fails before the change ships.
    //
    // Originally this pin checked for `loadInstanceEnvIntoProcessEnv` (the
    // bespoke D157 helper). Post-rebase audit (M107 PR #195) showed that
    // helper was redundant with the canonical `loadConfigEnvIntoProcess`
    // from `bin/nautilo-dev/src/lib/config-env.ts` — same file
    // (`resolveDotenvPath()` → `~/.nautilo${suffix}/instance.env`),
    // same semantics. Refactored to call the canonical loader; pin updated.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(import.meta.dir, "../../src/commands/setup-instance.ts"),
      "utf8",
    );
    expect(src).toContain('import { loadConfigEnvIntoProcess } from "../lib/config-env"');
    expect(src).toContain("loadConfigEnvIntoProcess();");
  });
});

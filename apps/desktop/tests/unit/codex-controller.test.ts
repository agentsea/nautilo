import { describe, expect, test } from "bun:test";
import type { ChildIdentity } from "@nautilo/codex-app-server-host/internal";
import { CODEX_REVIEWED_RUNTIME_ARTIFACT_REF, parseRelayCodexClientMessage, type HostScope, type ProfileLaunchScope, type ProfileScope, type RelayCodexSession } from "@nautilo/relay";
import { ElectronCodexController, isOfficialLoginUrl, type ElectronCodexTimerPort } from "../../electron/codex-controller.ts";

const session: RelayCodexSession = {
  relayId: "relay", relaySessionId: "session", desktopSessionId: "desktop", pairingGenerationRef: "pairing", selectedProtocolVersion: 8, capabilityRevision: 3,
};
const hostScope: HostScope = { ...session };
const launchScope: ProfileLaunchScope = { ...session, profileHandle: "profile", profileGeneration: 1, accountGeneration: 2, runtimeGeneration: 3 };
const profileScope: ProfileScope = { ...launchScope, childGeneration: 1 };

describe("ElectronCodexController", () => {
  test("accepts only exact official login origins", () => {
    for (const value of ["https://auth.openai.com/authorize", "https://chatgpt.com/auth?x=1"]) expect(isOfficialLoginUrl(value)).toBeTrue();
    for (const value of [
      "http://auth.openai.com/authorize", "https://openai.com/", "https://auth.openai.com.evil.test/",
      "https://sub.auth.openai.com/", "https://chatgpt.com.evil.test/", "https://user@auth.openai.com/",
      "https://auth.openai.com:444/", "https://chatgpt.com:444/", "notaurl",
    ]) expect(isOfficialLoginUrl(value)).toBeFalse();
  });

  test("does not expose a login ref when validation or Electron opening fails, and cancels upstream", async () => {
    const invalid = fixture({ authUrl: "https://auth.openai.com.evil.test/" });
    await invalid.attach();
    await ready(invalid.controller);
    expect(await invalid.controller.execute(profileScope, { kind: "account_login_start" })).toEqual({ kind: "rejected", code: "CODEX_CONTEXT_INVALID" });
    expect(invalid.cancelled).toEqual(["upstream-secret"]);

    const failed = fixture({ openFails: true });
    await failed.attach();
    await ready(failed.controller);
    expect(await failed.controller.execute(profileScope, { kind: "account_login_start" })).toEqual({ kind: "rejected", code: "CODEX_CONTEXT_INVALID" });
    expect(failed.cancelled).toEqual(["upstream-secret"]);
    expect(failed.opened).toEqual(["https://auth.openai.com/authorize?device=secret"]);
  });

  test("claims login refs before await and rejects replay, stale scope, and expiry without leaking material", async () => {
    let now = 10;
    const fx = fixture({ now: () => now });
    await fx.attach();
    await ready(fx.controller);
    const started = await fx.controller.execute(profileScope, { kind: "account_login_start" });
    if (started.kind !== "login_started") throw new Error("missing login ref");
    const stale = await fx.controller.execute({ ...profileScope, relaySessionId: "other" }, { kind: "account_login_cancel", loginRef: started.loginRef });
    expect(stale).toEqual({ kind: "rejected", code: "CODEX_CONTEXT_STALE" });
    expect(await fx.controller.execute(profileScope, { kind: "account_login_cancel", loginRef: started.loginRef })).toEqual({ kind: "account_status", state: "signed_in", accountGeneration: 2, accountEmail: "person@example.test", planType: "pro" });
    expect(await fx.controller.execute(profileScope, { kind: "account_login_cancel", loginRef: started.loginRef })).toEqual({ kind: "rejected", code: "CODEX_CORRELATION_REPLAY" });

    const fresh = await fx.controller.execute(profileScope, { kind: "account_login_start" });
    if (fresh.kind !== "login_started") throw new Error("missing login ref");
    now += 600_000;
    expect(await fx.controller.execute(profileScope, { kind: "account_login_cancel", loginRef: fresh.loginRef })).toEqual({ kind: "rejected", code: "CODEX_TIMEOUT" });
    expect(JSON.stringify([started, fresh, stale])).not.toContain("upstream-secret");
    expect(JSON.stringify([started, fresh, stale])).not.toContain("device=secret");
  });

  test("publishes the profile transition when an unattended login expires", async () => {
    const timer = new ManualTimer();
    const statusUpdates: number[] = [];
    const fx = fixture({ timer, statusUpdates });
    await fx.attach();
    await ready(fx.controller);
    const started = await fx.controller.execute(profileScope, { kind: "account_login_start" });
    if (started.kind !== "login_started") throw new Error("missing login ref");
    expect(fx.controller.status()).toMatchObject({ profiles: [{ state: "busy" }] });
    const beforeExpiry = statusUpdates.length;

    timer.fireAll();
    await fx.controller.execute(profileScope, { kind: "account_read" });

    expect(fx.controller.status()).toMatchObject({ profiles: [{ state: "signed_in" }] });
    expect(statusUpdates.length).toBeGreaterThan(beforeExpiry);
    expect(fx.cancelled).toEqual(["upstream-secret"]);
  });

  test("returns bounded display identity after cancellation without projecting auth material", async () => {
    const fx = fixture();
    await fx.attach();
    await ready(fx.controller);
    const started = await fx.controller.execute(profileScope, { kind: "account_login_start" });
    if (started.kind !== "login_started") throw new Error("missing login ref");
    const result = await fx.controller.execute(profileScope, { kind: "account_login_cancel", loginRef: started.loginRef });
    expect(result).toEqual({ kind: "account_status", state: "signed_in", accountGeneration: 2, accountEmail: "person@example.test", planType: "pro" });
    expect(JSON.stringify(result)).toContain("person@example.test");
    expect(JSON.stringify(result)).not.toContain("token-secret");
  });

  test("treats a populated managed ChatGPT account as signed in when OpenAI auth is required", async () => {
    const fx = fixture({ requiresOpenaiAuth: true });
    await fx.attach();
    await ready(fx.controller);

    expect(await fx.controller.execute(profileScope, { kind: "account_read" })).toEqual({
      kind: "account_status",
      state: "signed_in",
      accountGeneration: 2,
      accountEmail: "person@example.test",
      planType: "pro",
    });
  });

  test("publishes signed_in immediately after account polling consumes a completed browser login", async () => {
    const fx = fixture();
    await fx.attach();
    await ready(fx.controller);
    const started = await fx.controller.execute(profileScope, { kind: "account_login_start" });
    if (started.kind !== "login_started") throw new Error("missing login ref");

    expect(fx.controller.status()).toMatchObject({
      profiles: [{ profileHandle: "profile", state: "busy" }],
    });
    expect(await fx.controller.execute(profileScope, { kind: "account_read" })).toEqual({
      kind: "account_status",
      state: "signed_in",
      accountGeneration: 2,
      accountEmail: "person@example.test",
      planType: "pro",
    });
    expect(fx.controller.status()).toMatchObject({
      profiles: [{ profileHandle: "profile", state: "signed_in" }],
    });
    expect(
      await fx.controller.execute(profileScope, {
        kind: "account_login_cancel",
        loginRef: started.loginRef,
      }),
    ).toEqual({ kind: "rejected", code: "CODEX_CORRELATION_REPLAY" });
    expect(fx.cancelled).toEqual([]);
  });

  test("does not let a never-settling login cancellation wedge profile removal or close", async () => {
    const fx = fixture({ cancelGate: new Promise<void>(() => undefined) }); await fx.attach(); await ready(fx.controller);
    const login = await fx.controller.execute(profileScope, { kind: "account_login_start" }); if (login.kind !== "login_started") throw new Error("missing login");
    expect(await fx.controller.execute(launchScope, { kind: "profile_remove", profileHandle: "profile", profileGeneration: 1 })).toEqual({ kind: "profile_status", state: "removed", profileHandle: "profile", profileGeneration: 1 }); expect(fx.removals()).toBe(1); await fx.controller.close();
  });

  test("keeps a fingerprint generation stable, cleans cancelled installs, and closes gates", async () => {
    const installs: AbortSignal[] = [];
    const fx = fixture({ installs });
    expect(await fx.controller.execute(hostScope, { kind: "runtime_inspect" })).toEqual({ kind: "rejected", code: "CODEX_CAPABILITY_UNAVAILABLE" });
    await fx.attach();
    await fx.controller.enable(session);
    expect(await fx.controller.execute(hostScope, { kind: "runtime_install", artifactRef: "unreviewed" })).toEqual({ kind: "rejected", code: "CODEX_CAPABILITY_UNAVAILABLE" });
    expect(await fx.controller.execute(hostScope, { kind: "runtime_install", artifactRef: "reviewed-codex-runtime-artifact" })).toEqual({ kind: "rejected", code: "CODEX_CAPABILITY_UNAVAILABLE" });
    expect(installs).toHaveLength(0);
    expect(await fx.controller.execute(hostScope, { kind: "runtime_inspect" })).toEqual({ kind: "runtime_status", state: "ready", runtimeGeneration: 1 });
    expect(await fx.controller.execute(hostScope, { kind: "runtime_inspect" })).toEqual({ kind: "runtime_status", state: "ready", runtimeGeneration: 1 });
    const installing = await fx.controller.execute(hostScope, { kind: "runtime_install", artifactRef: CODEX_REVIEWED_RUNTIME_ARTIFACT_REF });
    if (installing.kind !== "runtime_status" || !installing.installRef) throw new Error("missing install ref");
    expect(await fx.controller.execute(hostScope, { kind: "runtime_install", artifactRef: CODEX_REVIEWED_RUNTIME_ARTIFACT_REF })).toEqual(installing);
    expect(await fx.controller.execute(hostScope, { kind: "runtime_cancel_install", installRef: installing.installRef })).toEqual({ kind: "runtime_status", state: "ready", runtimeGeneration: 1 });
    expect(installs).toHaveLength(1);
    expect(installs[0]?.aborted).toBeTrue();
    expect(await fx.controller.execute(hostScope, { kind: "runtime_cancel_install", installRef: installing.installRef })).toEqual({ kind: "rejected", code: "CODEX_CORRELATION_REPLAY" });
    expect(await fx.controller.execute(hostScope, { kind: "runtime_activate", runtimeGeneration: 1 })).toEqual({ kind: "runtime_status", state: "ready", runtimeGeneration: 1 });
    await fx.controller.close();
    expect(await fx.controller.execute(hostScope, { kind: "runtime_inspect" })).toEqual({ kind: "rejected", code: "CODEX_CAPABILITY_UNAVAILABLE" });
  });

  test("restores an inspected compatible runtime and projects exact safe profile generations", async () => {
    const fx = fixture();
    await fx.attach();
    await fx.controller.enable(session);
    expect(fx.controller.status()).toEqual({ state: "runtime_unavailable", runtime: { state: "absent" } });
    await fx.controller.execute(hostScope, { kind: "runtime_inspect" });
    expect(fx.controller.status()).toMatchObject({
      state: "ready",
      compatibility: "certified",
      runtimeGeneration: 1,
      runtime: { state: "ready" },
    });
    await fx.controller.execute(hostScope, { kind: "runtime_activate", runtimeGeneration: 1 });
    expect(fx.controller.status()).toMatchObject({
      state: "ready",
      compatibility: "certified",
      runtimeGeneration: 1,
      runtime: { state: "ready" },
      features: { stableConversation: true, collaborationMode: true },
    });
    await fx.controller.execute(hostScope, { kind: "profile_create", profileHandle: "profile", profileGeneration: 1 });
    expect(fx.controller.status()).toMatchObject({
      profiles: [{ profileHandle: "profile", profileGeneration: 1, accountGeneration: 0, state: "signed_out" }],
    });
    await fx.controller.ensureProfileChild(launchScope);
    expect(fx.controller.status()).toMatchObject({
      profiles: [{ profileHandle: "profile", profileGeneration: 1, accountGeneration: 2, state: "signed_out", childGeneration: 1 }],
    });
    await fx.controller.execute(profileScope, { kind: "account_read" });
    const status = fx.controller.status();
    expect(status).toMatchObject({ profiles: [{ state: "signed_in", childGeneration: 1 }] });
    expect(JSON.stringify(status)).not.toMatch(/home-opaque|upstream-secret|device=secret|private/i);
  });

  test("publishes bounded provenance for an incompatible inspected runtime", async () => {
    const fx = fixture({
      inspectResult: {
        state: "incompatible",
        source: "external",
        version: "0.146.0-alpha.3.1",
        compatibilityDiagnostics: [{
          feature: "core",
          reason: "changed_field_shape",
        }],
      },
    });
    await fx.attach();
    await fx.controller.enable(session);
    expect(await fx.controller.execute(hostScope, { kind: "runtime_inspect" })).toEqual({
      kind: "runtime_status",
      state: "incompatible",
    });
    expect(fx.controller.status()).toEqual({
      state: "runtime_incompatible",
      runtime: {
        state: "incompatible",
        source: "external",
        version: "0.146.0-alpha.3.1",
        compatibilityDiagnostics: [{
          feature: "core",
          reason: "changed_field_shape",
        }],
      },
    });
  });

  test("clears only the exact crashed child generation from the status ledger", async () => {
    const fx = fixture();
    await fx.attach();
    await ready(fx.controller);
    await fx.controller.ensureProfileChild(launchScope);
    const child = {
      profile: { actorId: "actor", profileHandle: "profile" as never, profileGeneration: 1 },
      accountGeneration: 2,
      runtimeGeneration: 3,
      childGeneration: 1,
    };

    expect(await fx.controller.onSupervisorFault({
      kind: "child_crashed",
      child: { ...child, childGeneration: 2 },
    })).toBeFalse();
    expect(fx.controller.status()).toMatchObject({
      profiles: [{ childGeneration: 1 }],
    });

    expect(await fx.controller.onSupervisorFault({ kind: "child_crashed", child })).toBeTrue();
    expect(fx.controller.status()).toMatchObject({
      profiles: [{ profileHandle: "profile", accountGeneration: 2 }],
    });
    expect(fx.controller.status().profiles?.[0]).not.toHaveProperty("childGeneration");
  });

  test("preserves limited runtime feature gates in its selected status", async () => {
    const limited = {
      stableConversation: true,
      explicitSteer: false,
      codexApprovals: false,
      requestUserInput: false,
      collaborationMode: false,
    };
    const fx = fixture({ compatibility: "limited", features: limited });
    await fx.attach();
    await fx.controller.enable(session);
    await fx.controller.execute(hostScope, { kind: "runtime_inspect" });
    await fx.controller.execute(hostScope, { kind: "runtime_activate", runtimeGeneration: 1 });
    expect(fx.controller.status()).toMatchObject({ state: "limited", compatibility: "limited", features: limited });
  });

  test("retains actor-scoped profile homes and monotonic runtime generations across a detached relay", async () => {
    const fx = fixture();
    await fx.attach();
    await ready(fx.controller);
    expect(await fx.controller.execute(hostScope, { kind: "runtime_inspect" })).toEqual({ kind: "runtime_status", state: "ready", runtimeGeneration: 1 });
    expect(fx.profileCreates()).toBe(1);
    await fx.controller.detach();
    fx.setFingerprint("replacement-fingerprint");
    const next = { ...session, relaySessionId: "reconnected" };
    const nextHost = { ...hostScope, relaySessionId: "reconnected" };
    const nextLaunch = { ...launchScope, relaySessionId: "reconnected" };
    await fx.attach(next);
    await fx.controller.enable(next);
    expect(await fx.controller.execute(nextHost, { kind: "profile_create", profileHandle: "profile", profileGeneration: 1 })).toEqual({ kind: "profile_status", state: "created", profileHandle: "profile", profileGeneration: 1, homeHandle: "home-opaque" });
    expect(fx.profileCreates()).toBe(1);
    await fx.controller.ensureProfileChild(nextLaunch);
    expect(await fx.controller.execute(nextHost, { kind: "runtime_inspect" })).toEqual({ kind: "runtime_status", state: "ready", runtimeGeneration: 2 });
  });

  test("removes through launch authority, purges login state, and replays only removed", async () => {
    const fx = fixture(); await fx.attach(); await ready(fx.controller);
    await fx.controller.execute(profileScope, { kind: "account_login_start" });
    expect(await fx.controller.execute(launchScope, { kind: "profile_remove", profileHandle: "profile", profileGeneration: 1 })).toEqual({ kind: "profile_status", state: "removed", profileHandle: "profile", profileGeneration: 1 });
    expect(fx.cancelled).toEqual(["upstream-secret"]);
    expect(fx.removals()).toBe(1);
    expect(await fx.controller.execute(launchScope, { kind: "profile_remove", profileHandle: "profile", profileGeneration: 1 })).toEqual({ kind: "profile_status", state: "removed", profileHandle: "profile", profileGeneration: 1 });
    await rejectsController(fx.controller.ensureProfileChild(launchScope), "CODEX_PROFILE_UNAVAILABLE");
  });

  test("does not overwrite a live login on an opaque-ref collision and activates the refreshed runtime handle", async () => {
    const fx = fixture({ mintId: () => "same-ref" });
    await fx.attach();
    await ready(fx.controller);
    expect(await fx.controller.execute(profileScope, { kind: "account_login_start" })).toMatchObject({ kind: "login_started", loginRef: "same-ref" });
    expect(await fx.controller.execute(profileScope, { kind: "account_login_start" })).toEqual({ kind: "rejected", code: "CODEX_CONTEXT_INVALID" });
    expect(fx.cancelled).toEqual(["upstream-secret"]);
    await fx.controller.execute(hostScope, { kind: "runtime_inspect" });
    fx.setHandle("runtime-fresh-opaque-handle");
    expect(await fx.controller.execute(hostScope, { kind: "runtime_inspect" })).toEqual({ kind: "runtime_status", state: "ready", runtimeGeneration: 1 });
    expect(fx.activated).toEqual(["runtime-opaque-handle", "runtime-fresh-opaque-handle"]);
  });

  test("selects only an exactly revalidated runtime and exposes only the selected opaque handle", async () => {
    let valid = false;
    const fx = fixture({ revalidate: async () => valid });
    await fx.attach();
    await ready(fx.controller);
    await fx.controller.execute(hostScope, { kind: "runtime_inspect" });
    expect(await fx.controller.execute(hostScope, { kind: "runtime_activate", runtimeGeneration: 99 })).toEqual({ kind: "rejected", code: "CODEX_RUNTIME_UNAVAILABLE" });
    expect(await fx.controller.execute(hostScope, { kind: "runtime_activate", runtimeGeneration: 1 })).toEqual({ kind: "rejected", code: "CODEX_RUNTIME_UNAVAILABLE" });
    expect(fx.controller.selectedRuntimeHandleForGeneration(1)).toBeNull();
    valid = true;
    expect(await fx.controller.execute(hostScope, { kind: "runtime_activate", runtimeGeneration: 1 })).toEqual({ kind: "runtime_status", state: "ready", runtimeGeneration: 1 });
    expect(fx.controller.selectedRuntimeHandleForGeneration(1)).toBe("runtime-opaque-handle");
    expect(fx.controller.selectedRuntimeHandleForGeneration(2)).toBeNull();
  });

  test("revalidates and refreshes the selected handle across same-identity inspection, and hides it while detached or closed", async () => {
    const fx = fixture();
    await fx.attach();
    await ready(fx.controller);
    await fx.controller.execute(hostScope, { kind: "runtime_inspect" });
    expect(fx.controller.selectedRuntimeHandleForGeneration(1)).toBe("runtime-opaque-handle");
    fx.setHandle("runtime-refreshed-opaque-handle");
    expect(await fx.controller.execute(hostScope, { kind: "runtime_inspect" })).toEqual({ kind: "runtime_status", state: "ready", runtimeGeneration: 1 });
    expect(fx.controller.selectedRuntimeHandleForGeneration(1)).toBe("runtime-refreshed-opaque-handle");
    await fx.controller.detach();
    expect(fx.controller.selectedRuntimeHandleForGeneration(1)).toBeNull();
    await fx.attach();
    await fx.controller.enable(session);
    expect(fx.controller.selectedRuntimeHandleForGeneration(1)).toBe("runtime-refreshed-opaque-handle");
    await fx.controller.close();
    expect(fx.controller.selectedRuntimeHandleForGeneration(1)).toBeNull();
  });

  test("keeps selection on rollback failure, selects a fresh generation on success, and leaves removal unavailable", async () => {
    let outcome: { readonly state: "ready" | "incompatible" | "failed"; readonly fingerprint?: string; readonly handle?: string } | null = { state: "failed" };
    let throws = false;
    const fx = fixture({ rollback: async () => { if (throws) throw new Error("rollback failed"); return outcome; } });
    await fx.attach();
    await ready(fx.controller);
    await fx.controller.execute(hostScope, { kind: "runtime_inspect" });
    await fx.controller.execute(hostScope, { kind: "runtime_activate", runtimeGeneration: 1 });
    expect(await fx.controller.execute(hostScope, { kind: "runtime_remove" })).toEqual({ kind: "rejected", code: "CODEX_CAPABILITY_UNAVAILABLE" });
    expect(fx.controller.selectedRuntimeHandleForGeneration(1)).toBe("runtime-opaque-handle");
    expect(await fx.controller.execute(hostScope, { kind: "runtime_rollback" })).toEqual({ kind: "rejected", code: "CODEX_RUNTIME_UNAVAILABLE" });
    expect(fx.controller.selectedRuntimeHandleForGeneration(1)).toBe("runtime-opaque-handle");
    outcome = null;
    expect(await fx.controller.execute(hostScope, { kind: "runtime_rollback" })).toEqual({ kind: "rejected", code: "CODEX_RUNTIME_UNAVAILABLE" });
    expect(fx.controller.selectedRuntimeHandleForGeneration(1)).toBe("runtime-opaque-handle");
    throws = true;
    expect(await fx.controller.execute(hostScope, { kind: "runtime_rollback" })).toEqual({ kind: "rejected", code: "CODEX_RUNTIME_UNAVAILABLE" });
    expect(fx.controller.selectedRuntimeHandleForGeneration(1)).toBe("runtime-opaque-handle");
    throws = false;
    outcome = {
      state: "ready",
      fingerprint: "rolled-back-fingerprint",
      handle: "runtime-rolled-back",
      source: "managed",
      version: "0.146.0",
      compatibility: "certified",
      features: {
        stableConversation: true,
        explicitSteer: true,
        codexApprovals: true,
        requestUserInput: true,
        collaborationMode: true,
      },
    };
    expect(await fx.controller.execute(hostScope, { kind: "runtime_rollback" })).toEqual({ kind: "runtime_status", state: "ready", runtimeGeneration: 2 });
    expect(fx.controller.selectedRuntimeHandleForGeneration(1)).toBeNull();
    expect(fx.controller.selectedRuntimeHandleForGeneration(2)).toBe("runtime-rolled-back");
  });

  test("bounds usage to the newest 31 daily buckets and yields a relay-parseable response", async () => {
    const daily = [...Array.from({ length: 31 }, (_, index) => ({ startDate: `2026-01-${String(index + 1).padStart(2, "0")}`, tokens: String(index) })), { startDate: "2026-02-01", tokens: "31" }];
    const fx = fixture({ daily });
    await fx.attach();
    await ready(fx.controller);
    const result = await fx.controller.execute(profileScope, { kind: "account_usage_read" });
    if (result.kind !== "account_usage_status") throw new Error("missing usage");
    expect(result.value.daily).toHaveLength(31);
    expect(result.value.daily[0]?.startDate).toBe("2026-01-02");
    expect(result.value.daily.at(-1)?.startDate).toBe("2026-02-01");
    const parsed = parseRelayCodexClientMessage({ type: "relay:codex-command-response", commandId: "usage", scope: profileScope, result });
    expect(parsed.ok).toBeTrue();
  });

  test("expires unclaimed logins exactly once and clears expiry callbacks on detach and close", async () => {
    const timer = new ManualTimer();
    const fx = fixture({ timer });
    await fx.attach();
    await ready(fx.controller);
    const first = await fx.controller.execute(profileScope, { kind: "account_login_start" });
    const second = await fx.controller.execute(profileScope, { kind: "account_login_start" });
    if (first.kind !== "login_started" || second.kind !== "login_started") throw new Error("missing login refs");
    timer.fireAll();
    await fx.controller.execute(profileScope, { kind: "account_read" });
    expect(fx.cancelled).toEqual(["upstream-secret", "upstream-secret"]);
    expect(await fx.controller.execute(profileScope, { kind: "account_login_cancel", loginRef: first.loginRef })).toEqual({ kind: "rejected", code: "CODEX_CORRELATION_REPLAY" });

    const third = await fx.controller.execute(profileScope, { kind: "account_login_start" });
    if (third.kind !== "login_started") throw new Error("missing login ref");
    await fx.controller.detach();
    timer.fireAll();
    await Promise.resolve();
    expect(fx.cancelled).toEqual(["upstream-secret", "upstream-secret", "upstream-secret"]);

    const closeTimer = new ManualTimer();
    const closing = fixture({ timer: closeTimer });
    await closing.attach();
    await ready(closing.controller);
    await closing.controller.execute(profileScope, { kind: "account_login_start" });
    await closing.controller.close();
    closeTimer.fireAll();
    await Promise.resolve();
    expect(closing.cancelled).toEqual(["upstream-secret"]);
  });

  test("discards a runtime completion delivered after final close", async () => {
    const installs: AbortSignal[] = [];
    const fx = fixture({ installs, lateInstall: true });
    await fx.attach();
    await fx.controller.enable(session);
    const started = await fx.controller.execute(hostScope, { kind: "runtime_install", artifactRef: CODEX_REVIEWED_RUNTIME_ARTIFACT_REF });
    if (started.kind !== "runtime_status") throw new Error("missing install");
    await fx.controller.close();
    expect(installs[0]?.aborted).toBeTrue();
    fx.completeInstall({ state: "ready", fingerprint: "late-fingerprint", handle: "late-handle" });
    await Promise.resolve();
    await Promise.resolve();
    expect(await fx.controller.execute(hostScope, { kind: "runtime_inspect" })).toEqual({ kind: "rejected", code: "CODEX_CAPABILITY_UNAVAILABLE" });
  });

  test("retains the manager's synchronous lifecycle and one terminal cancellation receipt without stale resurrection", async () => {
    const statusUpdates: number[] = [];
    const fx = fixture({
      statusUpdates,
      onInstallState: (emit) => emit({
        phase: "downloading",
        receivedBytes: 64 * 1024,
        totalBytes: 256 * 1024,
        canCancel: true,
      }),
    });
    await fx.attach();
    await fx.controller.enable(session);
    const started = await fx.controller.execute(hostScope, { kind: "runtime_install", artifactRef: CODEX_REVIEWED_RUNTIME_ARTIFACT_REF });
    if (started.kind !== "runtime_status" || !started.installRef) throw new Error("missing install");
    expect(fx.controller.status()).toMatchObject({
      runtime: {
        state: "installing",
        source: "managed",
        installRef: started.installRef,
        installation: { phase: "downloading", receivedBytes: 64 * 1024, totalBytes: 256 * 1024, canCancel: true },
      },
    });
    expect(statusUpdates.length).toBeGreaterThan(0);
    await fx.controller.execute(hostScope, { kind: "runtime_cancel_install", installRef: started.installRef });
    expect(fx.controller.status()).toMatchObject({
      runtime: {
        state: "absent",
        source: "managed",
        installation: { phase: "cancelled", receivedBytes: 64 * 1024, totalBytes: 256 * 1024, canCancel: false, code: "CODEX_RUNTIME_CANCELLED" },
      },
    });
    await fx.controller.detach();
    expect(fx.controller.status()).toEqual({ state: "runtime_unavailable", runtime: { state: "absent" } });
  });

  test("keeps exact relay-private cancellation authority visible before the manager's first lifecycle state", async () => {
    const fx = fixture();
    await fx.attach();
    await fx.controller.enable(session);
    const started = await fx.controller.execute(hostScope, { kind: "runtime_install", artifactRef: CODEX_REVIEWED_RUNTIME_ARTIFACT_REF });
    if (started.kind !== "runtime_status" || !started.installRef) throw new Error("missing install");
    expect(fx.controller.status()).toEqual({
      state: "runtime_unavailable",
      runtime: { state: "installing", source: "managed", installRef: started.installRef },
    });
    expect(await fx.controller.execute(hostScope, { kind: "runtime_cancel_install", installRef: started.installRef })).toEqual({ kind: "runtime_status", state: "absent" });
  });

  test("does not publish a terminal manager callback beneath an active installing runtime", async () => {
    const fx = fixture({
      lateInstall: true,
      onInstallState: (emit) => emit({ phase: "ready", receivedBytes: 128, totalBytes: 128, canCancel: false }),
    });
    await fx.attach();
    await fx.controller.enable(session);
    const started = await fx.controller.execute(hostScope, { kind: "runtime_install", artifactRef: CODEX_REVIEWED_RUNTIME_ARTIFACT_REF });
    if (started.kind !== "runtime_status" || !started.installRef) throw new Error("missing install");
    expect(fx.controller.status()).toEqual({
      state: "runtime_unavailable",
      runtime: { state: "installing", source: "managed", installRef: started.installRef },
    });
    fx.completeInstall({
      state: "ready",
      fingerprint: "managed-fingerprint",
      handle: "managed-handle",
      source: "managed",
      version: "0.146.0",
      compatibility: "certified",
      features: { stableConversation: true, explicitSteer: true, codexApprovals: true, requestUserInput: true, collaborationMode: true },
    });
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fx.controller.status()).toMatchObject({
      state: "runtime_unavailable",
      runtime: {
        state: "ready",
        source: "managed",
        version: "0.146.0",
        installation: { phase: "ready", receivedBytes: 128, totalBytes: 128, canCancel: false },
      },
    });
  });

  test("detach aborts an active inspection, rejects its queued peer, and leaves no late runtime ledger entry", async () => {
    const inspections: AbortSignal[] = [];
    const fx = fixture({ inspections, inspectGate: new Promise<void>(() => undefined) });
    await fx.attach();
    await fx.controller.enable(session);

    const active = fx.controller.execute(hostScope, { kind: "runtime_inspect" });
    await fx.inspectionStarted;
    const queued = fx.controller.execute(hostScope, { kind: "runtime_inspect" });
    const detached = fx.controller.detach();

    // detach fences before its cleanup joins the controller tail.
    expect(inspections).toHaveLength(1);
    expect(inspections[0]?.aborted).toBeTrue();
    await detached;
    expect(await active).toEqual({ kind: "rejected", code: "CODEX_CAPABILITY_UNAVAILABLE" });
    expect(await queued).toEqual({ kind: "rejected", code: "CODEX_CAPABILITY_UNAVAILABLE" });
    expect(inspections).toHaveLength(1);

    const reattached = { ...session, relaySessionId: "replacement" };
    await fx.attach(reattached);
    await fx.controller.enable(reattached);
    expect(fx.controller.status()).toEqual({ state: "runtime_unavailable", runtime: { state: "absent" } });
  });
});

async function ready(controller: ElectronCodexController) {
  await controller.enable(session);
  await controller.execute(hostScope, { kind: "profile_create", profileHandle: "profile", profileGeneration: 1 });
  await controller.ensureProfileChild(launchScope);
}
async function rejectsController(work: Promise<unknown>, code: string) {
  try { await work; } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error(`Expected ${code}`);
}

function fixture(options: {
  authUrl?: string; openFails?: boolean; now?: () => number; installs?: AbortSignal[]; daily?: readonly { readonly startDate: string; readonly tokens: string }[];
  requiresOpenaiAuth?: boolean;
  mintId?: () => string; timer?: ElectronCodexTimerPort; lateInstall?: boolean;
  onInstallState?: (emit: (state: { readonly phase: "resolving" | "downloading" | "verifying" | "staging" | "activating" | "ready" | "cancelled" | "failed"; readonly receivedBytes: number; readonly totalBytes: number; readonly canCancel: boolean; readonly code?: "CODEX_RUNTIME_CANCELLED" | "CODEX_RUNTIME_ARTIFACT_INVALID" }) => void) => void;
  statusUpdates?: number[];
  inspections?: AbortSignal[]; inspectGate?: Promise<void>;
  revalidate?: (handle: string, fingerprint: string) => Promise<boolean>;
  rollback?: () => Promise<{ readonly state: "ready" | "incompatible" | "failed"; readonly fingerprint?: string; readonly handle?: string; readonly source?: "external" | "managed"; readonly version?: string } | null>;
  cancelGate?: Promise<void>;
  compatibility?: "certified" | "compatible_uncertified" | "limited";
  features?: Readonly<{ stableConversation: boolean; explicitSteer: boolean; codexApprovals: boolean; requestUserInput: boolean; collaborationMode: boolean }>;
  inspectResult?: Readonly<{
    state: "absent" | "ready" | "incompatible" | "failed";
    fingerprint?: string;
    handle?: string;
    source?: "external" | "managed";
    version?: string;
    compatibility?: "certified" | "compatible_uncertified" | "limited";
    features?: Readonly<{ stableConversation: boolean; explicitSteer: boolean; codexApprovals: boolean; requestUserInput: boolean; collaborationMode: boolean }>;
  }>;
} = {}) {
  const runtimeProjection = Object.freeze({
    compatibility: options.compatibility ?? "certified",
    features: Object.freeze(options.features ?? {
      stableConversation: true,
      explicitSteer: true,
      codexApprovals: true,
      requestUserInput: true,
      collaborationMode: true,
    }),
  });
  const child: ChildIdentity = {
    profile: { actorId: "actor", profileHandle: "profile" as never, profileGeneration: 1 }, accountGeneration: 2, runtimeGeneration: 3, childGeneration: 1,
  };
  const cancelled: string[] = [];
  const opened: string[] = [];
  let fingerprint = "same-fingerprint";
  let handle = "runtime-opaque-handle";
  let created = 0;
  let removals = 0;
  const activated: string[] = [];
  const lateInstall = deferred<{ readonly state: "ready" | "incompatible" | "failed"; readonly fingerprint?: string; readonly handle?: string; readonly source?: "external" | "managed"; readonly version?: string; readonly compatibility?: "certified" | "compatible_uncertified" | "limited"; readonly features?: Readonly<{ stableConversation: boolean; explicitSteer: boolean; codexApprovals: boolean; requestUserInput: boolean; collaborationMode: boolean }> }>();
  const inspectionStarted = deferred<void>();
  const services = {
    actorId: () => "actor",
    createProfile: async (identity: ChildIdentity["profile"]) => { created += 1; return { handle: "home-opaque" as never, identity, identityFingerprint: "home-fingerprint" }; },
    ensure: async () => child,
    removeProfile: async () => { removals += 1; },
    startChatgptLogin: async () => ({ upstreamLoginId: "upstream-secret", authUrl: options.authUrl ?? "https://auth.openai.com/authorize?device=secret" }),
    cancelLogin: async (_child: ChildIdentity, upstream: string) => { cancelled.push(upstream); await options.cancelGate; },
    readAccount: async () => ({ state: "signed_in" as const, requiresOpenaiAuth: options.requiresOpenaiAuth ?? false, email: "person@example.test", planType: "pro" as const }),
    readUsage: options.daily ? async () => ({
      summary: { lifetimeTokens: null, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null },
      daily: options.daily!, observedAt: "2026-01-01T00:00:00.000Z", freshness: "live" as const,
    }) : undefined,
    logout: async () => undefined,
  };
  const controller = new ElectronCodexController({
    runtime: {
      inspect: async ({ signal }: { readonly signal?: AbortSignal } = {}) => {
        if (signal) options.inspections?.push(signal);
        inspectionStarted.resolve();
        if (options.inspectGate) {
          await Promise.race([
            options.inspectGate,
            new Promise<void>((resolve) => signal?.addEventListener("abort", resolve, { once: true })),
          ]);
          if (signal?.aborted) throw new Error("inspection aborted");
        }
        return options.inspectResult ?? { state: "ready" as const, fingerprint, handle, source: "external" as const, version: "0.146.0", ...runtimeProjection };
      },
      install: async ({ signal, onState }) => {
        options.installs?.push(signal);
        if (onState) options.onInstallState?.(onState);
        if (options.lateInstall) return lateInstall.promise;
        await new Promise<void>((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return { state: "failed" as const };
      },
      revalidateForActivation: async (candidateHandle, candidateFingerprint) => candidateHandle === handle && candidateFingerprint === fingerprint && (options.revalidate ? await options.revalidate(candidateHandle, candidateFingerprint) : true),
      activate: async (activeHandle) => { activated.push(activeHandle); return { state: "ready" as const, fingerprint, handle: activeHandle, source: "external" as const, version: "0.146.0", ...runtimeProjection }; },
      ...(options.rollback ? { rollback: options.rollback } : {}),
    },
    artifactAuthority: { artifactRef: CODEX_REVIEWED_RUNTIME_ARTIFACT_REF },
    openExternal: async (url) => { opened.push(url); if (options.openFails) throw new Error("open failed"); },
    now: options.now ?? (() => 1),
    mintId: options.mintId ?? (() => { let id = 0; return () => `opaque-${++id}`; })(),
    loginTtlMs: 1_000,
    onStatusChange: () => { options.statusUpdates?.push(1); },
    ...(options.timer ? { timer: options.timer } : {}),
  });
  return { controller, cancelled, opened, activated, inspectionStarted: inspectionStarted.promise, attach: (next = session) => controller.attach(next, services), setFingerprint: (value: string) => { fingerprint = value; }, setHandle: (value: string) => { handle = value; }, profileCreates: () => created, removals: () => removals, completeInstall: lateInstall.resolve };
}

class ManualTimer implements ElectronCodexTimerPort {
  private next = 0;
  private readonly callbacks = new Map<number, () => void>();
  setTimeout(callback: () => void): number { const handle = ++this.next; this.callbacks.set(handle, callback); return handle; }
  clearTimeout(handle: unknown): void { this.callbacks.delete(handle as number); }
  fireAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

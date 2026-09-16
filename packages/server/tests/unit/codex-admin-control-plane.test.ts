import { describe, expect, test } from "bun:test";
import type {
  RelayCodexCommandMessage,
  RelayCodexCommandResponseMessage,
} from "@nautilo/relay";
import type { RelayCodexSessionSnapshot } from "@nautilo/runtime";
import {
  CodexAdminControlFailure,
  CodexAdminControlPlane,
  selectPreferredCodexModelId,
  type CodexAdminControlError,
  type CodexAdminRelayPort,
} from "../../src/codex/admin-control-plane";

const host = { userId: "owner-1", relayId: "relay-1" } as const;
const profile = {
  ...host,
  profileHandle: "profile-1",
  profileGeneration: 2,
  accountGeneration: 4,
} as const;

class RelayFake implements CodexAdminRelayPort {
  readonly sent: RelayCodexCommandMessage[] = [];
  readonly sentOptions: ({ readonly timeoutMs?: number } | undefined)[] = [];
  readonly lookup: { relayId: string; userId: string }[] = [];
  childGeneration = 9;
  nextResponse: RelayCodexCommandResponseMessage | null = null;
  nextRejected: "CODEX_RUNTIME_UNAVAILABLE" | null = null;
  nextError: Error | null = null;
  sendGate: Promise<void> | null = null;
  publishReadyAfterInspect = false;

  constructor(session: RelayCodexSessionSnapshot = liveSession()) {
    this.session = session;
  }

  session: RelayCodexSessionSnapshot;

  getCodexSession(relayId: string, userId: string): RelayCodexSessionSnapshot | null {
    this.lookup.push({ relayId, userId });
    return relayId === host.relayId && userId === host.userId ? this.session : null;
  }

  async sendCodexCommand(
    _relayId: string,
    command: RelayCodexCommandMessage,
    options?: { readonly timeoutMs?: number },
  ): Promise<RelayCodexCommandResponseMessage> {
    this.sent.push(command);
    this.sentOptions.push(options);
    await this.sendGate;
    if (command.command.kind === "runtime_inspect" && this.publishReadyAfterInspect) {
      this.session = liveSession(this.session.selectedProtocolVersion);
    }
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      throw error;
    }
    if (this.nextRejected) {
      const code = this.nextRejected;
      this.nextRejected = null;
      return {
        type: "relay:codex-command-response",
        commandId: command.commandId,
        scope: command.scope,
        result: { kind: "rejected", code },
      } as RelayCodexCommandResponseMessage;
    }
    if (this.nextResponse) {
      const response = this.nextResponse;
      this.nextResponse = null;
      return response;
    }
    return responseFor(command, this.childGeneration);
  }
}

function liveSession(selectedProtocolVersion = 8): RelayCodexSessionSnapshot {
  return {
    ...host,
    relaySessionId: "socket-1",
    pairingGenerationRef: "pairing-1",
    desktopSessionId: "desktop-1",
    selectedProtocolVersion,
    capabilityRevision: 6,
    status: {
      state: "ready",
      runtimeGeneration: 7,
      runtime: { state: "ready" },
      profiles: [{
        profileHandle: profile.profileHandle,
        profileGeneration: profile.profileGeneration,
        accountGeneration: profile.accountGeneration,
        childGeneration: 8,
        state: "signed_out",
      }],
      workspace: { state: "unavailable" },
    },
  };
}

function control(
  relay = new RelayFake(),
  options: Partial<Pick<
    ConstructorParameters<typeof CodexAdminControlPlane>[0],
    "now" | "loginTtlMs" | "maxIssuedLogins" | "runtimeInspectTimeoutMs"
  >> = {},
) {
  const artifacts: { userId: string; relayId: string }[] = [];
  return {
    relay,
    artifacts,
    service: new CodexAdminControlPlane({
      relay,
      profileIds: {
        mint: () => ({ profileHandle: "new-profile", profileGeneration: 1 }),
      },
      artifacts: {
        selectInstallArtifact: async (input) => {
          artifacts.push(input);
          return { artifactRef: "reviewed-runtime-artifact" };
        },
      },
      ...options,
    }),
  };
}

function responseFor(
  command: RelayCodexCommandMessage,
  childGeneration: number,
): RelayCodexCommandResponseMessage {
  const response = (() => {
    switch (command.command.kind) {
      case "runtime_inspect":
      case "runtime_install":
      case "runtime_cancel_install":
      case "runtime_activate":
      case "runtime_rollback":
      case "runtime_remove":
        return {
          scope: command.scope,
          result: {
            kind: "runtime_status",
            state: command.command.kind === "runtime_install" ? "installing" : "ready",
            runtimeGeneration: command.command.kind === "runtime_activate" || command.command.kind === "runtime_remove"
              ? command.command.runtimeGeneration
              : 7,
            ...(command.command.kind === "runtime_inspect"
              ? { installRef: "install-1" }
              : {}),
          },
        };
      case "profile_create":
        return {
          scope: command.scope,
          result: {
            kind: "profile_status",
            state: "created",
            profileHandle: command.command.profileHandle,
            profileGeneration: command.command.profileGeneration,
            homeHandle: "home-private-1",
          },
        };
      case "profile_remove":
        return {
          scope: command.scope,
          result: {
            kind: "profile_status",
            state: "removed",
            profileHandle: command.command.profileHandle,
            profileGeneration: command.command.profileGeneration,
          },
        };
      case "ensure_profile_child":
        return {
          scope: { ...command.scope, childGeneration },
          result: { kind: "child_ready" },
        };
      case "account_login_start":
        return {
          scope: command.scope,
          result: { kind: "login_started", loginRef: "login-1", state: "waiting_for_browser" },
        };
      case "account_login_cancel":
      case "account_read":
      case "account_logout":
        return {
          scope: command.scope,
          result: { kind: "account_status", state: "signed_in", accountGeneration: 5 },
        };
      case "account_rate_limits_read":
        return {
          scope: command.scope,
          result: { kind: "rate_limits_status", value: { primary: null, secondary: null, plan: null, credits: null, spendControl: null, reached: null, observedAt: "2026-07-28T00:00:00.000Z", freshness: "live" } },
        };
      case "account_usage_read":
        return {
          scope: command.scope,
          result: { kind: "account_usage_status", value: { summary: { lifetimeTokens: null, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, daily: [], observedAt: "2026-07-28T00:00:00.000Z", freshness: "live" } },
        };
      case "model_list":
        return {
          scope: command.scope,
          result: {
            kind: "model_catalog_status",
            value: {
              models: [{
                id: "picker-sol",
                model: "gpt-5.6-sol",
                displayName: "GPT-5.6 Sol",
                description: "Frontier coding model",
                isDefault: true,
              }],
            },
          },
        };
      default:
        throw new Error(`unexpected ${command.command.kind}`);
    }
  })();
  return {
    type: "relay:codex-command-response",
    commandId: command.commandId,
    ...response,
  } as RelayCodexCommandResponseMessage;
}

async function expectCode(operation: () => Promise<unknown>, code: CodexAdminControlError) {
  try {
    await operation();
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(CodexAdminControlFailure);
    expect((error as CodexAdminControlFailure).code).toBe(code);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("CodexAdminControlPlane", () => {
  test("uses only server-selected artifacts and derives an exact live host scope", async () => {
    const fx = control();

    await fx.service.installRuntime(host);

    expect(fx.artifacts).toEqual([host]);
    expect(fx.relay.lookup).toEqual([host]);
    expect(fx.relay.sent).toHaveLength(1);
    const sent = fx.relay.sent[0]!;
    expect(typeof sent.commandId).toBe("string");
    expect(sent).toMatchObject({
      command: { kind: "runtime_install", artifactRef: "reviewed-runtime-artifact" },
      scope: {
        relayId: host.relayId,
        relaySessionId: "socket-1",
        desktopSessionId: "desktop-1",
        pairingGenerationRef: "pairing-1",
        selectedProtocolVersion: 8,
        capabilityRevision: 6,
      },
    });
    expect(Object.keys(fx.relay.sent[0]!.scope).sort()).toEqual([
      "capabilityRevision", "desktopSessionId", "pairingGenerationRef",
      "relayId", "relaySessionId", "selectedProtocolVersion",
    ]);
  });

  test("echoes the exact negotiated v8+ relay version instead of pinning Codex scopes to v8", async () => {
    const relay = new RelayFake(liveSession(9));
    const fx = control(relay);

    await fx.service.installRuntime(host);

    expect(relay.sent[0]?.scope.selectedProtocolVersion).toBe(9);
  });

  test("ensures the exact account child before every account operation without task or workspace scope", async () => {
    const fx = control();

    const login = await fx.service.startAccountLogin(profile);
    expect(login).toEqual({ kind: "login_started", loginRef: "login-1", state: "waiting_for_browser" });
    expect(fx.relay.sent.map((item) => item.command.kind)).toEqual([
      "ensure_profile_child", "account_login_start",
    ]);
    expect(fx.relay.sent[0]!.command).toEqual({
      kind: "ensure_profile_child",
      posture: { kind: "codex_default", anchorMode: "default" },
    });
    expect(fx.relay.sent[1]!.scope).toMatchObject({
      profileHandle: profile.profileHandle,
      profileGeneration: profile.profileGeneration,
      accountGeneration: profile.accountGeneration,
      runtimeGeneration: 7,
      childGeneration: 9,
    });
    for (const message of fx.relay.sent) {
      expect(message.scope).not.toHaveProperty("taskId");
      expect(message.scope).not.toHaveProperty("workspace");
      expect(message.scope).not.toHaveProperty("threadId");
    }
  });

  test("lists models from the exact live account child without inventing a catalog", async () => {
    const fx = control();

    const catalog = await fx.service.listModels(profile);

    expect(catalog).toEqual({
      models: [{
        id: "picker-sol",
        model: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        description: "Frontier coding model",
        isDefault: true,
      }],
      preferredModelId: "picker-sol",
    });
    expect(fx.relay.sent.map((item) => item.command.kind)).toEqual([
      "ensure_profile_child",
      "model_list",
    ]);
    expect(fx.relay.sent[1]!.scope).toMatchObject({
      profileHandle: profile.profileHandle,
      profileGeneration: profile.profileGeneration,
      accountGeneration: profile.accountGeneration,
      runtimeGeneration: 7,
      childGeneration: 9,
    });
  });

  test("prefers advertised Sol, then Terra, before the harness default", () => {
    const entry = (id: string, isDefault = false) => ({
      id,
      model: id,
      displayName: id,
      description: "",
      isDefault,
    });
    expect(selectPreferredCodexModelId([
      entry("gpt-5.5", true),
      entry("gpt-5.6-terra"),
      entry("gpt-5.6-sol"),
    ])).toBe("gpt-5.6-sol");
    expect(selectPreferredCodexModelId([
      entry("gpt-5.5", true),
      entry("gpt-5.6-terra"),
    ])).toBe("gpt-5.6-terra");
    expect(selectPreferredCodexModelId([entry("gpt-5.5", true)])).toBe("gpt-5.5");
  });

  test("reattaches a persisted profile to a fresh desktop controller before account access", async () => {
    const session = liveSession();
    const { profiles: _profiles, ...statusWithoutProfiles } = session.status!;
    const freshController = {
      ...session,
      status: statusWithoutProfiles,
    } satisfies RelayCodexSessionSnapshot;
    const fx = control(new RelayFake(freshController));

    const account = await fx.service.readAccount(profile);

    expect(account).toEqual({
      kind: "account_status",
      state: "signed_in",
      accountGeneration: 5,
    });
    expect(fx.relay.sent.map((item) => item.command.kind)).toEqual([
      "profile_create", "ensure_profile_child", "account_read",
    ]);
    expect(fx.relay.sent[0]!.command).toEqual({
      kind: "profile_create",
      profileHandle: profile.profileHandle,
      profileGeneration: profile.profileGeneration,
    });
    expect(fx.relay.sent[1]!.scope).toMatchObject({
      profileHandle: profile.profileHandle,
      profileGeneration: profile.profileGeneration,
      accountGeneration: profile.accountGeneration,
      runtimeGeneration: 7,
    });
  });

  test("correlates login cancellation to the exact issued child and rejects a replaced child", async () => {
    const fx = control();
    await fx.service.startAccountLogin(profile);
    fx.relay.childGeneration = 10;

    await expectCode(
      () => fx.service.cancelAccountLogin(profile, "login-1"),
      "CODEX_STALE",
    );
    expect(fx.relay.sent.map((item) => item.command.kind)).toEqual([
      "ensure_profile_child", "account_login_start", "ensure_profile_child",
    ]);
  });

  test("expires issued login refs and reads cancellation refs from live host status", async () => {
    let now = 1_000;
    const expiring = control(new RelayFake(), {
      now: () => new Date(now),
      loginTtlMs: 10,
    });
    await expiring.service.startAccountLogin(profile);
    now += 11;
    await expectCode(() => expiring.service.cancelAccountLogin(profile, "login-1"), "CODEX_STALE");

    const session = liveSession();
    const installing = {
      ...session,
      status: {
        ...session.status!,
        runtime: { state: "installing" as const, installRef: "live-install-ref" },
      },
    } satisfies RelayCodexSessionSnapshot;
    const cancellation = control(new RelayFake(installing));
    await cancellation.service.cancelRuntimeInstall(host);
    expect(cancellation.relay.sent.map((message) => message.command)).toEqual([
      { kind: "runtime_cancel_install", installRef: "live-install-ref" },
    ]);
  });

  test("uses exact profile generations for removal and rejects mismatched relay responses without leaks", async () => {
    const fx = control();
    const removed = await fx.service.removeProfile(profile);
    expect(removed).toEqual({
      kind: "profile_status",
      state: "removed",
      profileHandle: profile.profileHandle,
      profileGeneration: profile.profileGeneration,
    });
    expect(fx.relay.sent[0]).toMatchObject({
      command: {
        kind: "profile_remove",
        profileHandle: profile.profileHandle,
        profileGeneration: profile.profileGeneration,
      },
      scope: { runtimeGeneration: 7, accountGeneration: profile.accountGeneration },
    });

    const bad = control();
    const inspect = await bad.service.inspectRuntime(host);
    bad.relay.nextResponse = {
      type: "relay:codex-command-response",
      commandId: "wrong-command",
      scope: bad.relay.sent[0]!.scope,
      result: inspect,
    } as RelayCodexCommandResponseMessage;
    await expectCode(() => bad.service.inspectRuntime(host), "CODEX_STALE");

    const isolated = control();
    await expectCode(
      () => isolated.service.removeProfile({ ...profile, profileGeneration: 3 }),
      "CODEX_STALE",
    );
    expect(isolated.relay.sent).toEqual([]);
  });

  test("retries only removal through an exact already-draining profile generation", async () => {
    const session = liveSession();
    const draining = {
      ...session,
      status: {
        ...session.status!,
        profiles: [{
          ...session.status!.profiles![0]!,
          state: "draining" as const,
        }],
      },
    } satisfies RelayCodexSessionSnapshot;
    const fx = control(new RelayFake(draining));

    await fx.service.removeProfile(profile);

    expect(fx.relay.sent.map((message) => message.command.kind)).toEqual(["profile_remove"]);
    await expectCode(() => fx.service.readAccount(profile), "CODEX_STALE");
  });

  test("returns stable rejected codes and never passes arbitrary transport text through", async () => {
    const rejected = control();
    rejected.relay.nextRejected = "CODEX_RUNTIME_UNAVAILABLE";
    await expectCode(() => rejected.service.inspectRuntime(host), "CODEX_RUNTIME_UNAVAILABLE");

    const failed = control();
    failed.relay.nextError = new Error("/private/home/auth-url should never escape");
    await expectCode(() => failed.service.inspectRuntime(host), "CODEX_UNAVAILABLE");
  });

  test("shares one in-flight inspection only for callers on the exact live host scope", async () => {
    const fx = control();
    const gate = deferred();
    fx.relay.sendGate = gate.promise;

    const first = fx.service.inspectRuntime(host);
    const second = fx.service.inspectRuntime(host);
    await Promise.resolve();
    expect(fx.relay.sent).toHaveLength(1);

    gate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(fx.relay.sent).toHaveLength(1);
  });

  test("removes completed and rejected inspections from the exact-scope single-flight cache", async () => {
    const completed = control();
    await completed.service.inspectRuntime(host);
    await completed.service.inspectRuntime(host);
    expect(completed.relay.sent).toHaveLength(2);

    const rejected = control();
    rejected.relay.nextError = new Error("CODEX_TIMEOUT");
    await expectCode(() => rejected.service.inspectRuntime(host), "CODEX_TIMEOUT");
    await rejected.service.inspectRuntime(host);
    expect(rejected.relay.sent).toHaveLength(2);
  });

  test("does not share inspections after the live relay session scope changes", async () => {
    const fx = control();
    const gate = deferred();
    fx.relay.sendGate = gate.promise;
    const first = fx.service.inspectRuntime(host);
    fx.relay.session = { ...fx.relay.session, relaySessionId: "socket-2" };
    const second = fx.service.inspectRuntime(host);
    await Promise.resolve();
    expect(fx.relay.sent).toHaveLength(2);
    expect(fx.relay.sent.map((message) => message.scope.relaySessionId)).toEqual(["socket-1", "socket-2"]);

    gate.resolve();
    await Promise.all([first, second]);
  });

  test("uses the extended timeout only for runtime inspection", async () => {
    const fx = control(new RelayFake(), { runtimeInspectTimeoutMs: 60_000 });

    await fx.service.inspectRuntime(host);
    await fx.service.installRuntime(host);
    await fx.service.createProfile(host);
    await fx.service.startAccountLogin(profile);
    await fx.service.readAccount(profile);

    expect(fx.relay.sent.map((message) => message.command.kind)).toEqual([
      "runtime_inspect", "runtime_install", "profile_create", "ensure_profile_child",
      "account_login_start", "ensure_profile_child", "account_read",
    ]);
    expect(fx.relay.sentOptions).toEqual([
      { timeoutMs: 60_000 }, undefined, undefined, undefined, undefined, undefined, undefined,
    ]);
  });

  test("requires a live ready runtime for profile/account commands but allows runtime inspection while unavailable", async () => {
    const session = liveSession();
    const { runtimeGeneration: _runtimeGeneration, ...statusWithoutGeneration } = session.status!;
    const unavailable = {
      ...session,
      status: { ...statusWithoutGeneration, state: "runtime_unavailable" as const, runtime: { state: "absent" as const } },
    } satisfies RelayCodexSessionSnapshot;
    const fx = control(new RelayFake(unavailable));

    await fx.service.inspectRuntime(host);
    await expectCode(() => fx.service.readAccount(profile), "CODEX_STALE");
    expect(fx.relay.sent.map((item) => item.command.kind)).toEqual(["runtime_inspect", "runtime_inspect"]);
  });

  test("lazily restores a revalidated runtime before the first cold profile operation", async () => {
    const session = liveSession();
    const { runtimeGeneration: _runtimeGeneration, ...statusWithoutGeneration } = session.status!;
    const unavailable = {
      ...session,
      status: { ...statusWithoutGeneration, state: "runtime_unavailable" as const, runtime: { state: "absent" as const } },
    } satisfies RelayCodexSessionSnapshot;
    const relay = new RelayFake(unavailable);
    relay.publishReadyAfterInspect = true;
    const fx = control(relay);

    await fx.service.readAccount(profile);

    expect(fx.relay.sent.map((item) => item.command.kind)).toEqual([
      "runtime_inspect",
      "ensure_profile_child",
      "account_read",
    ]);
  });
});

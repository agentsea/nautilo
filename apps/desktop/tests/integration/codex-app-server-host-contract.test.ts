import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AppServerClientFactory,
  ChildIdentity,
  CodexSupervisorFault,
  HostClock,
  OpaqueHandle,
  SpawnSpec,
} from "@nautilo/codex-app-server-host/internal";
import {
  NodeCodexAppServerClientFactory,
  sameChild,
} from "@nautilo/codex-app-server-host/internal";
import type {
  BindingOpenScope,
  BindingScope,
  ProfileLaunchScope,
  RelayCodexClientMessage,
  RelayCodexCommandMessage,
  RelayCodexServerMessage,
  RelayCodexSession,
  WorkspaceReceipt,
} from "@nautilo/relay";
import {
  isRelayCodexCommandResponseForCommand,
  parseRelayCodexClientMessage,
  parseRelayCodexServerMessage,
} from "@nautilo/relay";
import {
  createElectronCodexHostServiceFactory,
  ElectronCodexHost,
} from "../../electron/codex-host.ts";
import { createCodexRuntimeProviderForSupervisor } from "../../electron/codex-runtime/facade.ts";
import {
  createRuntimeFacadeFixture,
  FakeCodexChild,
  FakeCodexProcessHost,
  ManualHostTimer,
  SYNTHETIC_RUNTIME_FIXTURE_PROVENANCE,
} from "../helpers/codex-app-server-fakes.ts";

const session: RelayCodexSession = {
  relayId: "relay-fixture",
  relaySessionId: "relay-session-fixture",
  desktopSessionId: "desktop-fixture",
  pairingGenerationRef: "pairing-fixture",
  selectedProtocolVersion: 8,
  capabilityRevision: 3,
};

const posture = {
  kind: "full_access_headless" as const,
  anchorMode: "danger-full-access" as const,
  approvalPolicy: "never" as const,
};

describe("Codex app-server host integration contract", () => {
  test("rejects a late A1 native input request while both A1 and A2 typed readers remain open", async () => {
    const a1 = new FakeCodexChild(fakeSpawnSpec("a1"), 1);
    const a2 = new FakeCodexChild(fakeSpawnSpec("a2"), 2);
    const identityA1 = childIdentity(1);
    const identityA2 = childIdentity(2);
    a1.identity = identityA1;
    a2.identity = identityA2;
    let current = identityA1;
    let a1CurrentChecks = 0;
    const delivered: string[] = [];
    const a2Delivered = deferred<void>();
    const factory = new NodeCodexAppServerClientFactory({
      callbacks: {
        isCurrent: (candidate) => {
          if (sameChild(candidate, identityA1)) a1CurrentChecks += 1;
          return sameChild(candidate, current);
        },
        onTransportFault: () => undefined,
        onCallbackFault: () => undefined,
        onNotification: ({ child, notification }) => {
          delivered.push(`${child.childGeneration}:${notification.method}`);
          if (sameChild(child, identityA2) && notification.method === "account/updated") {
            a2Delivered.resolve();
          }
        },
        onServerRequest: (async () => {
          throw new Error("stale A1 must never reach the native request receiver");
        }) as never,
      },
    });
    const clientA1 = await factory.connect(a1, identityA1);
    const clientA2 = await factory.connect(a2, identityA2);
    try {
      await initializeDirectClient(clientA1, a1, 1);
      await initializeDirectClient(clientA2, a2, 2);
      current = identityA2;
      a1.server.notify("account/login/completed", {
        loginId: "late-a1",
        success: true,
        error: null,
      }, { generation: 1 });
      const staleRequest = a1.server.request("item/tool/requestUserInput", {
        threadId: "thread-a1",
        turnId: "turn-a1",
        itemId: "item-a1",
        questions: [],
      }, { generation: 1 });
      a2.server.notify("account/updated", {
        authMode: "chatgpt",
        planType: "pro",
      }, { generation: 2 });
      await Promise.all([
        staleRequest.expectFailure((error) => {
          expect(error).toEqual({ code: -32603, message: "Request failed" });
        }),
        a2Delivered.promise,
      ]);
      expect(a1CurrentChecks).toBeGreaterThanOrEqual(2);
      expect(delivered).toEqual(["2:account/updated"]);
    } finally {
      await Promise.all([clientA1.close(), clientA2.close()]);
      a1.dispose();
      a2.dispose();
    }
  });

  test("all actual runtime sources reach the typed client and a stale child cannot harm its sibling", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "nautilo-codex-host-contract-"));
    const root = await realpath(temporaryRoot);
    const inheritedPath = process.env["PATH"];
    const inheritedCodexHome = process.env["CODEX_HOME"];
    let host: ElectronCodexHost | undefined;
    let timer: ManualHostTimer | undefined;
    try {
      const workspace = join(root, "workspace");
      await mkdir(workspace, { mode: 0o700 });
      const runtimeFixture = createRuntimeFacadeFixture(join(root, "runtime"));
      const external = await runtimeFixture.manager.resolveExternal({ configuredPath: runtimeFixture.privateTargets.external });
      const installed = await runtimeFixture.manager.installManaged();
      const active = await runtimeFixture.manager.resolveActiveManaged();
      expect([external, installed, active].map((value) => [value.state, value.source])).toEqual([
        ["ready", "configured"],
        ["ready", "managed"],
        ["ready", "managed"],
      ]);
      const routes = [
        { label: "external", generation: 11, details: external },
        { label: "install", generation: 12, details: installed },
        { label: "active", generation: 13, details: active },
      ] as const;
      const handles = new Map(routes.map((route) => [route.generation, route.details.handle!]));
      const runtimes = createCodexRuntimeProviderForSupervisor(
        runtimeFixture.manager,
        { resolveRuntimeHandleForGeneration: (generation) => handles.get(generation) ?? null },
      );
      const processes = new FakeCodexProcessHost();
      const currentChildren = new Map<string, ChildIdentity>();
      const notifications: Array<{ readonly child: ChildIdentity; readonly method: string }> = [];
      const requests: string[] = [];
      const transportFaults: ChildIdentity[] = [];
      const typedFactory = new NodeCodexAppServerClientFactory({
        maxCallbackBytes: 4_096,
        callbacks: {
          isCurrent: (child) => {
            const current = currentChildren.get(profileKey(child));
            return !!current && sameChild(current, child);
          },
          onTransportFault: ({ child }) => { transportFaults.push(child); },
          onCallbackFault: () => undefined,
          onNotification: ({ child, notification }) => {
            notifications.push({ child, method: notification.method });
          },
          onServerRequest: (async ({ method }) => {
            requests.push(method);
            if (method === "item/tool/requestUserInput") {
              return { answers: { target: { answers: ["synthetic-result"] } } };
            }
            throw new Error("unsupported synthetic request");
          }) as never,
        },
      });
      const clients: AppServerClientFactory = {
        async connect(child, identity) {
          currentChildren.set(profileKey(identity), identity);
          (child as FakeCodexChild).identity = identity;
          return typedFactory.connect(child, identity);
        },
      };
      timer = new ManualHostTimer();
      const clock: HostClock = { now: () => 1_000 };
      const supervisorFault = deferred<CodexSupervisorFault>();
      const createServices = createElectronCodexHostServiceFactory({
        actorId: () => "actor-fixture",
        currentFolder: () => ({ path: workspace, revision: 1 }),
        defaultWorkingDirectory: workspace,
        profileHomesRoot: join(root, "profiles"),
        profileHomesTrustedParent: root,
        bindingStateFile: join(root, "state", "bindings.json"),
        hmacKey: "synthetic-host-contract-hmac",
        clock,
        timer,
        runtimes,
        processes,
        clients,
        turnTerminal: { wait: async () => true },
        currentUid: () => process.getuid?.() ?? 0,
        environment: { SAFE_FIXTURE: "SENSITIVE_ENV_SENTINEL" },
        onFault: (fault) => { supervisorFault.resolve(fault); },
      });
      const sent: RelayCodexClientMessage[] = [];
      host = new ElectronCodexHost({
        currentActorId: () => "actor-fixture",
        createServices,
        status: () => ({ state: "ready", runtimeGeneration: 13 }),
      });
      await host.onRegistered(session, {
        send(message) {
          const parsed = parseRelayCodexClientMessage(message);
          expect(parsed.ok).toBeTrue();
          if (parsed.ok) sent.push(parsed.value);
          return parsed.ok;
        },
      });
      const status = sent.find((message) => message.type === "relay:codex-status");
      if (!status || status.status.workspace.state !== "bound") throw new Error("expected bound fixture workspace");
      const receipt = status.status.workspace.receipt;

      const bindings = new Map<string, { scope: BindingScope; child: FakeCodexChild }>();
      for (const [index, route] of routes.entries()) {
        const profileHandle = `profile-${route.label}`;
        const launchScope: ProfileLaunchScope = {
          ...session,
          profileHandle,
          profileGeneration: 1,
          accountGeneration: 1,
          runtimeGeneration: route.generation,
        };
        const ensure = command({
          type: "relay:codex-command",
          commandId: `ensure-${route.label}`,
          scope: launchScope,
          command: { kind: "ensure_profile_child", posture },
        });
        const ensuring = host.onCommand(ensure);
        const child = await Promise.race([
          processes.waitForCount(index + 1),
          ensuring.then(() => {
            throw new Error(`child did not spawn: ${JSON.stringify(responseFor(sent, ensure).result)}`);
          }),
        ]);
        const initialize = await child.server.expectClientRequest("initialize");
        expect(sent.some((message) => message.type === "relay:codex-command-response" && message.commandId === ensure.commandId)).toBeFalse();
        initialize.reply({
          userAgent: "Synthetic Codex",
          codexHome: child.spec.env["CODEX_HOME"],
          platformFamily: "unix",
          platformOs: "macos",
        }, { generation: 1 });
        await child.server.expectClientNotification("initialized");
        await ensuring;
        const ensureResponse = responseFor(sent, ensure);
        expect(ensureResponse.result).toEqual({ kind: "child_ready" });
        const childGeneration = "childGeneration" in ensureResponse.scope
          ? ensureResponse.scope.childGeneration
          : 1;
        const openScope: BindingOpenScope = {
          ...launchScope,
          childGeneration,
          workspace: receipt,
          bindingId: `binding-${route.label}`,
          bindingGeneration: 1,
          taskId: `task-${route.label}`,
          jobId: `job-${route.label}`,
        };
        const open = command({
          type: "relay:codex-command",
          commandId: `open-${route.label}`,
          scope: openScope,
          command: {
            kind: "open_binding",
            model: "gpt-5.6-codex",
            posture,
          },
        });
        const opening = host.onCommand(open);
        const start = await child.server.expectClientRequest("thread/start");
        start.reply(threadResponse(`thread-${route.label}`, workspace), { generation: 1 });
        await opening;
        const openResponse = responseFor(sent, open);
        expect(openResponse.result).toEqual({ kind: "binding_ready" });
        if (!("threadId" in openResponse.scope)) throw new Error("expected binding scope");
        bindings.set(route.label, { scope: openResponse.scope as BindingScope, child });
      }

      expect(processes.specs[0]).toMatchObject({
        executablePath: runtimeFixture.privateTargets.external,
        args: ["app-server", "--listen", "stdio://"],
      });
      for (const spec of processes.specs.slice(1)) {
        expect(spec.args).toEqual(["--listen", "stdio://"]);
        expect(spec.env["PATH"]).toEndWith("/codex-path");
      }
      expect(new Set(processes.specs.map((spec) => spec.env["CODEX_HOME"])).size).toBe(3);

      const sibling = bindings.get("install")!;
      const relayCountBeforeNativeRequests = sent.length;
      sibling.child.server.notify("account/login/completed", {
        loginId: "synthetic-login",
        success: true,
        error: null,
      }, { generation: 1 });
      sibling.child.server.notify("account/rateLimits/updated", {
        rateLimits: safeRateLimits(),
      }, { generation: 1 });
      sibling.child.server.notify("thread/tokenUsage/updated", {
        threadId: sibling.scope.threadId,
        turnId: "turn-synthetic",
        tokenUsage: { modelContextWindow: 128_000 },
      }, { generation: 1 });
      const nativeInput = sibling.child.server.request("item/tool/requestUserInput", {
        threadId: sibling.scope.threadId,
        turnId: "turn-synthetic",
        itemId: "item-synthetic",
        questions: [{
          id: "target",
          header: "Target",
          question: "Choose the synthetic target",
          isOther: true,
          isSecret: false,
          options: null,
        }],
      }, { generation: 1 });
      await nativeInput.expectResult((result) => {
        expect(result).toEqual({ answers: { target: { answers: ["synthetic-result"] } } });
      });
      await eventually(() => notifications.length === 3);
      expect(requests).toEqual(["item/tool/requestUserInput"]);
      // The injected typed-client seam answers this native request locally;
      // no unprojected request or private payload may leak onto the relay.
      expect(sent).toHaveLength(relayCountBeforeNativeRequests);

      const crashedExternal = bindings.get("external")!.child;
      const crashedIdentity = crashedExternal.identity;
      if (!crashedIdentity) throw new Error("missing crashed child identity");
      crashedExternal.exit(9, null);
      expect(await supervisorFault.promise).toEqual({ kind: "child_crashed", child: crashedIdentity });
      const resume = command({
        type: "relay:codex-command",
        commandId: "resume-healthy-sibling",
        scope: sibling.scope,
        command: { kind: "resume_binding" },
      });
      const resuming = host.onCommand(resume);
      const resumeRequest = await sibling.child.server.expectClientRequest("thread/resume");
      resumeRequest.reply(threadResponse(sibling.scope.threadId, workspace), { generation: 1 });
      await resuming;
      expect(responseFor(sent, resume).result).toEqual({ kind: "binding_ready" });
      expect(sibling.child.signals).toEqual([]);
      expect(transportFaults.some((child) => sameChild(child, sibling.child.identity!))).toBeFalse();

      const replacementScope: ProfileLaunchScope = {
        ...session,
        profileHandle: "profile-external",
        profileGeneration: 1,
        accountGeneration: 1,
        runtimeGeneration: 12,
      };
      const replace = command({
        type: "relay:codex-command",
        commandId: "replace-crashed-generation",
        scope: replacementScope,
        command: { kind: "ensure_profile_child", posture },
      });
      const replacing = host.onCommand(replace);
      const replacement = await processes.waitForCount(4);
      const replacementInitialize = await replacement.server.expectClientRequest("initialize");
      replacementInitialize.reply({
        userAgent: "Synthetic Codex",
        codexHome: replacement.spec.env["CODEX_HOME"],
        platformFamily: "unix",
        platformOs: "macos",
      }, { generation: 2 });
      await replacement.server.expectClientNotification("initialized");
      await replacing;
      expect(responseFor(sent, replace).result).toEqual({ kind: "child_ready" });
      expect(crashedExternal.signals).toEqual([]);
      expect(currentChildren.get("actor-fixture\u0000profile-external")?.childGeneration).toBe(2);

      const serializedRelay = JSON.stringify(sent);
      expect(serializedRelay).not.toContain(root);
      expect(serializedRelay).not.toContain("/fixture/private/");
      expect(serializedRelay).not.toContain("CODEX_HOME");
      expect(serializedRelay).not.toContain("SENSITIVE_ENV_SENTINEL");
      expect(JSON.stringify(routes.map((route) => route.details))).not.toContain("/fixture/private/");
      expect(SYNTHETIC_RUNTIME_FIXTURE_PROVENANCE).toBe("nautilo_synthetic");
      expect(process.env["PATH"]).toBe(inheritedPath);
      expect(process.env["CODEX_HOME"]).toBe(inheritedCodexHome);
    } finally {
      try {
        await host?.shutdown();
        expect(timer?.pendingCount ?? 0).toBe(0);
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    }
  }, 30_000);
});

function command(value: RelayCodexServerMessage): RelayCodexCommandMessage {
  const parsed = parseRelayCodexServerMessage(value);
  expect(parsed.ok).toBeTrue();
  if (!parsed.ok || parsed.value.type !== "relay:codex-command") throw new Error("invalid relay fixture command");
  return parsed.value;
}

function responseFor(sent: readonly RelayCodexClientMessage[], input: RelayCodexCommandMessage) {
  const response = [...sent].reverse().find((message) => (
    message.type === "relay:codex-command-response"
    && message.commandId === input.commandId
  ));
  if (!response) throw new Error(`missing response for ${input.commandId}`);
  expect(isRelayCodexCommandResponseForCommand(input, response)).toBeTrue();
  return response;
}

function threadResponse(id: string, cwd: string) {
  return {
    thread: { id, status: { type: "idle" }, turns: [] },
    model: "gpt-5.6-codex",
    cwd,
  };
}

function safeRateLimits() {
  return {
    limitId: "primary",
    limitName: "Synthetic",
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2_000 },
    secondary: null,
    credits: { hasCredits: true, unlimited: false, balance: "10" },
    individualLimit: null,
    planType: "pro",
    rateLimitReachedType: null,
  };
}

function profileKey(child: ChildIdentity): string {
  return `${child.profile.actorId}\u0000${child.profile.profileHandle}`;
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let iteration = 0; iteration < 100; iteration += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("synthetic app-server activity did not settle");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function childIdentity(childGeneration: number): ChildIdentity {
  return {
    profile: {
      actorId: "actor-fixture",
      profileHandle: "profile-a" as OpaqueHandle,
      profileGeneration: 1,
    },
    accountGeneration: 1,
    runtimeGeneration: 1,
    childGeneration,
  };
}

function fakeSpawnSpec(label: string): SpawnSpec {
  return {
    executablePath: `/fixture/private/nautilo_synthetic/${label}`,
    args: ["--listen", "stdio://"],
    cwd: `/fixture/workspace/${label}`,
    env: { CODEX_HOME: `/fixture/home/${label}` },
    detached: true,
  };
}

async function initializeDirectClient(
  client: Awaited<ReturnType<NodeCodexAppServerClientFactory["connect"]>>,
  child: FakeCodexChild,
  generation: number,
): Promise<void> {
  const initializing = client.initialize();
  const request = await child.server.expectClientRequest("initialize");
  request.reply({
    userAgent: "Synthetic Codex",
    codexHome: child.spec.env["CODEX_HOME"],
    platformFamily: "unix",
    platformOs: "macos",
  }, { generation });
  await initializing;
  await child.server.expectClientNotification("initialized");
}

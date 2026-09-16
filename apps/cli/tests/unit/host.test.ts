import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yargs from "yargs";

import {
  compileRailwayHeldTemplateScaffold,
  railwayMe,
  railwayProjects,
  type RailwayGraphqlVariables,
  type RailwayDeploymentPlan,
  type RailwayOperation,
  type RailwayOperationData,
  type RailwayOperationVariables,
  type RailwayPlanTransport,
  type RailwayPlanReleaseInput,
  type RailwayTransportResult,
  type RailwayTemplateAdoptionObservation,
} from "@nautilo/railway-hosting";

import { createRailwayDeploymentDriverState } from "../../src/lib/railway-deployment-runner.ts";
import {
  KeyringRailwayProviderCustodyStore,
  type RailwayProviderCustodyKeyringEntry,
} from "../../src/lib/railway-provider-custody.ts";
import {
  KeyringRailwayLaunchSecretStore,
  type RailwayLaunchSecretKeyringEntry,
} from "../../src/lib/railway-launch-secret-store.ts";
import {
  KeyringRailwayOwnerClaimStore,
  type RailwayOwnerClaimKeyringEntry,
} from "../../src/lib/railway-owner-claim-store.ts";
import {
  hashRailwayOwnerClaim,
  RailwayOwnerClaimControllerError,
  type RailwayOwnerClaimTarget,
} from "../../src/lib/railway-owner-claim-target.ts";
import {
  advanceRailwayMaintenanceUntilBlocked,
  clearRailwayLaunchCustody,
  createHostProgressSink,
  createHostModule,
  discoverProviderReferences,
  isRailwayLaunchSelector,
  railwayMaintenanceCustodyProjection,
  railwayMaintenanceProjectionComplete,
  renderRailwayPlanTty,
  type HostPlanInputFailure,
  type HostPlanDependencies,
} from "../../src/commands/host.ts";
import type { HostProviderPrompter } from "../../src/lib/host-provider-prompt.ts";

interface RecordedCall {
  readonly name: string;
  readonly isMutation: boolean;
  readonly variables: unknown;
}

class ReadOnlyFixtureTransport implements RailwayPlanTransport {
  readonly calls: RecordedCall[] = [];

  async execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
    operation: Operation,
    variables: RailwayOperationVariables<Operation>,
  ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
    this.calls.push({ name: operation.name, isMutation: operation.isMutation, variables });
    if (operation.isMutation) throw new Error("host plan attempted a mutation");
    if (operation.name === railwayMe.name) {
      return {
        outcome: "success",
        data: {
          me: {
            id: "user-1",
            name: "Taylor",
            workspaces: [{ id: "workspace-1", name: "Trial" }],
          },
        },
        metadata: { httpStatus: 200, rateLimit: {} },
      } as RailwayTransportResult<RailwayOperationData<Operation>>;
    }
    if (operation.name === railwayProjects.name) {
      return {
        outcome: "success",
        data: {
          projects: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
        metadata: { httpStatus: 200, rateLimit: {} },
      } as RailwayTransportResult<RailwayOperationData<Operation>>;
    }
    throw new Error("unexpected Railway operation");
  }
}

class InspectFixtureTransport implements RailwayPlanTransport {
  readonly calls: RecordedCall[] = [];

  async execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
    operation: Operation,
    variables: RailwayOperationVariables<Operation>,
  ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
    this.calls.push({ name: operation.name, isMutation: operation.isMutation, variables });
    if (operation.isMutation) throw new Error("inspect attempted a mutation");
    const connection = (nodes: readonly unknown[]) => ({
      edges: nodes.map((node, index) => ({ cursor: `cursor-${index}`, node })),
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    const success = (data: unknown) => ({
      outcome: "success" as const,
      data,
      metadata: { httpStatus: 200, rateLimit: {} },
    }) as RailwayTransportResult<RailwayOperationData<Operation>>;

    switch (operation.name) {
      case "RailwayProject":
        return success({ project: { id: "project-1", name: "nautilo" } });
      case "RailwayEnvironments":
        return success({ environments: connection([{ id: "environment-1", name: "production" }]) });
      case "RailwayProjectServices":
        return success({
          project: {
            services: connection([
              { id: "service-logto", name: "logto" },
              { id: "service-nautilo", name: "nautilo-server" },
            ]),
          },
        });
      case "RailwayEnvironmentVolumeInstances":
        return success({
          environment: { id: "environment-1", name: "production", volumeInstances: connection([]) },
        });
      case "RailwayDomains": {
        const serviceId = (variables as unknown as { readonly serviceId: string }).serviceId;
        return success({
          domains: {
            serviceDomains: serviceId === "service-logto"
              ? [{ id: "domain-logto", domain: "logto.generated.railway.app", targetPort: 4301 }]
              : [{ id: "domain-nautilo", domain: "nautilo.generated.railway.app", targetPort: 3001 }],
            customDomains: [],
          },
        });
      }
      default:
        throw new Error(`unexpected Railway inspection operation: ${operation.name}`);
    }
  }
}

class MemoryProviderCustodyEntry implements RailwayProviderCustodyKeyringEntry {
  value: string | null = null;
  writes = 0;

  getPassword(): Promise<string | null> {
    return Promise.resolve(this.value);
  }

  setPassword(password: string): Promise<void> {
    this.value = password;
    this.writes += 1;
    return Promise.resolve();
  }

  deleteCredential(): Promise<boolean> {
    const existed = this.value !== null;
    this.value = null;
    return Promise.resolve(existed);
  }
}

class MemorySecretEntry implements RailwayLaunchSecretKeyringEntry, RailwayOwnerClaimKeyringEntry {
  value: string | null = null;
  deletes = 0;

  getPassword(): Promise<string | null> { return Promise.resolve(this.value); }
  setPassword(value: string): Promise<void> {
    this.value = value;
    return Promise.resolve();
  }
  deleteCredential(): Promise<boolean> {
    this.deletes += 1;
    const existed = this.value !== null;
    this.value = null;
    return Promise.resolve(existed);
  }
}

interface Harness {
  readonly dependencies: HostPlanDependencies;
  readonly transport: ReadOnlyFixtureTransport;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly authorizationCalls: { count: number; requests: boolean[] };
}

function harness(environment: NodeJS.ProcessEnv): Harness {
  const transport = new ReadOnlyFixtureTransport();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const authorizationCalls = { count: 0, requests: [] as boolean[] };
  return {
    transport,
    stdout,
    stderr,
    authorizationCalls,
    dependencies: {
      environment,
      acquireRailwayAuthorization: (request) => {
        authorizationCalls.count += 1;
        authorizationCalls.requests.push(request.interactive);
        return Promise.resolve({
          outcome: "authorized",
          transport,
          authorization: { kind: "railway-oauth", mutationScope: "unqualified" },
        });
      },
      resolveRailwayRelease: () => Promise.resolve({ state: "not-published" }),
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
    },
  };
}

async function runHost(args: readonly string[], dependencies: HostPlanDependencies): Promise<void> {
  await yargs([...args])
    .scriptName("nautilo")
    .exitProcess(false)
    .strict()
    .command(createHostModule(dependencies))
    .fail((message, error) => {
      throw error ?? new Error(message);
    })
    .parseAsync();
}

async function rejected(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to reject");
}

function verifiedResumeRelease(): RailwayPlanReleaseInput {
  const digest = (name: string, character: string) => `${name}@sha256:${character.repeat(64)}`;
  return {
    state: "verified",
    channel: "qualification",
    manifest: {
      schemaVersion: 1,
      releaseId: "qualification-provider-config",
      images: [
        { name: "app-postgres", reference: digest("registry.nautilo.test/app-postgres", "a") },
        { name: "logto-postgres", reference: digest("registry.nautilo.test/logto-postgres", "b") },
        { name: "logto", reference: digest("registry.nautilo.test/logto", "c") },
        { name: "nautilo-server", reference: digest("registry.nautilo.test/nautilo-server", "d") },
        { name: "nautilo-bootstrap", reference: digest("registry.nautilo.test/nautilo-bootstrap", "e") },
      ],
      topology: {
        schemaVersion: 1,
        bootstrap: { image: "nautilo-bootstrap" },
        services: [
          { name: "app-postgres", role: "app-postgres", image: "app-postgres" },
          { name: "logto-postgres", role: "logto-postgres", image: "logto-postgres" },
          { name: "logto-seed", role: "logto-seed", image: "logto" },
          { name: "logto", role: "logto", image: "logto" },
          { name: "nautilo-server", role: "nautilo-server", image: "nautilo-server" },
        ],
        persistentMounts: [
          { role: "app-postgres-data", service: "app-postgres", mountPath: "/var/lib/postgresql/data" },
          { role: "logto-postgres-data", service: "logto-postgres", mountPath: "/var/lib/postgresql/data" },
          { role: "nautilo-data", service: "nautilo-server", mountPath: "/var/lib/nautilo" },
        ],
        environmentSchemaVersion: 1,
        migrationSchemaVersion: 1,
      },
      compatibility: {
        runtime: { minimum: 1, maximum: 1 },
        protocol: { minimum: 1, maximum: 1 },
        topology: { minimum: 1, maximum: 1 },
      },
    },
  } as unknown as RailwayPlanReleaseInput;
}

function adoptionObservation(release: RailwayPlanReleaseInput): RailwayTemplateAdoptionObservation {
  if (release.state !== "verified") throw new Error("expected verified release");
  const compiled = compileRailwayHeldTemplateScaffold(release.manifest);
  if (!compiled.ok) throw new Error(compiled.code);
  const serviceIds = new Map(compiled.scaffold.services.map((service, index) => [service.name, `service-${index + 1}`]));
  return {
    workspaceId: "workspace-1", projectId: "project-1", projectName: "nautilo-template",
    environmentId: "environment-1", environmentName: "production",
    sourceTemplateId: "template-1", sourceTemplateThreadSlug: null,
    services: compiled.scaffold.services.map((service, index) => ({
      id: serviceIds.get(service.name)!, name: service.name, image: service.image,
      startCommand: service.startCommand, templateId: "template-1",
      templateServiceId: `template-service-${index + 1}`, templateThreadSlug: null,
      deploymentId: `deployment-${index + 1}`, deploymentStatus: "SUCCESS",
      variables: Object.fromEntries(service.variables.map((variable) => [variable.key,
        variable.custody === "safe-literal" ? variable.value : `generated-${service.name}-${variable.key}`.padEnd(48, "x")])),
      unrenderedVariables: Object.fromEntries(service.variables.map((variable) => [variable.key, variable.value])),
    })),
    volumes: compiled.scaffold.volumes.map((volume, index) => ({ id: `volume-${index + 1}`, name: `volume-${index + 1}`,
      serviceId: serviceIds.get(volume.service)!, mountPath: volume.mountPath })),
    domains: compiled.scaffold.domains.map((domain, index) => ({ id: `domain-${index + 1}`,
      serviceId: serviceIds.get(domain.service)!, targetPort: domain.targetPort })),
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nautilo-host-cli-"));
  process.exitCode = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  process.exitCode = 0;
});

describe("host adopt Railway audit", () => {
  test("discovers one exact held project without copied IDs or Railway mutations", async () => {
    const fixture = harness({ HOME: root });
    const release = verifiedResumeRelease();
    if (release.state !== "verified") throw new Error("expected verified release");
    const candidate = adoptionObservation(release);
    const dependencies: HostPlanDependencies = {
      ...fixture.dependencies,
      resolveRailwayRelease: () => Promise.resolve(release),
      createRailwayTemplateAdoptionDiscovery: () => ({
        discoverNautiloShapedProjects: () => Promise.resolve([candidate]),
      }),
    };
    await runHost(["host", "adopt", "--backend", "railway"], dependencies);
    expect(process.exitCode).toBe(0);
    expect(fixture.stdout.join("")).toContain("Outcome: ready");
    expect(fixture.stdout.join("")).toContain("Railway changes: none");
    expect(`${fixture.stdout.join("")} ${fixture.stderr.join("")}`).not.toContain("project-1");
    expect(`${fixture.stdout.join("")} ${fixture.stderr.join("")}`).not.toContain("generated-");
    expect(fixture.transport.calls).toEqual([]);
  });

  test("returns deterministic blocked JSON without prompting or leaking IDs", async () => {
    const fixture = harness({ HOME: root });
    const release = verifiedResumeRelease();
    const dependencies: HostPlanDependencies = {
      ...fixture.dependencies,
      resolveRailwayRelease: () => Promise.resolve(release),
      createRailwayTemplateAdoptionDiscovery: () => ({
        discoverNautiloShapedProjects: () => Promise.resolve([]),
      }),
    };
    await runHost(["host", "adopt", "--backend", "railway", "--json"], dependencies);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(fixture.stdout.join(""))).toEqual({
      schemaVersion: 1, operation: "adopt-audit", backend: "railway", outcome: "blocked",
      code: "railway.template-adoption.no-match", nextAction: "repair-or-remove-held-project", mutationAuthorized: false,
    });
    expect(fixture.authorizationCalls.requests).toEqual([false]);
  });

  for (const withProviders of [false, true]) test(`confirmed adoption durably binds receipt and optional providers (${withProviders}) before entering the driver`, async () => {
    const fixture = harness({ HOME: root });
    const release = verifiedResumeRelease();
    if (release.state !== "verified") throw new Error("expected verified release");
    const signedManifest = { manifest: release.manifest,
      signature: { algorithm: "ed25519" as const, keyId: "test-key", value: Buffer.alloc(64).toString("base64") } };
    const retainedInputs: unknown[] = [];
    const candidate = adoptionObservation(release);
    const keyring = new MemorySecretEntry();
    const providerKeyring = new MemorySecretEntry();
    const providerStore = new KeyringRailwayProviderCustodyStore(providerKeyring);
    const config = join(root, "providers.toml");
    const key = `bu_${"synthetic".repeat(6)}`;
    await writeFile(config, `schemaVersion = 1\n[providers]\nbrowser-use = { value = "${key}" }\n`, { mode: 0o600 });
    const args = ["host", "adopt", "--backend", "railway", "--yes", "--json", "--progress", "none",
      ...(withProviders ? ["--provider-config", config] : [])];
    const dependencies: HostPlanDependencies = {
      ...fixture.dependencies,
      resolveRailwayRelease: (retained) => {
        retainedInputs.push(retained);
        return Promise.resolve({ ...release, signedManifest });
      },
      acquireRailwayAuthorization: (request) => {
        fixture.authorizationCalls.count += 1;
        fixture.authorizationCalls.requests.push(request.interactive);
        return Promise.resolve({ outcome: "authorized", transport: fixture.transport,
          authorization: { kind: "railway-oauth", mutationScope: "qualified" } });
      },
      createRailwayTemplateAdoptionDiscovery: () => ({
        discoverNautiloShapedProjects: () => Promise.resolve([candidate]),
      }),
      createRailwayLaunchSecretStore: () => Promise.resolve(new KeyringRailwayLaunchSecretStore(keyring)),
      createRailwayProviderCustodyStore: () => Promise.resolve(providerStore),
    };
    if (withProviders) {
      await runHost(args.filter((arg) => arg !== "--yes"), dependencies);
      expect(providerKeyring.value).toBeNull();
      expect(keyring.value).toBeNull();
      expect(fixture.transport.calls.every(({ isMutation }) => !isMutation)).toBeTrue();
    }
    await runHost(args, dependencies);
    const launchesRoot = join(root, ".nautilo", "hosting", "railway", "launches");
    const launchIds = await readdir(launchesRoot);
    expect(launchIds).toHaveLength(1);
    const state: unknown = JSON.parse(await readFile(join(launchesRoot, launchIds[0]!, "state.json"), "utf8"));
    expect(retainedInputs.at(-1)).toEqual(signedManifest);
    expect(state).toMatchObject({ releaseId: release.manifest.releaseId, releaseManifest: signedManifest,
      templateAdoption: { schemaVersion: 1, releases: {}, heldDeploymentIds: {
        "logto-seed": "deployment-3", logto: "deployment-4", "nautilo-server": "deployment-5",
      } } });
    expect(keyring.value).not.toBeNull();
    expect(state).toMatchObject({ providers: withProviders ? ["browser-use"] : [] });
    if (withProviders) {
      expect(await providerStore.load({ launchId: launchIds[0]!, releaseId: release.manifest.releaseId })).toEqual(new Map([["browser-use", key]]));
    }
    expect(JSON.stringify(state)).not.toContain(key);
    expect(fixture.stdout.join("\n") + fixture.stderr.join("\n")).not.toContain(key);
    expect(JSON.stringify(state)).not.toContain("generated-");
    expect(fixture.transport.calls.every(({ isMutation }) => !isMutation)).toBeTrue();
    expect(JSON.parse(fixture.stdout.at(-1)!)).toMatchObject({ operation: "adopt", outcome: "failure" });

    process.exitCode = 0;
    await runHost(args, dependencies);
    expect(await readdir(launchesRoot)).toEqual(launchIds);
    expect(JSON.parse(fixture.stdout.at(-1)!)).toMatchObject({ operation: "adopt", outcome: "failure" });
  });
});

describe("host plan provider discovery", () => {
  test("reads canonical documented config without writes and gives environment precedence", async () => {
    const runtimeConfig = join(root, ".nautilo", "runtime-config");
    const configPath = join(runtimeConfig, "instance.env");
    await mkdir(runtimeConfig, { recursive: true, mode: 0o700 });
    const fileOpenRouter = `sk-or-v1-${"f".repeat(40)}`;
    const fileTavily = `tvly-${"f".repeat(20)}`;
    const environmentTavily = `tvly-${"e".repeat(20)}`;
    await writeFile(
      configPath,
      `OPENROUTER_API_KEY=${fileOpenRouter}\nTAVILY_API_KEY=${fileTavily}\n`,
      { mode: 0o600 },
    );
    const beforeBody = await readFile(configPath, "utf8");
    const beforeEntries = await readdir(runtimeConfig);

    const result = await discoverProviderReferences({
      HOME: root,
      TAVILY_API_KEY: environmentTavily,
    });

    expect(result).toEqual({
      outcome: "resolved",
      references: [
        { provider: "openrouter", source: "documented-config", state: "configured" },
        { provider: "tavily", source: "environment", state: "configured" },
      ],
    });
    expect(await readFile(configPath, "utf8")).toBe(beforeBody);
    expect(await readdir(runtimeConfig)).toEqual(beforeEntries);
    expect(JSON.stringify(result)).not.toContain(fileOpenRouter);
    expect(JSON.stringify(result)).not.toContain(environmentTavily);
  });

  test("uses explicit config, falls back to root instance.env, and treats absence normally", async () => {
    const explicit = join(root, "explicit.env");
    await writeFile(explicit, `ELEVENLABS_API_KEY=sk_${"v".repeat(24)}\n`, { mode: 0o600 });
    expect(await discoverProviderReferences({
      HOME: join(root, "unused"),
      NAUTILO_DOTENV_PATH: explicit,
    })).toMatchObject({
      outcome: "resolved",
      references: [{ provider: "elevenlabs", source: "documented-config", state: "configured" }],
    });

    const nautiloRoot = join(root, ".nautilo");
    await mkdir(nautiloRoot, { mode: 0o700 });
    await writeFile(join(nautiloRoot, "instance.env"), `TAVILY_API_KEY=tvly-${"t".repeat(20)}\n`, {
      mode: 0o600,
    });
    expect(await discoverProviderReferences({ HOME: root })).toMatchObject({
      outcome: "resolved",
      references: [{ provider: "tavily", source: "documented-config", state: "configured" }],
    });
    expect(await discoverProviderReferences({ HOME: join(root, "missing-home") })).toEqual({
      outcome: "resolved",
      references: [],
    });
  });

  test("discovers direct and routed model providers for the runtime projection", async () => {
    const result = await discoverProviderReferences({
      HOME: root,
      OPENROUTER_API_KEY: `sk-or-v1-${"o".repeat(40)}`,
      OPENAI_API_KEY: `sk-${"x".repeat(40)}`,
      ANTHROPIC_API_KEY: `sk-ant-${"a".repeat(40)}`,
      TAVILY_API_KEY: `tvly-${"t".repeat(20)}`,
    });
    expect(result).toMatchObject({
      outcome: "resolved",
      references: [
        { provider: "anthropic", state: "configured" },
        { provider: "openai", state: "configured" },
        { provider: "openrouter", state: "configured" },
        { provider: "tavily", state: "configured" },
      ],
    });
  });

  test("returns typed failures for unsafe, oversized, and unreadable existing config", async () => {
    const actual = join(root, "actual.env");
    const linked = join(root, "linked.env");
    await writeFile(actual, "TAVILY_API_KEY=redacted\n", { mode: 0o600 });
    await symlink(actual, linked);
    expect(await discoverProviderReferences({ NAUTILO_DOTENV_PATH: linked })).toEqual({
      outcome: "failure",
      code: "railway.plan.provider-config-unsafe",
    });

    const oversized = join(root, "oversized.env");
    await writeFile(oversized, "x".repeat(1024 * 1024 + 1), { mode: 0o600 });
    expect(await discoverProviderReferences({ NAUTILO_DOTENV_PATH: oversized })).toEqual({
      outcome: "failure",
      code: "railway.plan.provider-config-too-large",
    });

    const shared = join(root, "shared.env");
    await writeFile(shared, "TAVILY_API_KEY=redacted\n", { mode: 0o644 });
    await chmod(shared, 0o644);
    expect(await discoverProviderReferences({ NAUTILO_DOTENV_PATH: shared })).toEqual({
      outcome: "failure",
      code: "railway.plan.provider-config-unsafe",
    });

    if (process.platform !== "win32") {
      const blockedDirectory = join(root, "blocked");
      const unreadable = join(blockedDirectory, "instance.env");
      await mkdir(blockedDirectory, { mode: 0o700 });
      await writeFile(unreadable, "TAVILY_API_KEY=redacted\n", { mode: 0o600 });
      await chmod(blockedDirectory, 0o000);
      try {
        expect(await discoverProviderReferences({ NAUTILO_DOTENV_PATH: unreadable })).toEqual({
          outcome: "failure",
          code: "railway.plan.provider-config-unreadable",
        });
      } finally {
        await chmod(blockedDirectory, 0o700);
      }
    }
  });
});

describe("nautilo host plan", () => {
  test("saved launch selectors admit deploy UUIDs and exact restored launch identities", () => {
    const uuid = "00000000-0000-4000-8000-000000000007";
    expect(isRailwayLaunchSelector(uuid)).toBe(true);
    expect(isRailwayLaunchSelector(`restore-${uuid}`)).toBe(true);
    expect(isRailwayLaunchSelector(`restore-restore-${uuid}`)).toBe(false);
    expect(isRailwayLaunchSelector("restore-project-by-name")).toBe(false);
  });

  test("paused final verification can confirm exact candidate-promoted custody", () => {
    const postUpgradeSourceState = { launchId: "launch-1", releaseId: "release-target" };
    const state = {
      sourceLaunchId: "launch-1",
      maintenanceReceipt: { stage: "release", targetReleaseId: "release-target" },
      candidateUpgrade: { stage: "complete" },
      postUpgradeSourceState,
    };
    expect(railwayMaintenanceCustodyProjection(state as never)).toBe(postUpgradeSourceState as never);
    expect(railwayMaintenanceCustodyProjection({ ...state, maintenanceReceipt: {
      ...state.maintenanceReceipt, stage: "complete" }, activeLaunch: { kind: "restore-target" } } as never))
      .toBe(postUpgradeSourceState as never);
    expect(railwayMaintenanceCustodyProjection({ ...state,
      candidateUpgrade: { stage: "verify-final" } } as never)).toBeUndefined();
    expect(railwayMaintenanceCustodyProjection({ ...state,
      postUpgradeSourceState: { ...postUpgradeSourceState, releaseId: "release-other" } } as never)).toBeUndefined();
    expect(railwayMaintenanceCustodyProjection({ ...state,
      postUpgradeSourceState: { ...postUpgradeSourceState, launchId: "launch-other" } } as never)).toBeUndefined();
  });

  test("completed maintenance discovery ignores history only after a causally later active projection", () => {
    const launchId = "00000000-0000-4000-8000-000000000007";
    const maintenance = {
      maintenanceId: "maintenance-old",
      sourceLaunchId: launchId,
      maintenanceReceipt: { stage: "complete" },
      activeLaunch: {
        kind: "source",
        launchId,
        releaseId: "release-old",
        selectedAt: "2026-08-14T12:45:40.775Z",
      },
    };
    const later = {
      launchId,
      state: {
        launchId,
        releaseId: "release-new",
        lifecycle: {
          state: "active",
          maintenanceId: "maintenance-new",
          updatedAt: "2026-08-14T16:54:20.034Z",
        },
      },
    };
    expect(railwayMaintenanceProjectionComplete(maintenance as never, [later as never])).toBe(true);
    expect(railwayMaintenanceProjectionComplete({
      ...maintenance,
      maintenanceId: "maintenance-new",
      activeLaunch: {
        ...maintenance.activeLaunch,
        releaseId: "release-new",
        selectedAt: "2026-08-14T17:00:00.000Z",
      },
    } as never, [{
      ...later,
      state: {
        ...later.state,
        releaseId: "release-old",
        lifecycle: {
          state: "active",
          maintenanceId: "maintenance-old",
          updatedAt: "2026-08-14T16:54:20.034Z",
        },
      },
    } as never])).toBe(false);
  });

  test("upgrade discovery is mutation-free when no saved server is eligible", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-host-upgrade-empty-"));
    const fixture = harness({ HOME: root });
    await runHost(["host", "upgrade", "--backend", "railway", "--recovery-config", join(root, "recovery.toml")], fixture.dependencies);
    expect(fixture.authorizationCalls.count).toBe(0);
    expect(fixture.transport.calls).toEqual([]);
    expect(fixture.stderr.join("")).toContain("No eligible saved Railway server");
    expect(process.exitCode).toBe(2);
    await rm(root, { recursive: true, force: true });
  });

  test("maintenance command keeps advancing durable revisions and reports truthful public phases", async () => {
    const states = [
      { revision: 1, portableExport: { target: { state: "started" } } },
      { revision: 2, portableExport: { target: { state: "started" } }, candidateUpgrade: { stage: "start-ready" } },
      { revision: 3, portableExport: { target: { state: "started" } }, candidateUpgrade: { stage: "complete" } },
    ];
    const results = [
      { outcome: "pending" as const, phase: "provider-backup" },
      { outcome: "pending" as const, phase: "portable-export" },
      { outcome: "complete" as const, active: "source" as const },
    ];
    const phases: string[] = [];
    let calls = 0;
    const advanced = await advanceRailwayMaintenanceUntilBlocked({
      initialState: { revision: 0 } as never,
      run: async () => results[calls++]!,
      readState: async () => states[calls - 1] as never,
      reportPhase: (phase) => phases.push(phase),
      interrupted: () => false,
    });
    expect(calls).toBe(3);
    expect(phases).toEqual(["exporting", "updating"]);
    expect(advanced.result).toEqual({ outcome: "complete", active: "source" });
    expect(advanced.state?.revision).toBe(3);
  });

  test("maintenance command returns pending when a provider observation makes no durable progress", async () => {
    let calls = 0;
    const state = { revision: 8, candidateUpgrade: { stage: "started" } } as never;
    const advanced = await advanceRailwayMaintenanceUntilBlocked({
      initialState: state,
      run: async () => { calls += 1; return { outcome: "pending", phase: "portable-export" }; },
      readState: async () => state,
      reportPhase: () => undefined,
      interrupted: () => false,
    });
    expect(calls).toBe(1);
    expect(advanced.result).toEqual({ outcome: "pending", phase: "portable-export" });
  });

  test("unified resume discovers the sole unfinished deployment when no maintenance exists", async () => {
    const launchId = "00000000-0000-4000-8000-000000000008";
    const state = createRailwayDeploymentDriverState({ launchId, releaseId: "qualification-provider-config", providers: [],
      target: { workspaceId: "workspace-1", projectName: "nautilo-resume-discovery", environmentName: "production" },
      now: "2026-08-07T00:00:00.000Z" });
    const directory = join(root, ".nautilo", "hosting", "railway", "launches", launchId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "state.json"), `${JSON.stringify(state)}\n`, { mode: 0o600 });
    const fixture = harness({ HOME: root });
    await runHost(["host", "resume", "--backend", "railway", "--json"], {
      ...fixture.dependencies,
      resolveRailwayRelease: () => Promise.resolve(verifiedResumeRelease()),
    });
    expect(fixture.authorizationCalls.count).toBe(1);
    expect(fixture.stderr.join("")).not.toContain("specify --launch");
    expect(process.exitCode).toBe(2);
  });

  test("resume reports an active maintenance projection complete without owner or provider effects", async () => {
    const launchId = "00000000-0000-4000-8000-000000000009";
    const created = createRailwayDeploymentDriverState({ launchId, releaseId: "release-2", providers: [],
      target: { workspaceId: "workspace-1", projectName: "nautilo-active", environmentName: "production" },
      now: "2026-08-07T00:00:00.000Z" });
    const state = { ...created, workflow: { schemaVersion: 1 as const, releaseId: "release-2", stage: "complete" as const },
      reconcile: { receipt: { ...created.reconcile.receipt, revision: 2, stage: "claimable" as const,
      updatedAt: "2026-08-07T00:00:01.000Z", claimableAt: "2026-08-07T00:00:01.000Z" } },
      lifecycle: { state: "active" as const, updatedAt: "2026-08-07T00:00:02.000Z", maintenanceId: "maintenance-1" } };
    const directory = join(root, ".nautilo", "hosting", "railway", "launches", launchId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "state.json"), `${JSON.stringify(state)}\n`, { mode: 0o600 });
    const fixture = harness({ HOME: root });
    await runHost(["host", "resume", "--backend", "railway", "--launch", launchId, "--json"], fixture.dependencies);
    expect(fixture.authorizationCalls.count).toBe(0);
    expect(JSON.parse(fixture.stdout.join(""))).toEqual({ schemaVersion: 1, operation: "resume", backend: "railway",
      outcome: "complete", phase: "complete" });
    expect(process.exitCode).toBe(0);
  });

  test("upgrade discovery never reclassifies a partial destroy as an active legacy launch", async () => {
    const launchId = "00000000-0000-4000-8000-000000000010";
    const created = createRailwayDeploymentDriverState({ launchId, releaseId: "release-1", providers: [],
      target: { workspaceId: "workspace-1", projectName: "nautilo-destroying", environmentName: "production" },
      now: "2026-08-07T00:00:00.000Z" });
    const receipt = { ...created.reconcile.receipt, revision: 2, stage: "claimable" as const,
      updatedAt: "2026-08-07T00:00:01.000Z", claimableAt: "2026-08-07T00:00:01.000Z",
      resources: [{ kind: "railway.project", id: "project-1", name: "nautilo-destroying" }] };
    const state = { ...created, reconcile: { receipt }, destroy: { schemaVersion: 1 as const, receipt, stage: "validate" as const } };
    const directory = join(root, ".nautilo", "hosting", "railway", "launches", launchId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "state.json"), `${JSON.stringify(state)}\n`, { mode: 0o600 });
    const fixture = harness({ HOME: root });
    await runHost(["host", "upgrade", "--backend", "railway", "--recovery-config", join(root, "unused")], fixture.dependencies);
    expect(fixture.stderr.join("")).toContain("No eligible saved Railway server");
    expect(fixture.authorizationCalls.count).toBe(0);
  });
  test("interactive provider entry selects hidden values without touching ambient config", async () => {
    const secret = `sk-or-v1-${"m".repeat(40)}`;
    const fixture = harness({ HOME: root, OPENROUTER_API_KEY: `sk-or-v1-${"e".repeat(40)}` });
    let promptCalls = 0;
    const prompter: HostProviderPrompter = {
      choose: async () => {
        promptCalls += 1;
        return { kind: "manual", providers: new Map([["openrouter", secret]]) };
      },
      repair: async () => undefined,
    };

    await runHost(["host", "plan", "--backend", "railway"], {
      ...fixture.dependencies,
      isInteractiveTerminal: () => true,
      createHostProviderPrompter: () => prompter,
    });

    expect(promptCalls).toBe(1);
    expect(fixture.authorizationCalls.requests).toEqual([true]);
    expect(fixture.stdout.join("")).toContain("OpenRouter (configured)");
    expect(fixture.stdout.join("")).not.toContain(secret);
    expect(fixture.stdout.join("")).not.toContain("sk-or-v1-e");
    expect(fixture.stderr.join("")).not.toContain(secret);
  });

  test("JSON provider input never invokes the interactive prompt seam", async () => {
    const fixture = harness({ HOME: root });
    let promptCalls = 0;
    await runHost(["host", "plan", "--backend", "railway", "--json"], {
      ...fixture.dependencies,
      isInteractiveTerminal: () => true,
      createHostProviderPrompter: () => {
        promptCalls += 1;
        throw new Error("JSON must not prompt");
      },
    });

    expect(promptCalls).toBe(0);
    expect(fixture.authorizationCalls.requests).toEqual([false]);
  });

  test("passes an explicit safe project name into the read-only plan", async () => {
    const fixture = harness({ HOME: root, OPENROUTER_API_KEY: `sk-or-v1-${"p".repeat(40)}` });
    await runHost([
      "host",
      "plan",
      "--backend",
      "railway",
      "--project-name",
      "nautilo-d508a1b2c3d4",
      "--all-providers",
      "--json",
    ], fixture.dependencies);

    const plan = JSON.parse(fixture.stdout.join("")) as RailwayDeploymentPlan;
    expect(plan.target).toMatchObject({
      projectName: "nautilo-d508a1b2c3d4",
      nameAvailable: true,
    });
    expect(fixture.authorizationCalls.requests).toEqual([false]);
    expect(fixture.transport.calls.every((call) => call.isMutation === false)).toBe(true);
  });

  test("rejects an unsafe project name before provider discovery or Railway authorization", async () => {
    for (const command of ["plan", "deploy"] as const) {
      const fixture = harness({ HOME: root, OPENROUTER_API_KEY: `sk-or-v1-${"q".repeat(40)}` });
      await runHost([
        "host",
        command,
        "--backend",
        "railway",
        "--project-name",
        "Nautilo qualification",
        "--json",
      ], fixture.dependencies);

      const failure = JSON.parse(fixture.stdout.join("")) as HostPlanInputFailure;
      expect(failure).toMatchObject({
        outcome: "input-failure",
        mutationAuthorized: false,
        error: {
          code: "railway.plan.project-name-invalid",
          nextAction: "repair-project-name",
        },
      });
      expect(fixture.authorizationCalls.count).toBe(0);
      expect(fixture.transport.calls).toEqual([]);
    }
  });

  test("non-terminal provider input never invokes the interactive prompt seam", async () => {
    const fixture = harness({ HOME: root });
    let promptCalls = 0;
    await runHost(["host", "plan", "--backend", "railway"], {
      ...fixture.dependencies,
      isInteractiveTerminal: () => false,
      createHostProviderPrompter: () => {
        promptCalls += 1;
        throw new Error("non-terminal input must not prompt");
      },
    });

    expect(promptCalls).toBe(0);
    expect(fixture.authorizationCalls.requests).toEqual([false]);
  });

  test("renders TTY and JSON from the same deterministic Railway plan object", async () => {
    const secret = `sk-or-v1-${"s".repeat(40)}`;
    const jsonHarness = harness({ HOME: root, OPENROUTER_API_KEY: secret });
    await runHost([
      "host",
      "plan",
      "--backend",
      "railway",
      "--all-providers",
      "--allow-core-degraded",
      "--json",
    ], jsonHarness.dependencies);
    const plan = JSON.parse(jsonHarness.stdout.join("")) as RailwayDeploymentPlan;

    const ttyHarness = harness({ HOME: root, OPENROUTER_API_KEY: secret });
    await runHost([
      "host",
      "plan",
      "--backend",
      "railway",
      "--all-providers",
      "--allow-core-degraded",
    ], {
      ...ttyHarness.dependencies,
      isInteractiveTerminal: () => false,
    });

    expect(ttyHarness.stdout.join("")).toBe(renderRailwayPlanTty(plan));
    expect(jsonHarness.stderr).toEqual([]);
    expect(ttyHarness.stderr).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain(secret);
    expect(plan).toMatchObject({
      operation: "plan",
      backend: "railway",
      mutationAuthorized: false,
      payer: { state: "resolved", workspaceId: "workspace-1" },
      cost: {
        state: "estimated",
        capturedAt: "2026-08-03T16:30:00.000Z",
        workload: "representative-team",
        monthlyBillCents: 5_076,
      },
    });
    for (const fixture of [jsonHarness, ttyHarness]) {
      expect(fixture.transport.calls.map((call) => call.name)).toEqual([
        "RailwayMe",
        "RailwayProjects",
      ]);
      expect(fixture.transport.calls.every((call) => call.isMutation === false)).toBe(true);
      expect(fixture.authorizationCalls.requests).toEqual([false]);
    }
  });

  test("binds repeatable include/exclude flags to the rich provider plan", async () => {
    const fixture = harness({
      HOME: root,
      OPENROUTER_API_KEY: `sk-or-v1-${"o".repeat(40)}`,
      TAVILY_API_KEY: `tvly-${"t".repeat(20)}`,
    });
    await runHost([
      "host",
      "plan",
      "--backend",
      "railway",
      "--all-providers",
      "--include-provider",
      "elevenlabs",
      "--include-provider",
      "openrouter",
      "--exclude-provider",
      "tavily",
      "--allow-core-degraded",
      "--json",
    ], fixture.dependencies);
    const plan = JSON.parse(fixture.stdout.join("")) as RailwayDeploymentPlan;
    expect(plan.providerPlan.providers.find((item: { provider: string }) =>
      item.provider === "openrouter")).toMatchObject({ selected: true, state: "configured" });
    expect(plan.providerPlan.providers.find((item: { provider: string }) =>
      item.provider === "tavily")).toMatchObject({ selected: false, state: "excluded" });
    expect(plan.providerPlan.issues).toContainEqual({
      code: "provider.missing-credential",
      provider: "elevenlabs",
    });
  });

  test("JSON authorization failure is typed, nonprompting, and requires an interactive OAuth run", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let authorizationCalls = 0;
    await runHost([
      "host",
      "plan",
      "--backend",
      "railway",
      "--json",
    ], {
      environment: { HOME: root },
      resolveRailwayRelease: () => Promise.resolve({ state: "not-published" }),
      acquireRailwayAuthorization: (request) => {
        authorizationCalls += 1;
        expect(request.interactive).toBe(false);
        return Promise.resolve({
          outcome: "authorization-required",
          failure: {
            kind: "reauthorization-required",
            repair: "run-in-interactive-terminal",
          },
        });
      },
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
    });

    expect(JSON.parse(stdout.join(""))).toEqual({
      schemaVersion: 1,
      operation: "plan",
      backend: "railway",
      outcome: "authorization-required",
      mutationAuthorized: false,
      error: {
        code: "railway.plan.authorization-required",
        message: "Railway authorization requires an interactive terminal; JSON and non-TTY runs never open a browser.",
        reason: "reauthorization-required",
        nextAction: "run-in-interactive-terminal",
      },
    });
    expect(stderr).toEqual([]);
    expect(authorizationCalls).toBe(1);
    expect(process.exitCode).toBe(2);
  });

  test("local config and release failures are redacted and prevent authorization", async () => {
    const unsafe = join(root, "unsafe.env");
    await writeFile(unsafe, "OPENROUTER_API_KEY=super-secret\n", { mode: 0o644 });
    await chmod(unsafe, 0o644);
    const fixture = harness({ HOME: root, NAUTILO_DOTENV_PATH: unsafe });
    await runHost([
      "host",
      "plan",
      "--backend",
      "railway",
      "--json",
    ], fixture.dependencies);
    const failure = JSON.parse(fixture.stdout.join("")) as HostPlanInputFailure;
    expect(failure.error.code).toBe("railway.plan.provider-config-unsafe");
    expect(JSON.stringify(failure)).not.toContain("super-secret");
    expect(fixture.authorizationCalls.count).toBe(0);

    const releaseFixture = harness({ HOME: root });
    const releaseDependencies: HostPlanDependencies = {
      ...releaseFixture.dependencies,
      resolveRailwayRelease: () => Promise.reject(new Error("raw release failure secret")),
    };
    await runHost([
      "host",
      "plan",
      "--backend",
      "railway",
      "--json",
    ], releaseDependencies);
    const releaseFailure = JSON.parse(releaseFixture.stdout.join("")) as HostPlanInputFailure;
    expect(releaseFailure.error.code).toBe("railway.plan.release-unavailable");
    expect(JSON.stringify(releaseFailure)).not.toContain("raw release failure secret");
    expect(releaseFixture.authorizationCalls.count).toBe(0);
  });

  test("provider-only TOML is applied before Railway authorization without leaking its path or value", async () => {
    const providerConfig = join(root, "providers.toml");
    const secret = `sk-or-v1-${"p".repeat(40)}`;
    await writeFile(providerConfig, [
      "schemaVersion = 1",
      "[providers]",
      `openrouter = { value = "${secret}" }`,
      "",
    ].join("\n"), { mode: 0o600 });
    const fixture = harness({ HOME: root });
    await runHost([
      "host",
      "plan",
      "--backend",
      "railway",
      "--provider-config",
      providerConfig,
      "--all-providers",
      "--allow-core-degraded",
      "--json",
    ], fixture.dependencies);
    const plan = JSON.parse(fixture.stdout.join("")) as RailwayDeploymentPlan;
    expect(plan.providerPlan.providers.find((item: { provider: string }) => item.provider === "openrouter"))
      .toMatchObject({ state: "configured", selected: true, source: "documented-config" });
    expect(fixture.authorizationCalls.count).toBe(1);
    expect(JSON.stringify(plan)).not.toContain(providerConfig);
    expect(JSON.stringify(plan)).not.toContain(secret);

    const invalid = join(root, "invalid-providers.toml");
    await writeFile(invalid, "schemaVersion = 1\n[providers]\nunknown = { value = \"not-a-key\" }\n", { mode: 0o600 });
    const invalidFixture = harness({ HOME: root });
    await runHost([
      "host",
      "plan",
      "--backend",
      "railway",
      "--provider-config",
      invalid,
      "--json",
    ], invalidFixture.dependencies);
    const failure = JSON.parse(invalidFixture.stdout.join("")) as HostPlanInputFailure;
    expect(failure.error.code).toBe("railway.plan.provider-config-invalid");
    expect(invalidFixture.authorizationCalls.count).toBe(0);
    expect(JSON.stringify(failure)).not.toContain(invalid);
  });

  test("deploy and resume reject invalid --provider-config before Railway authorization", async () => {
    const invalid = join(root, "invalid-providers.toml");
    const secret = "provider-config-must-not-leak";
    await writeFile(
      invalid,
      `schemaVersion = 1\n[providers]\nunknown = { value = "${secret}" }\n`,
      { mode: 0o600 },
    );

    const deployFixture = harness({ HOME: root });
    await runHost([
      "host",
      "deploy",
      "--backend",
      "railway",
      "--provider-config",
      invalid,
      "--json",
    ], deployFixture.dependencies);
    const deployFailure = JSON.parse(deployFixture.stdout.join("")) as HostPlanInputFailure;
    expect(deployFailure.error.code).toBe("railway.plan.provider-config-invalid");
    expect(deployFixture.authorizationCalls.count).toBe(0);
    expect(deployFixture.transport.calls).toEqual([]);
    expect(JSON.stringify(deployFailure)).not.toContain(secret);
    expect(JSON.stringify(deployFailure)).not.toContain(invalid);

    const launchId = "00000000-0000-4000-8000-000000000001";
    const state = createRailwayDeploymentDriverState({
      launchId,
      releaseId: "qualification-provider-config",
      providers: ["openrouter"],
      target: { workspaceId: "workspace-1", projectName: "nautilo-provider-config", environmentName: "production" },
      now: "2026-08-07T00:00:00.000Z",
    });
    const stateDirectory = join(root, ".nautilo", "hosting", "railway", "launches", launchId);
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(stateDirectory, "state.json"), `${JSON.stringify(state)}\n`, { mode: 0o600 });
    const resumeFixture = harness({ HOME: root });
    const resumeDependencies: HostPlanDependencies = {
      ...resumeFixture.dependencies,
      resolveRailwayRelease: () => Promise.resolve(verifiedResumeRelease()),
    };
    await runHost([
      "host",
      "resume",
      "--backend",
      "railway",
      "--launch",
      launchId,
      "--provider-config",
      invalid,
      "--json",
    ], resumeDependencies);
    const resumeFailure = JSON.parse(resumeFixture.stdout.join("")) as HostPlanInputFailure;
    expect(resumeFailure.error.code).toBe("railway.plan.provider-config-invalid");
    expect(resumeFixture.authorizationCalls.count).toBe(0);
    expect(resumeFixture.transport.calls).toEqual([]);
    expect(JSON.stringify(resumeFailure)).not.toContain(secret);
    expect(JSON.stringify(resumeFailure)).not.toContain(invalid);
  });

  test("resume uses retained provider custody first and only repairs an absent envelope from explicit config", async () => {
    const launchId = "00000000-0000-4000-8000-000000000002";
    const providerValue = `sk-or-v1-${"r".repeat(40)}`;
    const writeState = async (id: string, workflowStage?: "server-ready" | "complete") => {
      const state = createRailwayDeploymentDriverState({
        launchId: id,
        releaseId: "qualification-provider-config",
        providers: ["openrouter"],
        target: { workspaceId: "workspace-1", projectName: "nautilo-provider-custody", environmentName: "production" },
        now: "2026-08-07T00:00:00.000Z",
      });
      const directory = join(root, ".nautilo", "hosting", "railway", "launches", id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const persisted = workflowStage === undefined ? state : {
        ...state,
        workflow: { schemaVersion: 1, releaseId: "qualification-provider-config", stage: workflowStage },
      };
      await writeFile(join(directory, "state.json"), `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
    };
    await writeState(launchId);

    const retainedEntry = new MemoryProviderCustodyEntry();
    const retainedStore = new KeyringRailwayProviderCustodyStore(retainedEntry);
    await retainedStore.writeOrConfirm({
      launchId,
      releaseId: "qualification-provider-config",
      providers: new Map([["openrouter", providerValue]]),
    });
    const retainedFixture = harness({ HOME: root });
    await runHost([
      "host",
      "resume",
      "--backend",
      "railway",
      "--launch",
      launchId,
      "--json",
    ], {
      ...retainedFixture.dependencies,
      resolveRailwayRelease: () => Promise.resolve(verifiedResumeRelease()),
      createRailwayProviderCustodyStore: () => Promise.resolve(retainedStore),
    });
    expect(retainedFixture.authorizationCalls.count).toBe(1);
    expect(retainedFixture.stderr.join("")).not.toContain("provider custody repaired");
    expect(retainedEntry.writes).toBe(1);

    const conflictingConfig = join(root, "conflicting-providers.toml");
    const conflictingValue = `sk-or-v1-${"c".repeat(40)}`;
    await writeFile(conflictingConfig, [
      "schemaVersion = 1",
      "[providers]",
      `openrouter = { value = "${conflictingValue}" }`,
      "",
    ].join("\n"), { mode: 0o600 });
    const conflictFixture = harness({ HOME: root });
    await runHost([
      "host",
      "resume",
      "--backend",
      "railway",
      "--launch",
      launchId,
      "--provider-config",
      conflictingConfig,
      "--json",
    ], {
      ...conflictFixture.dependencies,
      resolveRailwayRelease: () => Promise.resolve(verifiedResumeRelease()),
      createRailwayProviderCustodyStore: () => Promise.resolve(retainedStore),
    });
    expect(conflictFixture.authorizationCalls.count).toBe(0);
    expect(conflictFixture.stderr.join("")).toContain("provider credential custody");
    expect(conflictFixture.stderr.join("")).not.toContain(conflictingValue);
    expect(conflictFixture.stderr.join("")).not.toContain(conflictingConfig);
    expect(retainedEntry.writes).toBe(1);

    const repairLaunchId = "00000000-0000-4000-8000-000000000003";
    await writeState(repairLaunchId);
    const repairConfig = join(root, "repair-providers.toml");
    await writeFile(repairConfig, [
      "schemaVersion = 1",
      "[providers]",
      `openrouter = { value = "${providerValue}" }`,
      "",
    ].join("\n"), { mode: 0o600 });
    const repairEntry = new MemoryProviderCustodyEntry();
    const repairStore = new KeyringRailwayProviderCustodyStore(repairEntry);
    const repairFixture = harness({ HOME: root });
    await runHost([
      "host",
      "resume",
      "--backend",
      "railway",
      "--launch",
      repairLaunchId,
      "--provider-config",
      repairConfig,
      "--json",
    ], {
      ...repairFixture.dependencies,
      resolveRailwayRelease: () => Promise.resolve(verifiedResumeRelease()),
      createRailwayProviderCustodyStore: () => Promise.resolve(repairStore),
    });
    expect(repairFixture.authorizationCalls.count).toBe(1);
    expect(repairEntry.writes).toBe(1);
    expect(repairEntry.value).not.toBeNull();
    expect(JSON.stringify(repairFixture.stdout)).not.toContain(providerValue);
    expect(JSON.stringify(repairFixture.stderr)).not.toContain(repairConfig);

    const readyLaunchId = "00000000-0000-4000-8000-000000000004";
    await writeState(readyLaunchId, "server-ready");
    const readyFixture = harness({ HOME: root });
    let readyCustodyStoreCalls = 0;
    await runHost([
      "host",
      "resume",
      "--backend",
      "railway",
      "--launch",
      readyLaunchId,
      "--json",
    ], {
      ...readyFixture.dependencies,
      resolveRailwayRelease: () => Promise.resolve(verifiedResumeRelease()),
      createRailwayProviderCustodyStore: () => {
        readyCustodyStoreCalls += 1;
        return Promise.reject(new Error("keychain is intentionally unavailable"));
      },
    });
    expect(readyFixture.authorizationCalls.count).toBe(0);
    expect(readyCustodyStoreCalls).toBe(1);
    expect(readyFixture.stderr.join("")).toContain("provider credential custody");
  });

  test("interactive resume repairs only absent pre-projection provider custody", async () => {
    const launchId = "00000000-0000-4000-8000-000000000005";
    const providerValue = `sk-or-v1-${"i".repeat(40)}`;
    const state = createRailwayDeploymentDriverState({
      launchId,
      releaseId: "qualification-provider-config",
      providers: ["openrouter"],
      target: { workspaceId: "workspace-1", projectName: "nautilo-interactive-repair", environmentName: "production" },
      now: "2026-08-07T00:00:00.000Z",
    });
    const directory = join(root, ".nautilo", "hosting", "railway", "launches", launchId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "state.json"), `${JSON.stringify(state)}\n`, { mode: 0o600 });

    const entry = new MemoryProviderCustodyEntry();
    const custody = new KeyringRailwayProviderCustodyStore(entry);
    const fixture = harness({ HOME: root });
    let repairs = 0;
    await runHost([
      "host",
      "resume",
      "--backend",
      "railway",
      "--launch",
      launchId,
    ], {
      ...fixture.dependencies,
      resolveRailwayRelease: () => Promise.resolve(verifiedResumeRelease()),
      createRailwayProviderCustodyStore: () => Promise.resolve(custody),
      isInteractiveTerminal: () => true,
      createHostProviderPrompter: () => ({
        choose: async () => ({ kind: "skip" }),
        repair: async ({ providers }) => {
          repairs += 1;
          expect(providers).toEqual(["openrouter"]);
          return new Map([["openrouter", providerValue]]);
        },
      }),
    });

    expect(repairs).toBe(1);
    expect(entry.writes).toBe(1);
    expect(fixture.authorizationCalls.requests).toEqual([true]);
    expect(fixture.stdout.join("")).not.toContain(providerValue);
    expect(fixture.stderr.join("")).not.toContain(providerValue);
  });

  test("local generated, provider, and temporary owner-claim custody cleanup attempts are independent", async () => {
    const calls: string[] = [];
    const generatedFailure = await clearRailwayLaunchCustody({
      clearGenerated: async () => {
        calls.push("generated");
        throw new Error("generated unavailable");
      },
      clearProviders: async () => {
        calls.push("providers");
      },
      clearOwnerClaim: async () => {
        calls.push("owner-claim");
      },
    });
    expect(calls).toEqual(["generated", "providers", "owner-claim"]);
    expect(generatedFailure).toEqual({ cleanupFailed: true });

    calls.length = 0;
    const providerFailure = await clearRailwayLaunchCustody({
      clearGenerated: async () => {
        calls.push("generated");
      },
      clearProviders: async () => {
        calls.push("providers");
        throw new Error("provider unavailable");
      },
      clearOwnerClaim: async () => {
        calls.push("owner-claim");
      },
    });
    expect(calls).toEqual(["generated", "providers", "owner-claim"]);
    expect(providerFailure).toEqual({ cleanupFailed: true });

    calls.length = 0;
    const ownerClaimFailure = await clearRailwayLaunchCustody({
      clearGenerated: async () => { calls.push("generated"); },
      clearProviders: async () => { calls.push("providers"); },
      clearOwnerClaim: async () => {
        calls.push("owner-claim");
        throw new Error("owner claim unavailable");
      },
    });
    expect(calls).toEqual(["generated", "providers", "owner-claim"]);
    expect(ownerClaimFailure).toEqual({ cleanupFailed: true });
  });

  test("strict parsing rejects provider, Railway, and password secrets on argv", async () => {
    for (const flag of ["--openrouter-api-key", "--railway-token", "--password"]) {
      const fixture = harness({ HOME: root });
      const error = await rejected(runHost([
        "host",
        "plan",
        "--backend",
        "railway",
        flag,
        "must-not-enter-argv",
      ], fixture.dependencies));
      expect(error).toBeInstanceOf(Error);
      expect(fixture.authorizationCalls.count).toBe(0);
      expect(fixture.stdout).toEqual([]);
    }
  });

  test("deploy remains write-free when confirmation or a verified release is absent", async () => {
    const fixture = harness({ HOME: root, OPENROUTER_API_KEY: `sk-or-v1-${"o".repeat(40)}` });
    await runHost([
      "host",
      "deploy",
      "--backend",
      "railway",
      "--all-providers",
      "--json",
    ], fixture.dependencies);
    const result = JSON.parse(fixture.stdout.join("")) as { outcome: string; nextAction: string };
    expect(result).toMatchObject({ outcome: "blocked", nextAction: "confirm-billable-mutation" });
    expect(fixture.transport.calls.every((call) => call.isMutation === false)).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });

  test("host progress keeps final JSON deterministic and JSONL redacted on stderr", () => {
    const fixture = harness({ HOME: root });
    const event = {
      schemaVersion: 1 as const,
      launchId: "00000000-0000-4000-8000-000000000001",
      stage: "databases",
      kind: "heartbeat" as const,
      elapsedMs: 15_000,
      messageCode: "hosting.poll.heartbeat",
    };
    const jsonl = createHostProgressSink({ progress: "jsonl", json: true }, fixture.dependencies);
    jsonl?.emit(event);
    expect(fixture.stdout).toEqual([]);
    expect(fixture.stderr).toEqual([`${JSON.stringify(event)}\n`]);

    const automaticJson = createHostProgressSink({ progress: "auto", json: true }, fixture.dependencies);
    const silent = createHostProgressSink({ progress: "none", json: false }, fixture.dependencies);
    expect(automaticJson).toBeUndefined();
    expect(silent).toBeUndefined();
    expect(fixture.stderr.join("")).not.toContain("sk-");
  });

  test("resume, inspect, and destroy refuse unknown launch receipts before authorization or mutation", async () => {
    for (const args of [
      ["host", "resume", "--backend", "railway", "--launch", "00000000-0000-4000-8000-000000000001", "--json"],
      ["host", "inspect", "--backend", "railway", "--launch", "00000000-0000-4000-8000-000000000001", "--json"],
      ["host", "destroy", "--backend", "railway", "--launch", "00000000-0000-4000-8000-000000000001", "--confirm-project", "project-1", "--json"],
    ]) {
      const fixture = harness({ HOME: root });
      await runHost(args, fixture.dependencies);
      expect(fixture.authorizationCalls.count).toBe(0);
      expect(fixture.transport.calls).toEqual([]);
      expect(fixture.stderr.join("")).toContain("launch checkpoint");
      expect(await readdir(root)).toEqual([]);
    }
  });

  test("inspect exposes and probes only the receipt's nautilo-public domain", async () => {
    const launchId = "00000000-0000-4000-8000-000000000004";
    const baseState = createRailwayDeploymentDriverState({
      launchId,
      releaseId: "qualification-provider-config",
      providers: [],
      target: { workspaceId: "workspace-1", projectName: "nautilo-inspect", environmentName: "production" },
      now: "2026-08-07T00:00:00.000Z",
    });
    const state = {
      ...baseState,
      reconcile: {
        receipt: {
          ...baseState.reconcile.receipt,
          revision: 4,
          stage: "claimable" as const,
          resources: [
            { kind: "railway.project", id: "project-1", name: "nautilo" },
            { kind: "railway.environment", id: "environment-1", name: "production" },
            { kind: "railway.domain", id: "domain-logto", name: "logto-public" },
            { kind: "railway.domain", id: "domain-nautilo", name: "nautilo-public" },
          ],
          updatedAt: "2026-08-07T00:00:04.000Z",
          claimableAt: "2026-08-07T00:00:04.000Z",
        },
      },
    };
    const stateDirectory = join(root, ".nautilo", "hosting", "railway", "launches", launchId);
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(stateDirectory, "state.json"), `${JSON.stringify(state)}\n`, { mode: 0o600 });

    const transport = new InspectFixtureTransport();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const probes: string[] = [];
    const inspectionFetch = Object.assign(
      async (input: string | URL | Request): Promise<Response> => {
        probes.push(input instanceof Request ? input.url : input.toString());
        return new Response(null, { status: 200 });
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch;
    await runHost([
      "host",
      "inspect",
      "--backend",
      "railway",
      "--launch",
      launchId,
      "--json",
    ], {
      environment: { HOME: root },
      acquireRailwayAuthorization: () => Promise.resolve({
        outcome: "authorized",
        transport,
        authorization: { kind: "railway-oauth", mutationScope: "unqualified" },
      }),
      resolveRailwayRelease: () => Promise.resolve({ state: "not-published" }),
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      fetch: inspectionFetch,
    });

    const result = JSON.parse(stdout.join("")) as { readonly url?: string; readonly runtimeReady: boolean };
    expect(result).toMatchObject({
      url: "https://nautilo.generated.railway.app",
      runtimeReady: true,
    });
    expect(probes).toEqual(["https://nautilo.generated.railway.app/health/ready"]);
    expect(JSON.stringify(result)).not.toContain("logto.generated.railway.app");
    expect(stderr).toEqual([]);
    expect(transport.calls.every((call) => call.isMutation === false)).toBe(true);
  });

  test("claimable resume rotates an expired protected claim, installs only its hash, and never opens a browser for JSON", async () => {
    const launchId = "00000000-0000-4000-8000-000000000006";
    const baseState = createRailwayDeploymentDriverState({
      launchId,
      releaseId: "qualification-provider-config",
      providers: [],
      target: { workspaceId: "workspace-1", projectName: "nautilo-owner-claim", environmentName: "production" },
      now: "2026-08-07T00:00:00.000Z",
    });
    const state = {
      ...baseState,
      reconcile: {
        receipt: {
          ...baseState.reconcile.receipt,
          revision: 4,
          stage: "claimable" as const,
          resources: [
            { kind: "railway.project", id: "project-1", name: "nautilo" },
            { kind: "railway.environment", id: "environment-1", name: "production" },
            { kind: "railway.domain", id: "domain-logto", name: "logto-public" },
            { kind: "railway.domain", id: "domain-nautilo", name: "nautilo-public" },
          ],
          updatedAt: "2026-08-07T00:00:04.000Z",
          claimableAt: "2026-08-07T00:00:04.000Z",
        },
      },
    };
    const stateDirectory = join(root, ".nautilo", "hosting", "railway", "launches", launchId);
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(stateDirectory, "state.json"), `${JSON.stringify(state)}\n`, { mode: 0o600 });

    const generatedEntry = new MemorySecretEntry();
    const generatedStore = new KeyringRailwayLaunchSecretStore(generatedEntry);
    await generatedStore.getOrCreate({ launchId, releaseId: "qualification-provider-config" });
    const originalGeneratedEnvelope = generatedEntry.value;
    const ownerEntry = new MemorySecretEntry();
    const ownerStore = new KeyringRailwayOwnerClaimStore(ownerEntry);
    const expiredClaim = `inv_${"a".repeat(32)}`;
    await ownerStore.getOrCreate({ launchId, releaseId: "qualification-provider-config", generate: () => expiredClaim });
    const installs: Array<{ readonly targetUrl: string; readonly bootstrapToken: string; readonly claimHash: string }> = [];
    const startupSleeps: number[] = [];
    let statusAttempts = 0;
    const ownerTarget: RailwayOwnerClaimTarget = {
      status: async ({ targetUrl }) => {
        expect(targetUrl).toBe("https://nautilo.generated.railway.app");
        statusAttempts += 1;
        if (statusAttempts < 3) {
          throw new RailwayOwnerClaimControllerError("railway.owner-claim.unreachable");
        }
        return { schemaVersion: 1, state: "awaiting-owner" };
      },
      install: async (request) => {
        installs.push(request);
        return { schemaVersion: 1, state: "claim-active" };
      },
    };
    const transport = new InspectFixtureTransport();
    const stdout: string[] = [];
    const stderr: string[] = [];
    let browserOpened = false;
    await runHost([
      "host", "resume", "--backend", "railway", "--launch", launchId,
      "--finish", "product", "--open-browser", "--json",
    ], {
      environment: { HOME: root },
      acquireRailwayAuthorization: () => Promise.resolve({
        outcome: "authorized",
        transport,
        authorization: { kind: "railway-oauth", mutationScope: "qualified" },
      }),
      resolveRailwayRelease: () => Promise.resolve({ state: "not-published" }),
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      createRailwayLaunchSecretStore: () => Promise.resolve(generatedStore),
      createRailwayOwnerClaimStore: () => Promise.resolve(ownerStore),
      railwayOwnerClaimTarget: ownerTarget,
      hostProgressScheduler: {
        now: () => 0,
        sleep: (milliseconds) => { startupSleeps.push(milliseconds); return Promise.resolve(); },
        every: () => () => undefined,
      },
      openRailwayOwnerClaimBrowser: async () => { browserOpened = true; },
    });

    expect(statusAttempts).toBe(3);
    expect(startupSleeps).toEqual([2_000, 2_000]);
    expect(installs).toHaveLength(1);
    const replacement = await ownerStore.getOrCreate({ launchId, releaseId: "qualification-provider-config" });
    expect(replacement).not.toBe(expiredClaim);
    expect(installs[0]!.claimHash).toBe(hashRailwayOwnerClaim(replacement));
    expect(installs[0]!.bootstrapToken).toHaveLength(43);
    expect(generatedEntry.value).toBe(originalGeneratedEnvelope);
    expect(browserOpened).toBe(false);
    const result = JSON.parse(stdout.join("")) as {
      readonly outcome: string;
      readonly ownerSetup: string;
      readonly recovery: { readonly resumeCommand: string };
      readonly completion: {
        readonly finish: string;
        readonly browser: string;
        readonly destinations: { readonly finalUrl: string };
      };
    };
    expect(result).toMatchObject({ outcome: "claim-active", ownerSetup: "claim-active" });
    expect(result.completion.finish).toBe("product");
    expect(result.completion.browser).toBe("not-requested");
    expect(result.completion.destinations.finalUrl).toBe(
      "https://nautilo.generated.railway.app/",
    );
    expect(result.recovery.resumeCommand).toContain(launchId);
    expect(JSON.stringify({ stdout, stderr })).not.toContain(expiredClaim);
    expect(JSON.stringify({ stdout, stderr })).not.toContain(replacement);
    expect(transport.calls.every((call) => call.isMutation === false)).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  test("does not report claim-active when an ambiguous install remains awaiting-owner", async () => {
    const launchId = "00000000-0000-4000-8000-000000000007";
    const baseState = createRailwayDeploymentDriverState({
      launchId,
      releaseId: "qualification-provider-config",
      providers: [],
      target: { workspaceId: "workspace-1", projectName: "nautilo-owner-unknown", environmentName: "production" },
      now: "2026-08-07T00:00:00.000Z",
    });
    const state = {
      ...baseState,
      reconcile: {
        receipt: {
          ...baseState.reconcile.receipt,
          revision: 4,
          stage: "claimable" as const,
          resources: [
            { kind: "railway.project", id: "project-1", name: "nautilo" },
            { kind: "railway.environment", id: "environment-1", name: "production" },
            { kind: "railway.domain", id: "domain-nautilo", name: "nautilo-public" },
          ],
          updatedAt: "2026-08-07T00:00:04.000Z",
          claimableAt: "2026-08-07T00:00:04.000Z",
        },
      },
    };
    const stateDirectory = join(root, ".nautilo", "hosting", "railway", "launches", launchId);
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(stateDirectory, "state.json"), `${JSON.stringify(state)}\n`, { mode: 0o600 });

    const generatedStore = new KeyringRailwayLaunchSecretStore(new MemorySecretEntry());
    await generatedStore.getOrCreate({ launchId, releaseId: "qualification-provider-config" });
    const ownerEntry = new MemorySecretEntry();
    const ownerStore = new KeyringRailwayOwnerClaimStore(ownerEntry);
    let statusReads = 0;
    const ownerTarget: RailwayOwnerClaimTarget = {
      status: async () => {
        statusReads += 1;
        return { schemaVersion: 1, state: "awaiting-owner" };
      },
      install: async () => { throw new RailwayOwnerClaimControllerError("railway.owner-claim.ambiguous-write"); },
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    await runHost([
      "host", "resume", "--backend", "railway", "--launch", launchId, "--json",
    ], {
      environment: { HOME: root },
      acquireRailwayAuthorization: () => Promise.resolve({
        outcome: "authorized",
        transport: new InspectFixtureTransport(),
        authorization: { kind: "railway-oauth", mutationScope: "qualified" },
      }),
      resolveRailwayRelease: () => Promise.resolve({ state: "not-published" }),
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      createRailwayLaunchSecretStore: () => Promise.resolve(generatedStore),
      createRailwayOwnerClaimStore: () => Promise.resolve(ownerStore),
      railwayOwnerClaimTarget: ownerTarget,
    });

    const result = JSON.parse(stdout.join("")) as {
      readonly outcome: string;
      readonly ownerSetup: string;
      readonly ownerSetupErrorCode: string;
      readonly recovery: { readonly resumeCommand: string };
    };
    expect(statusReads).toBe(2);
    expect(result).toMatchObject({ outcome: "install-unknown", ownerSetup: "install-unknown" });
    expect(result.ownerSetupErrorCode).toBe("railway.owner-claim.ambiguous-write");
    expect(result.recovery.resumeCommand).toContain(launchId);
    expect(stderr.join("")).toContain("could not be verified");
    expect(ownerEntry.value).not.toBeNull();
    expect(process.exitCode).toBe(1);
  });
});

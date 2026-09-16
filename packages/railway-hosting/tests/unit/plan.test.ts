import { describe, expect, test } from "bun:test";

import {
  planRailwayDeployment,
  RAILWAY_PROVISIONAL_V0_COST_DISCLOSURE,
  railwayMe,
  railwayProjects,
  type RailwayGraphqlVariables,
  type RailwayCostServiceAssumption,
  type RailwayOperation,
  type RailwayOperationData,
  type RailwayOperationVariables,
  type RailwayPlanRequest,
  type RailwayPlanTransport,
  type RailwayTransportResult,
} from "../../src";
import {
  verifyReleaseManifest,
  type VerifiedReleaseManifest,
} from "@nautilo/hosting";

interface RecordedCall {
  readonly name: string;
  readonly isMutation: boolean;
  readonly variables: unknown;
}

const successMetadata = { httpStatus: 200, rateLimit: {} } as const;

class FixtureTransport implements RailwayPlanTransport {
  readonly calls: RecordedCall[] = [];

  constructor(
    private readonly fixtures: {
      readonly me?: unknown;
      readonly projects?: readonly { readonly id: string; readonly name: string; readonly deletedAt?: string | null }[];
      readonly failure?: "authentication-required" | "network-failure";
    },
  ) {}

  async execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
    operation: Operation,
    variables: RailwayOperationVariables<Operation>,
  ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>> {
    this.calls.push({ name: operation.name, isMutation: operation.isMutation, variables });
    if (operation.isMutation) throw new Error(`plan attempted mutation ${operation.name}`);
    if (this.fixtures.failure !== undefined && operation.name === railwayMe.name) {
      return {
        outcome: "failure",
        failure: { kind: this.fixtures.failure, operation: operation.name },
      } as RailwayTransportResult<RailwayOperationData<Operation>>;
    }
    if (operation.name === railwayMe.name) {
      return {
        outcome: "success",
        data: this.fixtures.me,
        metadata: successMetadata,
      } as RailwayTransportResult<RailwayOperationData<Operation>>;
    }
    if (operation.name === railwayProjects.name) {
      const allProjects = this.fixtures.projects ?? [];
      const after = (variables as { readonly after?: string }).after;
      const start = after === undefined ? 0 : Number.parseInt(after.replace("cursor-", ""), 10);
      const page = allProjects.slice(start, start + 2);
      const end = start + page.length;
      return {
        outcome: "success",
        data: {
          projects: {
            edges: page.map((node, index) => ({ cursor: `edge-${start + index + 1}`, node })),
            pageInfo: {
              hasNextPage: end < allProjects.length,
              endCursor: end < allProjects.length ? `cursor-${end}` : null,
            },
          },
        },
        metadata: successMetadata,
      } as RailwayTransportResult<RailwayOperationData<Operation>>;
    }
    throw new Error(`unexpected read operation ${operation.name}`);
  }
}

function verifiedRelease(): VerifiedReleaseManifest {
  const digest = (character: string) => `registry.nautilo.test/image@sha256:${character.repeat(64)}`;
  const result = verifyReleaseManifest(
    {
      manifest: {
        schemaVersion: 1,
        releaseId: "2026.08.03-v1",
        images: [
          { name: "app-postgres", reference: digest("a") },
          { name: "logto-postgres", reference: digest("b") },
          { name: "logto", reference: digest("c") },
          { name: "nautilo-server", reference: digest("d") },
          { name: "nautilo-bootstrap", reference: digest("e") },
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
      signature: {
        algorithm: "ed25519",
        keyId: "test-key",
        value: Buffer.alloc(64).toString("base64"),
      },
    },
    { runtimeVersion: 1, protocolVersion: 1, topologySchemaVersion: 1 },
    {
      trustedPublicKeys: { "test-key": Buffer.from("test-spki").toString("base64") },
      verifier: { verify: () => true },
    },
  );
  if (!result.ok) throw new Error(`invalid release fixture: ${result.code}`);
  return result.manifest;
}

function request(overrides: Partial<RailwayPlanRequest> = {}): RailwayPlanRequest {
  return {
    authorization: { kind: "railway-oauth", mutationScope: "qualified" },
    release: { state: "verified", channel: "qualification", manifest: verifiedRelease() },
    cost: {
      state: "rate-card-estimate",
      capturedAt: "2026-08-03T16:30:00.000Z",
      workload: "idle",
      serviceAssumptions: [
        { service: "app-postgres", cpuMillicores: 250, memoryMiB: 512, volumeGiB: 1, egressGiBPerMonth: 0, activeHoursPerMonth: 744 },
        { service: "logto-postgres", cpuMillicores: 250, memoryMiB: 512, volumeGiB: 1, egressGiBPerMonth: 0, activeHoursPerMonth: 744 },
        { service: "logto-seed", cpuMillicores: 250, memoryMiB: 256, volumeGiB: 0, egressGiBPerMonth: 0, activeHoursPerMonth: 1 },
        { service: "logto", cpuMillicores: 250, memoryMiB: 512, volumeGiB: 0, egressGiBPerMonth: 1, activeHoursPerMonth: 744 },
        { service: "nautilo-server", cpuMillicores: 500, memoryMiB: 1024, volumeGiB: 1, egressGiBPerMonth: 5, activeHoursPerMonth: 744 },
      ],
    },
    providerSelection: {
      references: [{ provider: "openrouter", source: "environment", state: "configured" }],
      allProviders: true,
      qualifiedBaselineCapabilities: ["embeddings", "search", "tts", "stt"],
      infrastructure: "planned",
      coreDegradedConsent: false,
    },
    ...overrides,
  };
}

function me(workspaces: readonly { readonly id: string; readonly name: string }[]) {
  return { me: { id: "user-1", name: "Taylor", workspaces } };
}

function zeroCostAssumptions(): RailwayCostServiceAssumption[] {
  return ["app-postgres", "logto-postgres", "logto-seed", "logto", "nautilo-server"].map(
    (service) => ({
      service: service as RailwayCostServiceAssumption["service"],
      cpuMillicores: 0,
      memoryMiB: 0,
      volumeGiB: 0,
      egressGiBPerMonth: 0,
      activeHoursPerMonth: 0,
    }),
  );
}

describe("planRailwayDeployment", () => {
  test("exports the dated provisional V0 assumptions as an explicit complete estimate", async () => {
    const transport = new FixtureTransport({
      me: me([{ id: "workspace-1", name: "Trial" }]),
      projects: [],
    });
    const plan = await planRailwayDeployment(transport, request({
      cost: RAILWAY_PROVISIONAL_V0_COST_DISCLOSURE,
    }));

    expect(plan.cost).toMatchObject({
      state: "estimated",
      capturedAt: "2026-08-03T16:30:00.000Z",
      workload: "representative-team",
      monthlyResourceUsageCents: 5_076,
      monthlyBillCents: 5_076,
      assumptionsComplete: true,
    });
  });

  test("uses only read-only identity and project inventory operations", async () => {
    const transport = new FixtureTransport({
      me: me([{ id: "workspace-1", name: "Trial" }]),
      projects: [
        { id: "project-1", name: "first" },
        { id: "project-2", name: "second" },
        { id: "project-3", name: "third" },
        { id: "project-deleted", name: "nautilo", deletedAt: "2026-08-06T00:00:00.000Z" },
      ],
    });
    const plan = await planRailwayDeployment(transport, request());

    expect(transport.calls.map((call) => call.name)).toEqual([
      "RailwayMe",
      "RailwayProjects",
      "RailwayProjects",
    ]);
    expect(transport.calls.every((call) => call.isMutation === false)).toBe(true);
    expect(transport.calls[1]?.variables).toEqual({
      workspaceId: "workspace-1",
      includeDeleted: false,
      first: 50,
    });
    expect(transport.calls[2]?.variables).toEqual({
      workspaceId: "workspace-1",
      includeDeleted: false,
      first: 50,
      after: "cursor-2",
    });
    expect(plan).toMatchObject({
      operation: "plan",
      backend: "railway",
      mutationAuthorized: false,
      target: { projectName: "nautilo", visibleProjectCount: 3, nameAvailable: true },
      payer: {
        state: "resolved",
        kind: "customer-railway-workspace",
        workspaceId: "workspace-1",
      },
    });
    expect(plan.cost).toMatchObject({
      state: "estimated",
      basis: "railway-rate-card",
      monthlyResourceUsageCents: 5_076,
      monthlyBillCents: 5_076,
      assumptionsComplete: true,
      hobbyContext: { minimumCents: 500, includedUsageCents: 500 },
    });
  });

  test("plans an explicit safe project name without adopting the existing default project", async () => {
    const transport = new FixtureTransport({
      me: me([{ id: "workspace-1", name: "Trial" }]),
      projects: [{ id: "existing-project", name: "nautilo" }],
    });

    const plan = await planRailwayDeployment(transport, request({
      projectName: "nautilo-d508a1b2c3d4",
    }));

    expect(plan).toMatchObject({
      outcome: "ready-for-confirmation",
      mutationAuthorized: false,
      target: {
        projectName: "nautilo-d508a1b2c3d4",
        visibleProjectCount: 1,
        nameAvailable: true,
      },
    });
    expect(plan.notices.some((item) => item.code === "railway.plan.project-name-collision")).toBe(false);
  });

  test("rejects an unsafe explicit project name without substituting the default", async () => {
    const transport = new FixtureTransport({
      me: me([{ id: "workspace-1", name: "Trial" }]),
      projects: [],
    });

    const plan = await planRailwayDeployment(transport, request({ projectName: "Nautilo qualification" }));

    expect(plan).toMatchObject({
      outcome: "blocked",
      mutationAuthorized: false,
      target: { projectName: "Nautilo qualification", nameAvailable: true },
    });
    expect(plan.notices).toContainEqual({
      severity: "blocking",
      code: "railway.plan.project-name-invalid",
      message: "The Railway project name must use 1-64 lowercase letters, digits, or hyphens and cannot begin or end with a hyphen.",
    });
  });

  test("derives a transparent estimate from the documented CPU, RAM, volume, and egress rates", async () => {
    const assumptions = zeroCostAssumptions();
    assumptions[4] = {
      service: "nautilo-server",
      cpuMillicores: 1_000,
      memoryMiB: 1_024,
      volumeGiB: 10,
      egressGiBPerMonth: 20,
      activeHoursPerMonth: 744,
    };
    const transport = new FixtureTransport({
      me: me([{ id: "workspace-1", name: "Trial" }]),
      projects: [],
    });
    const plan = await planRailwayDeployment(transport, request({
      cost: {
        state: "rate-card-estimate",
        capturedAt: "2026-08-03T17:00:00.000Z",
        workload: "representative-team",
        serviceAssumptions: assumptions,
      },
    }));
    expect(plan.cost).toMatchObject({
      state: "estimated",
      monthlyResourceUsageCents: 3_250,
      monthlyBillCents: 3_250,
    });
    if (plan.cost.state !== "estimated") throw new Error("expected estimate");
    expect(plan.cost.breakdown[4]).toEqual({
      service: "nautilo-server",
      cpuCents: 2_000,
      memoryCents: 1_000,
      volumeCents: 150,
      egressCents: 100,
      totalCents: 3_250,
    });
  });

  test("applies the Hobby minimum/included-usage floor after deterministic cent rounding", async () => {
    const assumptions = zeroCostAssumptions();
    assumptions[4] = {
      ...assumptions[4]!,
      volumeGiB: 0.1,
      egressGiBPerMonth: 0.1,
    };
    const transport = new FixtureTransport({
      me: me([{ id: "workspace-1", name: "Trial" }]),
      projects: [],
    });
    const plan = await planRailwayDeployment(transport, request({
      cost: {
        state: "rate-card-estimate",
        capturedAt: "2026-08-03T17:00:00.000Z",
        workload: "idle",
        serviceAssumptions: assumptions,
      },
    }));
    expect(plan.cost).toMatchObject({
      state: "estimated",
      monthlyResourceUsageCents: 3,
      monthlyBillCents: 500,
      hobbyContext: { minimumCents: 500, includedUsageCents: 500 },
    });
    if (plan.cost.state !== "estimated") throw new Error("expected estimate");
    expect(plan.cost.breakdown[4]).toMatchObject({ volumeCents: 2, egressCents: 1, totalCents: 3 });
  });

  test("applies the Hobby floor to a measured resource-usage range", async () => {
    const transport = new FixtureTransport({
      me: me([{ id: "workspace-1", name: "Trial" }]),
      projects: [],
    });
    const plan = await planRailwayDeployment(transport, request({
      cost: {
        state: "measured-range",
        currency: "USD",
        monthlyResourceUsageCents: { minimum: 300, maximum: 800 },
        capturedAt: "2026-08-03T17:00:00.000Z",
        workload: "representative-team",
        serviceAssumptions: zeroCostAssumptions(),
      },
    }));
    expect(plan.cost).toMatchObject({
      state: "measured",
      monthlyResourceUsageCents: { minimum: 300, maximum: 800 },
      monthlyBillCents: { minimum: 500, maximum: 800 },
    });
  });

  test("falls back nonblockingly when no valid estimate assumptions exist", async () => {
    const transport = new FixtureTransport({
      me: me([{ id: "workspace-1", name: "Trial" }]),
      projects: [],
    });
    const plan = await planRailwayDeployment(transport, request({
      cost: {
        state: "rate-card-estimate",
        capturedAt: "2026-08-03T17:00:00.000Z",
        workload: "idle",
        serviceAssumptions: [],
      },
    }));
    expect(plan.cost.state).toBe("not-yet-measured");
    expect(plan.notices.find((item) => item.code === "railway.plan.cost-assumptions-incomplete")?.severity).toBe("warning");
    expect(plan.notices.some((item) =>
      item.code.startsWith("railway.plan.cost-") && item.severity === "blocking",
    )).toBe(false);
  });

  test("keeps the actual unpublished release and topology qualifications blocking", async () => {
    const transport = new FixtureTransport({
      me: me([{ id: "workspace-1", name: "Trial" }]),
      projects: [],
    });
    const unpublished = await planRailwayDeployment(transport, request({
      release: { state: "not-published" },
    }));
    expect(unpublished).toMatchObject({
      outcome: "blocked",
      nextAction: "resolve-blockers",
      release: { state: "not-published" },
      mutationAuthorized: false,
    });
    expect(unpublished.topology).toBeUndefined();
    expect(unpublished.notices.some((item) =>
      item.severity === "blocking" && item.code === "railway.plan.release-not-published",
    )).toBe(true);

    const published = await planRailwayDeployment(transport, request());
    expect(published.topology?.finalServices).toHaveLength(5);
    expect(published.notices.filter((item) => item.code === "railway.plan.topology-qualification")).toEqual([]);
  });

  test("requires explicit workspace choice when consent exposes more than one", async () => {
    const transport = new FixtureTransport({
      me: me([
        { id: "workspace-z", name: "Zed" },
        { id: "workspace-a", name: "Alpha" },
      ]),
    });
    const plan = await planRailwayDeployment(transport, request());
    expect(transport.calls.map((call) => call.name)).toEqual(["RailwayMe"]);
    expect(plan.identity.consentedWorkspaces).toEqual([
      { id: "workspace-a", name: "Alpha" },
      { id: "workspace-z", name: "Zed" },
    ]);
    expect(plan.payer).toEqual({ state: "unresolved" });
    expect(plan.notices.some((item) =>
      item.code === "railway.plan.workspace-selection-required" && item.severity === "blocking",
    )).toBe(true);
  });

  test("classifies read-only authorization failure without exposing transport details", async () => {
    const transport = new FixtureTransport({ failure: "authentication-required" });
    const plan = await planRailwayDeployment(transport, request());
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]).toMatchObject({ name: "RailwayMe", isMutation: false });
    expect(plan.authorization.workspaceDiscovery).toBe("failed");
    expect(plan.notices).toContainEqual({
      severity: "blocking",
      code: "railway.plan.authorization-required",
      message: "Railway authorization cannot read the consented workspace inventory; reauthorization is required.",
    });
    expect(JSON.stringify(plan)).not.toContain("authentication-required");
  });

  test("blocks project collision, unqualified mutation scope, and provider input while cost remains a warning", async () => {
    const transport = new FixtureTransport({
      me: me([{ id: "workspace-1", name: "Trial" }]),
      projects: [{ id: "unrelated-project-id", name: "nautilo" }],
    });
    const plan = await planRailwayDeployment(transport, request({
      authorization: { kind: "development-session", mutationScope: "unqualified" },
      cost: { state: "unavailable" },
      providerSelection: {
        references: [],
        allProviders: false,
        includeProviders: ["openrouter"],
        qualifiedBaselineCapabilities: [],
        infrastructure: "planned",
        coreDegradedConsent: false,
      },
    }));
    expect(plan.target).toMatchObject({ nameAvailable: false });
    expect(plan.providerPlan.issues).toContainEqual({
      code: "provider.missing-credential",
      provider: "openrouter",
    });
    expect(plan.providerPlan.readiness.coreReadiness).toBe("blocked");
    const noticeCodes = new Set(plan.notices.map((item) => item.code));
    for (const code of [
      "railway.plan.cost-unavailable",
      "railway.plan.provider-input-unresolved",
      "railway.plan.core-readiness-blocked",
      "railway.plan.mutation-scope-unqualified",
      "railway.plan.project-name-collision",
    ] as const) {
      expect(noticeCodes.has(code)).toBe(true);
    }
    expect(plan.notices.find((item) => item.code === "railway.plan.cost-unavailable")?.severity).toBe("warning");
  });

  test("cost uncertainty never adds a blocking decision", async () => {
    const validTransport = new FixtureTransport({
      me: me([{ id: "workspace-1", name: "Trial" }]),
      projects: [],
    });
    const unknownTransport = new FixtureTransport({
      me: me([{ id: "workspace-1", name: "Trial" }]),
      projects: [],
    });
    const valid = await planRailwayDeployment(validTransport, request());
    const unknown = await planRailwayDeployment(unknownTransport, request({
      cost: { state: "unavailable" },
    }));
    const blockingCodes = (plan: typeof valid) => plan.notices
      .filter((item) => item.severity === "blocking")
      .map((item) => `${item.code}:${item.subjectCode ?? ""}`);
    expect(blockingCodes(unknown)).toEqual(blockingCodes(valid));
    expect(unknown.cost).toEqual({
      state: "not-yet-measured",
      source: "https://docs.railway.com/pricing/plans",
      rateCardCapturedAt: "2026-08-03",
      rateCard: {
        hoursPerMonth: 744,
        ramGiBMonthCents: 1_000,
        cpuVcpuMonthCents: 2_000,
        volumeGiBMonthCents: 15,
        egressGiBCents: 5,
        hobbyMinimumCents: 500,
        hobbyIncludedUsageCents: 500,
      },
    });
  });

  test("normalizes plan output independently of Railway inventory ordering", async () => {
    const firstTransport = new FixtureTransport({
      me: me([
        { id: "workspace-b", name: "Beta" },
        { id: "workspace-a", name: "Alpha" },
      ]),
      projects: [
        { id: "project-b", name: "second" },
        { id: "project-a", name: "first" },
      ],
    });
    const secondTransport = new FixtureTransport({
      me: me([
        { id: "workspace-a", name: "Alpha" },
        { id: "workspace-b", name: "Beta" },
      ]),
      projects: [
        { id: "project-a", name: "first" },
        { id: "project-b", name: "second" },
      ],
    });
    const selected = request({ workspaceId: "workspace-a" });
    const first = await planRailwayDeployment(firstTransport, selected);
    const second = await planRailwayDeployment(secondTransport, selected);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

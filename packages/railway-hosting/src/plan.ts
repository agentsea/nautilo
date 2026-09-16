import {
  resolveProviderCapabilities,
  type ProviderCapabilityPlan,
  type ProviderSelectionInput,
  type VerifiedReleaseManifest,
  type SignedReleaseManifest,
} from "@nautilo/hosting";

import { railwayMe, railwayProjects, type RailwayProject } from "./operations";
import { paginateRailwayConnection } from "./pagination";
import { buildRailwayTopology, type RailwayTopology } from "./topology";
import type {
  RailwayGraphqlVariables,
  RailwayOperation,
  RailwayOperationData,
  RailwayOperationVariables,
  RailwayTransportResult,
} from "./types";

export const RAILWAY_PLAN_SCHEMA_VERSION = 1 as const;
export const RAILWAY_PLAN_PROJECT_NAME = "nautilo" as const;
export const RAILWAY_PROJECT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const RAILWAY_PRICING_SOURCE = "https://docs.railway.com/pricing/plans" as const;
export const RAILWAY_RATE_CARD_CAPTURED_AT = "2026-08-03" as const;
export const RAILWAY_RATE_CARD = {
  hoursPerMonth: 744,
  ramGiBMonthCents: 1_000,
  cpuVcpuMonthCents: 2_000,
  volumeGiBMonthCents: 15,
  egressGiBCents: 5,
  hobbyMinimumCents: 500,
  hobbyIncludedUsageCents: 500,
} as const;
export const RAILWAY_PROVISIONAL_V0_COST_CAPTURED_AT = "2026-08-03T16:30:00.000Z" as const;

export interface RailwayPlanTransport {
  execute<Operation extends RailwayOperation<string, RailwayGraphqlVariables, unknown>>(
    operation: Operation,
    variables: RailwayOperationVariables<Operation>,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<RailwayTransportResult<RailwayOperationData<Operation>>>;
}

/**
 * Publication is a separate fact from successful manifest verification. A
 * disposable qualification manifest may authorize a live proof without
 * claiming that Nautilo has published a customer release channel.
 */
export type RailwayPlanReleaseInput =
  | {
      readonly state: "verified";
      readonly channel: "qualification" | "production";
      readonly manifest: VerifiedReleaseManifest;
      /** Original envelope retained for signature-checked resume after stable advances. */
      readonly signedManifest?: SignedReleaseManifest | undefined;
    }
  | {
      readonly state: "not-published" | "missing" | "invalid";
    };

/**
 * Railway exposes rate cards, not a Nautilo topology estimator. V0 derives a
 * provisional estimate from explicit assumptions or accepts a measured range.
 */
export type RailwayCostDisclosureInput =
  | { readonly state: "unavailable" }
  | {
      readonly state: "rate-card-estimate";
      readonly capturedAt: string;
      readonly workload: "idle" | "representative-team";
      readonly serviceAssumptions: readonly RailwayCostServiceAssumption[];
    }
  | {
      readonly state: "measured-range";
      readonly currency: "USD";
      readonly monthlyResourceUsageCents: {
        readonly minimum: number;
        readonly maximum: number;
      };
      readonly capturedAt: string;
      readonly workload: "idle" | "representative-team";
      readonly serviceAssumptions: readonly RailwayCostServiceAssumption[];
    };

export type RailwayCostedServiceName =
  | "app-postgres"
  | "logto-postgres"
  | "logto-seed"
  | "logto"
  | "nautilo-server";

export interface RailwayCostServiceAssumption {
  readonly service: RailwayCostedServiceName;
  readonly cpuMillicores: number;
  readonly memoryMiB: number;
  readonly volumeGiB: number;
  readonly egressGiBPerMonth: number;
  readonly activeHoursPerMonth: number;
}

/**
 * Explicit average billable CPU/RAM, volume, and egress assumptions until a
 * measured Nautilo workload range is published. These are a disclosure, not a
 * reservation or billing guarantee; actual Railway usage may differ.
 */
export const RAILWAY_PROVISIONAL_V0_SERVICE_ASSUMPTIONS = [
  { service: "app-postgres", cpuMillicores: 250, memoryMiB: 512, volumeGiB: 1, egressGiBPerMonth: 0, activeHoursPerMonth: 744 },
  { service: "logto-postgres", cpuMillicores: 250, memoryMiB: 512, volumeGiB: 1, egressGiBPerMonth: 0, activeHoursPerMonth: 744 },
  { service: "logto-seed", cpuMillicores: 250, memoryMiB: 256, volumeGiB: 0, egressGiBPerMonth: 0, activeHoursPerMonth: 1 },
  { service: "logto", cpuMillicores: 250, memoryMiB: 512, volumeGiB: 0, egressGiBPerMonth: 1, activeHoursPerMonth: 744 },
  { service: "nautilo-server", cpuMillicores: 500, memoryMiB: 1024, volumeGiB: 1, egressGiBPerMonth: 5, activeHoursPerMonth: 744 },
] as const satisfies readonly RailwayCostServiceAssumption[];

export const RAILWAY_PROVISIONAL_V0_COST_DISCLOSURE = {
  state: "rate-card-estimate",
  capturedAt: RAILWAY_PROVISIONAL_V0_COST_CAPTURED_AT,
  workload: "representative-team",
  serviceAssumptions: RAILWAY_PROVISIONAL_V0_SERVICE_ASSUMPTIONS,
} as const satisfies RailwayCostDisclosureInput;

export interface RailwayPlanRequest {
  /** Omit only when exactly one consented workspace is discoverable. */
  readonly workspaceId?: string | undefined;
  /** Explicit new-project identity; omission preserves the original `nautilo` default. */
  readonly projectName?: string | undefined;
  /** The planner accepts evidence about authorization; it never performs OAuth. */
  readonly authorization: RailwayPlanAuthorizationInput;
  readonly release: RailwayPlanReleaseInput;
  readonly cost: RailwayCostDisclosureInput;
  /** Pure, caller-resolved provider input; this planner performs no file reads. */
  readonly providerSelection: ProviderSelectionInput;
}

export type RailwayPlanAuthorizationInput =
  | {
      readonly kind: "railway-oauth";
      /** Must remain unqualified until the required mutation scopes pass live proof. */
      readonly mutationScope: "qualified" | "unqualified";
    }
  | {
      /** Local development/break-glass identity is never a customer-path authorization. */
      readonly kind: "development-session";
      readonly mutationScope: "unqualified";
    };

export interface RailwayPlanWorkspace {
  readonly id: string;
  readonly name: string;
}

export type RailwayPlanNoticeSeverity = "info" | "warning" | "blocking";

export type RailwayPlanNoticeCode =
  | "railway.plan.authorization-required"
  | "railway.plan.discovery-failed"
  | "railway.plan.workspace-selection-required"
  | "railway.plan.workspace-unavailable"
  | "railway.plan.mutation-scope-unqualified"
  | "railway.plan.project-name-invalid"
  | "railway.plan.project-name-collision"
  | "railway.plan.release-not-published"
  | "railway.plan.release-missing"
  | "railway.plan.release-invalid"
  | "railway.plan.cost-unavailable"
  | "railway.plan.cost-invalid"
  | "railway.plan.cost-assumptions-incomplete"
  | "railway.plan.provider-input-unresolved"
  | "railway.plan.core-readiness-blocked"
  | "railway.plan.topology-invalid"
  | "railway.plan.topology-qualification"
  | "railway.plan.database-operator-managed"
  | "railway.plan.cost-is-disclosure";

export interface RailwayPlanNotice {
  readonly severity: RailwayPlanNoticeSeverity;
  readonly code: RailwayPlanNoticeCode;
  readonly message: string;
  readonly subjectCode?: string | undefined;
}

export type RailwayNormalizedCostDisclosure =
  | {
      readonly state: "not-yet-measured";
      readonly source: typeof RAILWAY_PRICING_SOURCE;
      readonly rateCardCapturedAt: typeof RAILWAY_RATE_CARD_CAPTURED_AT;
      readonly rateCard: typeof RAILWAY_RATE_CARD;
    }
  | {
      readonly state: "estimated";
      readonly basis: "railway-rate-card";
      readonly currency: "USD";
      readonly monthlyResourceUsageCents: number;
      readonly monthlyBillCents: number;
      readonly hobbyContext: RailwayHobbyCostContext;
      readonly breakdown: readonly RailwayServiceCostBreakdown[];
      readonly capturedAt: string;
      readonly workload: "idle" | "representative-team";
      readonly serviceAssumptions: readonly RailwayCostServiceAssumption[];
      readonly assumptionsComplete: boolean;
      readonly source: typeof RAILWAY_PRICING_SOURCE;
      readonly rateCardCapturedAt: typeof RAILWAY_RATE_CARD_CAPTURED_AT;
      readonly rateCard: typeof RAILWAY_RATE_CARD;
    }
  | {
      readonly state: "measured";
      readonly basis: "measured-nautilo-workload";
      readonly currency: "USD";
      readonly monthlyResourceUsageCents: {
        readonly minimum: number;
        readonly maximum: number;
      };
      readonly monthlyBillCents: {
        readonly minimum: number;
        readonly maximum: number;
      };
      readonly hobbyContext: RailwayHobbyCostContext;
      readonly capturedAt: string;
      readonly workload: "idle" | "representative-team";
      readonly serviceAssumptions: readonly RailwayCostServiceAssumption[];
      readonly assumptionsComplete: boolean;
      readonly source: typeof RAILWAY_PRICING_SOURCE;
      readonly rateCardCapturedAt: typeof RAILWAY_RATE_CARD_CAPTURED_AT;
      readonly rateCard: typeof RAILWAY_RATE_CARD;
    };

export interface RailwayHobbyCostContext {
  readonly minimumCents: typeof RAILWAY_RATE_CARD.hobbyMinimumCents;
  readonly includedUsageCents: typeof RAILWAY_RATE_CARD.hobbyIncludedUsageCents;
}

export interface RailwayServiceCostBreakdown {
  readonly service: RailwayCostedServiceName;
  readonly cpuCents: number;
  readonly memoryCents: number;
  readonly volumeCents: number;
  readonly egressCents: number;
  readonly totalCents: number;
}

export interface RailwayDeploymentPlan {
  readonly schemaVersion: typeof RAILWAY_PLAN_SCHEMA_VERSION;
  readonly operation: "plan";
  readonly backend: "railway";
  readonly outcome: "blocked" | "ready-for-confirmation";
  readonly nextAction: "resolve-blockers" | "confirm-billable-mutation";
  readonly mutationAuthorized: false;
  readonly identity: {
    readonly userId?: string | undefined;
    readonly consentedWorkspaces: readonly RailwayPlanWorkspace[];
    readonly selectedWorkspace?: RailwayPlanWorkspace | undefined;
  };
  readonly authorization: {
    readonly workspaceDiscovery: "resolved" | "failed";
    readonly kind: RailwayPlanAuthorizationInput["kind"];
    readonly mutationScope: "qualified" | "unqualified";
  };
  readonly target: {
    readonly projectName: string;
    readonly visibleProjectCount?: number | undefined;
    readonly nameAvailable?: boolean | undefined;
  };
  readonly payer:
    | { readonly state: "unresolved" }
    | {
        readonly state: "resolved";
        readonly kind: "customer-railway-workspace";
        readonly workspaceId: string;
        readonly workspaceName: string;
      };
  readonly release: {
    readonly state: RailwayPlanReleaseInput["state"];
    readonly channel?: "qualification" | "production" | undefined;
    readonly releaseId?: string | undefined;
  };
  readonly topology?: RailwayTopology | undefined;
  readonly cost: RailwayNormalizedCostDisclosure;
  readonly providerPlan: ProviderCapabilityPlan;
  readonly notices: readonly RailwayPlanNotice[];
}

function notice(
  severity: RailwayPlanNoticeSeverity,
  code: RailwayPlanNoticeCode,
  message: string,
  subjectCode?: string,
): RailwayPlanNotice {
  return {
    severity,
    code,
    message,
    ...(subjectCode === undefined ? {} : { subjectCode }),
  };
}

function isTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function normalizeCost(
  input: RailwayCostDisclosureInput,
  notices: RailwayPlanNotice[],
): RailwayNormalizedCostDisclosure {
  if (input.state === "unavailable") {
    notices.push(notice(
      "warning",
      "railway.plan.cost-unavailable",
      "Nautilo's Railway topology cost is not yet measured; Railway will bill actual usage under its current rate card.",
    ));
    return {
      state: "not-yet-measured",
      source: RAILWAY_PRICING_SOURCE,
      rateCardCapturedAt: RAILWAY_RATE_CARD_CAPTURED_AT,
      rateCard: RAILWAY_RATE_CARD,
    };
  }

  const range = input.state === "measured-range"
    ? input.monthlyResourceUsageCents
    : undefined;
  if (
    (range !== undefined && (
      !Number.isSafeInteger(range.minimum) ||
      !Number.isSafeInteger(range.maximum) ||
      range.minimum < 0 ||
      range.maximum < range.minimum
    )) ||
    !isTimestamp(input.capturedAt)
  ) {
    notices.push(notice(
      "warning",
      "railway.plan.cost-invalid",
      "The supplied cost disclosure is malformed and is reported as not yet measured; it does not block deployment.",
    ));
    return {
      state: "not-yet-measured",
      source: RAILWAY_PRICING_SOURCE,
      rateCardCapturedAt: RAILWAY_RATE_CARD_CAPTURED_AT,
      rateCard: RAILWAY_RATE_CARD,
    };
  }

  const serviceNames: readonly RailwayCostedServiceName[] = [
    "app-postgres",
    "logto-postgres",
    "logto-seed",
    "logto",
    "nautilo-server",
  ];
  const assumptionMap = new Map<RailwayCostedServiceName, RailwayCostServiceAssumption>();
  const duplicateServices = new Set<RailwayCostedServiceName>();
  let invalidAssumptionCount = 0;
  for (const assumption of input.serviceAssumptions) {
    const cpuNumerator = assumption.cpuMillicores * assumption.activeHoursPerMonth * RAILWAY_RATE_CARD.cpuVcpuMonthCents;
    const memoryNumerator = assumption.memoryMiB * assumption.activeHoursPerMonth * RAILWAY_RATE_CARD.ramGiBMonthCents;
    if (
      !serviceNames.includes(assumption.service) ||
      !Number.isSafeInteger(assumption.cpuMillicores) ||
      !Number.isSafeInteger(assumption.memoryMiB) ||
      !Number.isFinite(assumption.volumeGiB) ||
      !Number.isFinite(assumption.egressGiBPerMonth) ||
      !Number.isSafeInteger(assumption.activeHoursPerMonth) ||
      assumption.cpuMillicores < 0 ||
      assumption.memoryMiB < 0 ||
      assumption.volumeGiB < 0 ||
      assumption.egressGiBPerMonth < 0 ||
      assumption.activeHoursPerMonth < 0 ||
      assumption.activeHoursPerMonth > RAILWAY_RATE_CARD.hoursPerMonth ||
      !Number.isSafeInteger(cpuNumerator) ||
      !Number.isSafeInteger(memoryNumerator) ||
      !Number.isFinite(assumption.volumeGiB * RAILWAY_RATE_CARD.volumeGiBMonthCents) ||
      assumption.volumeGiB * RAILWAY_RATE_CARD.volumeGiBMonthCents > Number.MAX_SAFE_INTEGER ||
      !Number.isFinite(assumption.egressGiBPerMonth * RAILWAY_RATE_CARD.egressGiBCents) ||
      assumption.egressGiBPerMonth * RAILWAY_RATE_CARD.egressGiBCents > Number.MAX_SAFE_INTEGER
    ) {
      invalidAssumptionCount += 1;
      continue;
    }
    if (assumptionMap.has(assumption.service) || duplicateServices.has(assumption.service)) {
      assumptionMap.delete(assumption.service);
      duplicateServices.add(assumption.service);
      invalidAssumptionCount += 1;
      continue;
    }
    assumptionMap.set(assumption.service, { ...assumption });
  }
  const serviceAssumptions = [...assumptionMap.values()]
    .sort((left, right) => serviceNames.indexOf(left.service) - serviceNames.indexOf(right.service));
  const assumptionsComplete = serviceNames.every((service) => assumptionMap.has(service));
  if (!assumptionsComplete || invalidAssumptionCount > 0) {
    notices.push(notice(
      "warning",
      "railway.plan.cost-assumptions-incomplete",
      "The cost disclosure lacks a complete valid assumption for every final service; treat it as provisional.",
    ));
  }

  notices.push(notice(
    "warning",
    "railway.plan.cost-is-disclosure",
    "This is a dated Nautilo topology disclosure, not a Railway billing guarantee; actual usage is billed by Railway.",
  ));
  const hobbyContext: RailwayHobbyCostContext = {
    minimumCents: RAILWAY_RATE_CARD.hobbyMinimumCents,
    includedUsageCents: RAILWAY_RATE_CARD.hobbyIncludedUsageCents,
  };

  if (input.state === "measured-range") {
    return {
      state: "measured",
      basis: "measured-nautilo-workload",
      currency: input.currency,
      monthlyResourceUsageCents: { ...input.monthlyResourceUsageCents },
      monthlyBillCents: {
        minimum: Math.max(RAILWAY_RATE_CARD.hobbyMinimumCents, input.monthlyResourceUsageCents.minimum),
        maximum: Math.max(RAILWAY_RATE_CARD.hobbyMinimumCents, input.monthlyResourceUsageCents.maximum),
      },
      hobbyContext,
      capturedAt: input.capturedAt,
      workload: input.workload,
      serviceAssumptions,
      assumptionsComplete,
      source: RAILWAY_PRICING_SOURCE,
      rateCardCapturedAt: RAILWAY_RATE_CARD_CAPTURED_AT,
      rateCard: RAILWAY_RATE_CARD,
    };
  }

  if (serviceAssumptions.length === 0) {
    return {
      state: "not-yet-measured",
      source: RAILWAY_PRICING_SOURCE,
      rateCardCapturedAt: RAILWAY_RATE_CARD_CAPTURED_AT,
      rateCard: RAILWAY_RATE_CARD,
    };
  }

  const breakdown = serviceAssumptions.map(estimateServiceCost);
  const monthlyResourceUsageCents = breakdown.reduce((sum, item) => sum + item.totalCents, 0);
  return {
    state: "estimated",
    basis: "railway-rate-card",
    currency: "USD",
    monthlyResourceUsageCents,
    monthlyBillCents: Math.max(RAILWAY_RATE_CARD.hobbyMinimumCents, monthlyResourceUsageCents),
    hobbyContext,
    breakdown,
    capturedAt: input.capturedAt,
    workload: input.workload,
    serviceAssumptions,
    assumptionsComplete,
    source: RAILWAY_PRICING_SOURCE,
    rateCardCapturedAt: RAILWAY_RATE_CARD_CAPTURED_AT,
    rateCard: RAILWAY_RATE_CARD,
  };
}

function roundedCents(numerator: number, denominator = 1): number {
  return Math.round(numerator / denominator);
}

function estimateServiceCost(
  assumption: RailwayCostServiceAssumption,
): RailwayServiceCostBreakdown {
  const cpuCents = roundedCents(
    assumption.cpuMillicores * assumption.activeHoursPerMonth * RAILWAY_RATE_CARD.cpuVcpuMonthCents,
    1_000 * RAILWAY_RATE_CARD.hoursPerMonth,
  );
  const memoryCents = roundedCents(
    assumption.memoryMiB * assumption.activeHoursPerMonth * RAILWAY_RATE_CARD.ramGiBMonthCents,
    1_024 * RAILWAY_RATE_CARD.hoursPerMonth,
  );
  const volumeCents = roundedCents(
    assumption.volumeGiB * RAILWAY_RATE_CARD.volumeGiBMonthCents,
  );
  const egressCents = roundedCents(
    assumption.egressGiBPerMonth * RAILWAY_RATE_CARD.egressGiBCents,
  );
  return {
    service: assumption.service,
    cpuCents,
    memoryCents,
    volumeCents,
    egressCents,
    totalCents: cpuCents + memoryCents + volumeCents + egressCents,
  };
}

function releasePlan(
  input: RailwayPlanReleaseInput,
  notices: RailwayPlanNotice[],
): {
  readonly release: RailwayDeploymentPlan["release"];
  readonly topology?: RailwayTopology | undefined;
} {
  if (input.state !== "verified") {
    const code = input.state === "not-published"
      ? "railway.plan.release-not-published"
      : input.state === "missing"
        ? "railway.plan.release-missing"
        : "railway.plan.release-invalid";
    const message = input.state === "not-published"
      ? "No verified qualification or production release manifest was selected."
      : input.state === "missing"
        ? "An immutable verified qualification or production manifest is required before deployment."
        : "The selected release manifest failed verification.";
    notices.push(notice("blocking", code, message));
    return { release: { state: input.state } };
  }

  const topology = buildRailwayTopology(input.manifest);
  if (!topology.ok) {
    notices.push(notice(
      "blocking",
      "railway.plan.topology-invalid",
      "The verified release cannot produce the certified Railway topology.",
      topology.code,
    ));
    return {
      release: { state: input.state, channel: input.channel, releaseId: input.manifest.releaseId },
    };
  }

  for (const qualification of topology.topology.qualifications) {
    notices.push(notice(
      "blocking",
      "railway.plan.topology-qualification",
      qualification.explanation,
      qualification.code,
    ));
  }
  return {
    release: { state: input.state, channel: input.channel, releaseId: input.manifest.releaseId },
    topology: topology.topology,
  };
}

function transportFailureNotice(
  result: Exclude<RailwayTransportResult<unknown>, { readonly outcome: "success" }>,
): RailwayPlanNotice {
  const kind = result.outcome === "partial" ? result.failure.kind : result.failure.kind;
  return kind === "authentication-required" || kind === "permission-denied"
    ? notice(
        "blocking",
        "railway.plan.authorization-required",
        "Railway authorization cannot read the consented workspace inventory; reauthorization is required.",
      )
    : notice(
        "blocking",
        "railway.plan.discovery-failed",
        "Railway read-only discovery did not complete; retry without creating resources.",
      );
}

async function listProjects(
  transport: RailwayPlanTransport,
  workspaceId: string,
): Promise<
  | { readonly outcome: "success"; readonly projects: readonly RailwayProject[] }
  | { readonly outcome: "failure"; readonly notice: RailwayPlanNotice }
> {
  const result = await paginateRailwayConnection({
    initialVariables: { workspaceId, includeDeleted: false, first: 50 },
    fetchPage: async (variables) => {
      const page = await transport.execute(railwayProjects, variables);
      if (page.outcome === "success") {
        return { ...page, data: page.data.projects };
      }
      if (page.outcome === "partial") {
        return { ...page, data: page.data.projects };
      }
      return page;
    },
  });
  return result.outcome === "success"
    ? {
      outcome: "success",
      projects: result.nodes.filter((project) => project.deletedAt === undefined || project.deletedAt === null),
    }
    : { outcome: "failure", notice: transportFailureNotice(result.result) };
}

function selectWorkspace(
  workspaces: readonly RailwayPlanWorkspace[],
  requestedId: string | undefined,
  notices: RailwayPlanNotice[],
): RailwayPlanWorkspace | undefined {
  if (requestedId !== undefined) {
    const selected = workspaces.find((workspace) => workspace.id === requestedId);
    if (selected === undefined) {
      notices.push(notice(
        "blocking",
        "railway.plan.workspace-unavailable",
        "The requested workspace is not present in the workspaces granted through Railway consent.",
      ));
    }
    return selected;
  }
  if (workspaces.length === 1) return workspaces[0];
  notices.push(notice(
    "blocking",
    "railway.plan.workspace-selection-required",
    workspaces.length === 0
      ? "Railway consent did not expose a workspace for deployment."
      : "More than one consented Railway workspace is available; select one explicitly.",
  ));
  return undefined;
}

/**
 * Performs only RailwayMe and paginated RailwayProjects queries. It never
 * accepts billable confirmation and always returns mutationAuthorized=false.
 */
export async function planRailwayDeployment(
  transport: RailwayPlanTransport,
  request: RailwayPlanRequest,
): Promise<RailwayDeploymentPlan> {
  const notices: RailwayPlanNotice[] = [];
  const projectName = request.projectName ?? RAILWAY_PLAN_PROJECT_NAME;
  if (!RAILWAY_PROJECT_NAME_PATTERN.test(projectName)) {
    notices.push(notice(
      "blocking",
      "railway.plan.project-name-invalid",
      "The Railway project name must use 1-64 lowercase letters, digits, or hyphens and cannot begin or end with a hyphen.",
    ));
  }
  const providerPlan = resolveProviderCapabilities(request.providerSelection);
  const cost = normalizeCost(request.cost, notices);
  const plannedRelease = releasePlan(request.release, notices);

  if (providerPlan.issues.length > 0) {
    notices.push(notice(
      "blocking",
      "railway.plan.provider-input-unresolved",
      "Provider selection contains missing, invalid, duplicate, or unsupported input that must be resolved or explicitly skipped.",
    ));
  }
  if (providerPlan.readiness.outcome === "blocked") {
    notices.push(notice(
      "blocking",
      "railway.plan.core-readiness-blocked",
      "Core capability coverage is unresolved and has not received explicit degraded-mode consent.",
    ));
  }
  if (request.authorization.mutationScope !== "qualified") {
    notices.push(notice(
      "blocking",
      "railway.plan.mutation-scope-unqualified",
      "Read-only workspace access is insufficient until the required Railway OAuth mutation scope is live-qualified.",
    ));
  }
  notices.push(notice(
    "warning",
    "railway.plan.database-operator-managed",
    "Railway's PostgreSQL template is operator-managed; Nautilo remains responsible for database backup, restore, updates, and recovery.",
  ));

  const me = await transport.execute(railwayMe, {});
  if (me.outcome !== "success") {
    notices.push(transportFailureNotice(me));
    return finalizePlan({
      request,
      providerPlan,
      cost,
      plannedRelease,
      notices,
      workspaceDiscovery: "failed",
      workspaces: [],
    });
  }

  const workspaces = [...me.data.me.workspaces]
    .map((workspace) => ({ id: workspace.id, name: workspace.name }))
    .sort((left, right) => left.id.localeCompare(right.id) || left.name.localeCompare(right.name));
  const selectedWorkspace = selectWorkspace(workspaces, request.workspaceId, notices);
  let projectCount: number | undefined;
  let nameAvailable: boolean | undefined;
  if (selectedWorkspace !== undefined) {
    const projects = await listProjects(transport, selectedWorkspace.id);
    if (projects.outcome === "failure") {
      notices.push(projects.notice);
    } else {
      projectCount = projects.projects.length;
      nameAvailable = !projects.projects.some((project) => project.name === projectName);
      if (!nameAvailable) {
        notices.push(notice(
          "blocking",
          "railway.plan.project-name-collision",
          "A visible project already uses the requested Nautilo project name; choose a different --project-name before creation.",
        ));
      }
    }
  }

  return finalizePlan({
    request,
    providerPlan,
    cost,
    plannedRelease,
    notices,
    workspaceDiscovery: "resolved",
    userId: me.data.me.id,
    workspaces,
    selectedWorkspace,
    projectCount,
    nameAvailable,
  });
}

interface FinalizeInput {
  readonly request: RailwayPlanRequest;
  readonly providerPlan: ProviderCapabilityPlan;
  readonly cost: RailwayNormalizedCostDisclosure;
  readonly plannedRelease: {
    readonly release: RailwayDeploymentPlan["release"];
    readonly topology?: RailwayTopology | undefined;
  };
  readonly notices: readonly RailwayPlanNotice[];
  readonly workspaceDiscovery: "resolved" | "failed";
  readonly userId?: string | undefined;
  readonly workspaces: readonly RailwayPlanWorkspace[];
  readonly selectedWorkspace?: RailwayPlanWorkspace | undefined;
  readonly projectCount?: number | undefined;
  readonly nameAvailable?: boolean | undefined;
}

function finalizePlan(input: FinalizeInput): RailwayDeploymentPlan {
  const blocking = input.notices.some((item) => item.severity === "blocking");
  return {
    schemaVersion: RAILWAY_PLAN_SCHEMA_VERSION,
    operation: "plan",
    backend: "railway",
    outcome: blocking ? "blocked" : "ready-for-confirmation",
    nextAction: blocking ? "resolve-blockers" : "confirm-billable-mutation",
    mutationAuthorized: false,
    identity: {
      ...(input.userId === undefined ? {} : { userId: input.userId }),
      consentedWorkspaces: input.workspaces,
      ...(input.selectedWorkspace === undefined ? {} : { selectedWorkspace: input.selectedWorkspace }),
    },
    authorization: {
      workspaceDiscovery: input.workspaceDiscovery,
      kind: input.request.authorization.kind,
      mutationScope: input.request.authorization.mutationScope,
    },
    target: {
      projectName: input.request.projectName ?? RAILWAY_PLAN_PROJECT_NAME,
      ...(input.projectCount === undefined ? {} : { visibleProjectCount: input.projectCount }),
      ...(input.nameAvailable === undefined ? {} : { nameAvailable: input.nameAvailable }),
    },
    payer: input.selectedWorkspace === undefined
      ? { state: "unresolved" }
      : {
          state: "resolved",
          kind: "customer-railway-workspace",
          workspaceId: input.selectedWorkspace.id,
          workspaceName: input.selectedWorkspace.name,
        },
    release: input.plannedRelease.release,
    ...(input.plannedRelease.topology === undefined ? {} : { topology: input.plannedRelease.topology }),
    cost: input.cost,
    providerPlan: input.providerPlan,
    notices: input.notices,
  };
}

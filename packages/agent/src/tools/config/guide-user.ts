import { randomUUID } from "node:crypto";
import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  GENIE_APPLICATION_BRIDGE_VERSION_V1,
  GUIDE_USER_MAX_DISCOVERY_RESULTS_V1,
  UI_TARGET_DEFINITIONS_V1,
  guideUserArgsV1Schema,
  guideUserResultV1Schema,
  type GuideUserArgsV1,
  type GuideUserResultV1,
  type ApplicationCatalogueV1,
  type InitiatingClientSurfaceV1,
  type UiPresentation,
  type UiTargetDefinitionV1,
  type UiTargetDiscoveryResultV1,
  type UiTargetId,
} from "@nautilo/types";
import { getActiveApplicationCatalogueSync, kickRuntimeApplicationCatalogueRefresh } from "../../config/application-catalogue/runtime-catalogue";
import type { TrustedExecutionEntrypoint } from "../../agent/state";
import { getCurrentInitiatingClientSurface } from "../../runtime/initiating-client-surface-context";

export interface GuideUserToolContext {
  /** Server-stamped origin only. Missing/unknown provenance fails closed. */
  trustedExecutionEntrypoint?: TrustedExecutionEntrypoint | null;
  /** Process-local server declaration from the current tool-factory context. */
  initiatingClientSurface?: InitiatingClientSurfaceV1;
  /** Injectable only for deterministic tests; the default remains opaque. */
  actionIdFactory?: () => string;
  /** Injectable only for deterministic tests; one invocation uses this entire atomic snapshot. */
  catalogueSnapshot?: ApplicationCatalogueV1;
}

type DiscoveryMatch = {
  definition: UiTargetDefinitionV1;
  rank: number;
};

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
}

function searchableTokens(definition: UiTargetDefinitionV1): Set<string> {
  return new Set(tokenize([
    definition.target,
    definition.label,
    ...definition.menuPath,
    ...definition.discoveryTerms,
  ].join(" ")));
}

function discoveryRank(
  definition: UiTargetDefinitionV1,
  query: string,
  queryTokens: readonly string[],
): number | null {
  const targetTokens = searchableTokens(definition);
  if (!queryTokens.every((token) => targetTokens.has(token))) return null;

  const normalizedQuery = query.toLowerCase();
  if (normalizedQuery === definition.target.toLowerCase()) return 4;
  if (normalizedQuery === definition.label.toLowerCase()) return 3;
  if (normalizedQuery === definition.menuPath.join(" ").toLowerCase()) return 2;
  if (definition.discoveryTerms.some((term) => normalizedQuery === term.toLowerCase())) return 1;
  return 0;
}

function compareTargetIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Deterministic semantic discovery. It deliberately knows neither routes nor UI controls. */
export function discoverGuideUserTargets(query: string, definitions: readonly UiTargetDefinitionV1[] = getActiveApplicationCatalogueSync().targets): UiTargetDiscoveryResultV1[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const matches: DiscoveryMatch[] = definitions.flatMap((definition) => {
    const rank = discoveryRank(definition, query, queryTokens);
    return rank === null ? [] : [{ definition, rank }];
  });
  return matches
    .sort((left, right) => right.rank - left.rank || compareTargetIds(left.definition.target, right.definition.target))
    .slice(0, GUIDE_USER_MAX_DISCOVERY_RESULTS_V1)
    .map(({ definition }) => ({
      target: definition.target,
      label: definition.label,
      menuPath: [...definition.menuPath],
      description: definition.description,
    }));
}

function fallbackText(
  target: UiTargetId,
  definitions: readonly UiTargetDefinitionV1[],
  surface: InitiatingClientSurfaceV1,
): string {
  const definition = definitions.find((candidate) => candidate.target === target) ?? UI_TARGET_DEFINITIONS_V1.find((candidate) => candidate.target === target);
  if (!definition) throw new Error("guide_user target is missing from the shared target catalogue");
  const desktopPath = definition.menuPath.join(" then ");
  if (surface === "mobile.native" || surface === "mobile.web") {
    return `This Mobile client cannot open or map ${definition.label}. To continue this conversation in Nautilo Desktop, use ${desktopPath}.`;
  }
  return `Use ${desktopPath} to continue.`;
}

function effectiveGuideUserPresentation(
  requested: UiPresentation,
  confirmed: boolean,
  trustedExecutionEntrypoint: GuideUserToolContext["trustedExecutionEntrypoint"],
  initiatingClientSurface: InitiatingClientSurfaceV1,
): UiPresentation {
  if (initiatingClientSurface === "mobile.native" || initiatingClientSurface === "mobile.web") {
    return "link";
  }
  return confirmed && trustedExecutionEntrypoint === "foreground.main"
    ? requested
    : "link";
}

function resultForInput(
  input: GuideUserArgsV1,
  context: GuideUserToolContext,
): GuideUserResultV1 {
  const catalogue = context.catalogueSnapshot ?? getActiveApplicationCatalogueSync();
  if (!context.catalogueSnapshot) kickRuntimeApplicationCatalogueRefresh();
  const snapshot = catalogue.targets;
  const initiatingClientSurface =
    context.initiatingClientSurface ?? getCurrentInitiatingClientSurface();
  if ("query" in input) {
    return {
      version: GENIE_APPLICATION_BRIDGE_VERSION_V1,
      kind: "discovery",
      targets: discoverGuideUserTargets(input.query, snapshot),
    };
  }
  return {
    version: GENIE_APPLICATION_BRIDGE_VERSION_V1,
    kind: "guidance",
    actionId: (context.actionIdFactory ?? randomUUID)(),
    target: input.target,
    presentation: effectiveGuideUserPresentation(
      input.presentation,
      input.confirmed,
      context.trustedExecutionEntrypoint,
      initiatingClientSurface,
    ),
    fallbackText: fallbackText(input.target, snapshot, initiatingClientSurface),
  };
}

/**
 * D513 Phase 2.1 — durable semantic guidance only. This tool never emits a
 * client action, follows links, or performs UI/domain mutation.
 */
export function createGuideUserTool(context: GuideUserToolContext = {}): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "guide_user",
    description: "Find a supported Nautilo destination or record confirmed guidance for the user. Use the query branch when the target is uncertain. Set confirmed true only when the current direct Human message explicitly requests that presentation or clearly accepts an earlier offer; otherwise set confirmed false and the durable result will be a link. When useful, accompany the card with concise conversational help: explain why the destination matters, state the Human-owned steps, and say what you can do after the Human finishes, such as retrying the blocked task. The current client surface is server-bound; it is not a tool argument and cannot be overridden. On Mobile, this tool always records a durable guidance card rather than a reveal or spotlight. Do not merely emit a card, invent controls or steps, imply a Human-owned step is complete, claim a UI opened, click controls, navigate a browser, enter credentials, or change settings.",
    schema: guideUserArgsV1Schema,
    func: (input): Promise<string> => Promise.resolve(JSON.stringify(
      guideUserResultV1Schema.parse(
        resultForInput(guideUserArgsV1Schema.parse(input as unknown), context),
      ),
    )),
  });
}

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { getToolCatalog } from "@nautilo/catalog";
import type { ToolModelCapability, VerifiedOrdinaryOrigin } from "@nautilo/types";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  expandToolFamilies,
  TOOL_EXPOSURE_MANIFEST,
  TOOL_FAMILY_NAMES,
} from "../exposure/manifest";
import type { ActivatedToolsHandle } from "./activated-tools-handle";
import {
  hasAvailableTaskReportBackContinuation,
  type TaskReportBackContinuation,
} from "../../runtime/task-report-back-continuation";
import {
  checkCategoricalHostAdmissionPrerequisite,
  classifyHostScope,
} from "../../runtime/host-scoped-tools";
import {
  toolPolicyWithRecallRecordsAvailability,
  type RecallRecordsToolContext,
} from "../memory/recall-records";

const MAX_ACTIVATION_REQUESTS = 8;

interface ActivateToolsContext extends RecallRecordsToolContext {
  memoryAccessEnvelope?: MemoryAccessEnvelope | null;
  relayCapabilities?: Readonly<Record<string, boolean>>;
  readableNamespaces?: readonly string[];
  activeModelCapabilities?: readonly ToolModelCapability[];
  /** Server-stamped connected-app eligibility for the exact Human×Namespace. */
  connectedAppProviderIds?: readonly string[];
  toolWhitelist?: readonly string[];
  verifiedOrdinaryOrigin?: VerifiedOrdinaryOrigin | null;
  taskReportBackContinuation?: TaskReportBackContinuation | null;
  activatedTools?: ActivatedToolsHandle;
}

export function createActivateToolsTool(context?: ActivateToolsContext) {
  return new DynamicStructuredTool({
    name: "activate_tools",
    description:
      "Activate already-authorized deferred tools or tool families for the next model step. " +
      "This never grants permission; use discover_tools first when you need to find tools.",
    schema: z.object({
      names: z.array(z.string().min(1)).max(MAX_ACTIVATION_REQUESTS).default([]),
      families: z.array(z.enum(TOOL_FAMILY_NAMES)).max(MAX_ACTIVATION_REQUESTS).default([]),
    }).refine(
      ({ names, families }) => names.length + families.length > 0,
      "Provide at least one tool name or family.",
    ).refine(
      ({ names, families }) => names.length + families.length <= MAX_ACTIVATION_REQUESTS,
      `Request at most ${MAX_ACTIVATION_REQUESTS} names and families.`,
    ),
    func: ({ names, families }): Promise<string> => {
      const catalog = getToolCatalog();
      const handle = context?.activatedTools;
      if (!catalog || !handle) {
        return Promise.resolve(JSON.stringify({
          accepted: [],
          rejected: [{ selection: "activation", reason: "activation is unavailable for this turn" }],
        }));
      }

      const requestedNames = new Set(names.map((name) => name.trim()).filter(Boolean));
      const rejected: Array<{ selection: string; reason: string }> = [];
      for (const name of expandToolFamilies(families, TOOL_EXPOSURE_MANIFEST)) {
        // Families are stable manifests whose runtime members may be gated at
        // registration time. Missing family members are simply unavailable in
        // this runtime; only explicitly requested unknown names are errors.
        if (catalog.get(name)) requestedNames.add(name);
      }

      const candidateNames = [...new Set([...handle.snapshot(), ...requestedNames])];
      const readableNamespaces =
        context?.readableNamespaces ??
        (context?.memoryAccessEnvelope && "readableNamespaces" in context.memoryAccessEnvelope
          ? context.memoryAccessEnvelope.readableNamespaces
          : undefined);
      const resolution = catalog.resolveProgressiveTools({
        context: context === undefined ? undefined : { ...context },
        toolPolicy: toolPolicyWithRecallRecordsAvailability(
          context?.memoryAccessEnvelope?.toolPolicy,
          context,
        ),
        relayCapabilities: context?.relayCapabilities,
        readableNamespaces,
        activeModelCapabilities: context?.activeModelCapabilities,
        toolNameWhitelist: context?.toolWhitelist,
        activatedToolNames: candidateNames,
      });
      const eligibleNames = new Set(resolution.eligible.entries.map((entry) => entry.name));
      const activatableNames = new Set(resolution.snapshot.entries.map((entry) => entry.name));
      const activationExclusions = new Map(
        resolution.snapshot.exclusions.map(({ tool, reason }) => [tool, reason]),
      );
      const accepted: string[] = [];

      for (const name of requestedNames) {
        const entry = catalog.get(name);
        if (!entry) {
          rejected.push({ selection: name, reason: "unknown tool" });
        } else if (!eligibleNames.has(name)) {
          rejected.push({ selection: name, reason: "not authorized or unavailable in this runtime" });
        } else if (
          name === "security_scan"
          && !hasAvailableTaskReportBackContinuation(context?.taskReportBackContinuation)
        ) {
          rejected.push({
            selection: name,
            reason: "Task-internal worker tool; from a Room call in_background with tools [\"file\", \"security_scan\"]",
          });
        } else if (!activatableNames.has(name)) {
          const reason = activationExclusions.get(name);
          rejected.push({
            selection: name,
            reason: reason === "not in explicit tool whitelist"
              ? "not permitted by explicit tool whitelist"
              : "requires model capabilities unavailable to this model",
          });
        } else {
          // Activation has no model-authored args and must not choose a live
          // computer. It can still reject categorical impossibilities that
          // post-model would otherwise deny unavoidably on the next step.
          const prerequisite = checkCategoricalHostAdmissionPrerequisite({
            hostScope: classifyHostScope({
              toolName: name,
              executor: entry.executor === "relay" ? "relay" : "cloud",
              hostedBy: entry.hostedBy,
            }),
            toolName: name,
            verifiedOrdinaryOrigin: context?.verifiedOrdinaryOrigin,
            taskReportBackContinuation: context?.taskReportBackContinuation,
          });
          if (prerequisite.status === "denied") {
            rejected.push({ selection: name, reason: prerequisite.reason });
          } else if (entry.exposure === "core") {
            accepted.push(name);
          } else if (handle.add(name)) {
            accepted.push(name);
          } else {
            rejected.push({ selection: name, reason: "activation limit reached" });
          }
        }
      }

      return Promise.resolve(JSON.stringify({
        accepted,
        rejected,
        activeToolNames: handle.snapshot(),
        note: "Accepted deferred tool schemas are callable on the next model step; exact host, trust, and local-consent checks are revalidated at invocation.",
      }));
    },
  });
}

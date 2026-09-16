import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  TOOL_EXPOSURE_MANIFEST,
  TOOL_FAMILY_NAMES,
} from "../exposure/manifest";
import type { ActivatedToolsHandle } from "./activated-tools-handle";

const MAX_DEACTIVATION_REQUESTS = 8;

interface DeactivateToolsContext {
  activatedTools?: ActivatedToolsHandle;
}

/**
 * Remove deferred tool schemas from the current graph thread/task.
 *
 * Deactivation changes only the checkpointed exposure selection. It neither
 * revokes access nor changes the hard `toolWhitelist` ceiling.
 */
export function createDeactivateToolsTool(context?: DeactivateToolsContext) {
  return new DynamicStructuredTool({
    name: "deactivate_tools",
    description:
      "Remove previously activated deferred tools or tool families from later model steps. " +
      "This does not revoke permission and never changes the tool whitelist.",
    schema: z.object({
      names: z.array(z.string().min(1)).max(MAX_DEACTIVATION_REQUESTS).default([]),
      families: z.array(z.enum(TOOL_FAMILY_NAMES)).max(MAX_DEACTIVATION_REQUESTS).default([]),
    }).refine(
      ({ names, families }) => names.length + families.length > 0,
      "Provide at least one tool name or family.",
    ).refine(
      ({ names, families }) => names.length + families.length <= MAX_DEACTIVATION_REQUESTS,
      `Request at most ${MAX_DEACTIVATION_REQUESTS} names and families.`,
    ),
    func: ({ names, families }): Promise<string> => {
      const handle = context?.activatedTools;
      if (!handle) {
        return Promise.resolve(JSON.stringify({
          deactivated: [],
          note: "Deactivation is unavailable for this turn.",
        }));
      }

      const requestedNames = new Set(names.map((name) => name.trim()).filter(Boolean));
      for (const family of families) {
        for (const name of TOOL_EXPOSURE_MANIFEST.families[family]) {
          requestedNames.add(name);
        }
      }

      const activeBefore = new Set(handle.snapshot());
      const deactivated: string[] = [];
      for (const name of requestedNames) {
        if (activeBefore.has(name)) {
          handle.remove(name);
          deactivated.push(name);
        }
      }

      return Promise.resolve(JSON.stringify({
        deactivated,
        activeToolNames: handle.snapshot(),
        note: "Deactivated tools are unavailable on the next model step.",
      }));
    },
  });
}

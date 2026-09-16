import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

export function createBrowserClickTool() {
  return new DynamicStructuredTool({
    name: "browser_click",
    description:
      "Click an element in the SaaS app the user has open in Nautilo's embedded browser panel (e.g. " +
      "Google Docs, Gmail). Targets a ref like `@e3` from the most recent browser_snapshot.\n\n" +
      "WHEN TO USE: after browser_snapshot shows the element you need. Re-run browser_snapshot after " +
      "the click if the page navigates, re-renders, opens a dialog, or the user may have touched the screen.\n\n" +
      "REFS: come from the latest browser_snapshot only. They go stale the instant the page changes — " +
      "re-snapshot before acting on a new or uncertain target.\n\n" +
      "SCOPE: acts on the user's active embedded app surface only — not Nautilo's own UI or other apps.\n\n" +
      "AVAILABILITY: requires a connected desktop with the `control_browser` capability and an app open " +
      "in the embedded panel.",
    schema: z.object({
      ref: z
        .string()
        .describe('An @e ref from the most recent browser_snapshot, e.g. "@e3"'),
    }),
    func: () => {
      return Promise.reject(
        new Error(
          "browser_click is a relay tool — execution goes through the relay protocol, not direct invocation. If you see this error, the tool routing in toolsNode is broken.",
        ),
      );
    },
  });
}

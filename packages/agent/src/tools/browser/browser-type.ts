import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

export function createBrowserTypeTool() {
  return new DynamicStructuredTool({
    name: "browser_type",
    description:
      "Type text into an input or editable element in the SaaS app the user has open in Nautilo's " +
      "embedded browser panel (e.g. Google Docs, Gmail). Targets a ref like `@e5` from the most recent " +
      "browser_snapshot.\n\n" +
      "WHEN TO USE: after browser_snapshot shows the textbox or editable region. By default this appends " +
      "at the element without clearing existing content — use clear only when you intentionally want to " +
      "replace the whole field.\n\n" +
      "REFS: come from the latest browser_snapshot only. They go stale the instant the page changes — " +
      "re-snapshot before acting on a new or uncertain target.\n\n" +
      "SCOPE: acts on the user's active embedded app surface only — not Nautilo's own UI or other apps.\n\n" +
      "AVAILABILITY: requires a connected desktop with the `control_browser` capability and an app open " +
      "in the embedded panel.",
    schema: z.object({
      ref: z
        .string()
        .describe('An @e ref from the most recent browser_snapshot, e.g. "@e3"'),
      text: z.string().describe("Text to type into the element"),
      clear: z
        .boolean()
        .optional()
        .describe(
          "Replace existing content instead of appending. Default false — appends/types at the element.",
        ),
    }),
    func: () => {
      return Promise.reject(
        new Error(
          "browser_type is a relay tool — execution goes through the relay protocol, not direct invocation. If you see this error, the tool routing in toolsNode is broken.",
        ),
      );
    },
  });
}

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

export function createBrowserPressTool() {
  return new DynamicStructuredTool({
    name: "browser_press",
    description:
      "Press a keyboard key or combo in the SaaS app the user has open in Nautilo's embedded browser " +
      "panel (e.g. Enter to submit, Tab to move focus, Control+a to select all).\n\n" +
      "WHEN TO USE: after browser_snapshot when you need keyboard input rather than clicking or typing " +
      "into a specific ref. Re-run browser_snapshot after the key press if the page navigates or re-renders.\n\n" +
      "REFS: not required for this tool, but any element refs from browser_snapshot go stale the instant " +
      "the page changes — re-snapshot before subsequent click/type actions.\n\n" +
      "SCOPE: acts on the user's active embedded app surface only — not Nautilo's own UI or other apps.\n\n" +
      "AVAILABILITY: requires a connected desktop with the `control_browser` capability and an app open " +
      "in the embedded panel.",
    schema: z.object({
      key: z
        .string()
        .describe('A key or combo, e.g. "Enter", "Tab", "Control+a"'),
    }),
    func: () => {
      return Promise.reject(
        new Error(
          "browser_press is a relay tool — execution goes through the relay protocol, not direct invocation. If you see this error, the tool routing in toolsNode is broken.",
        ),
      );
    },
  });
}

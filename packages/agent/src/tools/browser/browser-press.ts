import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

export function createBrowserPressTool() {
  return new DynamicStructuredTool({
    name: "browser_press",
    description:
      "Press a keyboard key or combo in the SaaS app the user has open in Nautilo's embedded browser " +
      "panel (e.g. Enter to submit, Tab to move focus, Control+a to select all).\n\n" +
      "WHEN TO USE: after browser_snapshot when you need keyboard input rather than clicking or typing " +
      "text. Pass ref when the key must land on one exact observed control; omit it only when the page's " +
      "existing keyboard focus is intentionally the target. Re-run browser_snapshot after the key press.\n\n" +
      "REFS: optional, and must come from the latest browser_snapshot. They go stale the instant " +
      "the page changes — re-snapshot before subsequent click/type actions.\n\n" +
      "SCOPE: acts on the user's active embedded app surface only — not Nautilo's own UI or other apps.\n\n" +
      "AVAILABILITY: requires a connected desktop with the `control_browser` capability and an app open " +
      "in the embedded panel.",
    schema: z.object({
      key: z
        .string()
        .describe('A key or combo, e.g. "Enter", "Tab", "Control+a"'),
      ref: z
        .string()
        .trim()
        .regex(/^@?e[1-9]\d*$/u)
        .optional()
        .describe('Optional @e ref from the latest browser_snapshot to focus before pressing'),
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

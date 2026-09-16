import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

export function createBrowserScrollTool() {
  return new DynamicStructuredTool({
    name: "browser_scroll",
    description:
      "Wheel-scroll the embedded app surface via CDP mouse-wheel events at the viewport center — " +
      "works on canvas apps (Google Docs) whose content scrolls inside an internal container, " +
      "where window-level scroll is a no-op.\n\n" +
      "WHEN TO USE: when browser_snapshot or browser_screenshot shows content above/below or " +
      "to the sides of the current viewport — e.g. a long Google Doc, spreadsheet rows, or a " +
      "list that extends past the visible area. Re-screenshot or re-snapshot after scrolling " +
      "before acting on newly visible content.\n\n" +
      "WORKFLOW: browser_scroll {direction, amount?} → browser_screenshot / browser_snapshot → act.\n\n" +
      "SCOPE: scrolls the user's active embedded app surface only — not Nautilo's own UI.\n\n" +
      "AVAILABILITY: requires a connected desktop with the `control_browser` capability and an app open " +
      "in the embedded panel.",
    schema: z.object({
      direction: z
        .enum(["up", "down", "left", "right"])
        .describe("Scroll direction"),
      amount: z
        .number()
        .optional()
        .describe("Optional scroll amount in pixels; omit for a default page increment"),
    }),
    func: () => {
      return Promise.reject(
        new Error(
          "browser_scroll is a relay tool — execution goes through the relay protocol, not direct invocation. If you see this error, the tool routing in toolsNode is broken.",
        ),
      );
    },
  });
}

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

export function createBrowserScreenshotTool() {
  return new DynamicStructuredTool({
    name: "browser_screenshot",
    description:
      "Capture an image of the app surface so you can SEE canvas-rendered content (e.g. Google Docs) " +
      "that the snapshot can't show; then use browser_mouse to click coordinates from what you see.\n\n" +
      "WHEN TO USE: when browser_snapshot / browser_read cannot expose text because the app paints to a " +
      "<canvas> (Google Docs body, some spreadsheets, image-heavy editors). Take a screenshot, read the " +
      "visible pixels, locate the target by coordinates, then browser_mouse to place the caret or hit controls.\n\n" +
      "WORKFLOW: browser_screenshot → inspect the image → browser_mouse {x, y} → browser_press / browser_type " +
      "as needed. Re-screenshot after layout changes.\n\n" +
      "SAFETY: read-only (does not change the page). Targets ONLY the user's active embedded app surface.\n\n" +
      "AVAILABILITY: requires a connected desktop with the `control_browser` capability, a vision-capable " +
      "model, and an app open in the embedded panel.",
    schema: z.object({
      appId: z
        .string()
        .optional()
        .describe("Reserved for future active-app selection; omit to capture the current embedded surface"),
    }),
    func: () => {
      return Promise.reject(
        new Error(
          "browser_screenshot is a relay tool — execution goes through the relay protocol, not direct invocation. If you see this error, the tool routing in toolsNode is broken.",
        ),
      );
    },
  });
}

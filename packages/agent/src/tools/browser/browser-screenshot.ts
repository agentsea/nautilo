import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { browserDecisionPlanSchema } from "../../graph/browser-decision";
import { resolveBrowserDecisionModel } from "./browser-snapshot";

interface BrowserScreenshotContext {
  readonly turnId?: string | undefined;
  readonly fullEncryptionOnly?: boolean | undefined;
}

export function createBrowserScreenshotTool(context?: BrowserScreenshotContext) {
  const model = resolveBrowserDecisionModel(context);
  const canDelegate = model !== null;
  return new DynamicStructuredTool({
    name: "browser_screenshot",
    description:
      "Capture an image of the app surface so you can SEE canvas-rendered content (e.g. Google Docs) " +
      "that the snapshot can't show; then use browser_mouse to click coordinates from what you see.\n\n" +
      "WHEN TO USE: when browser_snapshot / browser_read cannot expose text because the app paints to a " +
      "<canvas> (Google Docs body, some spreadsheets, image-heavy editors). Take a screenshot, read the " +
      "visible pixels, locate the target by coordinates, then browser_mouse to place the caret or hit controls. " +
      (canDelegate
        ? "When pixels identify the routine targets better than browser_snapshot, pass decisionPlan to let the local visual extractor ground those pixels and delegate click, append-typing, keyboard and scroll choices to the decision model. Visual typing requires an explicit type action with clear=false; visually inferred clear/replace is intentionally unavailable.\n\n"
        : "\n\n") +
      "WORKFLOW: browser_screenshot → inspect the image → browser_mouse {x, y} → browser_press / browser_type " +
      "as needed. Re-screenshot after layout changes.\n\n" +
      "SAFETY: read-only (does not change the page). Targets ONLY the user's active embedded app surface.\n\n" +
      "AVAILABILITY: requires a connected desktop with the `control_browser` capability, a vision-capable " +
      "model, and an app open in the embedded panel.",
    schema: z.object({
      ...(canDelegate ? { decisionPlan: browserDecisionPlanSchema.optional().describe(
        "Delegate one complete canvas or pixel-grounded browser outcome. Send as a singleton call. The screenshot is extracted locally; only structured text, exact Genie-supplied values and coordinates go to the decision model.",
      ) } : {}),
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

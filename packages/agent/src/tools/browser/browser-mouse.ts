import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

export function createBrowserMouseTool() {
  return new DynamicStructuredTool({
    name: "browser_mouse",
    description:
      "Click at pixel coordinates (trusted) to place the caret / hit canvas targets you located in a screenshot.\n\n" +
      "WHEN TO USE: after browser_screenshot when you need to focus a canvas-rendered region (e.g. Google Docs " +
      "body) or click a control you identified visually. By default x/y are IMAGE pixels from the screenshot " +
      "(click exactly what you see — no scaling math). Do not multiply image coordinates by DPR or " +
      "scale: the executor converts image pixels to CSS pixels exactly once. Pass space:\"css\" when coords come from browser_get box " +
      "(CSS viewport pixels). Follow with browser_press or browser_type for keyboard input.\n\n" +
      "WORKFLOW: browser_screenshot → locate (x, y) in the image → browser_mouse {x, y} → browser_press / " +
      "browser_type. Re-screenshot after major layout changes.\n\n" +
      "SCOPE: acts on the user's active embedded app surface only — not Nautilo's own UI or other apps.\n\n" +
      "AVAILABILITY: requires a connected desktop with the `control_browser` capability and an app open " +
      "in the embedded panel.",
    schema: z.object({
      x: z
        .number()
        .describe(
          "Horizontal coordinate (image pixels from browser_screenshot by default; CSS px when space is css)",
        ),
      y: z
        .number()
        .describe(
          "Vertical coordinate (image pixels from browser_screenshot by default; CSS px when space is css)",
        ),
      space: z
        .enum(["css", "image"])
        .optional()
        .describe(
          "Coordinate space: image (default — pixels from the vision screenshot) or css (viewport CSS pixels)",
        ),
    }),
    func: () => {
      return Promise.reject(
        new Error(
          "browser_mouse is a relay tool — execution goes through the relay protocol, not direct invocation. If you see this error, the tool routing in toolsNode is broken.",
        ),
      );
    },
  });
}

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

export function createBrowserTypeTool() {
  const schema = z.object({
    ref: z
      .string()
      .optional()
      .describe('An @e ref from the most recent browser_snapshot. Omit only for an internally bound visual decision action.'),
    x: z.number().finite().nonnegative().optional()
      .describe("Screenshot image-pixel x coordinate. Reserved for screenshot-grounded decision actions."),
    y: z.number().finite().nonnegative().optional()
      .describe("Screenshot image-pixel y coordinate. Reserved for screenshot-grounded decision actions."),
    space: z.literal("image").optional()
      .describe("Coordinate space for screenshot-grounded decision actions."),
    text: z.string().describe("Text to type into the element"),
    clear: z
      .boolean()
      .optional()
      .describe(
        "Replace existing content instead of appending. Default false — appends/types at the element.",
      ),
  }).strict().superRefine((value, context) => {
    const hasRef = value.ref !== undefined;
    const hasCoordinates = value.x !== undefined || value.y !== undefined || value.space !== undefined;
    if (hasRef === hasCoordinates) {
      context.addIssue({
        code: "custom",
        message: "Provide either ref, or x/y with space=image, but not both",
      });
    }
    if (hasCoordinates && (value.x === undefined || value.y === undefined || value.space !== "image")) {
      context.addIssue({
        code: "custom",
        message: "Screenshot-grounded typing requires x, y and space=image",
      });
    }
    if (hasCoordinates && value.clear === true) {
      context.addIssue({
        code: "custom",
        path: ["clear"],
        message: "Screenshot-grounded typing cannot clear a visually inferred target",
      });
    }
  });
  return new DynamicStructuredTool({
    name: "browser_type",
    description:
      "Type text into an input or editable element in the SaaS app the user has open in Nautilo's " +
      "embedded browser panel (e.g. Google Docs, Gmail). Targets a ref like `@e5` from the most recent " +
      "browser_snapshot. Screenshot-grounded decision loops may instead use a server-bound image coordinate " +
      "to atomically focus the visible target and type; do not construct that coordinate form manually.\n\n" +
      "WHEN TO USE: after browser_snapshot shows the textbox or editable region. By default this appends " +
      "at the element without clearing existing content — use clear only when you intentionally want to " +
      "replace the whole field.\n\n" +
      "REFS: come from the latest browser_snapshot only. They go stale the instant the page changes — " +
      "re-snapshot before acting on a new or uncertain target.\n\n" +
      "SCOPE: acts on the user's active embedded app surface only — not Nautilo's own UI or other apps.\n\n" +
      "AVAILABILITY: requires a connected desktop with the `control_browser` capability and an app open " +
      "in the embedded panel.",
    schema,
    func: () => {
      return Promise.reject(
        new Error(
          "browser_type is a relay tool — execution goes through the relay protocol, not direct invocation. If you see this error, the tool routing in toolsNode is broken.",
        ),
      );
    },
  });
}

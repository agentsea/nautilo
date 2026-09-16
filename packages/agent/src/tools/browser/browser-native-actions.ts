import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

const relayStub = (name: string) => () =>
  Promise.reject(
    new Error(
      `${name} is a relay tool — execution goes through the relay protocol, not direct invocation. If you see this error, the tool routing in toolsNode is broken.`,
    ),
  );

const ref = z
  .string()
  .min(1)
  .describe(
    'An @e ref from the most recent browser_snapshot, e.g. "@e3", or a precise CSS selector when the snapshot exposes no ref',
  );

const availability =
  " Requires a connected desktop with the `control_browser` capability and an active embedded browser surface.";

export function createBrowserForwardTool() {
  return new DynamicStructuredTool({
    name: "browser_forward",
    description:
      "Navigate the active embedded browser forward by one history entry. Re-snapshot after navigation because prior refs are stale." +
      availability,
    schema: z.object({}),
    func: relayStub("browser_forward"),
  });
}

export function createBrowserReloadTool() {
  return new DynamicStructuredTool({
    name: "browser_reload",
    description:
      "Reload the active embedded page using native browser navigation. Re-snapshot after reload because prior refs are stale." +
      availability,
    schema: z.object({}),
    func: relayStub("browser_reload"),
  });
}

export function createBrowserHoverTool() {
  return new DynamicStructuredTool({
    name: "browser_hover",
    description:
      "Hover an element from the latest browser_snapshot to reveal menus, tooltips, or hover-only controls. Re-snapshot if the page changes." +
      availability,
    schema: z.object({ ref }),
    func: relayStub("browser_hover"),
  });
}

export function createBrowserDoubleClickTool() {
  return new DynamicStructuredTool({
    name: "browser_double_click",
    description:
      "Double-click an element from the latest browser_snapshot. Use for controls whose native interaction specifically requires two clicks." +
      availability,
    schema: z.object({ ref }),
    func: relayStub("browser_double_click"),
  });
}

export function createBrowserDragTool() {
  return new DynamicStructuredTool({
    name: "browser_drag",
    description:
      "Drag one element onto another. Prefer refs from the same fresh browser_snapshot; use precise CSS selectors when static drag/drop elements expose no refs." +
      availability,
    schema: z.object({
      from: ref.describe("Source @e ref or precise CSS selector"),
      to: ref.describe("Destination @e ref or precise CSS selector"),
    }),
    func: relayStub("browser_drag"),
  });
}

export function createBrowserSelectTool() {
  return new DynamicStructuredTool({
    name: "browser_select",
    description:
      "Select one or more values in a native HTML select element from the latest browser_snapshot." +
      availability,
    schema: z.object({
      ref,
      values: z.array(z.string().min(1)).min(1).describe("Option values to select"),
    }),
    func: relayStub("browser_select"),
  });
}

export function createBrowserSetCheckedTool() {
  return new DynamicStructuredTool({
    name: "browser_set_checked",
    description:
      "Set a checkbox or radio control from the latest browser_snapshot to the requested checked state." +
      availability,
    schema: z.object({
      ref,
      checked: z.boolean().describe("True to check the control; false to uncheck it"),
    }),
    func: relayStub("browser_set_checked"),
  });
}

export function createBrowserScrollIntoViewTool() {
  return new DynamicStructuredTool({
    name: "browser_scroll_into_view",
    description:
      "Scroll an element from the latest browser_snapshot into the visible viewport, then take a fresh snapshot before acting." +
      availability,
    schema: z.object({ ref }),
    func: relayStub("browser_scroll_into_view"),
  });
}

const browserWaitSchema = z
  .object({
    ref: ref.optional().describe("Optional @e ref to wait until present"),
    milliseconds: z
      .number()
      .int()
      .min(0)
      .max(30_000)
      .optional()
      .describe("Optional fixed delay in milliseconds, capped at 30000"),
  })
  .superRefine((value, ctx) => {
    if ((value.ref === undefined) === (value.milliseconds === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of `ref` or `milliseconds`",
      });
    }
  });

export function createBrowserWaitTool() {
  return new DynamicStructuredTool({
    name: "browser_wait",
    description:
      "Poll until an element ref is visible or pause for a short fixed delay while a dynamic embedded page settles. Re-snapshot after waiting." +
      availability,
    schema: browserWaitSchema,
    func: relayStub("browser_wait"),
  });
}

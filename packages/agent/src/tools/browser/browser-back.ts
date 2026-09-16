import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

export function createBrowserBackTool() {
  return new DynamicStructuredTool({
    name: "browser_back",
    description:
      "Navigate the active SaaS app in Nautilo's embedded browser panel back by one history entry.\n\n" +
      "WHEN TO USE: when the current page is a dead end, challenge page, unwanted link, or otherwise " +
      "requires returning to the previous page. Use this instead of browser_press with Alt+Left or " +
      "Meta+[; keyboard shortcuts do not control the embedded tab's native history.\n\n" +
      "WORKFLOW: browser_back {} → browser_snapshot {}. Navigation invalidates every prior @e ref, so " +
      "always take a fresh snapshot before acting again.\n\n" +
      "SCOPE: acts on the user's active embedded app surface only — not Nautilo's own UI or other apps.\n\n" +
      "AVAILABILITY: requires a connected desktop with the `control_browser` capability and an app open " +
      "in the embedded panel.",
    schema: z.object({}),
    func: () => {
      return Promise.reject(
        new Error(
          "browser_back is a relay tool — execution goes through the relay protocol, not direct invocation. If you see this error, the tool routing in toolsNode is broken.",
        ),
      );
    },
  });
}

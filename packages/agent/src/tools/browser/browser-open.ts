import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

const httpUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "URL must use http or https");

export function createBrowserOpenTool() {
  return new DynamicStructuredTool({
    name: "browser_open",
    description:
      "Navigate the active SaaS app in Nautilo's embedded browser panel directly to an HTTP or HTTPS URL.\n\n" +
      "WHEN TO USE: when the user supplies a URL, when a dead-end page has no usable link, or when you " +
      "need to replace the current page without interacting with Nautilo's address bar. The address bar " +
      "is host chrome and cannot be targeted with browser_type.\n\n" +
      "WORKFLOW: browser_open {url} → browser_snapshot {}. Navigation invalidates every prior @e ref, so " +
      "always take a fresh snapshot before acting again.\n\n" +
      "SCOPE: acts on the user's active embedded app surface only — not Nautilo's own UI or other apps.\n\n" +
      "AVAILABILITY: requires a connected desktop with the `control_browser` capability and an app open " +
      "in the embedded panel.",
    schema: z.object({
      url: httpUrl.describe("Absolute HTTP or HTTPS URL to open in the active embedded tab"),
    }),
    func: () => {
      return Promise.reject(
        new Error(
          "browser_open is a relay tool — execution goes through the relay protocol, not direct invocation. If you see this error, the tool routing in toolsNode is broken.",
        ),
      );
    },
  });
}

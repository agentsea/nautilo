import { connectedWebActivityEntrySchema } from "@nautilo/types";
import type { BrowserUseHostedRunEvent } from "../browser-use/browser-use-cloud";

export interface ConnectedWebActivityWrite {
  readonly providerEventId: number;
  readonly occurredAt: Date;
  readonly status: "pending" | "running" | "completed" | "error";
  readonly summary: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** V4 observed contract: core.event / tool / browser_execute only. */
export function connectedWebActivityFromEvents(events: readonly BrowserUseHostedRunEvent[]): ConnectedWebActivityWrite[] {
  return events.flatMap((event) => {
    if (event.type !== "core.event") return [];
    const part = record(event.data["part"]);
    if (part?.["type"] !== "tool" || part["tool"] !== "browser_execute") return [];
    const state = record(part["state"]);
    if (!state || !["pending", "running", "completed", "error"].includes(String(state["status"]))) return [];
    const input = record(state["input"]);
    const description = typeof input?.["description"] === "string" ? input["description"].replace(/\s+/gu, " ").trim() : "";
    // Do not truncate or serialize arbitrary output. Unsupported descriptions
    // get explicit withheld prose. Reasoning/code/output/metadata are ignored.
    const safe = connectedWebActivityEntrySchema.shape.summary.safeParse(description);
    const summary = safe.success && !/[@{}<>]|[A-Za-z0-9_=-]{40,}/u.test(description)
      ? safe.data : "Browser interaction (description withheld).";
    return [{ providerEventId: event.eventId, occurredAt: event.occurredAt,
      status: state["status"] as ConnectedWebActivityWrite["status"], summary }];
  });
}

/** UI/tool page size only; every earlier entry remains cursor-addressable. */
export const CONNECTED_WEB_ACTIVITY_PAGE_SIZE = 25;

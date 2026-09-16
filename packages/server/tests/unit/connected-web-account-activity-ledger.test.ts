import { expect, test } from "bun:test";
import { connectedWebActivityFromEvents } from "../../src/connected-web-accounts/activity-ledger";
import type { BrowserUseHostedRunEvent } from "../../src/browser-use/browser-use-cloud";

function event(description: string, status = "completed"): BrowserUseHostedRunEvent {
  return { eventId: 10, occurredAt: new Date("2026-09-04T15:00:00Z"), type: "core.event", data: {
    part: { type: "tool", tool: "browser_execute", state: { status,
      input: { description, code: "MUST NOT EXPOSE CODE" }, output: "MUST NOT EXPOSE PAGE OUTPUT",
      metadata: { output: "MUST NOT EXPOSE METADATA" } } },
  } };
}

test("records the observed V4 description/status without exposing code, output, metadata, or reasoning", () => {
  const result = connectedWebActivityFromEvents([event("Inspect billing navigation")]);
  expect(result).toEqual([{ providerEventId: 10, occurredAt: new Date("2026-09-04T15:00:00Z"), status: "completed", summary: "Inspect billing navigation" }]);
  expect(JSON.stringify(result)).not.toContain("MUST NOT");
  expect(connectedWebActivityFromEvents([{ ...event("unused"), data: { part: { type: "reasoning", text: "private reasoning", reasoningEncryptedContent: "opaque" } } }])).toEqual([]);
});

test("withholds capability/credential-shaped descriptions and never truncates them into plausible evidence", () => {
  for (const description of ["Open https://live.browser-use.com/private", "Enter password abcdef", "Read bearer abcdef", "Read credentials abcdef", "Read API keys abcdef", "Contact owner@example.com", "a".repeat(600)]) {
    expect(connectedWebActivityFromEvents([event(description)])[0]?.summary).toBe("Browser interaction (description withheld).");
  }
  expect(connectedWebActivityFromEvents([event("Inspect billing", "unknown")])).toEqual([]);
  expect(connectedWebActivityFromEvents([{ ...event("Inspect"), type: "browser.ready", data: { live_view_url: "https://private" } }])).toEqual([]);
});

/**
 * D423 Phase 4 — `buildFocusedResourcesBlock` unit tests.
 *
 * Pins the agent-side prompt injection layer for the ONE authoritative
 * `## Focused resources` manifest: given a resolved manifest, produce the
 * unified block (or empty string). Mirrors `two-path-block.test.ts` /
 * `buildArtifactRefsBlock` coverage: this file concerns itself only with the
 * string-building contract from public manifest fields. The server-side
 * resolver registry tests live in
 * `packages/server/tests/unit-isolated/focused-resources.test.ts`.
 *
 * Privacy is load-bearing: the block must render ONLY the public fields
 * (displayName / mimeType / size / location / lifetime / capabilities /
 * toolTarget) — never the private `locator` (absolute paths, relay IDs,
 * internal row ids).
 */
import { describe, test, expect } from "bun:test";
import { buildFocusedResourcesBlock, FOCUSED_RESOURCES_HEADER } from "../../src/prompts/templates";

describe("buildFocusedResourcesBlock", () => {
  test("empty / null / undefined → empty string (no block injected)", () => {
    expect(buildFocusedResourcesBlock([])).toBe("");
    expect(buildFocusedResourcesBlock(null)).toBe("");
    expect(buildFocusedResourcesBlock(undefined)).toBe("");
  });

  test("renders one coherent block spanning artifact + attachment lanes", () => {
    const out = buildFocusedResourcesBlock([
      {
        kind: "workspace-artifact",
        displayName: "q3.xlsx",
        mimeType: "application/vnd.ms-excel",
        size: 4096,
        location: "server",
        lifetime: "workspace",
        capabilities: ["read"],
        toolTarget: { tool: "file", zone: "workspace", path: "authoritative/reports/q3.xlsx" },
        locator: { artifactId: "reports/q3.xlsx" },
      },
      {
        kind: "message-attachment",
        displayName: "pic.png",
        location: "server",
        lifetime: "message",
        capabilities: ["read"],
        locator: { attachmentId: "att-1" },
      },
    ]);
    expect(out).toContain(FOCUSED_RESOURCES_HEADER.trim());
    expect(out).toContain("q3.xlsx");
    expect(out).toContain("pic.png");
    // Unified file tool target for the workspace artifact.
    expect(out).toContain('zone="workspace"');
    expect(out).toContain("authoritative/reports/q3.xlsx");
    // Each resource gets kind-specific guidance.
    expect(out).toContain("Workspace artifact");
    expect(out).toContain("Message attachment");
    // Focus never implies ingestion.
    expect(out).toContain("does NOT mean bytes were uploaded");
    expect(out).toContain("takes precedence over generic active-browser guidance");
    expect(out).toContain("NEVER call `browser_snapshot`");
    expect(out).toContain("Browser tools inspect embedded web pages, not focused files or workspace artifacts");
  });

  test("never exposes private locators (attachmentId / relayId / local absolute paths)", () => {
    const out = buildFocusedResourcesBlock([
      {
        kind: "workspace-artifact",
        displayName: "q3.xlsx",
        location: "server",
        lifetime: "workspace",
        capabilities: ["read"],
        toolTarget: { tool: "file", zone: "workspace", path: "authoritative/reports/q3.xlsx" },
        locator: { artifactId: "reports/q3.xlsx" },
      },
      {
        kind: "message-attachment",
        displayName: "clip.m4a",
        location: "server",
        lifetime: "message",
        capabilities: ["transcribe"],
        locator: { attachmentId: "att-secret" },
      },
      {
        kind: "local-file",
        displayName: "deck.pptx",
        location: "relay",
        lifetime: "turn",
        capabilities: [],
        locator: { relayId: "relay-secret", path: "/secret/abs/deck.pptx" },
      },
    ]);
    // Private locators never reach the prompt prose.
    expect(out).not.toContain("att-secret");
    expect(out).not.toContain("relay-secret");
    expect(out).not.toContain("/secret/abs");
    // The workspace artifact's bounded workspace path IS the model-facing tool
    // target (not a private locator) — it should appear.
    expect(out).toContain("authoritative/reports/q3.xlsx");
  });

  test("renders capabilities + location + lifetime as bounded prose", () => {
    const out = buildFocusedResourcesBlock([
      {
        kind: "message-attachment",
        displayName: "clip.m4a",
        mimeType: "audio/mp4",
        size: 1024,
        location: "server",
        lifetime: "message",
        capabilities: ["transcribe"],
        locator: { attachmentId: "a1" },
      },
    ]);
    expect(out).toContain("type audio/mp4");
    expect(out).toContain("1024 bytes");
    expect(out).toContain("lives on server");
    expect(out).toContain("in scope for this message");
    expect(out).toContain("may transcribe");
  });

  test("local-file entry has no file tool target → renders guidance without a path line", () => {
    const out = buildFocusedResourcesBlock([
      {
        kind: "local-file",
        displayName: "deck.pptx",
        location: "relay",
        lifetime: "turn",
        capabilities: [],
        locator: { relayId: "r", path: "/x/deck.pptx" },
      },
    ]);
    expect(out).toContain("deck.pptx");
    expect(out).toContain("lives on the user's device");
    expect(out).toContain("in scope for this turn only");
    expect(out).toContain("Local file");
    // No toolTarget ⇒ no `zone=` line for this entry.
    expect(out).not.toContain('zone="current"');
    expect(out).not.toContain('zone="absolute"');
  });

  test("local-file entry WITH a file tool target renders the model-facing zone + path, never the relay id", () => {
    const out = buildFocusedResourcesBlock([
      {
        kind: "local-file",
        displayName: "deck.pptx",
        location: "relay",
        lifetime: "turn",
        capabilities: ["read", "edit"],
        toolTarget: { tool: "file", zone: "current", path: "deck.pptx" },
        locator: { relayId: "relay-secret", path: "/Users/alice/demo/deck.pptx" },
      },
    ]);
    // The model-facing zone + relative path ARE rendered (the model needs them
    // to call the `file` tool). Focus still never claims ingestion.
    expect(out).toContain('zone="current"');
    expect(out).toContain("deck.pptx");
    expect(out).toContain("may read, edit");
    // The private locator (relay id, absolute path) never reaches prompt prose.
    expect(out).not.toContain("relay-secret");
    expect(out).not.toContain("/Users/alice/demo");
  });

  test("malformed capabilities are filtered + deduped", () => {
    const out = buildFocusedResourcesBlock([
      {
        kind: "workspace-artifact",
        displayName: "doc.pdf",
        location: "server",
        lifetime: "workspace",
        capabilities: ["read", "read", "bogus" as never, "edit"],
        locator: { artifactId: "d1" },
      },
    ]);
    expect(out).toContain("may read, edit");
    expect(out).not.toContain("bogus");
  });

  test("sanitizes control characters out of display fields", () => {
    const out = buildFocusedResourcesBlock([
      {
        kind: "workspace-artifact",
        displayName: "ev\u0000il.txt",
        location: "server",
        lifetime: "workspace",
        capabilities: ["read"],
        locator: { artifactId: "e1" },
      },
    ]);
    // The control char is stripped; entry still renders with the cleaned name.
    expect(out).toContain("evil.txt");
    expect(out).not.toContain("\u0000");
  });
});

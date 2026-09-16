/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cardSource = readFileSync(resolve(here, "approval-card.tsx"), "utf8");
const attentionSource = readFileSync(resolve(here, "../providers/attention.tsx"), "utf8");

describe("mobile local MCP exact review", () => {
  test("gives every approval choice an explicit accessible verb and 44 point target", () => {
    expect(cardSource).toContain('once: "Approve once"');
    expect(cardSource).toContain('room: "Approve for this room"');
    expect(cardSource).toContain('always: "Always approve"');
    expect(cardSource).toContain('accessibilityRole="button"');
    expect(cardSource).toContain('accessibilityState={{ disabled: anyPending, busy: isPending }}');
    expect(cardSource).toContain('minHeight: 44');
    expect(cardSource).toContain('accessibilityRole="alert"');
  });
  test("renders the exact effect with indexed JSON argv rather than a truncated tool summary", () => {
    expect(cardSource).toContain("function LocalMcpInstallDetail");
    expect(cardSource).toContain("argv[{index}]={JSON.stringify(entry)}");
    expect(cardSource).toContain("Approval digest: {approval.digest}");
    expect(cardSource).toContain("Subprocess sandbox: NOT sandboxed.");
    expect(cardSource).toContain("Local subprocess: none (HTTP transport).");
    expect(cardSource).toContain("approval.requiresExplicitReview && approval.localMcpInstall");
  });

  test("preserves digest on reply and fails closed for missing details or standing verbs", () => {
    expect(attentionSource).toContain("requiresExplicitReview: event.requiresExplicitReview === true");
    expect(attentionSource).toContain('allowedVerbs: ["once", "deny"]');
    expect(attentionSource).toContain("approval.localMcpInstall?.digest");
    expect(attentionSource).toContain('(verb !== "once" && verb !== "deny")');
  });

  test("renders and submits structured SSH exact review instead of failing it closed as missing", () => {
    expect(cardSource).toContain("function StructuredSshDetail");
    expect(cardSource).toContain('accessibilityLabel="Exact structured SSH approval"');
    expect(cardSource).toContain("approval.requiresExplicitReview && approval.structuredSsh");
    expect(cardSource).toContain("Request digest: {approval.approvedRequestDigest}");
    expect(attentionSource).toContain("!event.localMcpInstall && !event.structuredSsh");
    expect(attentionSource).toContain("approval.structuredSsh === undefined");
  });
});

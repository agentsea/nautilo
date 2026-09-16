import { describe, test, expect } from "bun:test";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  envelopeFactsForArtifacts,
  validateLogicalPath,
} from "../../src/tools/file/artifact-store";

const AGENT_ID = "20000000-0000-4000-8000-000000000002";
const USER_ID = "10000000-0000-4000-8000-000000000001";

function namespaceEnvelope(
  partial?: Partial<Extract<MemoryAccessEnvelope, { memoryMode?: "namespace" }>>,
): MemoryAccessEnvelope {
  return {
    ownerId: "10000000-0000-4000-8000-000000000001",
    actorId: "30000000-0000-4000-8000-000000000003",
    agentId: AGENT_ID,
    roomId: "room-1",
    readableNamespaces: ["r1", "r2"],
    mutableNamespaces: ["m1"],
    writableNamespaces: ["w1"],
    toolPolicy: {},
    ...partial,
  };
}

describe("validateLogicalPath", () => {
  test("rejects empty string", () => {
    expect(validateLogicalPath("")).toEqual({ ok: false, reason: "path is required" });
    expect(validateLogicalPath(null)).toEqual({ ok: false, reason: "path is required" });
    expect(validateLogicalPath(undefined)).toEqual({ ok: false, reason: "path is required" });
  });

  test("rejects absolute path (must be relative)", () => {
    const r = validateLogicalPath("/etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("must be relative");
      expect(r.reason).toContain("absolute");
    }
  });

  test("rejects .. segment", () => {
    const r = validateLogicalPath("drafts/../secret.md");
    expect(r).toEqual({ ok: false, reason: "path may not contain '..' segments" });
  });

  test("rejects control characters", () => {
    const r = validateLogicalPath("a\x01b.md");
    expect(r).toEqual({ ok: false, reason: "path contains control characters" });
  });

  test("accepts notes.md and round-trips", () => {
    expect(validateLogicalPath("notes.md")).toEqual({ ok: true, path: "notes.md" });
  });

  test("accepts nested forward slashes", () => {
    expect(validateLogicalPath("drafts/q3/file.md")).toEqual({
      ok: true,
      path: "drafts/q3/file.md",
    });
  });

  test("normalizes duplicate slashes", () => {
    expect(validateLogicalPath("drafts//q3")).toEqual({ ok: true, path: "drafts/q3" });
  });

  test("accepts backslashes and normalizes to forward slashes", () => {
    expect(validateLogicalPath("drafts\\foo")).toEqual({ ok: true, path: "drafts/foo" });
  });

  test("rejects dot-only path", () => {
    expect(validateLogicalPath(".")).toEqual({
      ok: false,
      reason: "path must contain at least one non-empty segment",
    });
  });
});

describe("envelopeFactsForArtifacts", () => {
  test("null envelope → clear missing-context reason", () => {
    const r = envelopeFactsForArtifacts(null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("Workspace artifact access requires an authenticated room/namespace context");
      expect(r.reason).toContain("no envelope");
    }
  });

  test("undefined envelope → same as null", () => {
    const r = envelopeFactsForArtifacts(undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("no envelope");
    }
  });

  test("scope-mode envelope → not implemented yet", () => {
    const scopeEnv: MemoryAccessEnvelope = {
      memoryMode: "scope",
      ownerId: "o",
      actorId: "a",
      agentId: AGENT_ID,
      roomId: "",
      scopeId: "scope-uuid",
      toolPolicy: {},
    };
    const r = envelopeFactsForArtifacts(scopeEnv);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("Artifact scope mode is not implemented yet");
      expect(r.reason).toContain("M088 Phase 4");
    }
  });

  test("namespace-mode envelope → facts match input", () => {
    const env = namespaceEnvelope({
      readableNamespaces: ["a", "b"],
      mutableNamespaces: ["m"],
      writableNamespaces: ["w"],
    });
    const r = envelopeFactsForArtifacts(env);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.facts.userId).toBe(USER_ID);
      expect(r.facts.agentId).toBe(AGENT_ID);
      expect(r.facts.readableNamespaces).toEqual(["a", "b"]);
      expect(r.facts.mutableNamespaces).toEqual(["m"]);
      expect(r.facts.writableNamespaces).toEqual(["w"]);
    }
  });

  test("namespace-mode envelope with empty ownerId → requires speaker user id", () => {
    const env = namespaceEnvelope({ ownerId: "" });
    const r = envelopeFactsForArtifacts(env);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("authenticated speaker user id");
      expect(r.reason).toContain("envelope.ownerId");
    }
  });
});

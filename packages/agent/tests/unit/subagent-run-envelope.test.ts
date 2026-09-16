import { describe, expect, test } from "bun:test";
import {
  isScopeMemoryEnvelope,
  type MemoryAccessEnvelope,
  type NamespaceMemoryEnvelope,
  type ScopeMemoryEnvelope,
} from "@nautilo/trust";
import { subagentMemoryModeNote } from "../../src/subagents/scope-subagent/run";

const scopeEnvelope: ScopeMemoryEnvelope = {
  memoryMode: "scope",
  ownerId: "o",
  actorId: "a",
  agentId: "g",
  roomId: "r",
  scopeId: "x",
  toolPolicy: {},
};

const namespaceEnvelope: NamespaceMemoryEnvelope = {
  memoryMode: "namespace",
  ownerId: "o",
  actorId: "a",
  agentId: "g",
  roomId: "r",
  readableNamespaces: ["n1"],
  mutableNamespaces: ["n1"],
  writableNamespaces: ["n1"],
  toolPolicy: {},
};

describe("M137 — subagent envelope kind routing", () => {
  test("isScopeMemoryEnvelope distinguishes scope vs namespace envelopes", () => {
    expect(isScopeMemoryEnvelope(scopeEnvelope)).toBe(true);
    expect(isScopeMemoryEnvelope(namespaceEnvelope)).toBe(false);
  });

  test("subagentMemoryModeNote selects scope-only vs private namespace footer", () => {
    const scopeNote = subagentMemoryModeNote(scopeEnvelope);
    const namespaceNote = subagentMemoryModeNote(namespaceEnvelope);

    expect(scopeNote).toContain("scope-only memory mode");
    expect(namespaceNote).toContain("private namespace");
    expect(scopeNote).not.toBe(namespaceNote);
  });

  test("restricted research uses its durable ledger instead of unavailable memory tools", () => {
    const note = subagentMemoryModeNote(scopeEnvelope, ["security_scan", "file"]);
    expect(note).toContain("security_scan ledger");
    expect(note).toContain("checkpoints");
    expect(note).not.toContain("manage_memory");
    expect(subagentMemoryModeNote(scopeEnvelope, [])).not.toContain("manage_memory");
  });

  test("subagentMemoryModeNote accepts MemoryAccessEnvelope union", () => {
    const envelopes: MemoryAccessEnvelope[] = [scopeEnvelope, namespaceEnvelope];
    for (const envelope of envelopes) {
      expect(subagentMemoryModeNote(envelope).length).toBeGreaterThan(0);
    }
  });
});

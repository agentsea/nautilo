import { describe, expect, test } from "bun:test";
import {
  memoryModeOf,
  isScopeMemoryEnvelope,
  isNamespaceMemoryEnvelope,
  envelopeReadableNamespaces,
  envelopeMutableNamespaces,
  envelopeWritableNamespaces,
  type NamespaceMemoryEnvelope,
  type ScopeMemoryEnvelope,
} from "../../src/types";

const nsFixture: NamespaceMemoryEnvelope = {
  ownerId: "o",
  actorId: "a",
  agentId: "g",
  roomId: "r",
  readableNamespaces: ["n1"],
  mutableNamespaces: ["n1"],
  writableNamespaces: ["n1"],
  toolPolicy: {},
};

const scopeFixture: ScopeMemoryEnvelope = {
  memoryMode: "scope",
  ownerId: "o",
  actorId: "a",
  agentId: "g",
  roomId: "r",
  scopeId: "s1",
  toolPolicy: {},
};

describe("M084 — memory envelope mode helpers", () => {
  test("memoryModeOf treats missing mode as namespace", () => {
    expect(memoryModeOf(nsFixture)).toBe("namespace");
    expect(memoryModeOf(null)).toBe("namespace");
  });

  test("memoryModeOf detects scope", () => {
    expect(memoryModeOf(scopeFixture)).toBe("scope");
  });

  test("isScopeMemoryEnvelope requires scope discriminant + scopeId", () => {
    expect(isScopeMemoryEnvelope(scopeFixture)).toBe(true);
    expect(isScopeMemoryEnvelope(nsFixture)).toBe(false);
    expect(isScopeMemoryEnvelope(null)).toBe(false);
  });

  test("isNamespaceMemoryEnvelope for pre-M084 fixtures", () => {
    expect(isNamespaceMemoryEnvelope(nsFixture)).toBe(true);
    expect(isNamespaceMemoryEnvelope(scopeFixture)).toBe(false);
  });

  test("envelope*Namespaces helpers return [] for scope or missing envelope", () => {
    expect(envelopeReadableNamespaces(null)).toEqual([]);
    expect(envelopeReadableNamespaces(scopeFixture)).toEqual([]);
    expect(envelopeMutableNamespaces(scopeFixture)).toEqual([]);
    expect(envelopeWritableNamespaces(scopeFixture)).toEqual([]);
  });

  test("envelope*Namespaces helpers pass through namespace lists", () => {
    expect(envelopeReadableNamespaces(nsFixture)).toEqual(["n1"]);
    expect(envelopeMutableNamespaces(nsFixture)).toEqual(["n1"]);
    expect(envelopeWritableNamespaces(nsFixture)).toEqual(["n1"]);
  });
});

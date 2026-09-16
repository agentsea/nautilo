import { describe, expect, test } from "bun:test";
import type { WhoamiResponse } from "@nautilo/types";
import {
  canonicalWhoamiProjectionForHash,
  whoamiIfNoneMatchEquals,
  whoamiWeakETagFromProjection,
} from "../../src/auth/whoami-conditional-http";

function sampleWhoami(overrides: Partial<WhoamiResponse> = {}): WhoamiResponse {
  return {
    sessionUserId: "user-1",
    sessionActorId: "actor-1",
    userIdentity: "id:user-1",
    handle: "alice",
    displayName: "Alice",
    externalId: "logto-sub-1",
    instanceId: "inst-1",
    mustChangePassword: false,
    groups: [
      { id: "g-b", type: "team", label: "Beta", roleSlug: "member" },
      { id: "g-a", type: "owners", label: "Owners", roleSlug: "owner" },
    ],
    capabilities: ["manage_members", "view_audit_log"],
    features: { office: { enabled: true } },
    highestRole: "owner",
    ...overrides,
  };
}

describe("whoamiWeakETagFromProjection (M213 Phase 8)", () => {
  test("ETag is opaque weak W/\"base64url\" with no plain user/role/cap tokens", () => {
    const etag = whoamiWeakETagFromProjection(sampleWhoami());
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(etag).not.toContain("user-1");
    expect(etag).not.toContain("alice");
    expect(etag).not.toContain("owner");
    expect(etag).not.toContain("manage_members");
  });

  test("stable across permuted groups and capabilities (hash-only sort)", () => {
    const a = sampleWhoami();
    const b = sampleWhoami({
      groups: [
        { id: "g-a", type: "owners", label: "Owners", roleSlug: "owner" },
        { id: "g-b", type: "team", label: "Beta", roleSlug: "member" },
      ],
      capabilities: ["view_audit_log", "manage_members"],
    });
    expect(whoamiWeakETagFromProjection(a)).toBe(whoamiWeakETagFromProjection(b));
    expect(a.groups[0]?.id).toBe("g-b");
    expect(b.groups[0]?.id).toBe("g-a");
  });

  test("changes when any authorized projection field changes", () => {
    const base = sampleWhoami();
    const baseEtag = whoamiWeakETagFromProjection(base);
    expect(whoamiWeakETagFromProjection({ ...base, mustChangePassword: true })).not.toBe(
      baseEtag,
    );
    expect(
      whoamiWeakETagFromProjection({
        ...base,
        capabilities: [...base.capabilities, "manage_groups"],
      }),
    ).not.toBe(baseEtag);
    expect(
      whoamiWeakETagFromProjection({
        ...base,
        features: { office: { enabled: false } },
      }),
    ).not.toBe(baseEtag);
  });

  test("canonicalWhoamiProjectionForHash does not mutate the live body", () => {
    const body = sampleWhoami();
    const groupsBefore = body.groups.map((g) => g.id);
    const capsBefore = [...body.capabilities];
    canonicalWhoamiProjectionForHash(body);
    expect(body.groups.map((g) => g.id)).toEqual(groupsBefore);
    expect(body.capabilities).toEqual(capsBefore);
  });
});

describe("whoamiIfNoneMatchEquals (M213 Phase 8)", () => {
  const etag = 'W/"abc123"';

  test("exact single-value match", () => {
    expect(whoamiIfNoneMatchEquals(etag, etag)).toBe(true);
    expect(whoamiIfNoneMatchEquals(`  ${etag}  `, etag)).toBe(true);
  });

  test("exact match among comma-separated tokens", () => {
    expect(whoamiIfNoneMatchEquals('W/"other", W/"abc123"', etag)).toBe(true);
  });

  test("no match for missing, empty, different, or wildcard headers", () => {
    expect(whoamiIfNoneMatchEquals(undefined, etag)).toBe(false);
    expect(whoamiIfNoneMatchEquals("", etag)).toBe(false);
    expect(whoamiIfNoneMatchEquals('W/"different"', etag)).toBe(false);
    expect(whoamiIfNoneMatchEquals("*", etag)).toBe(false);
  });

  test("accepts string[] header values", () => {
    expect(whoamiIfNoneMatchEquals([etag], etag)).toBe(true);
    expect(whoamiIfNoneMatchEquals(['W/"x"', 'W/"y"'], etag)).toBe(false);
  });
});

/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import {
  memoryAccessRecipients,
  memoryActionAvailability,
  memoryAudienceLabel,
  type MemoryActionAuthority,
} from "./presentation";

const fullAuthority: MemoryActionAuthority = {
  canEdit: true,
  canArchive: true,
  canHardDelete: true,
  canManageAccess: true,
};

describe("memoryActionAvailability", () => {
  test("fails closed until the detail route projects authority", () => {
    expect(memoryActionAvailability(null, "namespace")).toEqual({
      canEdit: false,
      canArchive: false,
      canDelete: false,
      canManageAccess: false,
      limitation: "Memory actions are unavailable until the server confirms your access.",
    });
  });

  test("uses the server-projected capability denial instead of a client capability guess", () => {
    expect(memoryActionAvailability({
      canEdit: false,
      canArchive: false,
      canHardDelete: false,
      canManageAccess: false,
    }, "namespace")).toEqual({
      canEdit: false,
      canArchive: false,
      canDelete: false,
      canManageAccess: false,
      limitation: "You can view this memory, but cannot change it from this context.",
    });
  });

  test("supports a writable namespace memory", () => {
    expect(memoryActionAvailability(fullAuthority, "namespace")).toEqual({
      canEdit: true,
      canArchive: true,
      canDelete: true,
      canManageAccess: true,
      limitation: null,
    });
  });

  test("keeps namespace-only access actions unavailable in scope mode", () => {
    expect(memoryActionAvailability({
      canEdit: true,
      canArchive: true,
      canHardDelete: true,
      canManageAccess: false,
    }, "scope")).toEqual({
      canEdit: true,
      canArchive: true,
      canDelete: true,
      canManageAccess: false,
      limitation: "This memory belongs to a private context and cannot be shared from here.",
    });
  });

  test("does not expose delete when the detail route reports no attached writable namespace", () => {
    expect(memoryActionAvailability({ ...fullAuthority, canHardDelete: false }, "namespace")).toMatchObject({
      canEdit: true,
      canArchive: true,
      canDelete: false,
      canManageAccess: true,
    });
  });
});

describe("memory access presentation", () => {
  const accessList = [
    { userHandle: "alex", displayName: "Alex" },
    { userHandle: "taylor", displayName: "Taylor" },
  ];

  test("does not offer the signed-in requester as a removable recipient", () => {
    expect(memoryAccessRecipients(accessList, "Alex")).toEqual([
      { userHandle: "taylor", displayName: "Taylor" },
    ]);
  });

  test("labels a requester-only namespace as private", () => {
    expect(
      memoryAudienceLabel(
        { namespaceIds: ["ns-private"], accessList: [accessList[0]] },
        "namespace",
        "alex",
      ),
    ).toBe("Private memory");
  });

  test("labels requester-only access as private even across internal namespaces", () => {
    expect(
      memoryAudienceLabel(
        {
          namespaceIds: ["ns-private", "ns-requester-room"],
          accessList: [accessList[0]],
        },
        "namespace",
        "alex",
      ),
    ).toBe("Private memory");
  });

  test("names the one other recipient without counting the requester", () => {
    expect(
      memoryAudienceLabel(
        { namespaceIds: ["ns-shared"], accessList },
        "namespace",
        "alex",
      ),
    ).toBe("Shared with Taylor");
  });
});

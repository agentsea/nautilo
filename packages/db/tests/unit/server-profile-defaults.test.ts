import { describe, expect, it } from "bun:test";
import { NAUTILO_PRODUCT_NAME } from "@nautilo/config";
import type { ServerProfileRow } from "../../src/schema/server-profile";
import {
  resolveServerProfile,
  deriveDefaultServerName,
} from "../../src/utils/server-profile-queries";

const DEFAULT_ICON = { kind: "preset", id: "server-default" } as const;

describe("resolveServerProfile", () => {
  it("applies all defaults when row is null", () => {
    expect(resolveServerProfile(null)).toEqual({
      name: NAUTILO_PRODUCT_NAME,
      description: null,
      descriptionVisibility: "public",
      icon: DEFAULT_ICON,
      reviewedAt: null,
    });
  });

  it("passes through a fully populated row unchanged", () => {
    const row: ServerProfileRow = {
      id: "server",
      name: "Acme Lab",
      description: "Internal research server",
      descriptionVisibility: "members",
      icon: { kind: "uploaded", blobId: "blob-123" },
      reviewedAt: new Date("2026-06-07T11:00:00.000Z"),
      updatedAt: new Date("2026-06-07T12:00:00.000Z"),
    };

    expect(resolveServerProfile(row)).toEqual({
      name: "Acme Lab",
      description: "Internal research server",
      descriptionVisibility: "members",
      icon: { kind: "uploaded", blobId: "blob-123" },
      reviewedAt: new Date("2026-06-07T11:00:00.000Z"),
    });
  });

  it("defaults unset fields on a partial row", () => {
    const row = {
      id: "server",
      name: "Custom Name",
      description: null,
      descriptionVisibility: "public",
      icon: null,
      reviewedAt: null,
      updatedAt: new Date("2026-06-07T12:00:00.000Z"),
    } satisfies ServerProfileRow;

    expect(resolveServerProfile(row)).toEqual({
      name: "Custom Name",
      description: null,
      descriptionVisibility: "public",
      icon: DEFAULT_ICON,
      reviewedAt: null,
    });
  });

  it("uses opts.defaultName for an unconfigured name (R6)", () => {
    expect(resolveServerProfile(null, { defaultName: "Kentauros" }).name).toBe(
      "Kentauros",
    );
  });

  it("a stored name wins over opts.defaultName", () => {
    const row = {
      id: "server",
      name: "Real Name",
      description: null,
      descriptionVisibility: "public",
      icon: null,
      reviewedAt: null,
      updatedAt: new Date(),
    } satisfies ServerProfileRow;
    expect(resolveServerProfile(row, { defaultName: "Kentauros" }).name).toBe(
      "Real Name",
    );
  });
});

describe("deriveDefaultServerName", () => {
  it("derives a title-cased label from a meaningful host", () => {
    expect(deriveDefaultServerName({ host: "https://kentauros.nautilo.dev:3001" })).toBe(
      "Kentauros",
    );
    expect(deriveDefaultServerName({ host: "acme-lab.example.com" })).toBe("Acme Lab");
  });

  it("falls back to a branded instance-stable name for generic hosts", () => {
    const a = deriveDefaultServerName({ host: "localhost", instanceId: "inst-one" });
    const b = deriveDefaultServerName({ host: "127.0.0.1", instanceId: "inst-one" });
    expect(a).toMatch(/^Nautilo [0-9a-z]{4}$/);
    expect(a).toBe(b); // deterministic for the same instanceId
    expect(deriveDefaultServerName({ host: "localhost", instanceId: "inst-two" })).not.toBe(a);
  });

  it("falls back to bare product name when nothing is derivable", () => {
    expect(deriveDefaultServerName({ host: "localhost", instanceId: "" })).toBe("Nautilo");
  });
});

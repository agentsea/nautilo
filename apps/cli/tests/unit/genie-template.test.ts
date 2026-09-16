import { describe, test, expect } from "bun:test";
import { SetupTemplateV1 } from "@nautilo/api-client";

describe("SetupTemplateV1 genie", () => {
  test("accepts explicit + preset avatar", () => {
    const r = SetupTemplateV1.safeParse({
      schemaVersion: 1,
      admin: {
        handle: "owner",
        displayName: "Owner",
        password: { value: "12345678" },
        pin: { value: "654321" },
      },
      claim: { inviteCode: { value: "x" } },
      genie: {
        mode: "explicit",
        name: "Astra",
        voice: "openai:nova",
        defaultModel: "openai:gpt-4o-mini",
        personality: "Warm.",
        avatar: { kind: "preset", presetId: "avatar-03" },
      },
    });
    expect(r.success).toBe(true);
  });

  test("rejects bad voice id", () => {
    const r = SetupTemplateV1.safeParse({
      schemaVersion: 1,
      admin: {
        handle: "owner",
        displayName: "Owner",
        password: { value: "12345678" },
        pin: { value: "654321" },
      },
      claim: { inviteCode: { value: "x" } },
      genie: {
        mode: "explicit",
        name: "Astra",
        voice: "badvoice",
        defaultModel: "openai:gpt-4o-mini",
        personality: "Warm.",
      },
    });
    expect(r.success).toBe(false);
  });

  test("rejects avatar-08 preset gap", () => {
    const r = SetupTemplateV1.safeParse({
      schemaVersion: 1,
      admin: {
        handle: "owner",
        displayName: "Owner",
        password: { value: "12345678" },
        pin: { value: "654321" },
      },
      claim: { inviteCode: { value: "x" } },
      genie: {
        mode: "explicit",
        name: "Astra",
        voice: "openai:nova",
        defaultModel: "openai:gpt-4o-mini",
        personality: "Warm.",
        avatar: { kind: "preset", presetId: "avatar-08" },
      },
    });
    expect(r.success).toBe(false);
  });

  test("rejects oversized personality", () => {
    const r = SetupTemplateV1.safeParse({
      schemaVersion: 1,
      admin: {
        handle: "owner",
        displayName: "Owner",
        password: { value: "12345678" },
        pin: { value: "654321" },
      },
      claim: { inviteCode: { value: "x" } },
      genie: {
        mode: "explicit",
        name: "Astra",
        voice: "openai:nova",
        defaultModel: "openai:gpt-4o-mini",
        personality: "x".repeat(2001),
      },
    });
    expect(r.success).toBe(false);
  });
});

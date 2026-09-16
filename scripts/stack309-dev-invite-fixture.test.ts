/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import {
  fixtureLocatorPath,
  mintInviteToken,
  normalizedOrigin,
  parseFixtureArgs,
} from "./stack309-dev-invite-fixture";

describe("Stack 309 dev invite fixture", () => {
  test("has a closed disposable-instance, role, expiry, and command contract", () => {
    expect(
      parseFixtureArgs([
        "mint",
        "--instance", "agent-lab-309-a7e2",
        "--server", "http://localhost:5401",
        "--role", "member",
        "--expires-in", "30m",
      ]),
    ).toEqual({
      command: "mint",
      instance: "agent-lab-309-a7e2",
      server: "http://localhost:5401",
      role: "member",
      expiresInMinutes: 30,
    });
    expect(() => parseFixtureArgs(["mint", "--instance", "default", "--server", "http://localhost:3001", "--role", "member", "--expires-in", "30m"])).toThrow();
    expect(() => parseFixtureArgs(["mint", "--instance", "agent-lab-309-a7e2", "--server", "http://localhost:5401", "--role", "member", "--expires-in", "61m"])).toThrow();
    expect(() => parseFixtureArgs(["mint", "--instance", "agent-lab-309-a7e2", "--server", "http://localhost:5401", "--role", "member", "--expires-in", "30m", "--output", "/tmp/nope"])).toThrow();
  });

  test("only accepts the exact local server origin and generates canonical opaque tokens", () => {
    expect(normalizedOrigin("http://localhost:5401")).toBe("http://localhost:5401");
    expect(() => normalizedOrigin("https://alpha.example.test")).toThrow();
    expect(() => normalizedOrigin("http://localhost:5401/redeem/x")).toThrow();
    expect(mintInviteToken()).toMatch(/^inv_[A-Za-z0-9_-]{32}$/);
  });

  test("writes to a fixed instance-owned path rather than caller-selected output", () => {
    const path = fixtureLocatorPath(
      "agent-lab-309-a7e2",
      "123e4567-e89b-42d3-a456-426614174000",
      { HOME: "/tmp/stack309-fixture-home" },
    );
    expect(path).toBe("/tmp/stack309-fixture-home/.nautilo-agent-lab-309-a7e2/fixtures/stack309-invites/invite-123e4567-e89b-42d3-a456-426614174000.locator");
  });
});

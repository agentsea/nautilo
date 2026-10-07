import { describe, expect, test } from "bun:test";
import { syntheticFixtureEmail } from "../../testing/synthetic-fixture-email";

describe("synthetic fixture email", () => {
  test("uses a reserved domain and a numeric fixture local part within email limits", () => {
    const email = syntheticFixtureEmail();
    expect(email).toMatch(/^fixture[0-9]+@example\.invalid$/);
    expect(email.split("@")[0]!.length).toBeLessThanOrEqual(64);
  });

  test("assigns distinct identities to separate fixtures", () => {
    expect(syntheticFixtureEmail()).not.toBe(syntheticFixtureEmail());
  });
});

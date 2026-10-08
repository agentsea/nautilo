import { randomUUID } from "node:crypto";

/** A unique, explicitly synthetic address for isolated database fixtures. */
export function syntheticFixtureEmail(): string {
  const suffix = BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString(10);
  return "fixture@example.invalid".replace("@", `${suffix}@`);
}

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("full backup authentication-cache exclusions", () => {
  test("never archives reusable session, claim, or plaintext Logto admin credentials", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/commands/save.ts"),
      "utf8",
    );
    for (const excluded of [
      "session.json",
      "cli-session.json",
      "sessions",
      "desktop-auth*.json",
      "claim-invite.txt",
      ".bootstrap/claim-invite",
      "logto-admin.txt",
      ".protected-instance",
    ]) {
      expect(source).toContain(`"--exclude=${excluded}"`);
    }
  });

  test("also strips a legacy protection marker while materializing a clone", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/commands/clone.ts"),
      "utf8",
    );
    expect(source).toContain('"--exclude=.protected-instance"');
  });
});

import { describe, expect, test } from "bun:test";
import { formatAgentDisplayName } from "../../src/components/identity/agent-display-name";

describe("formatAgentDisplayName", () => {
  test("returns plain displayName when unique within scope", () => {
    const agents = [{ displayName: "Jeannie" }, { displayName: "Nova" }];
    expect(
      formatAgentDisplayName({ displayName: "Jeannie", handle: "jeannie" }, agents),
    ).toBe("Jeannie");
  });

  test("returns Discord-style suffix when displayName collides", () => {
    const agents = [{ displayName: "Jeannie" }, { displayName: "Jeannie" }];
    expect(
      formatAgentDisplayName({ displayName: "Jeannie", handle: "jeannie_owner" }, agents),
    ).toBe("Jeannie (@jeannie_owner)");
    expect(
      formatAgentDisplayName({ displayName: "Jeannie", handle: "jeannie_guest" }, agents),
    ).toBe("Jeannie (@jeannie_guest)");
  });

  test("falls back to plain displayName on collision without handle", () => {
    const agents = [{ displayName: "Jeannie" }, { displayName: "Jeannie" }];
    expect(formatAgentDisplayName({ displayName: "Jeannie" }, agents)).toBe("Jeannie");
  });
});

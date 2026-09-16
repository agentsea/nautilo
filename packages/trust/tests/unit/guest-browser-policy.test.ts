import { describe, expect, test } from "bun:test";
import { buildGuestToolPolicy } from "../../src/personal-policy-resolver";
import { getRegisteredToolNames, getToolPolicy } from "../../src/tool-policies";

describe("D504 guest embedded-browser policy", () => {
  test("allows the complete registered browser family with ordinary impact semantics", () => {
    const guestPolicy = buildGuestToolPolicy();
    const browserTools = getRegisteredToolNames().filter((name) => name.startsWith("browser_"));

    expect(browserTools.length).toBeGreaterThan(0);
    for (const name of browserTools) {
      const registered = getToolPolicy(name);
      expect(registered.executor).toBe("relay");
      expect(registered.requiredCapability).toBe("control_browser");
      expect(guestPolicy[name]).toBe(registered.impact === "read-only" ? "read_only" : "allow");
    }
  });

  test("keeps unrelated identity-sensitive tools forbidden", () => {
    const guestPolicy = buildGuestToolPolicy();

    for (const name of [
      "search_memory",
      "manage_memory",
      "file",
      "apply_patch",
      "run_shell",
      "terminal",
      "update_config",
      "share_memory",
      "transcribe_audio",
      "execute_artifact",
    ]) {
      expect(guestPolicy[name]).toBe("forbidden");
    }
  });
});

import { describe, expect, test } from "bun:test";
import {
  CAP_INVOKE_AGENTS,
  CAP_MANAGE_UNCONTAINED_HOST_COMMANDS,
  CAP_WRITE_ARTIFACTS,
  isCapabilitySlug,
} from "../../src/capabilities";

describe("M246 community authorization capability symbols", () => {
  test("exports the canonical literal slugs", () => {
    expect(CAP_INVOKE_AGENTS).toBe("invoke_agents");
    expect(CAP_WRITE_ARTIFACTS).toBe("write_artifacts");
    expect(CAP_MANAGE_UNCONTAINED_HOST_COMMANDS).toBe("manage_uncontained_host_commands");
  });

  test("recognizes both slugs through the browser-safe union", () => {
    expect(isCapabilitySlug(CAP_INVOKE_AGENTS)).toBe(true);
    expect(isCapabilitySlug(CAP_WRITE_ARTIFACTS)).toBe(true);
    expect(isCapabilitySlug(CAP_MANAGE_UNCONTAINED_HOST_COMMANDS)).toBe(true);
    expect(isCapabilitySlug("invoke_agent")).toBe(false);
    expect(isCapabilitySlug("write_artifact")).toBe(false);
  });
});

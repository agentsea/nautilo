import { describe, expect, test } from "bun:test";
import { VideoHostAttestationRegistry, VIDEO_HOST_ATTESTATION_TTL_MS } from "../../src/apps/video-host-attestation-registry";

const binding = {
  userId: "human-1", sourceHash: "a".repeat(64), roomId: "room-1", namespaceId: "namespace-1",
  projectArtifactInternalId: "internal-1", projectArtifactId: "project-1", projectRevision: 7,
};

describe("Video host attestation registry", () => {
  test("binds a short-lived token to one exact human/project/revision and fails closed", () => {
    let now = 1_000;
    const registry = new VideoHostAttestationRegistry(() => now);
    const issued = registry.issue(binding);
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{32,128}$/u);
    expect(registry.validate(issued.token, binding)).toBe(true);
    expect(registry.validateForProject(issued.token, { ...binding, projectRevision: 8 })).toBeNull();
    now += VIDEO_HOST_ATTESTATION_TTL_MS;
    expect(registry.validate(issued.token, binding)).toBe(false);
  });

  test("only the token's authenticated human can revoke it", () => {
    const registry = new VideoHostAttestationRegistry();
    const issued = registry.issue(binding);
    expect(registry.revokeForUser(issued.token, "human-2")).toBe(false);
    expect(registry.validate(issued.token, binding)).toBe(true);
    expect(registry.revokeForUser(issued.token, binding.userId)).toBe(true);
    expect(registry.validate(issued.token, binding)).toBe(false);
  });

  test("unrelated issuance never evicts an unexpired project capability", () => {
    let now = 1000;
    const registry = new VideoHostAttestationRegistry(() => now);
    const original = registry.issue(binding);
    for (let index = 0; index < 257; index += 1) registry.issue({ ...binding, projectArtifactId: `project-${index}` });
    expect(registry.validate(original.token, binding)).toBe(true);
    now += VIDEO_HOST_ATTESTATION_TTL_MS;
    expect(registry.validate(original.token, binding)).toBe(false);
  });
});

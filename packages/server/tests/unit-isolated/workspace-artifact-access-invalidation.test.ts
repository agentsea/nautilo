import { describe, expect, mock, test } from "bun:test";

import { invalidateWorkspaceArtifactAccess } from
  "../../src/lib/workspace-artifact-access-invalidation";

describe("ordinary Artifact access invalidation", () => {
  test("emits the existing reload event from an internal object ID", async () => {
    const emit = mock(() => {});
    const resolveArtifact = mock(async () => ({
      id: "11111111-1111-4111-8111-111111111111",
      artifactId: "public-artifact-id",
      path: "notes/shared.md",
    }));

    await invalidateWorkspaceArtifactAccess(
      "11111111-1111-4111-8111-111111111111",
      { resolveArtifact, emit },
    );

    expect(resolveArtifact).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(emit).toHaveBeenCalledWith({
      type: "workspace.artifact.changed",
      id: "11111111-1111-4111-8111-111111111111",
      artifactId: "public-artifact-id",
      path: "notes/shared.md",
      reloadRequired: true,
    });
  });

  test("missing metadata or observer failure cannot reverse a committed outcome", async () => {
    const emit = mock(() => { throw new Error("observer offline"); });
    await invalidateWorkspaceArtifactAccess("missing", {
      resolveArtifact: async () => null,
      emit,
    });
    expect(emit).not.toHaveBeenCalled();

    await invalidateWorkspaceArtifactAccess("present", {
      resolveArtifact: async () => ({
        id: "present",
        artifactId: "public",
        path: "shared.md",
      }),
      emit,
    });
  });
});

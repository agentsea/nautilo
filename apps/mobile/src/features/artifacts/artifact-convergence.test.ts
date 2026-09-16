import { describe, expect, test } from "bun:test";

import {
  shouldExitAfterArtifactConvergence,
  shouldInstallArtifactConvergenceResult,
  shouldInstallBackgroundArtifactResult,
  shouldPassivelyRefreshArtifactViewerOnFocus,
  shouldRefreshFocusedArtifactList,
  viewerConvergenceAction,
} from "./artifact-convergence";

describe("artifact convergence decisions", () => {
  const changed = { type: "changed" as const, id: "row-a", artifactId: "logical-a", path: "a.md" };
  test("focused Files refreshes lifecycle and reconnect signals", () => {
    expect(shouldRefreshFocusedArtifactList(changed)).toBe(true);
    expect(shouldRefreshFocusedArtifactList({ type: "renamed", id: "row-a", oldPath: "a.md", newPath: "b.md" })).toBe(true);
    expect(shouldRefreshFocusedArtifactList({ type: "deleted", id: "row-a", artifactId: "logical-a" })).toBe(true);
    expect(shouldRefreshFocusedArtifactList({ type: "reconnected" })).toBe(true);
  });

  test("viewer reloads only its row, reconciles deletes, and suppresses local mutation races", () => {
    expect(viewerConvergenceAction(changed, "row-a", false)).toBe("reload");
    expect(viewerConvergenceAction({ type: "deleted", id: "row-a", artifactId: "logical-a" }, "row-a", false)).toBe("reconcile");
    expect(viewerConvergenceAction(changed, "row-b", false)).toBe("none");
    expect(viewerConvergenceAction(changed, "row-a", true)).toBe("none");
    expect(viewerConvergenceAction({ type: "reconnected" }, "row-a", false)).toBe("reload");
  });

  test("only canonical absence or unreadability exits a viewer", () => {
    for (const kind of ["auth_dead", "forbidden", "not_found"]) expect(shouldExitAfterArtifactConvergence(kind)).toBe(true);
    for (const kind of ["network", "server", "text", "file", "unsupported"]) expect(shouldExitAfterArtifactConvergence(kind)).toBe(false);
  });

  test("viewer focus returns refresh the same session without preserving a prior session", () => {
    expect(shouldPassivelyRefreshArtifactViewerOnFocus(undefined, "server-a\0artifact-a")).toBe(false);
    expect(shouldPassivelyRefreshArtifactViewerOnFocus("server-a\0artifact-a", "server-a\0artifact-a")).toBe(true);
    expect(shouldPassivelyRefreshArtifactViewerOnFocus("server-a\0artifact-a", "server-b\0artifact-a")).toBe(false);
    expect(shouldPassivelyRefreshArtifactViewerOnFocus("server-a\0artifact-a", "server-a\0artifact-b")).toBe(false);
  });

  test("background reload replaces only canonical/terminal results and preserves the current viewer on transient failure", () => {
    for (const kind of ["text", "file", "unsupported", "too_large", "auth_dead", "forbidden", "not_found"]) expect(shouldInstallBackgroundArtifactResult(kind)).toBe(true);
    for (const kind of ["network", "server", "cancelled", "missing_room", "not_implemented"]) expect(shouldInstallBackgroundArtifactResult(kind)).toBe(false);
  });

  test("explicit reconciliation retains the mounted viewer while loading but installs every completion", () => {
    expect(shouldInstallArtifactConvergenceResult("passive", true, "network")).toBe(false);
    expect(shouldInstallArtifactConvergenceResult("passive", true, "text")).toBe(true);
    expect(shouldInstallArtifactConvergenceResult("reconcile", true, "network")).toBe(true);
    expect(shouldInstallArtifactConvergenceResult("reconcile", true, "server")).toBe(true);
    // The default/session path is never a passive preservation policy.
    expect(shouldInstallArtifactConvergenceResult(undefined, true, "network")).toBe(true);
    expect(shouldInstallArtifactConvergenceResult("passive", false, "network")).toBe(true);
  });
});

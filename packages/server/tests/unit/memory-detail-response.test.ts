import { expect, test } from "bun:test";
import { projectOrdinaryMemoryDetail } from "../../src/routes/memory-detail-response";

test("ordinary Memory responses retain their public shape without internal input lineage", () => {
  const publicRow = { id: "memory-one", type: "preference", content: "Current Memory",
    importance: 0.5, tier: 1, createdAt: new Date(0), updatedAt: new Date(1),
    demotedAt: null, demotedFrom: null, namespaceIds: ["namespace-one"] };
  const result = projectOrdinaryMemoryDetail({ ...publicRow, contentRevision: 3,
    modelExposureDependencies: [{ kind: "source", sourceKind: "message", logicalSourceRef: "message:private-source",
      observedRevision: "2", observedContentFingerprint: "hmac-sha256:private", terminalAuthorityLeafHandle: "namespace-private" }] });
  expect(result).toEqual(publicRow);
  expect(JSON.stringify(result)).not.toContain("private-source");
  expect(result).not.toHaveProperty("contentRevision");
  expect(result).not.toHaveProperty("modelExposureDependencies");
});

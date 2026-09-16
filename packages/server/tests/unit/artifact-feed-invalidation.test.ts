import { expect, test } from "bun:test";
import { createArtifactFeedInvalidator } from "../../src/event-feed/artifact-invalidation";

test("Artifact invalidation privately refreshes historical recipients, without a new event", async () => {
  const notified: string[] = [];
  const invalidator = createArtifactFeedInvalidator({
    recipients: async id => { expect(id).toBe("internal-id"); return ["revoked-person", "current-person"]; },
    changed: userId => { notified.push(userId); if (userId === "revoked-person") throw new Error("socket"); },
  });
  await invalidator({ type: "workspace.artifact.changed", id: "internal-id", artifactId: "external", path: "not-for-feed", reloadRequired: true });
  expect(notified).toEqual(["revoked-person", "current-person"]);
  await invalidator({ type: "event_feed.changed" });
  expect(notified).toHaveLength(2);
});

test("ordinary Artifact saves do not scan feed history or send duplicate hints", async () => {
  let recipientLookups = 0;
  const notified: string[] = [];
  const invalidator = createArtifactFeedInvalidator({
    recipients: async () => { recipientLookups += 1; return ["historical-recipient"]; },
    changed: userId => { notified.push(userId); },
  });

  await invalidator({
    type: "workspace.artifact.changed",
    id: "internal-id",
    artifactId: "external-id",
    path: "document.md",
  });

  expect(recipientLookups).toBe(0);
  expect(notified).toEqual([]);
});

test("rename and deletion still invalidate historical feed presentation", async () => {
  const lookedUp: string[] = [];
  const notified: string[] = [];
  const invalidator = createArtifactFeedInvalidator({
    recipients: async id => { lookedUp.push(id); return [`recipient-${id}`]; },
    changed: userId => { notified.push(userId); },
  });

  await invalidator({
    type: "workspace.artifact.renamed",
    id: "renamed-id",
    artifactId: "external-renamed",
    oldPath: "before.md",
    newPath: "after.md",
  });
  await invalidator({
    type: "workspace.artifact.deleted",
    id: "deleted-id",
    artifactId: "external-deleted",
    namespaceIds: [],
  });

  expect(lookedUp).toEqual(["renamed-id", "deleted-id"]);
  expect(notified).toEqual(["recipient-renamed-id", "recipient-deleted-id"]);
});

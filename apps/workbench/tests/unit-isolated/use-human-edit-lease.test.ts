import { describe, expect, test } from "bun:test";
import {
  humanEditLeaseStateForEditor,
  humanEditLeaseTargetForResource,
  humanEditLeaseTransportRoute,
} from "../../src/editors/use-human-edit-lease";

describe("humanEditLeaseStateForEditor", () => {
  test("routes artifact leases to the server and local-file leases to Desktop", () => {
    expect(humanEditLeaseTransportRoute("workspace_artifact")).toBe("workspace");
    expect(humanEditLeaseTransportRoute("local_file")).toBe("desktop");
  });

  test("maps save and conflict status independently of dirty bit", () => {
    expect(humanEditLeaseStateForEditor({ status: "patching", dirty: false })).toBe("saving");
    expect(humanEditLeaseStateForEditor({ status: "conflict", dirty: false })).toBe("conflict");
  });

  test("advertises clean only for a clean idle/saved editor", () => {
    expect(humanEditLeaseStateForEditor({ status: "idle", dirty: false })).toBe("clean");
    expect(humanEditLeaseStateForEditor({ status: "saved", dirty: false })).toBe("clean");
    expect(humanEditLeaseStateForEditor({ status: "idle", dirty: true })).toBe("dirty");
    expect(humanEditLeaseStateForEditor({ status: "saved", dirty: true })).toBe("dirty");
  });

  test("retains a draft as dirty across unsaved, offline, failed, rebase, and resync states", () => {
    for (const status of ["unsaved", "offline-queued", "failed", "rebasing", "resyncing"] as const) {
      expect(humanEditLeaseStateForEditor({ status, dirty: true })).toBe("dirty");
    }
  });

  test("suppresses a stale target while the editor switches resources", () => {
    const oldTarget = {
      resourceKey: "local:/old.md",
      target: {
        kind: "local_file" as const,
        relayId: "relay-1",
        candidatePath: "/old.md",
      },
    };

    expect(humanEditLeaseTargetForResource(oldTarget, "local:/new.md")).toBeNull();
    expect(humanEditLeaseTargetForResource(oldTarget, "local:/old.md")).toEqual(oldTarget.target);
  });
});

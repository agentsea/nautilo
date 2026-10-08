import { describe, expect, test } from "bun:test";
import { dispatchReadShellOutput } from "../../electron/relay-dispatch/read-shell-output";
import { dispatchRetainedOutputArtifact, RunShellOutputArtifactStore } from "../../electron/run-shell-output-continuity";

const owner = { instanceId: "instance-fixture", userId: "human-fixture", relayId: "relay-fixture", desktopSessionId: "desktop-fixture" };

function fixture() {
  const store = new RunShellOutputArtifactStore();
  const draft = store.createDraft(owner);
  draft.append("stdout", Buffer.from("compile started\ncompile complete\n"), 33);
  draft.append("stderr", Buffer.from("warning: fixture\n"), 17);
  return { store, reference: draft.commit().reference };
}

describe("standalone retained shell output reader", () => {
  test("pages and searches existing references with the same offsets and completeness", () => {
    const { store, reference } = fixture();
    try {
      const page = { reference, offset_bytes: 4, max_bytes: 13 };
      expect(dispatchReadShellOutput({ ...page, operation: "page" }, owner, store))
        .toEqual(dispatchRetainedOutputArtifact({ output_artifact: page }, owner, store));
      const search = { operation: "search", reference, query: "compile", context_bytes: 4 };
      expect(dispatchReadShellOutput(search, owner, store))
        .toEqual(dispatchRetainedOutputArtifact({ output_artifact: search }, owner, store));
    } finally { store.clear(); }
  });

  test("a reference alone cannot read another owner or unavailable storage", () => {
    const { store, reference } = fixture();
    try {
      for (const key of Object.keys(owner) as (keyof typeof owner)[]) {
        expect(dispatchReadShellOutput({ operation: "page", reference }, { ...owner, [key]: "foreign" }, store))
          .toEqual({ ok: false, reason: "not_found" });
      }
      expect(dispatchReadShellOutput({ operation: "page", reference }, undefined, store))
        .toEqual({ ok: false, reason: "unavailable" });
      expect(dispatchReadShellOutput({ operation: "page", reference }, owner, undefined))
        .toEqual({ ok: false, reason: "unavailable" });
    } finally { store.clear(); }
  });

  test("does not accept command fields and deletes only on an explicitly requested final page", () => {
    const { store, reference } = fixture();
    try {
      expect(dispatchReadShellOutput({ operation: "page", reference, command: "echo unexpected" }, owner, store))
        .toEqual({ ok: false, reason: "invalid" });
      expect(dispatchReadShellOutput({ operation: "launch", reference }, owner, store))
        .toEqual({ ok: false, reason: "invalid" });
      const first = dispatchReadShellOutput({ operation: "page", reference, max_bytes: 4, delete_after_read: true }, owner, store);
      expect(first.ok && "deleted" in first.result && first.result.deleted).toBe(false);
      const final = dispatchReadShellOutput({ operation: "page", reference, delete_after_read: true }, owner, store);
      expect(final.ok && "deleted" in final.result && final.result.deleted).toBe(true);
      expect(dispatchReadShellOutput({ operation: "page", reference }, owner, store))
        .toEqual({ ok: false, reason: "not_found" });
    } finally { store.clear(); }
  });
});

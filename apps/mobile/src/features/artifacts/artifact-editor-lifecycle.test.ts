import { describe, expect, test } from "bun:test";

import {
  canSaveArtifactEditor,
  createArtifactEditorExitCoordinator,
  initialArtifactEditorLifecycle,
  markArtifactEditorClean,
  markArtifactEditorDirty,
  requestArtifactEditorExit,
  transitionArtifactEditorPhase,
} from "./artifact-editor-lifecycle";

describe("artifact editor lifecycle", () => {
  test("only a ready user mutation becomes dirty and requires confirmation", () => {
    expect(markArtifactEditorDirty(initialArtifactEditorLifecycle)).toBe(
      initialArtifactEditorLifecycle,
    );
    const ready = transitionArtifactEditorPhase(initialArtifactEditorLifecycle, "ready");
    const dirty = markArtifactEditorDirty(ready);
    expect(dirty).toEqual({ phase: "ready", dirty: true });
    expect(requestArtifactEditorExit(dirty)).toBe("confirm-discard");
    expect(requestArtifactEditorExit(markArtifactEditorClean(dirty))).toBe("proceed");
  });

  test("save is enabled only for dirty ready idle state with a save handler", () => {
    const dirty = markArtifactEditorDirty(
      transitionArtifactEditorPhase(initialArtifactEditorLifecycle, "ready"),
    );
    expect(canSaveArtifactEditor(dirty, "idle", true)).toBe(true);
    expect(canSaveArtifactEditor(dirty, "idle", false)).toBe(false);
    expect(canSaveArtifactEditor(dirty, "unavailable", true)).toBe(false);
    expect(canSaveArtifactEditor(dirty, "saving", true)).toBe(false);
    expect(canSaveArtifactEditor(markArtifactEditorClean(dirty), "idle", true)).toBe(false);
  });

  test("loading and error transitions clear dirty state and never prompt", () => {
    const dirty = { phase: "ready" as const, dirty: true };
    const loading = transitionArtifactEditorPhase(dirty, "loading");
    const error = transitionArtifactEditorPhase(dirty, "error");
    expect(loading).toEqual({ phase: "loading", dirty: false });
    expect(error).toEqual({ phase: "error", dirty: false });
    expect(requestArtifactEditorExit(loading)).toBe("proceed");
    expect(requestArtifactEditorExit(error)).toBe("proceed");
  });

  test("coordinates Keep editing, destructive discard, exact replay, and one bypass", () => {
    const coordinator = createArtifactEditorExitCoordinator();
    const dirty = { phase: "ready" as const, dirty: true };
    const prompts: Array<{ keepEditing: () => void; discardChanges: () => void }> = [];
    const calls: string[] = [];
    const effects = {
      present: (prompt: { keepEditing: () => void; discardChanges: () => void }) => prompts.push(prompt),
      markClean: () => calls.push("clean"),
      onDiscard: () => calls.push("discard"),
    };

    coordinator.request(dirty, () => calls.push("explicit"), effects);
    coordinator.request(dirty, () => calls.push("duplicate"), effects);
    expect(prompts).toHaveLength(1);
    prompts[0].keepEditing();
    expect(calls).toEqual([]);

    let prevented = 0;
    const action = { type: "GO_BACK", key: "exact" };
    coordinator.intercept(
      dirty,
      { preventDefault: () => { prevented += 1; }, action },
      (value) => { expect(value).toBe(action); calls.push("dispatch"); },
      effects,
    );
    expect(prevented).toBe(1);
    prompts[1].discardChanges();
    expect(calls).toEqual(["clean", "discard", "dispatch"]);

    coordinator.intercept(
      dirty,
      { preventDefault: () => { prevented += 1; }, action },
      () => calls.push("replayed-twice"),
      effects,
    );
    expect(prevented).toBe(1);
    expect(calls).toEqual(["clean", "discard", "dispatch"]);
  });
});

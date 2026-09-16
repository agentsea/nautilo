import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

import {
  initialMessageEditState,
  messageEditReducer,
} from "./message-edit-state";

describe("mobile message edit state", () => {
  test("resizes the editor and keeps actions outside scrollable conflict and draft content", () => {
    const source = readFileSync(new URL("./message-edit-sheet.tsx", import.meta.url), "utf8");
    expect(source).toContain('<KeyboardAvoidingView behavior="padding" style={styles.modalRoot}>');
    expect(source).toContain('maxHeight: "100%"');
    expect(source).toContain('body: { flexShrink: 1 }');
    expect(source).toContain('actions: { flexShrink: 0');
    expect(source).toContain('keyboardShouldPersistTaps="handled"');
    expect(source).toContain('onLayout={(event) => setAvailableHeight(event.nativeEvent.layout.height)}');
    expect(source).toContain('Math.min(styles.input.maxHeight, availableHeight / 3)');
    expect(source.indexOf('<View style={styles.actions}>')).toBeGreaterThan(source.indexOf('</ScrollView>'));
    expect(source.indexOf('accessibilityLabel="Confirm review of current message"')).toBeLessThan(source.indexOf('</ScrollView>'));
    expect(source).not.toContain('BottomSheetTextInput');
    expect(source).not.toContain('onSubmitEditing');
    expect(source).toContain('onRequestClose={close}');
    expect(source).toContain('!savingRef.current && !state.saving');
    expect(source).toContain('disabled={saveDisabled}');
  });
  test("preserves every character of a long multiline draft through save failure and conflict review", () => {
    const content = "A complete editable line.\n".repeat(400);
    const draft = `${content}Final editable line.`;
    const initial = initialMessageEditState({ id: "42", content, editRevision: 3 });
    expect(initial.draft).toBe(content);
    const saving = messageEditReducer(messageEditReducer(initial, { type: "draft", value: draft }), { type: "save-started" });
    expect(saving.draft).toBe(draft);
    const failed = messageEditReducer(saving, { type: "save-failed", error: "Retry" });
    const conflicted = messageEditReducer(failed, { type: "conflict", content, editRevision: 4, source: "save" });
    expect(conflicted.conflictCurrent?.content).toBe(content);
    expect(messageEditReducer(conflicted, { type: "conflict-reviewed" }).draft).toBe(draft);
  });

  test("starts from the canonical content and rejects a blank draft", () => {
    const initial = initialMessageEditState({ id: "42", content: "before", editRevision: 3 });
    const blank = messageEditReducer(initial, { type: "draft", value: "  \n" });
    const attempted = messageEditReducer(blank, { type: "save-started" });

    expect(attempted).toMatchObject({
      draft: "  \n",
      baseContent: "before",
      baseRevision: 3,
      saving: false,
      error: "A message can't be empty.",
    });
  });

  test("preserves a failed draft and permits an explicit retry", () => {
    const initial = initialMessageEditState({ id: "42", content: "before", editRevision: 3 });
    const drafted = messageEditReducer(initial, { type: "draft", value: "my edit" });
    const saving = messageEditReducer(drafted, { type: "save-started" });
    const failed = messageEditReducer(saving, {
      type: "save-failed",
      error: "Could not save this edit. Your draft is preserved.",
    });

    expect(saving.saving).toBe(true);
    expect(failed).toMatchObject({
      draft: "my edit",
      baseRevision: 3,
      saving: false,
      error: "Could not save this edit. Your draft is preserved.",
    });
    expect(messageEditReducer(failed, { type: "save-started" }).saving).toBe(true);
  });

  test("requires explicit review before a conflicted draft can overwrite the latest revision", () => {
    const initial = initialMessageEditState({ id: "42", content: "before", editRevision: 3 });
    const drafted = messageEditReducer(initial, { type: "draft", value: "my edit" });
    const conflicted = messageEditReducer(drafted, {
      type: "conflict",
      content: "edited elsewhere",
      editRevision: 4,
      source: "remote",
    });

    expect(conflicted).toMatchObject({
      draft: "my edit",
      baseContent: "edited elsewhere",
      baseRevision: 4,
      conflictReviewRequired: true,
      conflictCurrent: { content: "edited elsewhere", editRevision: 4 },
    });
    const reviewed = messageEditReducer(conflicted, { type: "conflict-reviewed" });
    expect(reviewed.conflictReviewRequired).toBe(false);
    expect(reviewed.draft).toBe("my edit");
    expect(reviewed.baseRevision).toBe(4);
  });
});

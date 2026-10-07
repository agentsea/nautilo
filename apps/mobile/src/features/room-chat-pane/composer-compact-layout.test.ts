import { expect, test } from "bun:test";

const composer = await Bun.file(new URL("../../components/composer.tsx", import.meta.url)).text();
const roomComposer = await Bun.file(new URL("./room-chat-composer.tsx", import.meta.url)).text();

test("composer content can shrink and scroll while message actions remain outside it", () => {
  const scrollStart = composer.indexOf("<ScrollView");
  const scrollEnd = composer.indexOf("</ScrollView>", scrollStart);
  const body = composer.slice(scrollStart, scrollEnd);
  expect(scrollStart).toBeGreaterThan(-1);
  expect(body).toContain("{contextSlot}");
  expect(body).toContain("{attachmentsSlot}");
  expect(body).toContain("<TextInput");
  expect(body).toContain("maxHeight: inputMaxHeight");
  expect(body).toContain("onFocus={revealFocusedInput}");
  expect(composer).toContain("Math.min(COMPOSER_INPUT_MAX_HEIGHT, event.nativeEvent.layout.height)");
  expect(composer).toContain("scrollResponderScrollNativeHandleToKeyboard");
  expect(body).toContain("{activeCommand ?");
  expect(body).toContain("{activeMention ?");
  expect(body).toContain('keyboardShouldPersistTaps="handled"');
  expect(composer.indexOf("{recording ? (", scrollEnd)).toBeGreaterThan(scrollEnd);
  expect(composer.indexOf("<View style={styles.actionRow}>")).toBeGreaterThan(scrollEnd);
  expect(composer).toContain("body: { flexGrow: 0, flexShrink: 1, minHeight: 0 }");
  expect(composer).toContain("maxHeight: '100%'");
});

test("room status, image recovery and history guidance use the shared scroll body", () => {
  const context = roomComposer.slice(roomComposer.indexOf("contextSlot={<>"), roomComposer.indexOf("        </>}"));
  expect(context).toContain("<AutoApproveBar");
  expect(context).toContain("c.imageAttachmentError");
  expect(context).toContain("c.imageHistoryNotice");
  expect(context).toContain("Remove images");
  expect(context).toContain("Choose a model that supports images");
});


test("the transcript yields space to the composer on compact screens", async () => {
  const pane = await Bun.file(new URL("../../components/room-chat-pane.tsx", import.meta.url)).text();
  expect(pane).toContain('transcriptWrap: { flex: 1, flexShrink: 1, minHeight: 0, overflow: "hidden" }');
});

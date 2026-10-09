import { expect, test } from "bun:test";

test("keeps the image attachment action reachable for capability guidance", async () => {
  const source = await Bun.file(new URL("./room-chat-composer.tsx", import.meta.url)).text();
  const attachSlot = source.split("attachSlot={")[1]?.split("</Pressable>")[0] ?? "";
  expect(attachSlot).toContain("c.handleAttach()");
  expect(attachSlot).not.toContain("disabled=");
  expect(attachSlot).not.toContain("accessibilityState={{ disabled:");
});

test("rejects unsupported images before opening the native picker", async () => {
  const source = await Bun.file(new URL("../../hooks/use-room-chat-controller.ts", import.meta.url)).text();
  const handler = source.split("const handleAttach = useCallback(async () => {")[1]?.split("const picked = await pickImages")[0] ?? "";
  expect(handler).toContain("if (imageInputUnsupported) { setAttachPermissionNote(IMAGE_ATTACHMENT_SELECTION_HINT); return; }");
});

import { expect, test } from "bun:test";
import { isCompanionAction, isCompanionAvatar, isCompanionBinding, isCompanionSnapshot, shouldShowCompanion } from "../../electron/companion-contract";

test("visibility follows the Workbench owner, not application-wide focus", () => {
  const away = { enabled: true, ownerCurrent: true, mainFocused: false, mainDialogFocused: false };
  expect(shouldShowCompanion(away)).toBe(true); // another app, Space, or the companion itself
  expect(shouldShowCompanion({ ...away, mainFocused: true })).toBe(false);
  expect(shouldShowCompanion({ ...away, mainDialogFocused: true })).toBe(false);
  expect(shouldShowCompanion({ ...away, ownerCurrent: false })).toBe(false);
  expect(shouldShowCompanion({ ...away, enabled: false })).toBe(false);
});
test("surface contract accepts fixed controls and rejects malformed commands", () => {
  expect(isCompanionAction({ type: "send", text: "Hi" })).toBe(true);
  expect(isCompanionAction({ type: "send", text: 4 })).toBe(false);
  expect(isCompanionAction({ type: "view", value: "chat" })).toBe(true);
  expect(isCompanionAction({ type: "view", value: "arbitrary" })).toBe(false);
  expect(isCompanionAction({ type: "shell", command: "anything" })).toBe(false);
  expect(isCompanionBinding({ roomId: "a", botActorId: "b", agentId: "c", name: "Genie" })).toBe(true);
  expect(isCompanionBinding({ roomId: "", botActorId: "b", agentId: "c", name: "Genie" })).toBe(false);
  expect(isCompanionSnapshot({})).toBe(false);
});

test("avatar transport admits only inline PNG and fixed bubble appearance choices", () => {
  expect(isCompanionAvatar("data:image/png;base64,YXZhdGFy")).toBe(true);
  expect(isCompanionAvatar("https://example.com/avatar?token=secret")).toBe(false);
  expect(isCompanionAvatar("blob:private-parent-context")).toBe(false);
  expect(isCompanionAvatar("data:text/html;base64,YXZhdGFy")).toBe(false);
  expect(isCompanionAction({ type: "bubble-appearance", value: "avatar" })).toBe(true);
  expect(isCompanionAction({ type: "bubble-appearance", value: "orb" })).toBe(true);
  expect(isCompanionAction({ type: "bubble-appearance", value: "remote" })).toBe(false);
});

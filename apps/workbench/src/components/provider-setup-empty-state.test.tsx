import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoomMemberDto } from "@nautilo/types";
import {
  ProviderSetupEmptyState,
  needsPersonalChatReadiness,
  personalChatNeedsSetup,
  shouldShowProviderSetupEmptyState,
} from "./provider-setup-empty-state";

const ownGenie: RoomMemberDto = {
  actorId: "agent-actor",
  kind: "agent",
  displayName: "Genie",
  agentId: "agent",
  roomRole: "member",
};
const human: RoomMemberDto = {
  actorId: "human-actor",
  kind: "user",
  displayName: "Human",
  userId: "human",
  roomRole: "admin",
};

test("personal-only chat needs its own readiness even when the server has keys", () => {
  expect(needsPersonalChatReadiness(true, false, true)).toBeTrue();
  expect(needsPersonalChatReadiness(true, true, false)).toBeTrue();
  expect(needsPersonalChatReadiness(true, true, true)).toBeFalse();
  expect(needsPersonalChatReadiness(false, false, false)).toBeFalse();
  expect(personalChatNeedsSetup("ready")).toBeFalse();
  expect(personalChatNeedsSetup("checking")).toBeTrue();
  expect(personalChatNeedsSetup("disabled")).toBeTrue();
});

test("a Human-only Room is not blocked by missing server keys", () => {
  const status = { setupState: "server-needs-keys", providers: { hasLlm: false } } as Parameters<typeof shouldShowProviderSetupEmptyState>[0];
  expect(shouldShowProviderSetupEmptyState(status, [human])).toBeFalse();
  expect(shouldShowProviderSetupEmptyState(status, [human, ownGenie])).toBeTrue();
});

test("personal setup explains disabled policy without linking to Server Admin", () => {
  const disabled = renderToStaticMarkup(
    <ProviderSetupEmptyState canManageProviders={false} personalState="disabled" />,
  );
  expect(disabled).toContain("disabled on this server");
  expect(disabled).not.toContain("/admin");
  const missing = renderToStaticMarkup(
    <ProviderSetupEmptyState canManageProviders={false} personalState="missing-key" />,
  );
  expect(missing).toContain("/settings#personal-provider-keys");
  expect(missing).not.toContain("/admin");
  const missingModel = renderToStaticMarkup(
    <ProviderSetupEmptyState canManageProviders={false} personalState="missing-model" />,
  );
  expect(missingModel).toContain("/settings#model");
});

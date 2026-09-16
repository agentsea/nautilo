import { expect, test } from "bun:test";
import { shouldAutoResolveAsk } from "@nautilo/types";

const controllerSource = await Bun.file(
  new URL("../hooks/use-room-chat-controller.ts", import.meta.url),
).text();

test("ordinary sends carry the shared session Auto-Approve flag while ask-user resumes stay exact", () => {
  expect(controllerSource).toContain('import { useAutoApprove } from "@/providers/auto-approve"');
  expect(controllerSource).toContain("const { enabled: autoApproveEnabled } = useAutoApprove()");
  expect(controllerSource).toContain("const messageBody = resume ? { ...resume } : {");

  const ordinarySendStart = controllerSource.indexOf("const messageBody = resume ? { ...resume } : {");
  const ordinarySendEnd = controllerSource.indexOf("const boundMessageBody", ordinarySendStart);
  const ordinarySend = controllerSource.slice(ordinarySendStart, ordinarySendEnd);
  expect(ordinarySend).toContain("autoApprove: canInvokeAgents && autoApproveEnabled");
  expect(ordinarySend).toContain("only for a Human with current Agent-invocation authority");
  expect(ordinarySend).not.toContain("resume ? { ...resume, autoApprove");
});

test("the shared eligibility predicate stays fail-closed for disabled, egress, and exact-review asks", () => {
  expect(shouldAutoResolveAsk({ enabled: true, hasNetworkContext: false })).toBe(true);
  expect(shouldAutoResolveAsk({ enabled: false, hasNetworkContext: false })).toBe(false);
  expect(shouldAutoResolveAsk({ enabled: true, hasNetworkContext: true })).toBe(false);
  expect(shouldAutoResolveAsk({
    enabled: true,
    hasNetworkContext: false,
    requiresExplicitReview: true,
  })).toBe(false);
  expect(shouldAutoResolveAsk({
    enabled: true,
    hasNetworkContext: false,
    requiresExplicitReview: true,
    structuredSshHostTrust: "unknown",
  })).toBe(false);
});

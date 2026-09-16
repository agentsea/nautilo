import { expect, test } from "bun:test";

const inviteScreen = await Bun.file(
  new URL("../../app/(onboarding)/invite.tsx", import.meta.url),
).text();
const sharedScreen = await Bun.file(
  new URL("../../components/screen.tsx", import.meta.url),
).text();

test("invite forms use the shared keyboard-aware scroll surface", () => {
  // The profile stage has three text fields plus its action. A plain centered
  // View makes the lower fields unreachable on compact screens or above a
  // software keyboard; this must stay on the shared form surface.
  expect(inviteScreen).toContain('import { Screen } from "@/components/screen"');
  expect(inviteScreen).toContain("<Screen contentStyle={styles.content}>");
  expect(inviteScreen).toContain("</Screen>");
  expect(inviteScreen).not.toContain("<View style={styles.container}>");
  expect(sharedScreen).toContain("KeyboardAwareScrollView");
  expect(sharedScreen).toContain('keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}');
  expect(sharedScreen).toContain('keyboardShouldPersistTaps="handled"');
});

test("a warm native route race recovers only coordinator-owned token-free correlation", () => {
  expect(inviteScreen).toContain("const activeRoute = getInviteIntake().activeRoute()");
  expect(inviteScreen).toContain("if (activeRoute) router.replace(activeRoute)");
  expect(inviteScreen).not.toContain("Linking.addEventListener");
  expect(inviteScreen).not.toContain("useDeepLink");
});

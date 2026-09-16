import { expect, test } from "bun:test";

const barSource = await Bun.file(new URL("./auto-approve-bar.tsx", import.meta.url)).text();
const confirmationSource = await Bun.file(
  new URL("./settings/settings-confirmation.tsx", import.meta.url),
).text();
const providerSource = await Bun.file(
  new URL("../providers/auto-approve.tsx", import.meta.url),
).text();

test("Auto-Approve uses the shared React Native confirmation instead of the Web no-op Alert", () => {
  expect(barSource).toContain('from "@/components/settings/settings-confirmation"');
  expect(barSource).toContain("<SettingsConfirmation");
  expect(barSource).not.toContain("Alert.alert");
  expect(barSource).toContain("setEnableConfirmationVisible(true)");
  expect(barSource).toContain("setEnabled(true)");
  expect(confirmationSource).toContain("<Modal");
  expect(confirmationSource).toContain("useSafeAreaInsets");
  expect(confirmationSource).toContain("flexWrap: \"wrap\"");
});

test("Auto-Approve remains root-owned, session-only state", () => {
  expect(providerSource).toContain("useState(false)");
  expect(providerSource).not.toContain("AsyncStorage");
  expect(providerSource).not.toContain("localStorage");
});

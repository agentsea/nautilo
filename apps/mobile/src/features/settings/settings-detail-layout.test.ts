/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { createSettingsLanding } from "./settings-shell";
import { platformCapabilities as nativePlatform } from "@/platform/capabilities.native";

const settingsRouteFiles = [
  "profile.tsx",
  "human-profile.tsx",
  "voice.tsx",
  "voice-picker.tsx",
  "models.tsx",
  "access.tsx",
  "security.tsx",
  "approvals.tsx",
  "appearance.tsx",
  "notifications.tsx",
  "about.tsx",
] as const;

const routeDirectory = new URL("../../app/(drawer)/(tabs)/settings/", import.meta.url);

describe("Settings detail layout contract", () => {
  test("keeps every detail destination on the shared scroll scaffold", async () => {
    for (const filename of settingsRouteFiles) {
      const source = await Bun.file(new URL(filename, routeDirectory)).text();
      expect(source, filename).toContain("<Screen");
      expect(source, filename).not.toMatch(/<Screen[^>]*scroll=\{false\}/);
    }
  });

  test("keeps the agreement detail on its shared scroll scaffold", async () => {
    const route = await Bun.file(new URL("user-agreement.tsx", routeDirectory)).text();
    const shared = await Bun.file(new URL("../user-agreement/agreement-screen.tsx", import.meta.url)).text();
    expect(route).toContain("UserAgreementSettingsScreen");
    expect(route).toContain('platform === "native"');
    expect(shared).toContain("<Screen edgeTop={false}");
  });

  test("keeps the long Soul editor out of the Agent profile scroll surface", async () => {
    const source = await Bun.file(new URL("profile.tsx", routeDirectory)).text();
    expect(source).toContain("<SoulEditorSheet");
    expect(source).toContain('numberOfLines={4}');
    expect(source).not.toMatch(/<TextInput[^>]*multiline[^>]*Soul instructions/);
  });

  test("keeps Human and Agent menu labels distinct and the smoke selectors aligned", async () => {
    const rows = createSettingsLanding({
      authState: "signed-in",
      viewerState: "verified",
      viewerName: "Alex",
      themePreference: "system",
      platformCapabilities: nativePlatform,
    }).sections.flatMap((group) => group.rows);
    expect(rows.find((row) => row.id === "profile")?.label).toBe("Agent profile");
    expect(rows.find((row) => row.id === "human-profile")?.label).toBe("Your profile");

    const flow = await Bun.file(new URL("../../../.maestro/d465-settings-smoke.yaml", import.meta.url)).text();
    expect(flow).toContain("tapOn: Agent profile");
    expect(flow).toContain('assertVisible: "Your profile.*"');
    expect(flow).toContain("text: Save Agent profile");

    const scrollFlow = await Bun.file(new URL("../../../.maestro/d465-settings-scroll.yaml", import.meta.url)).text();
    expect(scrollFlow).toContain("openLink: nautilo://settings/profile");
    expect(scrollFlow).toContain("text: Save Agent profile");
    expect(scrollFlow).toContain("openLink: nautilo://settings/human-profile");
  });

  test("does not render fake top-bar actions and wires shipped overflow destinations", async () => {
    const components = new URL("../../components/", import.meta.url);
    const appBar = await Bun.file(new URL("app-bar.tsx", components)).text();
    const overflow = await Bun.file(new URL("overflow-sheet.tsx", components)).text();
    expect(appBar).not.toContain("onSearchPress ??");
    expect(appBar).toContain("{onSearchPress ? <Pressable");
    expect(overflow).toContain('openSettings("/settings/approvals")');
    expect(overflow).toContain('openSettings("/settings/human-profile")');
    expect(overflow).not.toMatch(/label="(Approvals|Account)"[^>]*hint="Coming soon"/);
  });

  test("route cleanup invalidates scope instead of permanently disposing retained settings controllers", async () => {
    for (const filename of ["profile.tsx", "models.tsx", "model-picker.tsx", "security.tsx"] as const) {
      const source = await Bun.file(new URL(filename, routeDirectory)).text();
      expect(source, filename).not.toMatch(/useEffect\(\(\) => \(\) => .*\.dispose\(\)/);
      expect(source, filename).toContain("setScope(null)");
    }
  });

  test("unavailable model rows are visibly and semantically non-interactive", async () => {
    const picker = await Bun.file(new URL("model-picker.tsx", routeDirectory)).text();
    const sharedPicker = await Bun.file(new URL("../../components/settings/settings-picker-screen.tsx", import.meta.url)).text();
    expect(picker).toContain("disabled: !row.selectable");
    expect(sharedPicker).toContain("disabled={disabled}");
    expect(sharedPicker).toContain("option.disabled === true || interactionDisabled");
  });

  test("model radio rows save immediately without a below-fold confirmation action", async () => {
    const picker = await Bun.file(new URL("model-picker.tsx", routeDirectory)).text();
    const summary = await Bun.file(new URL("models.tsx", routeDirectory)).text();
    expect(picker).toContain("controller.apply(id)");
    expect(picker).toContain("pendingId={pendingId}");
    expect(picker).toContain('if (router.canGoBack()) router.back()');
    expect(picker).not.toContain("Use as default");
    expect(picker).not.toContain("controller.select(");
    expect(picker).not.toContain("controller.save(");
    expect(summary).toContain("useFocusEffect(useCallback(() => {");
    expect(summary).toContain("if (scope) void controller.load();");
  });

  test("successful picker mutations return to their canonical summaries", async () => {
    const modelPicker = await Bun.file(new URL("model-picker.tsx", routeDirectory)).text();
    const voicePicker = await Bun.file(new URL("voice-picker.tsx", routeDirectory)).text();
    expect(modelPicker).toContain('router.replace("/(drawer)/(tabs)/settings/models")');
    expect(voicePicker).toContain('router.replace("/(drawer)/(tabs)/settings/voice")');
  });

  test("optional PIN and password edits have explicit secret-clearing cancel paths", async () => {
    const route = await Bun.file(new URL("security.tsx", routeDirectory)).text();
    const pinForm = await Bun.file(new URL("pin-form.tsx", import.meta.url)).text();
    const passwordForm = await Bun.file(new URL("password-form.tsx", import.meta.url)).text();

    expect(route).toContain("onCancel={cancelPinEdit}");
    expect(route).toContain("onCancel={cancelPasswordEdit}");
    expect(route).toContain('setSecretFormEpoch((epoch) => epoch + 1)');
    expect(pinForm).toContain("onPress={onCancel}");
    expect(passwordForm).toContain("!required ? <Pressable");
    expect(passwordForm).toContain("onPress={onCancel}");
  });

  test("notification settings leads with one outcome and hides healthy delivery machinery", async () => {
    const route = await Bun.file(new URL("notifications.tsx", routeDirectory)).text();
    const presentation = await Bun.file(new URL("notification-settings-presentation.ts", import.meta.url)).text();

    // One journey is presented to a Human even though permission, binding, and
    // reconciliation remain separate authorities underneath.
    expect(route).toContain('accessibilityRole="summary"');
    expect(route).toContain("deriveNotificationJourney({");
    expect(route).toContain('title="Notify me about"');
    expect(route).not.toContain('<SettingsSection title="This device">');
    expect(route).not.toContain('title={`This server · ${activeServer?.displayName ?? "Nautilo"}`}');
    expect(route).not.toContain("Delivery to this phone");
    expect(route).not.toContain("Default Room level");

    // Scope remains a server-owned API enum, but every visible choice says
    // what it does rather than leaking none/direct/all as product language.
    expect(route).toContain('accessibilityRole="radio"');
    expect(presentation).toContain('label: "Directed messages"');
    expect(presentation).toContain('description: "Messages addressed to you."');
    expect(presentation).toContain('label: "All messages"');
    expect(presentation).toContain('description: "Every eligible message in your chats."');
    expect(presentation).toContain('label: "Nothing"');
    expect(presentation).toContain('description: "Do not send alerts from this server."');
    expect(presentation).toContain('value: "direct"');
    expect(presentation).toContain('value: "all"');
    expect(presentation).toContain('value: "none"');

    // Privacy is an explicit fixed guarantee, healthy bindings stay hidden,
    // and a multi-server qualifier appears only when it tells the Human
    // something useful.
    expect(route).toContain("Message text never appears on your lock screen. Important-message alerts show the sender and conversation, matching Desktop.");
    expect(route).toContain("const multiServer = servers.length > 1;");
    expect(route).toContain("{multiServer ? (");
    expect(route).toContain("These choices apply to:");
    expect(route).toContain('<SettingsSection title="More options">');
    expect(route).toContain("App badge");

    // Product Settings describe real delivery behavior; provider qualification
    // remains an automated/operator concern rather than a Human-facing test.
    expect(route).not.toContain('accessibilityLabel="Send test notification"');
    expect(presentation).toContain("if (input.permission === \"denied\")");
    expect(presentation).toContain("title: \"Notifications are off\"");
    expect(presentation).toContain("title: \"Connecting this phone\"");
    expect(presentation).toContain('title: input.permission === "provisional" ? "Notifications are on quietly" : "Notifications are on"');
    expect(presentation).toContain('needsAttention("Notifications need attention"');
    expect(presentation).toContain("The permission branches deliberately precede every setup branch");
    expect(route).toContain("<Screen edgeTop={false}");

    // Fast local reconciliation must not flash a spinner or resize the status
    // card. Progress is disclosed only after a short delay and occupies a
    // permanently reserved accessory slot when it is needed.
    expect(route).toContain("const PROGRESS_DISCLOSURE_DELAY_MS = 300;");
    expect(route).toContain("const showJourneyProgress = useDelayedProgress(");
    expect(route).toContain("styles.progressSlot");
    expect(route).not.toContain("setReconcileSummary(null)");
    expect(route).not.toContain('accessibilityLabel="Loading notification settings"');

    const flow = await Bun.file(new URL("../../../.maestro/d468-notifications-smoke.yaml", import.meta.url)).text();
    expect(flow).toContain("assertNotVisible: THIS DEVICE");
    expect(flow).toContain("assertNotVisible: Delivery to this phone");
    expect(flow).toContain("assertNotVisible: Default Room level");
    expect(flow).toContain("scrollUntilVisible:");
    expect(flow).toContain("tapOn: Go back");
  });
});

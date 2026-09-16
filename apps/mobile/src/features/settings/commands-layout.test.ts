import { describe, expect, test } from "bun:test";

const commandsLayoutSource = await Bun.file(
  new URL("../../app/(drawer)/(tabs)/settings/commands/_layout.tsx", import.meta.url),
).text();
const newCommandSource = await Bun.file(
  new URL("../../app/(drawer)/(tabs)/settings/commands/new.tsx", import.meta.url),
).text();
const commandDetailSource = await Bun.file(
  new URL("../../app/(drawer)/(tabs)/settings/commands/[name].tsx", import.meta.url),
).text();
const skillsLayoutSource = await Bun.file(
  new URL("../../app/(drawer)/(tabs)/settings/skills/_layout.tsx", import.meta.url),
).text();
const settingsLayoutSource = await Bun.file(
  new URL("../../app/(drawer)/(tabs)/settings/_layout.tsx", import.meta.url),
).text();

describe("mobile Commands navigation scaffold", () => {
  test("keeps every Commands route below the shared safe-area app bar", () => {
    expect(commandsLayoutSource).toContain("<AppBar");
    expect(commandsLayoutSource).toContain('<Stack.Screen name="index" options={{ title: "Commands" }} />');
    expect(commandsLayoutSource).toContain('<Stack.Screen name="new" options={{ title: "New Command" }} />');
    expect(commandsLayoutSource).toContain('<Stack.Screen name="[name]" options={{ title: "Command" }} />');
    expect(commandsLayoutSource).not.toContain("headerShown: false");
    expect(newCommandSource).not.toContain('<AppBar title="New Command"');
  });

  test("returns every restored nested Settings root to the Settings landing", () => {
    for (const source of [settingsLayoutSource, commandsLayoutSource, skillsLayoutSource]) {
      expect(source).toContain("router.canGoBack()");
      expect(source).toContain('router.replace("/(drawer)/(tabs)/settings")');
      expect(source).toContain("onPress={returnToSettings}");
    }
  });

  test("keeps long Command instructions in bounded internal editors", () => {
    expect(newCommandSource).toContain('body: { height: 220');
    expect(commandDetailSource).toContain('body: { height: 250');
    for (const source of [newCommandSource, commandDetailSource]) {
      expect(source).toContain("scrollEnabled={multiline}");
      expect(source).not.toContain("body: { minHeight:");
    }
  });

  test("keeps the primary Command mutation reachable above the software keyboard", () => {
    for (const source of [newCommandSource, commandDetailSource]) {
      expect(source).toContain('import { KeyboardStickyView } from "react-native-keyboard-controller"');
      expect(source).toContain("<KeyboardStickyView style={styles.actionBar}>");
      expect(source).toMatch(/<Screen[^>]*keyboardBottomOffset=/);
    }
    expect(newCommandSource).toMatch(/<KeyboardStickyView style=\{styles\.actionBar\}>[\s\S]*?accessibilityLabel="Create Command"[\s\S]*?<\/KeyboardStickyView>/);
    expect(commandDetailSource).toMatch(/<KeyboardStickyView style=\{styles\.actionBar\}>[\s\S]*?accessibilityLabel="Save Command"[\s\S]*?<\/KeyboardStickyView>/);
  });
});

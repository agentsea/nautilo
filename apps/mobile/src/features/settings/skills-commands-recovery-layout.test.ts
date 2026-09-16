import { describe, expect, test } from "bun:test";

const skillsListSource = await Bun.file(
  new URL("../../app/(drawer)/(tabs)/settings/skills/index.tsx", import.meta.url),
).text();
const skillDetailSource = await Bun.file(
  new URL("../../app/(drawer)/(tabs)/settings/skills/[name].tsx", import.meta.url),
).text();
const commandsListSource = await Bun.file(
  new URL("../../app/(drawer)/(tabs)/settings/commands/index.tsx", import.meta.url),
).text();
const commandDetailSource = await Bun.file(
  new URL("../../app/(drawer)/(tabs)/settings/commands/[name].tsx", import.meta.url),
).text();

describe("mobile Skills and Commands first-load recovery", () => {
  test("gives each failed catalogue load a visible accessible retry through its canonical controller", () => {
    for (const [source, label, retry] of [
      [skillsListSource, "Try again loading Skills", "controller.retry()"],
      [commandsListSource, "Try again loading Commands", "controller.retry()"],
    ]) {
      expect(source).toContain("state.loadError && !state.data");
      expect(source).toContain(`accessibilityLabel="${label}"`);
      expect(source).toContain(retry);
      expect(source).toContain("disabled={retryDisabled}");
      expect(source).toContain("state.loading || state.mutating");
    }
  });

  test("retries the exact failed detail identity without routing away", () => {
    for (const [source, label] of [
      [skillDetailSource, "Try again loading this Skill"],
      [commandDetailSource, "Try again loading this Command"],
    ]) {
      expect(source).toContain("state.loadError && !");
      expect(source).toContain(`accessibilityLabel="${label}"`);
      expect(source).toContain("controller.retry(name)");
      expect(source).toContain("disabled={retryDisabled}");
      expect(source).toContain("const retryDisabled = !scope || busy");
    }
  });
});

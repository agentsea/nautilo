import { describe, test, expect } from "bun:test";
import {
  genieCustomizationPath,
  genieSoftPromptPrimaryLabel,
  genieSoftPromptStorageKey,
  isGenieSoftPromptDismissed,
  launchGenieCustomizationFromSoftPrompt,
  markGenieSoftPromptDismissed,
  readWorkbenchTheme,
  shouldOfferGenieSoftPrompt,
} from "../../src/lib/genie-soft-prompt";

describe("genie soft prompt helpers (D112)", () => {
  test("shouldOfferGenieSoftPrompt is true when ready, not customized, signed in, not dismissed", () => {
    const ok = shouldOfferGenieSoftPrompt({
      setupState: "ready",
      genieCustomized: false,
      sessionUserId: "user-1",
      getItem: () => null,
    });
    expect(ok).toBe(true);
  });

  test("shouldOfferGenieSoftPrompt respects dismissed flag", () => {
    const key = genieSoftPromptStorageKey("user-1");
    const ok = shouldOfferGenieSoftPrompt({
      setupState: "ready",
      genieCustomized: false,
      sessionUserId: "user-1",
      getItem: (k) => (k === key ? "1" : null),
    });
    expect(ok).toBe(false);
  });

  test("mark + is dismissed round-trip via in-memory map", () => {
    const store = new Map<string, string>();
    markGenieSoftPromptDismissed("u9", (k, v) => {
      store.set(k, v);
    });
    expect(
      isGenieSoftPromptDismissed("u9", (k) => store.get(k) ?? null),
    ).toBe(true);
  });
});

describe("genie soft prompt D162 launch helpers", () => {
  test("genieSoftPromptPrimaryLabel uses Customize Genie in both runtimes", () => {
    expect(genieSoftPromptPrimaryLabel(true)).toBe("Customize Genie");
    expect(genieSoftPromptPrimaryLabel(false)).toBe("Customize Genie");
  });

  test("genieCustomizationPath keeps targeted personality and avatar entrypoints", () => {
    expect(genieCustomizationPath()).toBe("/customize-genie");
    expect(genieCustomizationPath("personality")).toBe(
      "/customize-genie?startAt=personality",
    );
    expect(genieCustomizationPath("avatar")).toBe(
      "/customize-genie?startAt=avatar",
    );
  });

  test("readWorkbenchTheme reads nautilo-theme", () => {
    expect(readWorkbenchTheme(() => "dark")).toBe("dark");
    expect(readWorkbenchTheme(() => "light")).toBe("light");
    expect(readWorkbenchTheme(() => "system")).toBe(null);
  });

  test("launchGenieCustomizationFromSoftPrompt opens desktop wizard with token and theme", async () => {
    let opened: { token: string | null; theme: "light" | "dark" | null } | null =
      null;
    let navigated = false;
    await launchGenieCustomizationFromSoftPrompt({
      hasDesktopBridge: true,
      onboardingOpen: async (token, theme) => {
        opened = { token, theme };
      },
      getAccessToken: async () => "tok-abc",
      getTheme: () => "dark",
      navigateToCustomization: () => {
        navigated = true;
      },
    });
    expect(opened).toEqual({ token: "tok-abc", theme: "dark" });
    expect(navigated).toBe(false);
  });

  test("launchGenieCustomizationFromSoftPrompt opens the guided browser route", async () => {
    let navigated = false;
    await launchGenieCustomizationFromSoftPrompt({
      hasDesktopBridge: false,
      getAccessToken: async () => "unused",
      getTheme: () => null,
      navigateToCustomization: () => {
        navigated = true;
      },
    });
    expect(navigated).toBe(true);
  });
});

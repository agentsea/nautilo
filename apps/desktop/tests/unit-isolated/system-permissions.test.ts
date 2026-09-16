import { describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({
  app: { isPackaged: false },
  shell: { openExternal: async () => undefined },
  systemPreferences: {
    isTrustedAccessibilityClient: (_prompt) => false,
    getMediaAccessStatus: () => "unknown",
    askForMediaAccess: async () => false,
  },
}));

const {
  createSystemPermissionsRegistry,
  isSystemPermissionId,
} = await import("../../electron/system-permissions");

function adapter(overrides: Partial<Parameters<typeof createSystemPermissionsRegistry>[0]> = {}) {
  return {
    platform: "darwin" as NodeJS.Platform,
    isTrustedAccessibilityClient: () => false,
    getScreenRecordingStatus: () => "not-determined",
    getMicrophoneStatus: () => "not-determined" as const,
    askForMicrophoneAccess: async () => "granted" as const,
    requestScreenRecordingPermission: async () => ({ ok: true as const, granted: false }),
    openMicrophoneSettings: async () => undefined,
    openSystemSettings: async () => undefined,
    ...overrides,
  };
}

describe("desktop-wide system permission registry", () => {
  test("keeps the fixed IDs and Human setup order exact", () => {
    const registry = createSystemPermissionsRegistry(adapter());
    const snapshot = registry.status();

    expect(snapshot).toMatchObject({ version: 1, platform: "macos" });
    expect(snapshot.permissions.map((permission) => permission.id)).toEqual([
      "accessibility",
      "screen-recording",
      "microphone",
    ]);
    expect(snapshot.permissions.map((permission) => permission.requiredFor)).toEqual([
      ["computer-use"],
      ["computer-use"],
      ["voice"],
    ]);
    expect(snapshot.permissions.map((permission) => permission.restart)).toEqual([
      "not-required",
      "not-required",
      "not-required",
    ]);
  });

  test("maps Accessibility, screen recording, and microphone truthfully", () => {
    const registry = createSystemPermissionsRegistry(adapter({
      isTrustedAccessibilityClient: () => true,
      getScreenRecordingStatus: () => "denied",
      getMicrophoneStatus: () => "restricted",
    }));

    expect(registry.status().permissions.map((permission) => [
      permission.state,
      permission.action,
    ])).toEqual([
      ["granted", null],
      ["denied", "request"],
      ["restricted", null],
    ]);
  });

  test("requests Screen Recording as the Nautilo host, then uses the fixed Settings fallback", async () => {
    const opened: string[] = [];
    const accessibilityPrompts: boolean[] = [];
    let screenRequests = 0;
    let microphone: "not-determined" | "granted" = "not-determined";
    let asked = 0;
    const registry = createSystemPermissionsRegistry(adapter({
      isTrustedAccessibilityClient: (prompt) => {
        accessibilityPrompts.push(prompt);
        return false;
      },
      getScreenRecordingStatus: () => "denied",
      requestScreenRecordingPermission: async () => {
        screenRequests += 1;
        return { ok: true as const, granted: false };
      },
      getMicrophoneStatus: () => microphone,
      askForMicrophoneAccess: async () => {
        asked += 1;
        microphone = "granted";
        return microphone;
      },
      openSystemSettings: async (url) => {
        opened.push(url);
      },
    }));

    await registry.resolve("accessibility");
    await registry.resolve("screen-recording");
    expect(registry.status().permissions[1]).toMatchObject({ action: "open-settings" });
    await registry.resolve("screen-recording");
    const afterMicrophonePrompt = await registry.resolve("microphone");

    expect(opened).toEqual([
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    ]);
    expect(accessibilityPrompts).toContain(true);
    expect(screenRequests).toBe(1);
    expect(asked).toBe(1);
    expect(afterMicrophonePrompt.permissions[2]).toMatchObject({
      state: "granted",
      action: null,
      restart: "not-required",
    });
  });

  test("clears the Screen Recording Settings fallback as soon as the host grant is observed", async () => {
    let screen: "denied" | "granted" = "denied";
    const registry = createSystemPermissionsRegistry(adapter({
      getScreenRecordingStatus: () => screen,
      requestScreenRecordingPermission: async () => ({ ok: true, granted: false }),
    }));
    await registry.resolve("screen-recording");
    expect(registry.status().permissions[1].action).toBe("open-settings");
    screen = "granted";
    expect(registry.status().permissions[1]).toMatchObject({ state: "granted", action: null });
    screen = "denied";
    expect(registry.status().permissions[1].action).toBe("request");
  });

  test("still attempts the host-owned Screen Recording request for an unknown macOS result", () => {
    const registry = createSystemPermissionsRegistry(adapter({
      getScreenRecordingStatus: () => "future-electron-value",
    }));
    expect(registry.status().permissions[1]).toMatchObject({
      state: "unknown",
      action: "request",
    });
  });

  test("reports non-macOS capability truthfully without pretending Chromium granted it", async () => {
    let opened = false;
    const registry = createSystemPermissionsRegistry(adapter({
      platform: "linux",
      openSystemSettings: async () => {
        opened = true;
      },
    }));

    expect(registry.status()).toMatchObject({
      platform: "other",
      permissions: [
        { state: "unsupported", action: null },
        { state: "unsupported", action: null },
        { state: "unsupported", action: null },
      ],
    });
    await registry.resolve("accessibility");
    expect(opened).toBe(false);
  });

  test("latches a relaunch after sending a denied microphone to Settings", async () => {
    let microphone: "denied" | "granted" = "denied";
    const registry = createSystemPermissionsRegistry(adapter({
      getMicrophoneStatus: () => microphone,
    }));

    expect(registry.status().permissions[2].restart).toBe("not-required");
    const stillDenied = await registry.resolve("microphone");
    expect(stillDenied.permissions[2]).toMatchObject({
      state: "denied",
      restart: "required",
    });
    microphone = "granted";
    expect(registry.status().permissions[2]).toMatchObject({
      state: "granted",
      restart: "required",
    });
  });

  test("does not invent a restart after opening Settings for an unknown microphone state", async () => {
    const registry = createSystemPermissionsRegistry(adapter({
      getMicrophoneStatus: () => "unknown",
    }));

    expect((await registry.resolve("microphone")).permissions[2]).toMatchObject({
      state: "unknown",
      restart: "not-required",
    });
  });

  test("does not latch a restart when opening denied microphone Settings fails", async () => {
    const registry = createSystemPermissionsRegistry(adapter({
      getMicrophoneStatus: () => "denied",
      openMicrophoneSettings: async () => {
        throw new Error("settings unavailable");
      },
    }));

    await expect(registry.resolve("microphone")).rejects.toThrow(
      "settings unavailable",
    );
    expect(registry.status().permissions[2].restart).toBe("not-required");
  });

  test("suppresses a prior microphone restart latch when status becomes restricted", async () => {
    let microphone: "denied" | "restricted" = "denied";
    const registry = createSystemPermissionsRegistry(adapter({
      getMicrophoneStatus: () => microphone,
    }));

    await registry.resolve("microphone");
    microphone = "restricted";
    expect(registry.status().permissions[2]).toMatchObject({
      state: "restricted",
      restart: "not-required",
    });
  });

  test("suppresses a prior microphone restart latch when status detection fails", async () => {
    let getterFails = false;
    const registry = createSystemPermissionsRegistry(adapter({
      getMicrophoneStatus: () => {
        if (getterFails) throw new Error("TCC unavailable");
        return "denied";
      },
    }));

    await registry.resolve("microphone");
    getterFails = true;
    expect(registry.status().permissions[2]).toMatchObject({
      state: "unknown",
      restart: "not-required",
    });
  });

  test("accepts exactly the three renderer IDs", () => {
    expect(isSystemPermissionId("accessibility")).toBe(true);
    expect(isSystemPermissionId("screen-recording")).toBe(true);
    expect(isSystemPermissionId("microphone")).toBe(true);
    expect(isSystemPermissionId("screen")).toBe(false);
    expect(isSystemPermissionId({ id: "accessibility" })).toBe(false);
    expect(isSystemPermissionId(null)).toBe(false);
  });
});

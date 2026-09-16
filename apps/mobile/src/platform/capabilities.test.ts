import { describe, expect, test } from "bun:test";

import {
  admitPlatformRoute,
  initiatingClientSurfaceForMobile,
  MOBILE_CAPABILITY_KEYS,
  type MobilePlatformCapabilities,
} from "./capability-contract";
import { platformCapabilities as fallbackCapabilities } from "./capabilities";
import { platformCapabilities as nativeCapabilities } from "./capabilities.native";
import { platformCapabilities as webCapabilities } from "./capabilities.web";

describe("D515 platform capability authority", () => {
  test("every projection is exhaustive and deeply immutable", () => {
    for (const projection of [fallbackCapabilities, nativeCapabilities, webCapabilities]) {
      expect(Object.keys(projection.decisions).sort()).toEqual([...MOBILE_CAPABILITY_KEYS].sort());
      expect(Object.isFrozen(projection)).toBe(true);
      expect(Object.isFrozen(projection.decisions)).toBe(true);
      for (const decision of Object.values(projection.decisions)) expect(Object.isFrozen(decision)).toBe(true);
    }
  });

  test("unknown runtimes fail closed for every capability", () => {
    expect(fallbackCapabilities.platform).toBe("unknown");
    for (const decision of Object.values(fallbackCapabilities.decisions)) {
      expect(decision.status).toBe("unavailable");
    }
    expect(initiatingClientSurfaceForMobile(fallbackCapabilities)).toBe("unknown");
  });

  test("native preserves accepted authority while Web never claims it", () => {
    expect(initiatingClientSurfaceForMobile(nativeCapabilities)).toBe("mobile.native");
    expect(initiatingClientSurfaceForMobile(webCapabilities)).toBe("mobile.web");
    for (const key of MOBILE_CAPABILITY_KEYS) {
      expect(nativeCapabilities.decisions[key].status).toBe("supported");
    }
    for (const key of [
      "notifications",
      "badges",
      "chatAttachments",
      "photoSelection",
      "voice",
      "nativeShareImport",
      "protectedFilesystem",
      "installationIdentity",
      "controllerAuthority",
      "hostAuthority",
    ] as const) {
      expect(webCapabilities.decisions[key].status).toBe("unavailable");
    }
  });

  test("forged mutable state cannot enable native-only route admission", () => {
    expect(() => {
      (webCapabilities.decisions as Record<string, unknown>).controllerAuthority = { status: "supported" };
    }).toThrow();
    expect(admitPlatformRoute(webCapabilities, "/computers")).toMatchObject({
      allowed: false,
      requiredCapability: "controllerAuthority",
    });
    expect(admitPlatformRoute(nativeCapabilities, "/computers")).toEqual({
      allowed: true,
      requiredCapability: "controllerAuthority",
    });
  });

  test("unknown routes remain reusable while known native-only families are gated", () => {
    expect(admitPlatformRoute(webCapabilities, "/chat/room-1")).toEqual({
      allowed: true,
      requiredCapability: null,
    });
    for (const path of [
      "/share",
      "/scan-qr",
      "/scan-computer-qr",
      "/computers/host-1",
      "/files/computer/host-1/home",
      "/settings/notifications",
      "/settings/voice",
      "/settings/agent-photos",
    ]) {
      expect(admitPlatformRoute(webCapabilities, path).allowed).toBe(false);
    }
  });

  test("route admission reads the canonical projection, not arbitrary client fields", () => {
    const forged = {
      ...webCapabilities,
      controllerAuthority: true,
      capabilities: { controllerAuthority: true },
    } as MobilePlatformCapabilities & Record<string, unknown>;
    expect(admitPlatformRoute(forged, "/computers").allowed).toBe(false);
  });
});

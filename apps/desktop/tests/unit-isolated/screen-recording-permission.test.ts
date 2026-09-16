import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCREEN_RECORDING_PERMISSION_HELPER,
  SCREEN_RECORDING_PERMISSION_REQUEST_ARGUMENT,
  requestScreenRecordingPermission,
  resolveScreenRecordingPermissionHelper,
} from "../../electron/screen-recording-permission.ts";
import { screenRecordingPermissionBuildPlan } from "../../scripts/build-screen-recording-permission.ts";

class FakeHelper extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = null;
}

describe("D516 host-owned Screen Recording request helper", () => {
  test("resolves only the exact packaged or source-owned helper, never PATH", () => {
    const exists = (path: string) => path.endsWith(SCREEN_RECORDING_PERMISSION_HELPER);
    expect(resolveScreenRecordingPermissionHelper({
      platform: "darwin", isPackaged: true, resourcesPath: "/Applications/Nautilo.app/Contents/Resources",
      devVendorRoot: "/repo/apps/desktop/vendor", exists,
    })).toBe("/Applications/Nautilo.app/Contents/Resources/tools-permissions/nautilo-screen-recording-permission");
    expect(resolveScreenRecordingPermissionHelper({
      platform: "darwin", isPackaged: false, resourcesPath: null,
      devVendorRoot: "/repo/apps/desktop/vendor", exists,
    })).toBe("/repo/apps/desktop/vendor/screen-recording-permission/nautilo-screen-recording-permission");
    expect(resolveScreenRecordingPermissionHelper({
      platform: "darwin", isPackaged: true, resourcesPath: "relative",
      devVendorRoot: "/repo/apps/desktop/vendor", exists,
    })).toBeNull();
    expect(resolveScreenRecordingPermissionHelper({
      platform: "linux", isPackaged: false, resourcesPath: null,
      devVendorRoot: "/repo/apps/desktop/vendor", exists,
    })).toBeNull();
  });

  test("accepts only the exact JSON boolean from the fixed request command", async () => {
    const helper = new FakeHelper();
    const request = requestScreenRecordingPermission("/fixed/helper", {
      spawn: (file, args, options) => {
        expect(file).toBe("/fixed/helper");
        expect(args).toEqual([SCREEN_RECORDING_PERMISSION_REQUEST_ARGUMENT]);
        expect(options).toEqual({ shell: false, stdio: ["ignore", "pipe", "ignore"] });
        queueMicrotask(() => {
          helper.stdout.emit("data", Buffer.from('{"screenRecording":false}\n'));
          helper.emit("close", 0);
        });
        return helper;
      },
    });
    await expect(request).resolves.toEqual({ ok: true, granted: false });
  });

  test("fails closed for malformed, oversized, unavailable, or nonzero-helper responses", async () => {
    await expect(requestScreenRecordingPermission(null)).resolves.toEqual({ ok: false, code: "unavailable" });
    for (const response of ["{}", '{"screenRecording":true,"extra":true}', "not-json", "x".repeat(129)]) {
      const helper = new FakeHelper();
      const request = requestScreenRecordingPermission("/fixed/helper", {
        spawn: () => {
          queueMicrotask(() => {
            helper.stdout.emit("data", Buffer.from(response));
            helper.emit("close", 0);
          });
          return helper;
        },
      });
      await expect(request).resolves.toEqual({ ok: false, code: "invalid_response" });
    }
  });

  test("build plan compiles checked-in CoreGraphics source into one universal vendor binary", () => {
    const desktopRoot = join(import.meta.dir, "../..");
    const plan = screenRecordingPermissionBuildPlan(desktopRoot);
    expect(plan.source).toBe(join(desktopRoot, "native/screen-recording-permission/main.m"));
    expect(plan.universalOutput).toBe(join(desktopRoot, "vendor/screen-recording-permission/nautilo-screen-recording-permission"));
    const source = readFileSync(plan.source, "utf8");
    expect(source).toContain("CGRequestScreenCaptureAccess()");
    expect(source).toContain('strcmp(argv[1], "--request")');
    expect(source).not.toContain("osascript");
    expect(source).not.toContain("desktopCapturer");
  });
});

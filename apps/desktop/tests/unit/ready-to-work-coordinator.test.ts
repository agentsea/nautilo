import { describe, expect, test } from "bun:test";
import {
  createReadyToWorkDesiredState,
  hasReadyToWorkExactBinding,
  type ReadyToWorkBinding,
} from "../../electron/ready-to-work-contract";
import {
  ReadyToWorkCoordinator,
  ReadyToWorkOperationQueue,
  commitReadyComputerUseEnable,
  commitReadyOwnerEnable,
  readyToWorkBoundedValue,
  readyToWorkComputerUseFailureReason,
  readyToWorkWorkstationFailureReason,
} from "../../electron/ready-to-work-coordinator";

const binding: ReadyToWorkBinding = {
  humanId: "human-17",
  authority: {
    scope: "https://alpha.example.test",
    revision: "revision-17",
    connectionAttemptId: "attempt-17",
    serverFingerprint: "fingerprint-17",
  },
};
const ready = (target: "voice_settings" | "auto_approve_settings" | "workstation_settings" |
  "computer_use_settings" | "coding_connection_settings") =>
  ({ state: "ready" as const, reason: null, repairTarget: target });

describe("Ready-to-work coordinator", () => {
  test("bounds a hung owner/network promise so the lane can admit later work", async () => {
    const never = new Promise<string>(() => undefined);
    expect(await readyToWorkBoundedValue(never, 5, "timed-out")).toBe("timed-out");
  });

  test("canceled Codex enable cannot persist true after Off", async () => {
    const calls: string[] = [];
    let current = true;
    let releaseEnable!: () => void;
    const enable = new Promise<void>((resolve) => { releaseEnable = resolve; });
    const finishing = (async () => {
      await enable;
      return await commitReadyOwnerEnable({
        isCurrent: () => current,
        persistEnabled: () => { calls.push("persist:true"); },
        disable: async () => { calls.push("disable"); },
      });
    })();
    current = false;
    calls.push("persist:false");
    releaseEnable();
    expect(await finishing).toBeFalse();
    expect(calls).toEqual(["persist:false", "disable"]);
  });

  test("a post-mint Computer Use provider failure canonically revokes the new receipt", async () => {
    let rejectProvider!: (error: Error) => void;
    const provider = new Promise<boolean>((_resolve, reject) => { rejectProvider = reject; });
    const calls: string[] = ["minted"];
    const committed = commitReadyComputerUseEnable({
      providerReady: async () => await provider,
      disable: async () => { calls.push("disabled"); },
    });
    rejectProvider(new Error("provider changed after mint"));
    expect(await committed).toBe(false);
    expect(calls).toEqual(["minted", "disabled"]);

    let cleanupError: unknown = null;
    try {
      await commitReadyComputerUseEnable({
        providerReady: () => false,
        disable: async () => { throw new Error("revoke failed"); },
      });
    } catch (error) {
      cleanupError = error;
    }
    expect(cleanupError).toBeInstanceOf(Error);
    expect((cleanupError as Error).message).toBe("revoke failed");
  });

  test("serializes overlapping Ready operations in admission order", async () => {
    const queue = new ReadyToWorkOperationQueue();
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = queue.run(async () => {
      calls.push("first:start");
      await firstGate;
      calls.push("first:end");
      return "first";
    });
    const second = queue.run(async () => {
      calls.push("second:start");
      return "second";
    });
    await Promise.resolve();
    expect(calls).toEqual(["first:start"]);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual(["first", "second"]);
    expect(calls).toEqual(["first:start", "first:end", "second:start"]);
  });

  test("maps exact Workstation and Computer Use repair causes", () => {
    expect(readyToWorkWorkstationFailureReason("capability_missing"))
      .toBe("workstation_capability_missing");
    expect(readyToWorkWorkstationFailureReason("relay_binding_unavailable"))
      .toBe("workstation_relay_unavailable");
    expect(readyToWorkWorkstationFailureReason("stale_revision"))
      .toBe("workstation_profile_update_needed");
    expect(readyToWorkComputerUseFailureReason({
      accessibilityGranted: false,
      screenRecordingGranted: true,
      state: "enabled",
      providerReady: true,
    })).toBe("computer_use_accessibility_required");
    expect(readyToWorkComputerUseFailureReason({
      accessibilityGranted: true,
      screenRecordingGranted: false,
      state: "enabled",
      providerReady: true,
    })).toBe("computer_use_screen_recording_required");
    expect(readyToWorkComputerUseFailureReason({
      accessibilityGranted: true,
      screenRecordingGranted: true,
      state: "enabled",
      providerReady: false,
    })).toBe("computer_use_provider_unavailable");
    expect(readyToWorkComputerUseFailureReason({
      accessibilityGranted: true,
      screenRecordingGranted: true,
      state: "not-enabled",
      providerReady: false,
    })).toBe("computer_use_provider_unavailable");
    expect(readyToWorkComputerUseFailureReason({
      accessibilityGranted: true,
      screenRecordingGranted: true,
      state: "not-enabled",
      providerReady: true,
    })).toBe("computer_use_setup_required");
  });

  test("projects renderer owner drift without invoking restore", () => {
    let restores = 0;
    const coordinator = new ReadyToWorkCoordinator({
      restoreRendererOwners: async () => {
        restores += 1;
        return { voice: ready("voice_settings"), autoApprove: ready("auto_approve_settings") };
      },
      restoreWorkstation: async () => ready("workstation_settings"),
      observeComputerUse: async () => ready("computer_use_settings"),
      restoreCodingConnection: async () => ready("coding_connection_settings"),
      disableRendererOwners: async () => undefined,
      disableWorkstation: async () => undefined,
      disableComputerUse: async () => undefined,
      disableCodingConnection: async () => undefined,
    });
    const desired = createReadyToWorkDesiredState(binding, {
      voice: true, auto_approve: true, workstation: false, computer_use: false, coding_connection: false,
    });
    const status = coordinator.observe(desired, {
      voice: ready("voice_settings"),
      auto_approve: {
        state: "needs_attention",
        reason: "owner_rejected",
        repairTarget: "auto_approve_settings",
      },
    });
    expect(restores).toBe(0);
    expect(status.components.find((component) => component.id === "auto_approve"))
      .toMatchObject({ state: "needs_attention", reason: "owner_rejected" });
  });

  test("runs owners once in fixed order and preserves one exact partial failure", async () => {
    const calls: string[] = [];
    const coordinator = new ReadyToWorkCoordinator({
      restoreRendererOwners: async () => {
        calls.push("renderer");
        return { voice: ready("voice_settings"), autoApprove: ready("auto_approve_settings") };
      },
      restoreWorkstation: async () => { calls.push("workstation"); return ready("workstation_settings"); },
      observeComputerUse: async () => {
        calls.push("computer_use");
        return { state: "needs_attention", reason: "computer_use_setup_required", repairTarget: "computer_use_settings" };
      },
      restoreCodingConnection: async () => { calls.push("coding"); return ready("coding_connection_settings"); },
      disableRendererOwners: async () => undefined,
      disableWorkstation: async () => undefined,
      disableComputerUse: async () => undefined,
      disableCodingConnection: async () => undefined,
    });
    const desired = createReadyToWorkDesiredState(binding, {
      voice: true, auto_approve: true, workstation: true, computer_use: true, coding_connection: true,
    });
    const first = await coordinator.reconcile({ desired, trigger: "startup", isCurrent: () => true });
    expect(calls).toEqual(["renderer", "workstation", "computer_use", "coding"]);
    expect(first.components.find((component) => component.id === "computer_use")).toMatchObject({
      state: "needs_attention", reason: "computer_use_setup_required",
    });
    await coordinator.reconcile({ desired, trigger: "startup", isCurrent: () => true });
    expect(calls).toHaveLength(4);
    await coordinator.reconcile({ desired, trigger: "relay_reconnect", isCurrent: () => true });
    expect(calls).toHaveLength(8);
    await coordinator.reconcile({ desired, trigger: "explicit_restore", isCurrent: () => true });
    expect(calls).toHaveLength(12);
  });

  test("uses authority-reducing disable order", async () => {
    const calls: string[] = [];
    const coordinator = new ReadyToWorkCoordinator({
      restoreRendererOwners: async () => ({ voice: ready("voice_settings"), autoApprove: ready("auto_approve_settings") }),
      restoreWorkstation: async () => ready("workstation_settings"),
      observeComputerUse: async () => ready("computer_use_settings"),
      restoreCodingConnection: async () => ready("coding_connection_settings"),
      disableCodingConnection: async () => { calls.push("coding"); },
      disableComputerUse: async () => { calls.push("computer_use"); },
      disableWorkstation: async () => { calls.push("workstation"); },
      disableRendererOwners: async () => { calls.push("renderer"); },
    });
    const desired = createReadyToWorkDesiredState(binding, {
      voice: true, auto_approve: true, workstation: true, computer_use: true, coding_connection: true,
    });
    await coordinator.disable(desired);
    expect(calls).toEqual(["coding", "computer_use", "workstation", "renderer"]);
    expect(coordinator.status().mode).toBe("standard");
  });

  test("projects Standard immediately while delayed Off cleanup fences a rapid re-enroll", async () => {
    const calls: string[] = [];
    let releaseCleanup!: () => void;
    const delayedCleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const coordinator = new ReadyToWorkCoordinator({
      restoreRendererOwners: async () => ({ voice: ready("voice_settings"), autoApprove: ready("auto_approve_settings") }),
      restoreWorkstation: async () => ready("workstation_settings"),
      observeComputerUse: async () => ready("computer_use_settings"),
      restoreCodingConnection: async () => ready("coding_connection_settings"),
      disableCodingConnection: async () => { calls.push("off:start"); await delayedCleanup; },
      disableComputerUse: async () => undefined,
      disableWorkstation: async () => undefined,
      disableRendererOwners: async () => undefined,
    });
    const desired = createReadyToWorkDesiredState(binding, {
      voice: false, auto_approve: false, workstation: false, computer_use: false, coding_connection: true,
    });
    coordinator.observe(desired, { coding_connection: ready("coding_connection_settings") });
    const cleanup = coordinator.disable(desired);
    expect(coordinator.status().mode).toBe("standard");
    const queue = new ReadyToWorkOperationQueue();
    const reenroll = queue.run(async () => {
      await cleanup;
      calls.push("enroll");
    });
    await Promise.resolve();
    expect(calls).toEqual(["off:start"]);
    releaseCleanup();
    await reenroll;
    expect(calls).toEqual(["off:start", "enroll"]);
  });

  test("keeps the old desired record but rolls back and stops later owners when active binding drifts", async () => {
    const calls: string[] = [];
    let currentBinding: ReadyToWorkBinding = { ...binding, humanId: "human-18" };
    const desired = createReadyToWorkDesiredState(binding, {
      voice: true, auto_approve: false, workstation: true, computer_use: false, coding_connection: false,
    });
    const coordinator = new ReadyToWorkCoordinator({
      restoreRendererOwners: async () => {
        calls.push("renderer");
        currentBinding = {
          ...binding,
          authority: { ...binding.authority, revision: "revision-18" },
        };
        return { voice: ready("voice_settings"), autoApprove: ready("auto_approve_settings") };
      },
      restoreWorkstation: async () => { calls.push("workstation"); return ready("workstation_settings"); },
      observeComputerUse: async () => ready("computer_use_settings"),
      restoreCodingConnection: async () => ready("coding_connection_settings"),
      disableRendererOwners: async () => { calls.push("disable_renderer"); },
      disableWorkstation: async () => { calls.push("disable_workstation"); },
      disableComputerUse: async () => undefined,
      disableCodingConnection: async () => undefined,
    });
    const exactCurrent = async () => hasReadyToWorkExactBinding(desired, currentBinding);
    const stale = await coordinator.reconcile({ desired, trigger: "startup", isCurrent: exactCurrent });
    expect(calls).toEqual([]);
    expect(stale.components.filter((component) => component.state === "needs_attention")
      .every((component) => component.reason === "authority_changed")).toBeTrue();

    currentBinding = binding;
    const drifted = await coordinator.reconcile({
      desired,
      trigger: "explicit_restore",
      isCurrent: exactCurrent,
    });
    expect(calls).toEqual(["renderer", "disable_renderer"]);
    expect(drifted.components.find((component) => component.id === "voice")?.reason)
      .toBe("authority_changed");
  });

  test("rolls back and stops later owners when same-binding desired intent is deleted or changed", async () => {
    const original = createReadyToWorkDesiredState(binding, {
      voice: true, auto_approve: false, workstation: true, computer_use: false, coding_connection: false,
    });
    for (const mutation of ["delete", "change"] as const) {
      const calls: string[] = [];
      let persisted: typeof original | null = original;
      const coordinator = new ReadyToWorkCoordinator({
        restoreRendererOwners: async () => {
          calls.push("renderer");
          persisted = mutation === "delete"
            ? null
            : createReadyToWorkDesiredState(binding, {
                ...original.components,
                workstation: false,
              });
          return { voice: ready("voice_settings"), autoApprove: ready("auto_approve_settings") };
        },
        restoreWorkstation: async () => { calls.push("workstation"); return ready("workstation_settings"); },
        observeComputerUse: async () => ready("computer_use_settings"),
        restoreCodingConnection: async () => ready("coding_connection_settings"),
        disableRendererOwners: async () => { calls.push("disable_renderer"); },
        disableWorkstation: async () => { calls.push("disable_workstation"); },
        disableComputerUse: async () => undefined,
        disableCodingConnection: async () => undefined,
      });
      const isCurrent = async () => persisted !== null &&
        persisted.components.voice === original.components.voice &&
        persisted.components.auto_approve === original.components.auto_approve &&
        persisted.components.workstation === original.components.workstation &&
        persisted.components.computer_use === original.components.computer_use &&
        persisted.components.coding_connection === original.components.coding_connection;
      const status = await coordinator.reconcile({
        desired: original,
        trigger: "explicit_restore",
        isCurrent,
      });
      expect(calls).toEqual(["renderer", "disable_renderer"]);
      expect(status.components.find((component) => component.id === "voice")?.reason)
        .toBe("authority_changed");
    }
  });
});

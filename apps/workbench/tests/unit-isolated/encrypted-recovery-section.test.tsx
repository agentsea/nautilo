import "../bun-dom-preload";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { getCryptoAdmissionSnapshot, registerCryptoAdmissionAccessOwner, setCryptoAdmissionAccessState } from "../../src/lib/crypto-admission-access";

import type {
  WorkbenchEncryptionDeviceRoster,
  WorkbenchEncryptionRecoveryReadinessPort,
} from
  "../../src/lib/encryption-recovery-readiness";

function health(
  fingerprint = "A".repeat(43),
): Pick<
  WorkbenchEncryptionDeviceRoster["devices"][number],
  "publicFingerprintBase64url" | "membershipEvidence"
    | "admissionEvidence" | "domainKeyCoverage" | "deliveryEvidence"
> {
  return {
    publicFingerprintBase64url: fingerprint,
    membershipEvidence: {
      lineageGeneration: 1,
      epoch: 2,
      securityRevision: 3,
      acknowledgedSequence: 4,
      headDigestBase64url: "H".repeat(43),
    },
    admissionEvidence: {
      lastProvedAt: Date.UTC(2026, 8, 1, 10),
      expiresAt: Date.UTC(2026, 8, 1, 11),
    },
    domainKeyCoverage: { acknowledged: 4, required: 5 },
    deliveryEvidence: {
      acknowledgedSequence: 7,
      highWatermark: 8,
      blocked: null,
    },
  };
}

let verified = true;
let stale = false;
let copyShouldSucceed = true;
let copyShouldReject = false;
let copiedText: string | undefined;
mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({
    viewer: { isVerified: verified, staleWhoami: stale },
  }),
}));

mock.module("../../src/lib/api", () => ({
  apiClient: {
    getMessageBackfillProgress: () => Promise.resolve({
      status: "disabled" as const,
      snapshotAt: 0,
      snapshotComplete: true,
      caughtUp: true,
      lastSweepAt: null,
      activeLease: false,
      counts: {eligible: 0, alreadyAuthenticated: 0,
        independentlyParityVerified: 0, claimedRepairing: 0,
        repairedAndVerified: 0, unsupported: 0, failed: 0},
      waiting: {authorizedDevice: 0, authority: 0},
    }),
    encryptionCoverage: {
      getPersonal: () => Promise.resolve({
        dtoVersion: 1,
        policy: "plaintext_only",
        computedAt: null,
        families: [],
      }),
    },
    admin: {
      encryptionTransition: {
        getPolicy: () => Promise.resolve({
          responseVersion: 1,
          policy: {
            mode: "shadow_encryption",
            shadowBehavior: "fallback",
            revision: 1,
            updatedAt: "2026-09-01T00:00:00.000Z",
          },
          canManage: false,
          coveragePreview: {
            protected: "0",
            unsupported: "0",
            unexercised: "0",
          },
        }),
      },
    },
  },
}));

mock.module("../../src/lib/copy-to-clipboard", () => ({
  copyTextToClipboard: (text: string) => {
    copiedText = text;
    if (copyShouldReject) return Promise.reject(new Error("clipboard denied"));
    return Promise.resolve(copyShouldSucceed);
  },
}));

const { EncryptedRecoverySection } = await import(
  "../../src/pages/settings/sections/encrypted-recovery-section"
);

afterEach(() => {
  cleanup();
  verified = true;
  stale = false;
  copyShouldSucceed = true;
  copyShouldReject = false;
  copiedText = undefined;
  localStorage.clear();
  sessionStorage.clear();
});

describe("EncryptedRecoverySection", () => {
  test("successful setup requests admission once without treating local keys as server proof", async () => {
    const reconcile = mock(() => undefined);
    const unregister = registerCryptoAdmissionAccessOwner(reconcile);
    setCryptoAdmissionAccessState({ status: "blocked", identity: "qa:device", policy: null });
    try {
      const port: WorkbenchEncryptionRecoveryReadinessPort = {
        inspect: async () => ({ status: "setup_pending" }),
        setup: async () => ({ status: "active" }),
      };
      const view = render(<EncryptedRecoverySection readinessPort={port} showPersonalCoverage={false} />);
      fireEvent.click(await view.findByRole("button", { name: "Continue setup" }));
      await waitFor(() => expect(reconcile).toHaveBeenCalledWith("device_ready"));
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(getCryptoAdmissionSnapshot().status).toBe("blocked");
    } finally {
      cleanup();
      unregister();
    }
  });

  test("suppresses personal coverage in the pre-admission recovery surface", async () => {
    const port: WorkbenchEncryptionRecoveryReadinessPort = {
      inspect: () => Promise.resolve({ status: "setup_required" }),
      setup: () => Promise.reject(new Error("must not setup")),
    };
    const view = render(
      <EncryptedRecoverySection
        readinessPort={port}
        showPersonalCoverage={false}
      />,
    );
    await waitFor(() => expect(
      view.getByRole("button", { name: "Set up recovery kit" }),
    ).toBeTruthy());
    expect(view.queryByText("Your encryption coverage")).toBeNull();
  });

  test("copies, acknowledges, and shows the phrase only once without persisting it", async () => {
    const mnemonic = `${Array<string>(23).fill("abandon").join(" ")} art`;
    let confirmed = false;
    const port: WorkbenchEncryptionRecoveryReadinessPort = {
      inspect: () => Promise.resolve({ status: "setup_required" }),
      async setup(present) {
        const result = await present({
          documentHeader: "Nautilo Offline Recovery Kit v1",
          revealMnemonic: () => mnemonic,
        });
        if (result.status !== "confirmed") throw new Error("cancelled");
        confirmed = true;
        return { status: "active" };
      },
    };
    const view = render(<EncryptedRecoverySection readinessPort={port} />);
    const user = userEvent.setup();
    const setupButton = view.getByRole("button", {
      name: "Set up recovery kit",
    }) as HTMLButtonElement;
    await waitFor(() => expect(setupButton.disabled).toBe(false));
    fireEvent.click(setupButton);
    await waitFor(() => expect(
      view.getByTestId("encrypted-recovery-mnemonic").textContent,
    ).toBe(mnemonic));
    const confirm = view.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    const acknowledgement = view.getByRole("checkbox", {
      name: "I saved this recovery phrase somewhere safe",
    }) as HTMLInputElement;
    expect(confirm.disabled).toBe(true);
    await user.click(view.getByRole("button", { name: "Copy phrase" }));
    await waitFor(() => expect(copiedText).toBe(mnemonic));
    expect(acknowledgement.checked).toBe(false);
    expect(confirm.disabled).toBe(true);
    expect(view.getByText("Copied to clipboard.")).toBeTruthy();
    await user.click(acknowledgement);
    expect(confirm.disabled).toBe(false);
    await user.click(acknowledgement);
    expect(confirm.disabled).toBe(true);
    await user.click(acknowledgement);
    fireEvent.click(confirm);
    await waitFor(() => expect(
      view.getByText(/offline recovery phrase was acknowledged/),
    ).toBeTruthy());
    expect(confirmed).toBe(true);
    expect(view.queryByText(mnemonic)).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  test("keeps manual acknowledgement usable after clipboard failure", async () => {
    copyShouldReject = true;
    const mnemonic = `${Array<string>(23).fill("abandon").join(" ")} art`;
    const port: WorkbenchEncryptionRecoveryReadinessPort = {
      inspect: () => Promise.resolve({ status: "setup_required" }),
      async setup(present) {
        const result = await present({
          documentHeader: "Nautilo Recovery Kit v1",
          revealMnemonic: () => mnemonic,
        });
        return result.status === "confirmed"
          ? { status: "active" }
          : { status: "setup_required" };
      },
    };
    const view = render(<EncryptedRecoverySection readinessPort={port} />);
    const user = userEvent.setup();
    await waitFor(() => expect(
      view.getByRole("button", { name: "Set up recovery kit" }),
    ).toBeTruthy());
    await user.click(view.getByRole("button", { name: "Set up recovery kit" }));
    await user.click(await view.findByRole("button", { name: "Copy phrase" }));
    const failure = await view.findByRole("alert");
    expect(failure.textContent).toBe(
      "Copy failed. Select the phrase and copy it manually.",
    );
    expect(failure.textContent).not.toContain(mnemonic);
    const acknowledgement = view.getByRole("checkbox", {
      name: "I saved this recovery phrase somewhere safe",
    });
    await user.click(acknowledgement);
    expect((view.getByRole("button", { name: "Continue" }) as HTMLButtonElement)
      .disabled).toBe(false);
    await user.click(view.getByRole("button", { name: "Cancel" }));
  });

  test("continues sealed pending setup without asking for a new phrase", async () => {
    let presentations = 0;
    const port: WorkbenchEncryptionRecoveryReadinessPort = {
      inspect: () => Promise.resolve({ status: "setup_pending" }),
      setup: () => {
        presentations += 1;
        return Promise.resolve({ status: "active" });
      },
    };
    const view = render(<EncryptedRecoverySection readinessPort={port} />);
    await waitFor(() => expect(
      view.getByRole("button", { name: "Continue setup" }),
    ).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Continue setup" }));
    await waitFor(() => expect(
      view.getByText(/offline recovery phrase was acknowledged/),
    ).toBeTruthy());
    expect(presentations).toBe(1);
    expect(view.queryByTestId("encrypted-recovery-mnemonic")).toBeNull();
  });

  test("does not describe initial Human Domain custody as complete Room encryption", async () => {
    const port: WorkbenchEncryptionRecoveryReadinessPort = {
      inspect: () => Promise.resolve({
        status: "active",
        encryptionSetup: "human_domain_active",
      }),
      setup: () => Promise.reject(new Error("must not setup")),
    };
    const view = render(<EncryptedRecoverySection readinessPort={port} />);
    await waitFor(() => expect(
      view.getByText(/Private Rooms can be prepared separately/),
    ).toBeTruthy());
    expect(view.getByText(/shared Rooms may still require encrypted key delivery/))
      .toBeTruthy();
    expect(view.queryByText(/fully encrypted/i)).toBeNull();
  });

  test("explains that existing Room keys load opportunistically", async () => {
    const port: WorkbenchEncryptionRecoveryReadinessPort = {
      inspect: () => Promise.resolve({
        status: "active",
        encryptionSetup: "v2_personal_authority_ready",
      }),
      setup: () => Promise.reject(new Error("must not setup")),
    };
    const view = render(<EncryptedRecoverySection readinessPort={port} />);
    await waitFor(() => expect(
      view.getByText(/Encryption keys for other existing Rooms are loaded only when this device needs them/),
    ).toBeTruthy());
    expect(view.getByText(/plaintext Shadow fallback/)).toBeTruthy();
  });

  test("starts additional-device enrollment from a target device", async () => {
    let continuations = 0;
    const port: WorkbenchEncryptionRecoveryReadinessPort = {
      inspect: () => Promise.resolve({
        status: "additional_device_required",
        enrollmentStatus: "required",
      }),
      continueAdditionalDevice: () => {
        continuations += 1;
        return Promise.resolve({
          status: "additional_device_required",
          enrollmentStatus: "waiting_for_approval",
          operationId: "device-add-2",
          verificationCode: "ABCDEF-012345-6789AB",
        });
      },
      setup: () => Promise.reject(new Error("must not setup")),
    };
    const view = render(<EncryptedRecoverySection readinessPort={port} />);
    await waitFor(() => expect(
      view.getByText(/Connect this device through an already enrolled/),
    ).toBeTruthy());
    expect(view.getByText("Step 1 of 4")).toBeTruthy();
    fireEvent.click(view.getByRole("button", {
      name: "Request device connection",
    }));
    await waitFor(() => expect(view.getByText("ABCDEF-012345-6789AB"))
      .toBeTruthy());
    expect(view.getByText("Step 2 of 4")).toBeTruthy();
    expect(continuations).toBe(1);
    expect(view.queryByRole("button", { name: "Set up recovery kit" })).toBeNull();
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("explains a membership-change block instead of showing generic syncing", async () => {
    const port: WorkbenchEncryptionRecoveryReadinessPort = {
      inspect: () => Promise.resolve({
        status: "additional_device_required",
        enrollmentStatus: "syncing",
        operationId: "device-add-membership-change",
        syncReason: "current_domain_sync_required",
      }),
      continueAdditionalDevice: () => Promise.reject(new Error("must not continue")),
      setup: () => Promise.reject(new Error("must not setup")),
    };
    const view = render(<EncryptedRecoverySection readinessPort={port} />);
    await waitFor(() => expect(view.getByText(/Room encryption membership changed/))
      .toBeTruthy());
    expect(view.getByText("Step 4 of 4")).toBeTruthy();
    expect(view.queryByText(/waiting for an existing device to finish Agent/))
      .toBeNull();
  });

  test("keeps personal authority catch-up visible before declaring connection ready", async () => {
    const port: WorkbenchEncryptionRecoveryReadinessPort = {
      inspect: () => Promise.resolve({
        status: "additional_device_required",
        enrollmentStatus: "syncing",
        syncReason: "personal_authority_required",
        operationId: "device-add-personal",
        verificationCode: "ABCDEF-012345-6789AB",
      }),
      continueAdditionalDevice: () => Promise.resolve({
        status: "additional_device_required",
        enrollmentStatus: "syncing",
        syncReason: "personal_authority_required",
        operationId: "device-add-personal",
        verificationCode: "ABCDEF-012345-6789AB",
      }),
      setup: () => Promise.reject(new Error("must not setup")),
    };
    const view = render(<EncryptedRecoverySection readinessPort={port} />);
    await waitFor(() => expect(
      view.getByText(/small personal encryption authority/),
    ).toBeTruthy());
    expect(view.getByText("Step 4 of 4")).toBeTruthy();
    expect(view.queryByText("This device has usable local encryption keys."))
      .toBeNull();
  });

  test("automatically advances and refreshes a pending target device", async () => {
    let continuations = 0;
    const port: WorkbenchEncryptionRecoveryReadinessPort = {
      inspect: () => Promise.resolve({
        status: "additional_device_required",
        enrollmentStatus: "waiting_for_approval",
        operationId: "device-add-auto-refresh",
        verificationCode: "ABCDEF-012345-6789AB",
      }),
      continueAdditionalDevice: () => {
        continuations += 1;
        return Promise.resolve({
          status: "active",
          encryptionSetup: "human_domain_active",
        });
      },
      setup: () => Promise.reject(new Error("must not setup")),
    };
    // Readiness text can precede the passive focus subscription. Settle the
    // initial inspection and React effects before sending the one focus.
    const view = await act(async () => render(<EncryptedRecoverySection readinessPort={port} />));
    await waitFor(() => expect(view.getByText("Step 2 of 4")).toBeTruthy());
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(view.getByText(
      "This device has usable local encryption keys.",
    ))
      .toBeTruthy());
    expect(continuations).toBe(1);
    expect(view.queryByText("ABCDEF-012345-6789AB")).toBeNull();
  });

  test("discovers approval work while the current device authority catches up", async () => {
    let inspections = 0;
    let continuations = 0;
    const port: WorkbenchEncryptionRecoveryReadinessPort = {
      inspect: () => {
        inspections += 1;
        return Promise.resolve(inspections === 1 ? {
          status: "additional_device_required" as const,
          enrollmentStatus: "syncing" as const,
          syncReason: "personal_authority_required" as const,
        } : {
          status: "active" as const,
          encryptionSetup: "device_active" as const,
          pendingAdditionalDevices: [{
            operationId: "device-add-discovered",
            deviceId: "crypto:browser:target",
            clientKind: "browser" as const,
            verificationCode: "ABCDEF-012345-6789AB",
            progress: "approval_required" as const,
          }],
        });
      },
      continueAdditionalDevice: () => {
        continuations += 1;
        return Promise.reject(new Error("must not continue current device"));
      },
      setup: () => Promise.reject(new Error("must not setup")),
    };
    // Readiness text can precede the passive focus subscription. Settle the
    // initial inspection and React effects before sending the one focus.
    const view = await act(async () => render(<EncryptedRecoverySection readinessPort={port} />));
    await waitFor(() => expect(
      view.getByText(/small personal encryption authority/),
    ).toBeTruthy());
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(view.getByText("ABCDEF-012345-6789AB"))
      .toBeTruthy());
    expect(inspections).toBe(2);
    expect(continuations).toBe(0);
  });

  test("shows signed device identity delivery as the third connection step", async () => {
    const port: WorkbenchEncryptionRecoveryReadinessPort = {
      inspect: () => Promise.resolve({
        status: "additional_device_required",
        enrollmentStatus: "syncing",
        operationId: "device-add-delivery",
        syncReason: "delivery_pending",
      }),
      continueAdditionalDevice: () => Promise.resolve({
        status: "additional_device_required",
        enrollmentStatus: "syncing",
        operationId: "device-add-delivery",
        syncReason: "delivery_pending",
      }),
      setup: () => Promise.reject(new Error("must not setup")),
    };
    const view = render(<EncryptedRecoverySection readinessPort={port} />);
    await waitFor(() => expect(view.getByText("Step 3 of 4")).toBeTruthy());
    expect(view.getByText("Receive and verify device identity")).toBeTruthy();
    expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("3");
    expect(view.getByRole("button", { name: "Check connection now" })).toBeTruthy();
  });

  test("approves a matching additional-device code on the active device", async () => {
    let approved: readonly [string, string] | null = null;
    const port: WorkbenchEncryptionRecoveryReadinessPort = {
      inspect: () => Promise.resolve({
        status: "active",
        encryptionSetup: "human_domain_active",
        pendingAdditionalDevices: [{
          operationId: "device-add-2",
          deviceId: "crypto:electron:desktop-2",
          clientKind: "electron",
          verificationCode: "ABCDEF-012345-6789AB",
          progress: "approval_required",
        }],
      }),
      approveAdditionalDevice: (operationId, verificationCode) => {
        approved = [operationId, verificationCode];
        return Promise.resolve({
          status: "active",
          encryptionSetup: "human_domain_active",
          pendingAdditionalDevices: [],
        });
      },
      setup: () => Promise.reject(new Error("must not setup")),
    };
    const view = render(<EncryptedRecoverySection readinessPort={port} />);
    await waitFor(() => expect(view.getByText("ABCDEF-012345-6789AB"))
      .toBeTruthy());
    fireEvent.click(view.getByRole("button", {
      name: "Approve matching code",
    }));
    await waitFor(() => expect(approved).toEqual([
      "device-add-2",
      "ABCDEF-012345-6789AB",
    ]));
    expect(view.queryByText("ABCDEF-012345-6789AB")).toBeNull();
  });

  test("keeps a transfer-ready device connection visible and resumable", async () => {
    let advanced = "";
    const port: WorkbenchEncryptionRecoveryReadinessPort = {
      inspect: () => Promise.resolve({
        status: "active",
        encryptionSetup: "human_domain_active",
        pendingAdditionalDevices: [{
          operationId: "device-add-transfer",
          deviceId: "crypto:electron:desktop-2",
          clientKind: "electron",
          verificationCode: "ABCDEF-012345-6789AB",
          progress: "transfer_ready",
        }],
      }),
      advanceAdditionalDevice: (operationId) => {
        advanced = operationId;
        return Promise.resolve({
          status: "active",
          encryptionSetup: "human_domain_active",
          pendingAdditionalDevices: [],
        });
      },
      setup: () => Promise.reject(new Error("must not setup")),
    };
    const view = render(<EncryptedRecoverySection readinessPort={port} />);
    await waitFor(() => expect(view.getByText(/Continue the signed device connection/))
      .toBeTruthy());
    fireEvent.click(view.getByRole("button", {
      name: "Finish device connection",
    }));
    await waitFor(() => expect(advanced).toBe("device-add-transfer"));
    expect(view.queryByText(/Continue the signed device connection/)).toBeNull();
  });

  test("keeps a blocked final connection visible with its exact reason", async () => {
    const port: WorkbenchEncryptionRecoveryReadinessPort = {
      inspect: () => Promise.resolve({
        status: "active",
        encryptionSetup: "human_domain_active",
        pendingAdditionalDevices: [{
          operationId: "device-add-transfer-blocked",
          deviceId: "crypto:electron:desktop-2",
          clientKind: "electron",
          verificationCode: "ABCDEF-012345-6789AB",
          progress: "transfer_ready",
        }],
      }),
      advanceAdditionalDevice: () => Promise.reject(new Error(
        "Additional-device transition unavailable (source_envelope_unavailable)",
      )),
      setup: () => Promise.reject(new Error("must not setup")),
    };
    const view = render(<EncryptedRecoverySection readinessPort={port} />);
    await waitFor(() => expect(view.getByText(/Continue the signed device connection/))
      .toBeTruthy());
    fireEvent.click(view.getByRole("button", {
      name: "Finish device connection",
    }));
    await waitFor(() => expect(view.getByRole("alert").textContent)
      .toContain("source_envelope_unavailable"));
    expect(view.getByText(/Continue the signed device connection/)).toBeTruthy();
    expect(view.getByRole("button", {
      name: "Finish device connection",
    })).toBeTruthy();
  });

  test("does not expose setup while viewer authority is stale", () => {
    stale = true;
    const port: WorkbenchEncryptionRecoveryReadinessPort = {
      inspect: () => Promise.reject(new Error("must not inspect")),
      setup: () => Promise.reject(new Error("must not setup")),
    };
    const view = render(<EncryptedRecoverySection readinessPort={port} />);
    expect(view.getByText(/Reconnect to verify your identity/)).toBeTruthy();
    expect(view.queryByRole("button")).toBeNull();
  });

  test("requires explicit confirmation before removing stale local device keys", async () => {
    let resets = 0;
    const port: WorkbenchEncryptionRecoveryReadinessPort = {
      inspect: () => Promise.resolve({
        status: "reset_required",
        reason: "server_identity_missing",
      }),
      resetLocalSetup: () => {
        resets += 1;
        return Promise.resolve({ status: "setup_required" });
      },
      setup: () => Promise.reject(new Error("must not setup")),
    };
    const view = render(<EncryptedRecoverySection readinessPort={port} />);
    await waitFor(() => expect(view.getByText(/no longer recognizes this device/))
      .toBeTruthy());
    fireEvent.click(view.getByRole("button", {
      name: "Reset this device's encryption setup",
    }));
    expect(resets).toBe(0);
    fireEvent.click(view.getByRole("button", { name: "Remove stale keys" }));
    await waitFor(() => expect(view.getByRole("button", {
      name: "Set up recovery kit",
    })).toBeTruthy());
    expect(resets).toBe(1);
  });

  test("offers fresh device connection before phrase recovery for a stale device", async () => {
    let reconnects = 0;
    const port: WorkbenchEncryptionRecoveryReadinessPort = {
      inspect: () => Promise.resolve({
        status: "recovery_required",
        reason: "stale_device",
      }),
      reconnectEncryptionDevice: () => {
        reconnects += 1;
        return Promise.resolve({
          status: "additional_device_required",
          enrollmentStatus: "waiting_for_approval",
          operationId: "replacement-device",
          verificationCode: "ABCDEF-012345-6789AB",
        });
      },
      recoverEncryptionDevice: () => Promise.reject(
        new Error("must not recover without a phrase"),
      ),
      setup: () => Promise.reject(new Error("must not setup")),
    };
    const view = render(<EncryptedRecoverySection readinessPort={port} />);
    expect(await view.findByText(/replaces the old device group with a fresh one/))
      .toBeTruthy();
    expect(view.getByLabelText("Current 24-word recovery phrase")).toBeTruthy();
    const recover = view.getByRole(
      "button",
      { name: "Recover this device" },
    ) as HTMLButtonElement;
    expect(recover.disabled).toBe(true);
    fireEvent.click(view.getByRole("button", {
      name: "Reconnect through another device",
    }));
    await waitFor(() => expect(view.getByText("ABCDEF-012345-6789AB"))
      .toBeTruthy());
    expect(reconnects).toBe(1);
  });

  test("shows the MLS roster and requires a PIN before removing another device", async () => {
    let removal: readonly [string, string] | null = null;
    const roster = {
      formatVersion: 1 as const,
      currentDeviceId: "browser-current",
      currentMemberCount: 2,
      devices: [{
        ...health(),
        deviceId: "browser-current",
        clientKind: "browser" as const,
        deviceGeneration: 1,
        deviceRevision: 4,
        membershipState: "current" as const,
        isCurrentDevice: true,
        canRemove: false,
        createdAt: 1,
        lastSeenAt: 2,
        revokedAt: null,
      }, {
        ...health("B".repeat(43)),
        deviceId: "desktop-other",
        clientKind: "electron" as const,
        deviceGeneration: 1,
        deviceRevision: 3,
        membershipState: "current" as const,
        isCurrentDevice: false,
        canRemove: true,
        createdAt: 2,
        lastSeenAt: 3,
        revokedAt: null,
      }],
    };
    const port: WorkbenchEncryptionRecoveryReadinessPort = {
      inspect: () => Promise.resolve({
        status: "active",
        encryptionSetup: "v2_personal_authority_ready",
      }),
      listEncryptionDevices: () => Promise.resolve(roster),
      removeEncryptionDevice: (deviceId, pin) => {
        removal = [deviceId, pin];
        return Promise.resolve({
          status: "active",
          encryptionSetup: "v2_personal_authority_ready",
        });
      },
      setup: () => Promise.reject(new Error("must not setup")),
    };
    const view = render(<EncryptedRecoverySection readinessPort={port} />);
    const user = userEvent.setup();
    await waitFor(() => expect(view.getByText("Desktop")).toBeTruthy());
    expect(view.getByText("Local key custody: Available")).toBeTruthy();
    expect(view.getByText("Local key custody: Verifiable only on that device"))
      .toBeTruthy();
    expect(view.getAllByText("Current Domain keys acknowledged: 4 of 5"))
      .toHaveLength(2);
    expect(view.getAllByText("Key delivery: 7 of 8 acknowledged"))
      .toHaveLength(2);
    expect(view.getAllByText(/Active session proof: .*valid until/))
      .toHaveLength(2);
    fireEvent.click(view.getByRole("button", { name: "Remove" }));
    const confirm = view.getByRole(
      "button",
      { name: "Remove device" },
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.type(view.getByLabelText("PIN to remove encryption device"), "123456");
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(removal).toEqual(["desktop-other", "123456"]));
  });

  test("keeps the device roster visible while personal authority catches up", async () => {
    const port: WorkbenchEncryptionRecoveryReadinessPort = {
      inspect: () => Promise.resolve({
        status: "additional_device_required",
        enrollmentStatus: "syncing",
        syncReason: "personal_authority_required",
      }),
      listEncryptionDevices: () => Promise.resolve({
        formatVersion: 1,
        currentDeviceId: "browser-current",
        currentMemberCount: 2,
        devices: [{
          ...health(),
          deviceId: "browser-current",
          clientKind: "browser",
          deviceGeneration: 1,
          deviceRevision: 4,
          membershipState: "current",
          isCurrentDevice: true,
          canRemove: false,
          createdAt: 1,
          lastSeenAt: 2,
          revokedAt: null,
        }, {
          ...health("B".repeat(43)),
          deviceId: "desktop-other",
          clientKind: "electron",
          deviceGeneration: 1,
          deviceRevision: 4,
          membershipState: "current",
          isCurrentDevice: false,
          canRemove: true,
          createdAt: 2,
          lastSeenAt: 3,
          revokedAt: null,
        }],
      }),
      continueAdditionalDevice: () => Promise.reject(new Error("not needed")),
      setup: () => Promise.reject(new Error("must not setup")),
    };
    const view = render(<EncryptedRecoverySection readinessPort={port} />);
    await waitFor(() => expect(view.getByText("Encryption device health"))
      .toBeTruthy());
    expect(view.getByText("Browser · This device")).toBeTruthy();
    expect(view.getByText("Desktop")).toBeTruthy();
    expect(view.getByText(/Waiting for another connected device/)).toBeTruthy();
    expect(view.getByText("Personal encryption authority: Waiting"))
      .toBeTruthy();
  });
});

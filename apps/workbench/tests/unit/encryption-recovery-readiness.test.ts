import { describe, expect, test } from "bun:test";

import { createDesktopEncryptionRecoveryReadinessPort } from
  "../../src/lib/encryption-recovery-readiness";

describe("desktop encrypted recovery renderer adapter", () => {
  test("confirms the exact main-owned presentation then releases the listener", async () => {
    let listener: ((value: {
      presentationId: string;
      documentHeader: string;
      mnemonic: string;
    }) => void) | undefined;
    let resolved: unknown;
    let finishSetup!: () => void;
    const finished = new Promise<void>((resolve) => {
      finishSetup = resolve;
    });
    let unsubscribed = false;
    const port = createDesktopEncryptionRecoveryReadinessPort({
      inspect: () => Promise.resolve({ status: "setup_required" }),
      async setup() {
        listener?.({
          presentationId: "presentation-1",
          documentHeader: "Nautilo Offline Recovery Kit v1",
          mnemonic: "alpha bravo charlie",
        });
        await finished;
        return { status: "active" };
      },
      resolvePresentation(input) {
        resolved = input;
        finishSetup();
        return Promise.resolve();
      },
      onPresentation(next) {
        listener = next;
        return () => {
          unsubscribed = true;
          listener = undefined;
        };
      },
    });
    expect(await port.setup((presentation) => {
      expect(presentation.revealMnemonic()).toBe("alpha bravo charlie");
      return { status: "confirmed" };
    })).toEqual({ status: "active" });
    expect(resolved).toEqual({
      presentationId: "presentation-1",
      status: "confirmed",
    });
    expect(unsubscribed).toBe(true);
  });

  test("cancels main-owned setup if presentation UI fails", async () => {
    let listener: ((value: {
      presentationId: string;
      documentHeader: string;
      mnemonic: string;
    }) => void) | undefined;
    let finishSetup!: () => void;
    const finished = new Promise<void>((resolve) => {
      finishSetup = resolve;
    });
    let resolved: unknown;
    const port = createDesktopEncryptionRecoveryReadinessPort({
      inspect: () => Promise.resolve({ status: "setup_required" }),
      async setup() {
        listener?.({
          presentationId: "presentation-2",
          documentHeader: "Recovery",
          mnemonic: "secret words",
        });
        await finished;
        return { status: "setup_required" };
      },
      resolvePresentation(input) {
        resolved = input;
        finishSetup();
        return Promise.resolve();
      },
      onPresentation(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });
    let caught: unknown;
    try {
      await port.setup(() => {
        throw new Error("renderer closed");
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("renderer closed");
    expect(resolved).toEqual({
      presentationId: "presentation-2",
      status: "cancelled",
    });
  });
});

import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  InitialDeviceRecoveryCeremonyError,
  prepareInitialDeviceBootstrapRequest,
} from "../../src/device/initial-bootstrap-ceremony.ts";
import {
  nautiloActorId,
  nautiloUserId,
  type TranslationResult,
} from "../../src/index.ts";

function valueOf<T>(result: TranslationResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const USER_ID = valueOf(
  nautiloUserId("00000000-0000-4000-8000-00000000000a"),
);
const ACTOR_ID = valueOf(
  nautiloActorId("00000000-0000-4000-8000-00000000000b"),
);
const LINEAGE = new Uint8Array(32).fill(0x31);
const SIGNING_PUBLIC_KEY = new Uint8Array(32).fill(0x41);
const ENCRYPTION_PUBLIC_KEY = new Uint8Array(65).fill(0x51);

function deterministicCrypto(): LatticeCrypto {
  let next = 0;
  return new LatticeCrypto({
    bytes: (length) => new Uint8Array(length).fill(next++),
  });
}

function requestInput() {
  return {
    userId: USER_ID,
    humanActorId: ACTOR_ID,
    deviceId: "device_alice_browser",
    clientKind: "browser" as const,
    installationLineageDigest: LINEAGE,
    signingPublicKey: SIGNING_PUBLIC_KEY,
    encryptionPublicKey: ENCRYPTION_PUBLIC_KEY,
    context: {
      kind: "preparation" as const,
      authorityId: "prep_1",
    },
    idempotencyKey: "bootstrap_alice_browser",
  };
}

describe("initial-device recovery ceremony", () => {
  test("creates a bootstrap request only after explicit acknowledgement", async () => {
    let presentations = 0;
    let retainedPresentation:
      | Parameters<
        NonNullable<
          Parameters<typeof prepareInitialDeviceBootstrapRequest>[0][
            "presentRecoveryKit"
          ]
        >
      >[0]
      | undefined;
    const request = await prepareInitialDeviceBootstrapRequest({
      crypto: deterministicCrypto(),
      request: requestInput(),
      presentRecoveryKit(presentation) {
        presentations += 1;
        retainedPresentation = presentation;
        expect(presentation.documentHeader).toBe("Nautilo Recovery Kit v1");
        const mnemonic = presentation.revealMnemonic();
        expect(JSON.stringify(presentation)).not.toContain(mnemonic);
        expect(inspect(presentation)).not.toContain(mnemonic);
        return { status: "confirmed" };
      },
    });

    expect(presentations).toBe(1);
    expect(request).toMatchObject(requestInput());
    expect(request.recoveryKeyId).toMatch(/^recovery_[0-9a-f]{32}$/u);
    expect(request.recoveryPublicKey).toHaveLength(65);
    expect(JSON.stringify(request)).not.toContain("abandon");
    expect(() => retainedPresentation?.revealMnemonic()).toThrow(
      "Recovery kit presentation is no longer available",
    );
  });

  test("malformed confirmation cannot produce a bootstrap request or leak words", async () => {
    let displayedMnemonic = "";
    let caught: unknown;
    try {
      await prepareInitialDeviceBootstrapRequest({
        crypto: deterministicCrypto(),
        request: requestInput(),
        presentRecoveryKit(presentation) {
          displayedMnemonic = presentation.revealMnemonic();
          return { status: "unexpected" } as never;
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InitialDeviceRecoveryCeremonyError);
    expect(caught).toMatchObject({ code: "confirmation_failed" });
    expect(String(caught)).not.toContain("abandon");
    expect(JSON.stringify(caught)).not.toContain(displayedMnemonic);
  });

  test("cancellation stops before any bootstrap request exists", async () => {
    expect(
      prepareInitialDeviceBootstrapRequest({
        crypto: deterministicCrypto(),
        request: requestInput(),
        presentRecoveryKit: () => ({ status: "cancelled" }),
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  test("presentation interruption is fail-closed and redacts the thrown cause", async () => {
    const secretCause = "abandon abandon private recovery display";
    let caught: unknown;
    try {
      await prepareInitialDeviceBootstrapRequest({
        crypto: deterministicCrypto(),
        request: requestInput(),
        presentRecoveryKit: () => {
          throw new Error(secretCause);
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InitialDeviceRecoveryCeremonyError);
    expect(caught).toMatchObject({ code: "presentation_interrupted" });
    expect(String(caught)).not.toContain(secretCause);
    expect(JSON.stringify(caught)).not.toContain(secretCause);
  });
});

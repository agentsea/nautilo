import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  RECOVERY_KIT_DOCUMENT_HEADER,
  RECOVERY_KIT_FORMAT_VERSION,
  createRecoveryMnemonicCredential,
} from "../recovery/recovery-kit.ts";
import type { BeginInitialDeviceBootstrap } from "./initial-bootstrap.ts";

export type InitialDeviceRecoveryCeremonyErrorCode =
  | "cancelled"
  | "confirmation_failed"
  | "presentation_interrupted";

export class InitialDeviceRecoveryCeremonyError extends Error {
  override readonly name = "InitialDeviceRecoveryCeremonyError";

  constructor(readonly code: InitialDeviceRecoveryCeremonyErrorCode) {
    super(`Initial-device recovery ceremony failed (${code})`);
  }
}

export interface InitialDeviceRecoveryKitPresentation {
  readonly formatVersion: typeof RECOVERY_KIT_FORMAT_VERSION;
  readonly documentHeader: typeof RECOVERY_KIT_DOCUMENT_HEADER;
  /**
   * Deliberately reveals the client-only secret during the recovery-kit
   * ceremony. The value is unavailable after the presenter returns.
   */
  revealMnemonic(): string;
}

export type InitialDeviceRecoveryKitPresentationResult =
  | { readonly status: "confirmed" }
  | {
    readonly status: "cancelled";
  };

export type PresentInitialDeviceRecoveryKit = (
  presentation: InitialDeviceRecoveryKitPresentation,
) =>
  | InitialDeviceRecoveryKitPresentationResult
  | Promise<InitialDeviceRecoveryKitPresentationResult>;

type InitialDeviceBootstrapRequestBeforeRecovery = Omit<
  BeginInitialDeviceBootstrap,
  "recoveryKeyId" | "recoveryPublicKey"
>;

const CUSTOM_INSPECTION = Symbol.for("nodejs.util.inspect.custom");

class RecoveryKitPresentation
  implements InitialDeviceRecoveryKitPresentation
{
  readonly formatVersion = RECOVERY_KIT_FORMAT_VERSION;
  readonly documentHeader = RECOVERY_KIT_DOCUMENT_HEADER;
  #mnemonic: string | undefined;

  constructor(mnemonic: string) {
    this.#mnemonic = mnemonic;
    Object.freeze(this);
  }

  revealMnemonic(): string {
    if (this.#mnemonic === undefined) {
      throw new Error("Recovery kit presentation is no longer available");
    }
    return this.#mnemonic;
  }

  destroy(): void {
    this.#mnemonic = undefined;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      formatVersion: this.formatVersion,
      documentHeader: this.documentHeader,
      mnemonic: "[REDACTED]",
    });
  }

  [CUSTOM_INSPECTION](): Readonly<Record<string, unknown>> {
    return this.toJSON();
  }
}

/**
 * Client-side Wave 7 ceremony. No bootstrap request exists until the newly
 * generated offline recovery phrase is explicitly acknowledged by the Human.
 *
 * The server deliberately cannot verify this Human interaction: it receives
 * only the confirmed credential's public key and key ID.
 */
export async function prepareInitialDeviceBootstrapRequest(input: {
  readonly crypto: Pick<
    LatticeCrypto,
    "createRecoveryKit" | "hash"
  >;
  readonly request: InitialDeviceBootstrapRequestBeforeRecovery;
  readonly presentRecoveryKit: PresentInitialDeviceRecoveryKit;
}): Promise<BeginInitialDeviceBootstrap> {
  const credential = await createRecoveryMnemonicCredential(input.crypto);
  const presentation = new RecoveryKitPresentation(credential.mnemonic);
  let presentationResult: InitialDeviceRecoveryKitPresentationResult;
  try {
    presentationResult = await input.presentRecoveryKit(presentation);
  } catch {
    throw new InitialDeviceRecoveryCeremonyError("presentation_interrupted");
  } finally {
    presentation.destroy();
  }

  if (presentationResult.status === "cancelled") {
    throw new InitialDeviceRecoveryCeremonyError("cancelled");
  }
  if (presentationResult.status !== "confirmed") {
    throw new InitialDeviceRecoveryCeremonyError("confirmation_failed");
  }

  return Object.freeze({
    ...input.request,
    context: Object.freeze({ ...input.request.context }),
    installationLineageDigest: Uint8Array.from(
      input.request.installationLineageDigest,
    ),
    signingPublicKey: Uint8Array.from(input.request.signingPublicKey),
    encryptionPublicKey: Uint8Array.from(input.request.encryptionPublicKey),
    recoveryKeyId: credential.keyId,
    recoveryPublicKey: Uint8Array.from(credential.publicKey),
  });
}

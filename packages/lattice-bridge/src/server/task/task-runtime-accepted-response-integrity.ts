import {
  hasTaskRuntimeTemporarySigner,
  withTaskRuntimeTemporarySigner,
  type LatticeCrypto,
  type TaskRuntimeCancellationResultEvidence,
  type TaskRuntimeRunResultReadEvidence,
  type TaskRuntimeTerminalMessageEvidence,
} from "@nautilo/lattice-crypto";
import { decodeTaskRuntimeBackgroundAuthorizationResponseV2 } from
  "@nautilo/lattice-crypto/wire";

type PublicationEvidence =
  | TaskRuntimeCancellationResultEvidence
  | TaskRuntimeRunResultReadEvidence
  | TaskRuntimeTerminalMessageEvidence;

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * Verify the durable response without conflating its wrapper hash with the
 * inner Domain grant hash retained by authenticated Runtime evidence.
 */
export async function taskRuntimeAcceptedResponseIsCurrent(input: Readonly<{
  crypto: LatticeCrypto;
  evidence: PublicationEvidence;
  acceptedResponseHash: Uint8Array;
  acceptedResponseBytes: Uint8Array;
}>): Promise<boolean> {
  const responseHash = input.crypto.hash(input.acceptedResponseBytes);
  try {
    if (!equal(responseHash, input.acceptedResponseHash)) return false;
    if (!hasTaskRuntimeTemporarySigner(input.evidence)) {
      return equal(input.acceptedResponseHash,
        input.evidence.authorizationDigest);
    }
    return await withTaskRuntimeTemporarySigner(input.evidence, signer => {
      let response: ReturnType<
        typeof decodeTaskRuntimeBackgroundAuthorizationResponseV2
      > | undefined;
      let authorizationHash: Uint8Array | undefined;
      try {
        response = decodeTaskRuntimeBackgroundAuthorizationResponseV2(
          input.acceptedResponseBytes,
        );
        authorizationHash = input.crypto.hash(response.authorizationBytes);
        return equal(authorizationHash, input.evidence.authorizationDigest)
          && equal(response.certificateBytes, signer.certificateBytes);
      } catch {
        return false;
      } finally {
        authorizationHash?.fill(0);
        response?.authorizationBytes.fill(0);
        response?.certificateBytes.fill(0);
      }
    });
  } catch {
    return false;
  } finally {
    responseHash.fill(0);
  }
}

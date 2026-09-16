import type {
  LatticeCrypto,
  LatticeStorage,
  OpenedGrantAuthoritySet,
} from "@nautilo/lattice-crypto";
import {
  decodeBackgroundAgentWorkDescriptorV2,
  type BackgroundAgentWorkDescriptorV2,
} from "@nautilo/lattice-crypto/wire";

import {
  destroyProtectedInvocationCapability,
  executeProtectedGrantAuthoritySetCapabilityOperationV2,
  type ProtectedGrantAuthoritySetFactsV2,
  type ProtectedGrantAuthoritySetPortV2,
  type ProtectedGrantOperationResult,
  type ProtectedInvocationCapability,
} from "./protected-grant-invocation.ts";

export interface ProtectedSyntheticBackgroundInputV2 {
  readonly objectId: string;
  readonly namespaceId: string;
  readonly ciphertext: Uint8Array;
}

export interface ProtectedSyntheticBackgroundPlaintextInputV2 {
  readonly objectId: string;
  readonly namespaceId: string;
  readonly plaintext: Uint8Array;
}

export interface ProtectedSyntheticBackgroundPlaintextOutputV2 {
  readonly objectId: string;
  readonly plaintext: Uint8Array;
}

export interface ProtectedSyntheticBackgroundEncryptedOutputV2 {
  readonly objectId: string;
  readonly namespaceId: string;
  readonly ciphertext: Uint8Array;
}

export function protectedSyntheticBackgroundObjectAadV2(input: Readonly<{
  readonly objectId: string;
  readonly namespaceId: string;
}>): Uint8Array {
  return new TextEncoder().encode(
    `nautilo/background-synthetic-object/v2\0${input.objectId}\0${input.namespaceId}`,
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function destroyDescriptor(descriptor: BackgroundAgentWorkDescriptorV2): void {
  descriptor.recipientPublicKey.fill(0);
  if (descriptor.source.kind === "synthetic_payload") {
    descriptor.source.fingerprint.fill(0);
  }
}

function descriptorMatchesFacts(
  descriptor: BackgroundAgentWorkDescriptorV2,
  facts: ProtectedGrantAuthoritySetFactsV2,
): boolean {
  return facts.recipientAgentId === descriptor.subject.agentId
    && facts.recipientKeyId === descriptor.recipientKeyId
    && JSON.stringify(facts.grantScope) === JSON.stringify(descriptor.grantScope)
    && facts.namespaceRequirements.length
      === descriptor.namespaceRequirements.length
    && facts.domainRequirements.length === descriptor.domainRequirements.length
    && facts.namespaceRequirements.every((actual, index) => {
      const expected = descriptor.namespaceRequirements[index]!;
      return actual.namespaceId === expected.namespaceId
        && actual.domainId === expected.domainId
        && JSON.stringify(actual.operations)
          === JSON.stringify(expected.operations)
        && actual.expectedAccessRevision === expected.expectedAccessRevision
        && actual.expectedPolicyRevision === expected.expectedPolicyRevision;
    })
    && facts.domainRequirements.every((actual, index) => {
      const expected = descriptor.domainRequirements[index]!;
      return actual.domainId === expected.domainId
        && actual.expectedEpoch === expected.expectedEpoch
        && actual.expectedAgentAuthorizationRevision
          === expected.expectedAgentAuthorizationRevision;
    });
}

function exactInputInventory(
  descriptor: BackgroundAgentWorkDescriptorV2,
  inputs: readonly ProtectedSyntheticBackgroundInputV2[],
): boolean {
  return inputs.length === descriptor.inputBindings.length
    && inputs.every((input, index) => {
      const expected = descriptor.inputBindings[index]!;
      return input.objectId === expected.objectId
        && input.namespaceId === expected.namespaceId
        && input.ciphertext instanceof Uint8Array
        && input.ciphertext.length > 0;
    });
}

function unavailable(): ProtectedGrantOperationResult<never> {
  return Object.freeze({
    status: "unavailable",
    reason: "authorization_unavailable",
  });
}

/**
 * Dormant Wave 11 proof harness. It performs a descriptor-bound transform
 * across the complete authority set while keeping all roots inside the bridge.
 * It is deliberately synthetic and is not reachable from a product worker.
 */
export async function executeProtectedSyntheticBackgroundWorkV2<Value>(
  input: Readonly<{
    readonly capability: ProtectedInvocationCapability;
    readonly crypto: LatticeCrypto;
    readonly storage: Pick<LatticeStorage, "getGrant" | "consumeGrant">;
    readonly descriptorBytes: Uint8Array;
    readonly expectedDescriptorHash: Uint8Array;
    readonly encryptedInputs: readonly ProtectedSyntheticBackgroundInputV2[];
    readonly authority: ProtectedGrantAuthoritySetPortV2;
    readonly transform: (
      inputs: readonly ProtectedSyntheticBackgroundPlaintextInputV2[],
    ) =>
      | Readonly<{
        readonly value: Value;
        readonly outputs:
          readonly ProtectedSyntheticBackgroundPlaintextOutputV2[];
      }>
      | PromiseLike<Readonly<{
        readonly value: Value;
        readonly outputs:
          readonly ProtectedSyntheticBackgroundPlaintextOutputV2[];
      }>>;
  }>,
): Promise<ProtectedGrantOperationResult<Readonly<{
  readonly value: Value;
  readonly outputs: readonly ProtectedSyntheticBackgroundEncryptedOutputV2[];
}>>> {
  let descriptor: BackgroundAgentWorkDescriptorV2;
  let calculatedDescriptorHash: Uint8Array | undefined;
  try {
    calculatedDescriptorHash = input.crypto.hash(input.descriptorBytes);
    if (
      !(input.descriptorBytes instanceof Uint8Array)
      || !(input.expectedDescriptorHash instanceof Uint8Array)
      || input.expectedDescriptorHash.length !== 32
      || !equalBytes(
        calculatedDescriptorHash,
        input.expectedDescriptorHash,
      )
    ) throw new TypeError("Synthetic background descriptor hash is invalid");
    descriptor = decodeBackgroundAgentWorkDescriptorV2(input.descriptorBytes);
    if (
      !exactInputInventory(descriptor, input.encryptedInputs)
      || input.encryptedInputs.reduce(
        (total, item) => total + item.ciphertext.length,
        0,
      ) > descriptor.maximumCiphertextBytes
    ) throw new TypeError("Synthetic background input inventory is not exact");
  } catch {
    destroyProtectedInvocationCapability(input.capability);
    return unavailable();
  } finally {
    calculatedDescriptorHash?.fill(0);
  }

  const authority: ProtectedGrantAuthoritySetPortV2 = {
    resolvePreflightFacts: async (request) => {
      const facts = await input.authority.resolvePreflightFacts(request);
      return facts !== null && descriptorMatchesFacts(descriptor, facts)
        ? facts
        : null;
    },
    resolveCurrentAuthorization: input.authority.resolveCurrentAuthorization,
  };
  try {
    return await executeProtectedGrantAuthoritySetCapabilityOperationV2({
      capability: input.capability,
      crypto: input.crypto,
      storage: input.storage,
      authority,
      execute: async (opened) => {
      const rootsByDomain = new Map(
        opened.domains.map((entry) => [entry.domainId, entry.aiRoot]),
      );
      const requirementsByNamespace = new Map<
        string,
        OpenedGrantAuthoritySet["namespaceRequirements"][number]
      >(
        opened.namespaceRequirements.map((entry) => [entry.namespaceId, entry]),
      );
      const plaintextInputs: ProtectedSyntheticBackgroundPlaintextInputV2[] = [];
      const plaintextOutputs: Uint8Array[] = [];
      try {
        for (const encrypted of input.encryptedInputs) {
          const requirement = requirementsByNamespace.get(encrypted.namespaceId);
          const root = requirement === undefined
            ? undefined
            : rootsByDomain.get(requirement.domainId);
          if (root === undefined || !requirement!.operations.includes("decrypt")) {
            throw new TypeError("Synthetic input lacks exact decrypt authority");
          }
          const plaintext = input.crypto.aeadOpen(
            root,
            encrypted.ciphertext,
            protectedSyntheticBackgroundObjectAadV2(encrypted),
          );
          if (plaintext === null) {
            throw new TypeError("Synthetic input ciphertext is invalid");
          }
          plaintextInputs.push(Object.freeze({
            objectId: encrypted.objectId,
            namespaceId: encrypted.namespaceId,
            plaintext,
          }));
        }
        const transformed = await input.transform(
          Object.freeze(plaintextInputs),
        );
        if (
          transformed.outputs.length !== descriptor.outputSlots.length
          || transformed.outputs.some((output, index) =>
            output.objectId !== descriptor.outputSlots[index]!.objectId
            || !(output.plaintext instanceof Uint8Array)
          )
        ) throw new TypeError("Synthetic output inventory is not exact");
        const totalPlaintext = plaintextInputs.reduce(
          (total, item) => total + item.plaintext.length,
          0,
        ) + transformed.outputs.reduce(
          (total, item) => total + item.plaintext.length,
          0,
        );
        if (totalPlaintext > descriptor.maximumPlaintextBytes) {
          throw new TypeError("Synthetic transform exceeds its plaintext bound");
        }
        const encryptedOutputs: ProtectedSyntheticBackgroundEncryptedOutputV2[] = [];
        for (const [index, output] of transformed.outputs.entries()) {
          plaintextOutputs.push(output.plaintext);
          const slot = descriptor.outputSlots[index]!;
          for (const outputNamespaceId of slot.namespaceIds) {
            const requirement = requirementsByNamespace.get(outputNamespaceId);
            const root = requirement === undefined
              ? undefined
              : rootsByDomain.get(requirement.domainId);
            if (root === undefined || !requirement!.operations.includes("encrypt")) {
              throw new TypeError("Synthetic output lacks exact encrypt authority");
            }
            encryptedOutputs.push(Object.freeze({
              objectId: output.objectId,
              namespaceId: outputNamespaceId,
              ciphertext: input.crypto.aeadSeal(
                root,
                output.plaintext,
                protectedSyntheticBackgroundObjectAadV2({
                  objectId: output.objectId,
                  namespaceId: outputNamespaceId,
                }),
              ),
            }));
          }
        }
        const totalCiphertext = encryptedOutputs.reduce(
          (total, item) => total + item.ciphertext.length,
          0,
        );
        if (totalCiphertext > descriptor.maximumCiphertextBytes) {
          encryptedOutputs.forEach((entry) => entry.ciphertext.fill(0));
          throw new TypeError(
            "Synthetic transform exceeds its ciphertext bound",
          );
        }
        return Object.freeze({
          value: transformed.value,
          outputs: Object.freeze(encryptedOutputs),
        });
      } finally {
        plaintextInputs.forEach((entry) => entry.plaintext.fill(0));
        plaintextOutputs.forEach((bytes) => bytes.fill(0));
      }
      },
    });
  } finally {
    destroyDescriptor(descriptor);
  }
}

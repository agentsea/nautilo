import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  objectId,
  prepareAgentRuntimeInitialization,
} from "@nautilo/lattice-crypto";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import {
  AgentRuntimeSignerHistoryInvalidError,
  AgentRuntimeSignerHistoryUnavailableError,
  authenticateHistoricalAgentRuntimeSignerPublication,
  type ResolveHistoricalAgentRuntimeSignerManagerAuthority,
} from "../../src/server/index.ts";

async function fixture() {
  const crypto = new LatticeCrypto(seededRng(0x237_51));
  const managerSigning = crypto.generateSigningKeyPair();
  const prepared = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "operation-signer-history-verification",
    agentId: agentId("agent-signer-history-verification"),
    authorizationRevision: authorizationRevision(4),
    configObjects: [{
      objectId: objectId("config-signer-history-verification"),
      configRevision: authorizationRevision(1),
      plaintextDek: new Uint8Array(32).fill(0x61),
    }],
    domains: [],
    resolveCurrentDomainCommitterAuthority: () => null,
    manager: {
      managerHumanId: humanId("human-signer-history-manager"),
      managerAuthorizationRevision: authorizationRevision(4),
      managerDeviceId: cryptoDeviceId("device-signer-history-manager"),
    },
    managerSigningPrivateKey: managerSigning.privateKey,
    resolveCurrentManagerAuthority: () => managerSigning.publicKey,
  });
  const resolveHistoricalManagerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority =
      (context) => ({
        ...context,
        managerSigningPublicKey: managerSigning.publicKey,
      });
  return {
    crypto,
    managerSigning,
    prepared,
    resolveHistoricalManagerAuthority,
  };
}

describe("Agent Runtime signer historical authority", () => {
  test("authenticates the complete persisted publication tuple against retained manager history", async () => {
    const state = await fixture();
    const authenticated =
      await authenticateHistoricalAgentRuntimeSignerPublication({
        crypto: state.crypto,
        publication: state.prepared.signerPublication,
        resolveHistoricalManagerAuthority:
          state.resolveHistoricalManagerAuthority,
      });

    expect(authenticated).toEqual(state.prepared.signerPublication);
    expect(authenticated).not.toBe(state.prepared.signerPublication);
    expect(authenticated.signerPublicKey)
      .not.toBe(state.prepared.signerPublication.signerPublicKey);
  });

  test("returns a typed invalid-history error for a substituted signature", async () => {
    const state = await fixture();
    const signature =
      state.prepared.signerPublication.signature.slice();
    signature[0] = signature[0]! ^ 0xff;

    const error =
      await authenticateHistoricalAgentRuntimeSignerPublication({
        crypto: state.crypto,
        publication: {
          ...state.prepared.signerPublication,
          signature,
        },
        resolveHistoricalManagerAuthority:
          state.resolveHistoricalManagerAuthority,
      }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AgentRuntimeSignerHistoryInvalidError);
    expect(error).toHaveProperty(
      "code",
      "agent_runtime_signer_history_invalid",
    );
  });

  test("preserves availability failure as a typed error rather than unauthenticated history", async () => {
    const state = await fixture();
    const storageFailure = new Error("retained device history unavailable");

    const error =
      await authenticateHistoricalAgentRuntimeSignerPublication({
        crypto: state.crypto,
        publication: state.prepared.signerPublication,
        resolveHistoricalManagerAuthority: async () => {
          throw storageFailure;
        },
      }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(
      AgentRuntimeSignerHistoryUnavailableError,
    );
    expect(error).toHaveProperty(
      "code",
      "agent_runtime_signer_history_unavailable",
    );
    expect((error as Error).cause).toBe(storageFailure);
  });
});

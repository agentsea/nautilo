import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  seededRng,
} from "../../src/crypto/index.ts";
import {
  openAgentRuntimeFromDomain,
} from "../../src/agent-runtime/domain-envelope.ts";
import {
  agentRuntimeConfigDekAadV2,
} from "../../src/agent-runtime/runtime-rotation-v2.ts";
import {
  authorizeAgentRuntimeInitializationWriteV2,
} from "../../src/agent-runtime/initialization-authorized-write.ts";
import {
  AgentRuntimeInitializationOutcomeUnknownV2,
  persistAgentRuntimeInitializationV2,
  prepareAgentRuntimeInitializationV2,
  type AgentRuntimeInitializationPersistenceContextV2,
} from "../../src/agent-runtime/storage-coordinator.ts";
import {
  parseAgentRuntimeDomainEnvelope,
} from "../../src/format/agent-runtime-v2.ts";
import {
  InMemoryV2Store,
  type AgentRuntimeAtomicStorageWireV2,
} from "../../src/storage/v2-store.ts";
import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  objectId,
} from "../../src/v2-types/ids.ts";

function bytes(fill: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

async function fixture(seed = 0x225_90) {
  const crypto = new LatticeCrypto(seededRng(seed));
  const committerA = crypto.generateSigningKeyPair();
  const committerZ = crypto.generateSigningKeyPair();
  const configA = bytes(0x41);
  const configB = bytes(0x42);
  const rootA = bytes(0x51);
  const rootZ = bytes(0x52);
  const prepared = await prepareAgentRuntimeInitializationV2({
    crypto,
    operationId: "operation-initialize-agent",
    agentId: agentId("agent-initialize"),
    authorizationRevision: authorizationRevision(7),
    configObjects: [
      {
        objectId: objectId("config-a"),
        configRevision: authorizationRevision(2),
        plaintextDek: configA,
      },
      {
        objectId: objectId("config-z"),
        configRevision: authorizationRevision(3),
        plaintextDek: configB,
      },
    ],
    domains: [
      {
        domainId: cryptoDomainId("domain-a"),
        domainEpoch: domainEpoch(4),
        agentAuthorizationRevision: authorizationRevision(7),
        committerDeviceId: cryptoDeviceId("device-a"),
        domainRoot: rootA,
        committerSigningPrivateKey: committerA.privateKey,
      },
      {
        domainId: cryptoDomainId("domain-z"),
        domainEpoch: domainEpoch(5),
        agentAuthorizationRevision: authorizationRevision(8),
        committerDeviceId: cryptoDeviceId("device-z"),
        domainRoot: rootZ,
        committerSigningPrivateKey: committerZ.privateKey,
      },
    ],
    resolveCurrentDomainCommitterAuthority: (context) =>
      context.committerDeviceId === "device-a"
        ? committerA.publicKey
        : context.committerDeviceId === "device-z"
          ? committerZ.publicKey
          : null,
    manager: {
      managerHumanId: humanId("human-manager"),
      managerAuthorizationRevision: authorizationRevision(7),
      managerDeviceId: cryptoDeviceId("device-manager"),
    },
    managerSigningPrivateKey: committerA.privateKey,
    resolveCurrentManagerAuthority: () => committerA.publicKey,
  });
  return {
    crypto,
    prepared,
    configA,
    configB,
    rootA,
    rootZ,
    committerA,
    committerZ,
  };
}

function persistenceInput(state: Awaited<ReturnType<typeof fixture>>) {
  return {
    crypto: state.crypto,
    prepared: state.prepared,
    resolveCurrentAuthorization: () => ({
      currentState: {
        agentId: state.prepared.runtime.agentId,
        authorizationRevision: authorizationRevision(7),
        runtimeGeneration: agentRuntimeGeneration(0),
      },
      currentManager: {
        managerHumanId: humanId("human-manager"),
        managerAuthorizationRevision: authorizationRevision(7),
        managerDeviceId: cryptoDeviceId("device-manager"),
      },
      currentManagerSigningPublicKey: state.committerA.publicKey,
      domains: [
        {
          domainId: cryptoDomainId("domain-a"),
          domainEpoch: domainEpoch(4),
          agentAuthorizationRevision: authorizationRevision(7),
          committerDeviceId: cryptoDeviceId("device-a"),
          committerSigningPublicKey: state.committerA.publicKey,
        },
        {
          domainId: cryptoDomainId("domain-z"),
          domainEpoch: domainEpoch(5),
          agentAuthorizationRevision: authorizationRevision(8),
          committerDeviceId: cryptoDeviceId("device-z"),
          committerSigningPublicKey: state.committerZ.publicKey,
        },
      ],
    }),
  };
}

describe("Agent Runtime initialization storage coordinator", () => {
  test("cryptographically prepares and atomically persists a complete non-empty state", async () => {
    const state = await fixture();
    const store = new InMemoryV2Store();

    expect(await persistAgentRuntimeInitializationV2({
      ...persistenceInput(state),
      storage: store,
    })).toBe("inserted");

    const stored = await store.getAgentRuntimeAtomicState(
      state.prepared.runtime.agentId,
    );
    if (stored === null) throw new Error("missing initialized Runtime");
    expect(stored.runtime.agentId).toBe(
      agentId("agent-initialize"),
    );
    expect(stored.runtime.authorizationRevision).toBe(
      authorizationRevision(7),
    );
    expect(stored.runtime.runtimeGeneration).toBe(
      agentRuntimeGeneration(0),
    );
    expect(stored.configObjects.map((entry) => entry.objectId)).toEqual([
      "config-a",
      "config-z",
    ]);
    expect(stored.domainEnvelopes.map((entry) => entry.domainId)).toEqual([
      "domain-a",
      "domain-z",
    ]);
    expect(stored.challengeConsumptions).toEqual([]);

    for (const [index, config] of stored.configObjects.entries()) {
      const plaintext = state.crypto.aeadOpen(
        state.prepared.runtime.key,
        config.wrappedDekBytes,
        agentRuntimeConfigDekAadV2({
          agentId: agentId(config.agentId),
          objectId: objectId(config.objectId),
          configRevision: authorizationRevision(config.configRevision),
          runtimeGeneration:
            agentRuntimeGeneration(config.runtimeGeneration),
        }),
      );
      expect(plaintext).toEqual(index === 0 ? state.configA : state.configB);
    }
    for (const [index, record] of stored.domainEnvelopes.entries()) {
      const envelope = parseAgentRuntimeDomainEnvelope(record.envelopeBytes);
      const opened = openAgentRuntimeFromDomain({
        crypto: state.crypto,
        domainRoot: index === 0 ? state.rootA : state.rootZ,
        envelope,
        expected: {
          agentId: agentId(record.agentId),
          domainId: cryptoDomainId(record.domainId),
          domainEpoch: domainEpoch(record.domainEpoch),
          agentAuthorizationRevision:
            authorizationRevision(record.agentAuthorizationRevision),
          runtimeGeneration:
            agentRuntimeGeneration(record.runtimeGeneration),
          committerDeviceId: cryptoDeviceId(record.committerDeviceId),
        },
        resolveHistoricalCommitter: () =>
          index === 0
            ? state.committerA.publicKey
            : state.committerZ.publicKey,
      });
      expect(opened.key).toEqual(state.prepared.runtime.key);
    }
  });

  test("persists a detached initialization artifact after process-style structured cloning", async () => {
    const state = await fixture(0x225_9b);
    const rehydrated = structuredClone(state.prepared);

    expect(await persistAgentRuntimeInitializationV2({
      ...persistenceInput(state),
      prepared: rehydrated,
      storage: new InMemoryV2Store(),
    })).toBe("inserted");
  });

  test("binds the signer publication to every public initialization component", async () => {
    const state = await fixture(0x225_98);
    const candidates = [
      {
        ...state.prepared,
        intended: {
          ...state.prepared.intended,
          runtime: {
            ...state.prepared.intended.runtime,
            authorizationRevision: authorizationRevision(8),
          },
        },
      },
      {
        ...state.prepared,
        intended: {
          ...state.prepared.intended,
          configInventory: {
            ...state.prepared.intended.configInventory,
            objectCount:
              state.prepared.intended.configInventory.objectCount + 1,
          },
        },
      },
      {
        ...state.prepared,
        intended: {
          ...state.prepared.intended,
          domainEnvelopes:
            state.prepared.intended.domainEnvelopes.map((entry, index) =>
              index === 0
                ? {
                  ...entry,
                  domainEpoch: domainEpoch(entry.domainEpoch + 1),
                }
                : entry
            ),
        },
      },
    ] as const;
    const digestTamper = structuredClone(state.prepared);
    digestTamper.intended.configInventory.digest[0] =
      digestTamper.intended.configInventory.digest[0]! ^ 0xff;
    const envelopeHashTamper = structuredClone(state.prepared);
    envelopeHashTamper.intended.domainEnvelopes[0]!.envelopeHash[0] =
      envelopeHashTamper.intended.domainEnvelopes[0]!.envelopeHash[0]!
        ^ 0xff;

    for (const prepared of [
      ...candidates,
      digestTamper,
      envelopeHashTamper,
    ]) {
      expect(persistAgentRuntimeInitializationV2({
        crypto: state.crypto,
        storage: new InMemoryV2Store(),
        prepared,
        resolveCurrentAuthorization: () => null,
      })).rejects.toThrow(
        /signer publication|inventory (?:count|digest)|coordinates|commitment|envelope/,
      );
    }
  });

  test("snapshots manager identity and private key before the first authority await", async () => {
    const crypto = new LatticeCrypto(seededRng(0x225_99));
    const committer = crypto.generateSigningKeyPair();
    const manager = crypto.generateSigningKeyPair();
    const callerManagerPrivateKey = manager.privateKey.slice();
    const prepared = await prepareAgentRuntimeInitializationV2({
      crypto,
      operationId: "operation-manager-snapshot",
      agentId: agentId("agent-manager-snapshot"),
      authorizationRevision: authorizationRevision(3),
      configObjects: [{
        objectId: objectId("config-manager-snapshot"),
        configRevision: authorizationRevision(1),
        plaintextDek: bytes(0x71),
      }],
      domains: [{
        domainId: cryptoDomainId("domain-manager-snapshot"),
        domainEpoch: domainEpoch(2),
        agentAuthorizationRevision: authorizationRevision(3),
        committerDeviceId: cryptoDeviceId("device-committer"),
        domainRoot: bytes(0x72),
        committerSigningPrivateKey: committer.privateKey,
      }],
      resolveCurrentDomainCommitterAuthority: async () => {
        callerManagerPrivateKey.fill(0xff);
        await Promise.resolve();
        return committer.publicKey;
      },
      manager: {
        managerHumanId: humanId("human-manager"),
        managerAuthorizationRevision: authorizationRevision(3),
        managerDeviceId: cryptoDeviceId("device-manager"),
      },
      managerSigningPrivateKey: callerManagerPrivateKey,
      resolveCurrentManagerAuthority: () => manager.publicKey,
    });

    expect(Array.from(callerManagerPrivateKey)).toEqual(
      Array.from(bytes(0xff)),
    );
    expect(prepared.signerPublication.managerHumanId).toBe(
      humanId("human-manager"),
    );
  });

  test("distinguishes exact replay, fork, and throw-after-commit ambiguity without retrying", async () => {
    const state = await fixture(0x225_91);
    const store = new InMemoryV2Store();
    expect(await persistAgentRuntimeInitializationV2({
      ...persistenceInput(state),
      storage: store,
    })).toBe("inserted");
    expect(await persistAgentRuntimeInitializationV2({
      ...persistenceInput(state),
      storage: store,
    })).toBe("duplicate");

    const fork = await fixture(0x225_92);
    expect(await persistAgentRuntimeInitializationV2({
      ...persistenceInput(fork),
      storage: store,
    })).toBe("stale");

    const ambiguousState = await fixture(0x225_93);
    const backing = new InMemoryV2Store();
    let puts = 0;
    const ambiguous = {
      getAgentRuntimeAtomicState: backing.getAgentRuntimeAtomicState.bind(
        backing,
      ),
      getAgentRuntimeSignerPublication:
        backing.getAgentRuntimeSignerPublication.bind(backing),
      async putAgentRuntimeAtomicStateIfAbsent(
        authorized: Parameters<
          InMemoryV2Store["putAgentRuntimeAtomicStateIfAbsent"]
        >[0],
      ) {
        puts += 1;
        await backing.putAgentRuntimeAtomicStateIfAbsent(authorized);
        throw new Error("lost initialization response");
      },
    };
    const error = await persistAgentRuntimeInitializationV2({
      ...persistenceInput(ambiguousState),
      storage: ambiguous,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(
      AgentRuntimeInitializationOutcomeUnknownV2,
    );
    expect((error as Error).cause).toEqual(
      new Error("lost initialization response"),
    );
    expect(puts).toBe(1);
    expect(await persistAgentRuntimeInitializationV2({
      ...persistenceInput(ambiguousState),
      storage: ambiguous,
    })).toBe("duplicate");
    expect(puts).toBe(1);

    const beforeCommit = await fixture(0x225_96);
    let beforeAttempts = 0;
    const beforeError = new Error("failed before initialization commit");
    const before = {
      getAgentRuntimeAtomicState: async () => null,
      getAgentRuntimeSignerPublication: async () => null,
      putAgentRuntimeAtomicStateIfAbsent: async () => {
        beforeAttempts += 1;
        throw beforeError;
      },
    };
    const observed = await persistAgentRuntimeInitializationV2({
      ...persistenceInput(beforeCommit),
      storage: before,
    }).catch((cause: unknown) => cause);
    expect(observed).toBeInstanceOf(
      AgentRuntimeInitializationOutcomeUnknownV2,
    );
    expect((observed as Error).cause).toBe(beforeError);
    expect(beforeAttempts).toBe(1);
  });

  test("requires exact persisted signer history before classifying initialization replay", async () => {
    const state = await fixture(0x225_9d);
    const backing = new InMemoryV2Store();
    expect(await persistAgentRuntimeInitializationV2({
      ...persistenceInput(state),
      storage: backing,
    })).toBe("inserted");

    const base = {
      getAgentRuntimeAtomicState:
        backing.getAgentRuntimeAtomicState.bind(backing),
      putAgentRuntimeAtomicStateIfAbsent: async () => {
        throw new Error("initialization replay must not attempt another put");
      },
    };
    expect(await persistAgentRuntimeInitializationV2({
      ...persistenceInput(state),
      storage: {
        ...base,
        getAgentRuntimeSignerPublication: async () => null,
      },
    })).toBe("stale");

    const persisted = await backing.getAgentRuntimeSignerPublication(
      state.prepared.runtime.agentId,
      state.prepared.runtime.generation,
    );
    expect(persisted).not.toBeNull();
    const substituted = {
      ...persisted!,
      signature: persisted!.signature.map((byte, index) =>
        index === 0 ? byte ^ 0xff : byte
      ),
    };
    expect(await persistAgentRuntimeInitializationV2({
      ...persistenceInput(state),
      storage: {
        ...base,
        getAgentRuntimeSignerPublication: async () => substituted,
      },
    })).toBe("stale");

    const corrupt = {
      ...persisted!,
      signature: new Uint8Array(1),
    };
    expect(
      persistAgentRuntimeInitializationV2({
        ...persistenceInput(state),
        storage: {
          ...base,
          getAgentRuntimeSignerPublication: async () => corrupt,
        },
      }),
    ).rejects.toThrow(/signature/i);

    const unavailable = Object.assign(
      new Error("signer history read failed"),
      { code: "agent_runtime_signer_history_unavailable" as const },
    );
    const observed = await persistAgentRuntimeInitializationV2({
      ...persistenceInput(state),
      storage: {
        ...base,
        getAgentRuntimeSignerPublication: async () => {
          throw unavailable;
        },
      },
    }).catch((cause: unknown) => cause);
    expect(observed).toBe(unavailable);

    let raceReads = 0;
    expect(await persistAgentRuntimeInitializationV2({
      ...persistenceInput(state),
      storage: {
        getAgentRuntimeAtomicState: async (id) => {
          raceReads += 1;
          return raceReads === 1
            ? null
            : backing.getAgentRuntimeAtomicState(id);
        },
        getAgentRuntimeSignerPublication: async () => null,
        putAgentRuntimeAtomicStateIfAbsent: async () => "existing",
      },
    })).toBe("stale");
    expect(raceReads).toBe(2);
  });

  test("re-resolves exact live authorization and full Domain inventory after the durable read", async () => {
    const state = await fixture(0x225_98);
    const current = persistenceInput(state).resolveCurrentAuthorization();
    const replacement = state.crypto.generateSigningKeyPair();
    const cases = [
      {
        label: "authorization revision changed",
        authorization: {
          ...current,
          currentState: {
            ...current.currentState,
            authorizationRevision: authorizationRevision(8),
          },
        },
      },
      {
        label: "Domain omitted",
        authorization: {
          ...current,
          domains: current.domains.slice(1),
        },
      },
      {
        label: "Domain added",
        authorization: {
          ...current,
          domains: [
            ...current.domains,
            {
              domainId: cryptoDomainId("domain-zz"),
              domainEpoch: domainEpoch(1),
              agentAuthorizationRevision: authorizationRevision(1),
              committerDeviceId: cryptoDeviceId("device-zz"),
              committerSigningPublicKey: replacement.publicKey,
            },
          ],
        },
      },
      {
        label: "Domain coordinates substituted",
        authorization: {
          ...current,
          domains: current.domains.map((domain, index) =>
            index === 0
              ? {
                ...domain,
                committerDeviceId: cryptoDeviceId("device-substitute"),
              }
              : domain
          ),
        },
      },
      {
        label: "committer revoked or replaced",
        authorization: {
          ...current,
          domains: current.domains.map((domain, index) =>
            index === 0
              ? {
                ...domain,
                committerSigningPublicKey: replacement.publicKey,
              }
              : domain
          ),
        },
      },
    ] as const;

    for (const item of cases) {
      let reads = 0;
      let writes = 0;
      let context: AgentRuntimeInitializationPersistenceContextV2 | undefined;
      const result = await persistAgentRuntimeInitializationV2({
        crypto: state.crypto,
        prepared: state.prepared,
        storage: {
          getAgentRuntimeAtomicState: async () => {
            reads += 1;
            return null;
          },
          getAgentRuntimeSignerPublication: async () => null,
          putAgentRuntimeAtomicStateIfAbsent: async () => {
            writes += 1;
            return "inserted";
          },
        },
        resolveCurrentAuthorization: (value) => {
          context = value;
          return item.authorization;
        },
      });
      expect(result, item.label).toBe("stale");
      expect(reads, item.label).toBe(1);
      expect(writes, item.label).toBe(0);
      expect(context?.expectedState).toEqual(current.currentState);
      expect(context?.configInventory.objectCount).toBe(2);
      expect(context?.expectedDomains.map((domain) => domain.domainId))
        .toEqual([
          cryptoDomainId("domain-a"),
          cryptoDomainId("domain-z"),
        ]);
    }

    let nullReads = 0;
    expect(await persistAgentRuntimeInitializationV2({
      crypto: state.crypto,
      prepared: state.prepared,
      storage: {
        getAgentRuntimeAtomicState: async () => {
          nullReads += 1;
          return null;
        },
        getAgentRuntimeSignerPublication: async () => null,
        putAgentRuntimeAtomicStateIfAbsent: async () => "inserted",
      },
      resolveCurrentAuthorization: () => null,
    })).toBe("stale");
    expect(nullReads).toBe(1);
  });

  test("revocation occurring during the durable read prevents the initialization put", async () => {
    const state = await fixture(0x225_99);
    let authorized = true;
    let puts = 0;
    const current = persistenceInput(state).resolveCurrentAuthorization();
    expect(await persistAgentRuntimeInitializationV2({
      crypto: state.crypto,
      prepared: state.prepared,
      storage: {
        getAgentRuntimeAtomicState: async () => {
          authorized = false;
          return null;
        },
        getAgentRuntimeSignerPublication: async () => null,
        putAgentRuntimeAtomicStateIfAbsent: async () => {
          puts += 1;
          return "inserted";
        },
      },
      resolveCurrentAuthorization: () =>
        authorized ? current : null,
    })).toBe("stale");
    expect(puts).toBe(0);
  });

  test("carries exact live authorization into the atomic insert boundary", async () => {
    const state = await fixture(0x225_9c);
    let liveAuthorizationRevision = authorizationRevision(7);
    let observedRevision: number | null = null;

    expect(await persistAgentRuntimeInitializationV2({
      ...persistenceInput(state),
      storage: {
        getAgentRuntimeAtomicState: async () => null,
        getAgentRuntimeSignerPublication: async () => null,
        putAgentRuntimeAtomicStateIfAbsent: async (authorized) => {
          observedRevision =
            authorized.authorization.context.expectedState
              .authorizationRevision;
          liveAuthorizationRevision = authorizationRevision(8);
          return observedRevision === liveAuthorizationRevision
            ? "inserted"
            : "stale";
        },
      },
    })).toBe("stale");
    expect(Number(observedRevision)).toBe(authorizationRevision(7));
  });

  test("reference storage rejects structural, cloned, mutated, and replayed initialization capabilities", async () => {
    const state = await fixture(0x225_9a);
    type InitializationWrite = Parameters<
      InMemoryV2Store["putAgentRuntimeAtomicStateIfAbsent"]
    >[0];
    const capture = async () => {
      let captured: InitializationWrite | null = null;
      expect(await persistAgentRuntimeInitializationV2({
        ...persistenceInput(state),
        storage: {
          getAgentRuntimeAtomicState: async () => null,
          getAgentRuntimeSignerPublication: async () => null,
          putAgentRuntimeAtomicStateIfAbsent: async (authorized) => {
            captured = authorized;
            return "inserted";
          },
        },
      })).toBe("inserted");
      return captured as unknown as InitializationWrite;
    };
    const reference = new InMemoryV2Store();
    const cloned = await capture();
    expect(reference.putAgentRuntimeAtomicStateIfAbsent(
      structuredClone(cloned) as never,
    )).rejects.toThrow("authorized write capability");
    const mutated = await capture();
    mutated.state.configInventory.digest[0] =
      mutated.state.configInventory.digest[0]! ^ 0xff;
    expect(reference.putAgentRuntimeAtomicStateIfAbsent(
      mutated,
    )).rejects.toThrow("authorized write capability");
    const replayed = await capture();
    expect(await reference.putAgentRuntimeAtomicStateIfAbsent(
      replayed,
    )).toBe("inserted");
    expect(reference.putAgentRuntimeAtomicStateIfAbsent(
      replayed,
    )).rejects.toThrow("authorized write capability");
    expect(reference.putAgentRuntimeAtomicStateIfAbsent({
      state: replayed.state,
    } as never)).rejects.toThrow("authorized write capability");
  });

  test("initialization capability mint binds every independent write-set axis", async () => {
    const state = await fixture(0x225_9d);
    let captured: Parameters<
      InMemoryV2Store["putAgentRuntimeAtomicStateIfAbsent"]
    >[0] | null = null;
    expect(await persistAgentRuntimeInitializationV2({
      ...persistenceInput(state),
      storage: {
        getAgentRuntimeAtomicState: async () => null,
        getAgentRuntimeSignerPublication: async () => null,
        putAgentRuntimeAtomicStateIfAbsent: async (authorized) => {
          captured = authorized;
          return "inserted";
        },
      },
    })).toBe("inserted");
    if (captured === null) throw new Error("missing initialization capability");
    const valid = captured as unknown as Parameters<
      typeof authorizeAgentRuntimeInitializationWriteV2
    >[0];
    const authorize = (overrides: Partial<typeof valid>) => () =>
      authorizeAgentRuntimeInitializationWriteV2({
        ...valid,
        ...overrides,
      });
    const changedManager = {
      ...valid.authorization.currentManager,
      managerDeviceId: cryptoDeviceId("other-manager-device"),
    };
    const changedDomain = {
      ...valid.authorization.context.expectedDomains[0]!,
      domainEpoch: domainEpoch(999),
    };
    for (const overrides of [
      {
        authorization: {
          ...valid.authorization,
          context: {
            ...valid.authorization.context,
            expectedState: {
              ...valid.authorization.context.expectedState,
              authorizationRevision: authorizationRevision(999),
            },
          },
        },
      },
      {
        authorization: {
          ...valid.authorization,
          currentManager: changedManager,
        },
      },
      {
        authorization: {
          ...valid.authorization,
          context: {
            ...valid.authorization.context,
            expectedManager: changedManager,
          },
        },
      },
      {
        signerPublication: {
          ...valid.signerPublication,
          managerDeviceId: cryptoDeviceId("other-manager-device"),
        },
      },
      {
        authorization: {
          ...valid.authorization,
          context: {
            ...valid.authorization.context,
            configInventory: {
              ...valid.authorization.context.configInventory,
              objectCount:
                valid.authorization.context.configInventory.objectCount + 1,
            },
          },
        },
      },
      {
        state: {
          ...valid.state,
          domainEnvelopes: valid.state.domainEnvelopes.slice(1),
        },
      },
      {
        authorization: {
          ...valid.authorization,
          context: {
            ...valid.authorization.context,
            expectedDomains:
              valid.authorization.context.expectedDomains.slice(1),
          },
        },
      },
      {
        state: {
          ...valid.state,
          domainEnvelopes: [
            {
              ...valid.state.domainEnvelopes[0]!,
              domainEpoch: domainEpoch(999),
            },
            valid.state.domainEnvelopes[1]!,
          ],
        },
      },
      {
        authorization: {
          ...valid.authorization,
          authorizedDomains: valid.authorization.authorizedDomains.slice(1),
        },
      },
      {
        authorization: {
          ...valid.authorization,
          context: {
            ...valid.authorization.context,
            expectedDomains: [
              changedDomain,
              valid.authorization.context.expectedDomains[1]!,
            ],
          },
        },
      },
      {
        authorization: {
          ...valid.authorization,
          authorizedDomains: [
            {
              ...valid.authorization.authorizedDomains[0]!,
              domainEpoch: domainEpoch(999),
            },
            valid.authorization.authorizedDomains[1]!,
          ],
        },
      },
    ]) {
      expect(authorize(overrides)).toThrow(
        "authorization does not match its write set",
      );
    }
  });

  test("fails before crypto or storage for incomplete, unordered, or unauthorized inputs", async () => {
    const crypto = new LatticeCrypto(seededRng(0x225_94));
    const signing = crypto.generateSigningKeyPair();
    const base = {
      crypto,
      operationId: "operation-negative",
      agentId: agentId("agent-negative"),
      authorizationRevision: authorizationRevision(0),
      configObjects: [{
        objectId: objectId("config-a"),
        configRevision: authorizationRevision(0),
        plaintextDek: bytes(1),
      }],
      domains: [{
        domainId: cryptoDomainId("domain-a"),
        domainEpoch: domainEpoch(0),
        agentAuthorizationRevision: authorizationRevision(0),
        committerDeviceId: cryptoDeviceId("device-a"),
        domainRoot: bytes(2),
        committerSigningPrivateKey: signing.privateKey,
      }],
      resolveCurrentDomainCommitterAuthority: () => signing.publicKey,
      manager: {
        managerHumanId: humanId("human-manager"),
        managerAuthorizationRevision: authorizationRevision(0),
        managerDeviceId: cryptoDeviceId("device-manager"),
      },
      managerSigningPrivateKey: signing.privateKey,
      resolveCurrentManagerAuthority: () => signing.publicKey,
    } as const;

    expect(prepareAgentRuntimeInitializationV2({
      ...base,
      configObjects: [],
      domains: [],
    })).rejects.toThrow("must contain at least one config object");
    expect(prepareAgentRuntimeInitializationV2({
      ...base,
      configObjects: [],
    })).rejects.toThrow("must contain at least one config object");
    expect(prepareAgentRuntimeInitializationV2({
      ...base,
      configObjects: [{
        ...base.configObjects[0],
        plaintextDek: bytes(1, 31),
      }],
    })).rejects.toThrow("plaintext DEK must contain exactly 32 bytes");
    expect(prepareAgentRuntimeInitializationV2({
      ...base,
      domains: [{
        ...base.domains[0],
        domainRoot: bytes(2, 31),
      }],
    })).rejects.toThrow("Domain root must contain exactly 32 bytes");
    expect(prepareAgentRuntimeInitializationV2({
      ...base,
      resolveCurrentDomainCommitterAuthority: () => null,
    })).rejects.toThrow("committer is not currently authorized");
    const wrongAuthority = crypto.generateSigningKeyPair();
    expect(prepareAgentRuntimeInitializationV2({
      ...base,
      resolveCurrentDomainCommitterAuthority: () =>
        wrongAuthority.publicKey,
    })).rejects.toThrow(
      "committer private key does not match current authority",
    );
    expect(prepareAgentRuntimeInitializationV2({
      ...base,
      configObjects: [
        base.configObjects[0],
        base.configObjects[0],
      ],
    })).rejects.toThrow("config objects must be sorted and unique");
    expect(prepareAgentRuntimeInitializationV2({
      ...base,
      domains: [
        base.domains[0],
        base.domains[0],
      ],
    })).rejects.toThrow("Domains must be sorted and unique");

    const mutated = await prepareAgentRuntimeInitializationV2(base);
    mutated.runtime.key.fill(0);
    expect(persistAgentRuntimeInitializationV2({
      crypto,
      storage: new InMemoryV2Store(),
      prepared: mutated,
      resolveCurrentAuthorization: () => null,
    })).rejects.toThrow("signer publication does not match");
  });

  test("wipes owned Runtime, config-DEK, Domain-root, and signing-key transients", async () => {
    class ObservingCrypto extends LatticeCrypto {
      readonly generated: Uint8Array[] = [];
      readonly sealKeys: Uint8Array[] = [];
      readonly sealPlaintexts: Uint8Array[] = [];
      readonly signingKeys: Uint8Array[] = [];

      override randomBytes(length: number): Uint8Array {
        const generated = super.randomBytes(length);
        this.generated.push(generated);
        return generated;
      }

      override aeadSeal(
        key: Uint8Array,
        plaintext: Uint8Array,
        aad?: Uint8Array,
      ): Uint8Array {
        this.sealKeys.push(key);
        this.sealPlaintexts.push(plaintext);
        return super.aeadSeal(key, plaintext, aad);
      }

      override sign(
        signingPrivateKey: Uint8Array,
        message: Uint8Array,
      ): Uint8Array {
        this.signingKeys.push(signingPrivateKey);
        return super.sign(signingPrivateKey, message);
      }
    }

    const crypto = new ObservingCrypto(seededRng(0x225_97));
    const signing = crypto.generateSigningKeyPair();
    crypto.generated.length = 0;
    crypto.signingKeys.length = 0;
    const callerDek = bytes(0x61);
    const callerRoot = bytes(0x62);
    const prepared = await prepareAgentRuntimeInitializationV2({
      crypto,
      operationId: "operation-wipe",
      agentId: agentId("agent-wipe"),
      authorizationRevision: authorizationRevision(0),
      configObjects: [{
        objectId: objectId("config-wipe"),
        configRevision: authorizationRevision(0),
        plaintextDek: callerDek,
      }],
      domains: [{
        domainId: cryptoDomainId("domain-wipe"),
        domainEpoch: domainEpoch(0),
        agentAuthorizationRevision: authorizationRevision(0),
        committerDeviceId: cryptoDeviceId("device-wipe"),
        domainRoot: callerRoot,
        committerSigningPrivateKey: signing.privateKey,
      }],
      resolveCurrentDomainCommitterAuthority: () => signing.publicKey,
      manager: {
        managerHumanId: humanId("human-manager"),
        managerAuthorizationRevision: authorizationRevision(0),
        managerDeviceId: cryptoDeviceId("device-manager"),
      },
      managerSigningPrivateKey: signing.privateKey,
      resolveCurrentManagerAuthority: () => signing.publicKey,
    });

    expect(crypto.generated[0]?.every((byte) => byte === 0)).toBe(true);
    expect(
      crypto.sealKeys.every((value) =>
        value.every((byte) => byte === 0)
      ),
    ).toBe(true);
    expect(
      crypto.sealPlaintexts.every((value) =>
        value.every((byte) => byte === 0)
      ),
    ).toBe(true);
    expect(
      crypto.signingKeys.every((value) =>
        value.every((byte) => byte === 0)
      ),
    ).toBe(true);
    expect(callerDek).toEqual(bytes(0x61));
    expect(callerRoot).toEqual(bytes(0x62));
    expect(signing.privateKey.some((byte) => byte !== 0)).toBe(true);
    expect(prepared.runtime.key.some((byte) => byte !== 0)).toBe(true);
  });

  test("accepts raw durable reads but never exposes a Runtime raw-state tagger", async () => {
    const state = await fixture(0x225_95);
    let durable: AgentRuntimeAtomicStorageWireV2 | null = null;
    let durableSignerPublication:
      typeof state.prepared.signerPublication | null = null;
    let puts = 0;
    const adapter = {
      getAgentRuntimeAtomicState: async () =>
        durable === null ? null : structuredClone(durable),
      getAgentRuntimeSignerPublication: async () =>
        durableSignerPublication === null
          ? null
          : structuredClone(durableSignerPublication),
      async putAgentRuntimeAtomicStateIfAbsent(authorized: Parameters<
        InMemoryV2Store["putAgentRuntimeAtomicStateIfAbsent"]
      >[0]) {
        puts += 1;
        const intended = authorized.state;
        durable = {
          runtime: structuredClone(intended.runtime),
          configInventory: structuredClone(intended.configInventory),
          configObjects: intended.configObjects.map((entry) => ({
            agentId: entry.agentId,
            objectId: entry.objectId,
            configRevision: entry.configRevision,
            runtimeGeneration: entry.runtimeGeneration,
            wrappedDekHash: entry.wrappedDekHash.slice(),
            wrappedDekBytes: entry.wrappedDek.ciphertext.slice(),
          })),
          domainEnvelopes: intended.domainEnvelopes.map((entry) => ({
            agentId: entry.agentId,
            domainId: entry.domainId,
            domainEpoch: entry.domainEpoch,
            agentAuthorizationRevision: entry.agentAuthorizationRevision,
            runtimeGeneration: entry.runtimeGeneration,
            committerDeviceId: entry.committerDeviceId,
            envelopeHash: entry.envelopeHash.slice(),
            envelopeBytes: entry.envelopeBytes.ciphertext.slice(),
          })),
          challengeConsumptions: [],
        };
        durableSignerPublication =
          structuredClone(authorized.signerPublication);
        return "inserted" as const;
      },
    };

    expect(await persistAgentRuntimeInitializationV2({
      ...persistenceInput(state),
      storage: adapter,
    })).toBe("inserted");
    expect(await persistAgentRuntimeInitializationV2({
      ...persistenceInput(state),
      storage: adapter,
    })).toBe("duplicate");
    expect(puts).toBe(1);
  });
});

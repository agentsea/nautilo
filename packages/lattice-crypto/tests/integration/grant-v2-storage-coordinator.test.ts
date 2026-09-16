import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  seededRng,
} from "../../src/crypto/index.ts";
import {
  serializeGrantV2,
  type GrantV2,
} from "../../src/format/grant-v2.ts";
import {
  mintGrantV2,
  type GrantOperationAuthorizationV2,
} from "../../src/grant/authorization.ts";
import {
  abortGrantUseV2,
  coordinateGrantUseV2 as coordinateGrantUseWithAuthorizationV2,
  GrantClaimOutcomeUnknownV2,
  preflightGrantUseV2,
  type GrantUseAuthorizationContextV2,
  type GrantUseAuthorizationDecisionV2,
  type GrantUsePreflightV2,
  type ResolveCurrentGrantUseAuthorizationV2,
} from "../../src/grant/storage-coordinator.ts";
import {
  InMemoryV2Store,
  type GrantWireRecordV2,
} from "../../src/storage/v2-store.ts";
import {
  accessRevision,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  humanId,
  namespaceId,
} from "../../src/v2-types/ids.ts";
import { opaqueBytes } from "../../src/v2-types/opaque.ts";
import * as publicApi from "../../src/index.ts";

const NOW = 4_000_000;

function allowDecision(
  context: GrantUseAuthorizationContextV2,
): GrantUseAuthorizationDecisionV2 {
  return Object.freeze({
    context,
    currentTime: context.preflightTime,
    issuingDeviceActive: true,
    recipientAgentAuthorized: true,
    requestedNamespacesAuthorized: true,
    requestedDomainsAuthorized: true,
    hostAllowsOperation: true,
    currentSingleUseStatus: context.singleUseStatus,
  });
}

type CoordinateGrantUseInput<Value> = Parameters<
  typeof coordinateGrantUseWithAuthorizationV2<Value>
>[0];

function coordinateGrantUseV2<Value>(
  input: Omit<CoordinateGrantUseInput<Value>, "resolveCurrentAuthorization">
    & Readonly<{
      readonly resolveCurrentAuthorization?:
        ResolveCurrentGrantUseAuthorizationV2;
    }>,
) {
  return coordinateGrantUseWithAuthorizationV2({
    ...input,
    resolveCurrentAuthorization:
      input.resolveCurrentAuthorization ?? allowDecision,
  });
}

function bytes(marker: number): Uint8Array {
  return new Uint8Array(32).fill(marker);
}

async function fixture(input: {
  readonly seed?: number;
  readonly singleUse?: boolean;
  readonly grantIdValue?: string;
} = {}): Promise<{
  readonly crypto: LatticeCrypto;
  readonly grant: GrantV2;
  readonly authorization: GrantOperationAuthorizationV2;
  readonly store: InMemoryV2Store;
  readonly aiRoot: Uint8Array;
}> {
  const crypto = new LatticeCrypto(seededRng(input.seed ?? 7_700));
  const issuer = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const aiRoot = bytes(0xab);
  const id = grantId(input.grantIdValue ?? "grant-coordinate");
  const grant = await mintGrantV2(crypto, {
    id,
    issuingDeviceId: cryptoDeviceId("alice-phone"),
    issuingHumanId: humanId("alice"),
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: agentId("genie"),
    recipientKeyId: "invocation-key",
    recipientEncryptionPublicKey: recipient.publicKey,
    scope: [humanId("alice")],
    operations: ["decrypt"],
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    coveredDomains: [{
      domainId: cryptoDomainId("domain-alice"),
      domainEpoch: domainEpoch(4),
      agentAuthorizationRevision: authorizationRevision(8),
      aiRoot,
    }],
    singleUse: input.singleUse ?? true,
  });
  const authorization: GrantOperationAuthorizationV2 = {
    now: NOW + 1,
    expectedIssuingDeviceId: cryptoDeviceId("alice-phone"),
    issuingDeviceHumanId: humanId("alice"),
    issuingDeviceSigningPublicKey: issuer.publicKey,
    issuingDeviceActive: true,
    recipientAgentId: agentId("genie"),
    recipientKeyId: "invocation-key",
    recipientEncryptionPrivateKey: recipient.privateKey,
    operation: "decrypt",
    singleUseAvailable: true,
    namespaceId: namespaceId("room-alice"),
    namespaceAccessRevision: accessRevision(3),
    namespaceParticipants: [humanId("alice")],
    domainId: cryptoDomainId("domain-alice"),
    domainEpoch: domainEpoch(4),
    agentAuthorizationRevision: authorizationRevision(8),
    hostAllowsOperation: true,
  };
  const store = new InMemoryV2Store();
  await store.putGrant({
    grantId: grant.id,
    grantBytes: opaqueBytes("grant", serializeGrantV2(grant)),
    consumed: false,
  });
  return { crypto, grant, authorization, store, aiRoot };
}

async function preflight(
  state: Awaited<ReturnType<typeof fixture>>,
): Promise<GrantUsePreflightV2> {
  const prepared = await preflightGrantUseV2(
    state.crypto,
    state.grant,
    state.authorization,
  );
  if (prepared === null) throw new Error("expected Grant preflight");
  return prepared;
}

async function observeWipedRoot<T>(
  run: () => Promise<T>,
): Promise<{
  readonly result?: T;
  readonly error?: unknown;
  readonly wiped: boolean;
}> {
  const originalFill = Uint8Array.prototype.fill;
  let wiped = false;
  Uint8Array.prototype.fill = function (
    value: number,
    start?: number,
    end?: number,
  ): Uint8Array {
    const before = this.slice();
    const result = originalFill.call(this, value, start, end);
    if (
      value === 0
      && before.length === 32
      && before.every((byte) => byte === 0xab)
      && this.every((byte) => byte === 0)
    ) {
      wiped = true;
    }
    return result;
  };
  try {
    return { result: await run(), wiped };
  } catch (error) {
    return { error, wiped };
  } finally {
    Uint8Array.prototype.fill = originalFill;
  }
}

async function observeResolverDecision(
  seed: number,
  decide: (
    context: GrantUseAuthorizationContextV2,
  ) => unknown,
): Promise<{
  readonly error?: unknown;
  readonly result?: unknown;
  readonly wiped: boolean;
  readonly claims: number;
  readonly executions: number;
}> {
  const state = await fixture({ seed });
  const prepared = await preflight(state);
  let claims = 0;
  let executions = 0;
  const observed = await observeWipedRoot(() =>
    coordinateGrantUseV2({
      preflight: prepared,
      storage: {
        consumeGrant: () => {
          claims += 1;
          return state.store.consumeGrant(state.grant.id);
        },
      },
      resolveCurrentAuthorization: (context) =>
        decide(context) as GrantUseAuthorizationDecisionV2,
      execute: () => {
        executions += 1;
        return "executed";
      },
    })
  );
  return {
    ...observed,
    claims,
    executions,
  };
}

describe("v2 Grant storage coordinator", () => {
  test("returns null when live authorization denies preflight", async () => {
    const state = await fixture({ seed: 7_708 });

    expect(
      await preflightGrantUseV2(
        state.crypto,
        state.grant,
        {
          ...state.authorization,
          hostAllowsOperation: false,
        },
      ),
    ).toBeNull();
  });

  test("normalizes base-context provider failure and wipes the canonical Grant wire", async () => {
    const state = await fixture({ seed: 7_709 });
    const expectedWire = serializeGrantV2(state.grant);
    const cause = new Error("injected Grant hash failure");
    let hashedWire: Uint8Array | null = null;
    state.crypto.hash = (value) => {
      hashedWire = value;
      throw cause;
    };
    const prepared = await preflightGrantUseV2(
      state.crypto,
      state.grant,
      state.authorization,
    );

    expect(prepared).toBeNull();
    expect(hashedWire).not.toBeNull();
    expect(hashedWire).not.toBe(expectedWire);
    expect(hashedWire!.every((byte) => byte === 0)).toBe(true);
  });

  test("claims exact single-use storage before the crypto tail and wipes afterward", async () => {
    const state = await fixture();
    const prepared = await preflight(state);
    let callbackRoot: Uint8Array | null = null;

    const result = await coordinateGrantUseV2({
      preflight: prepared,
      storage: state.store,
      execute: async (opened) => {
        expect((await state.store.getGrant(state.grant.id))?.consumed).toBe(
          true,
        );
        expect(opened.aiRoot).toEqual(state.aiRoot);
        callbackRoot = opened.aiRoot;
        return "executed";
      },
    });

    expect(result).toEqual({ status: "executed", value: "executed" });
    expect(callbackRoot).not.toBeNull();
    expect(callbackRoot!.every((byte) => byte === 0)).toBe(true);
    expect(
      coordinateGrantUseV2({
        preflight: prepared,
        storage: state.store,
        execute: () => "replayed",
      }),
    ).rejects.toThrow("already used");
  });

  test("explicitly aborts an unused preflight, wipes its root, and preserves the Grant", async () => {
    const state = await fixture({ seed: 7_875 });
    const prepared = await preflight(state);
    const observed = await observeWipedRoot(async () => {
      abortGrantUseV2(prepared);
    });

    expect(observed.error).toBeUndefined();
    expect(observed.wiped).toBe(true);
    expect((await state.store.getGrant(state.grant.id))?.consumed).toBe(false);
    expect(() => abortGrantUseV2(prepared)).toThrow("already used");
    let claims = 0;
    let executions = 0;
    expect(
      coordinateGrantUseV2({
        preflight: prepared,
        storage: {
          consumeGrant: (id) => {
            claims += 1;
            return state.store.consumeGrant(id);
          },
        },
        execute: () => {
          executions += 1;
          return "forbidden";
        },
      }),
    ).rejects.toThrow("already used");
    expect({ claims, executions }).toEqual({ claims: 0, executions: 0 });
  });

  test("rejects a forged preflight at the explicit abort boundary", async () => {
    const state = await fixture({ seed: 7_876 });
    const forged = Object.freeze({
      grantId: state.grant.id,
      preflightId: "grant-use-forged",
      singleUse: true,
    }) as GrantUsePreflightV2;

    expect(() => abortGrantUseV2(forged)).toThrow("untrusted");
  });

  test("only one concurrent use can claim and execute", async () => {
    const state = await fixture({ seed: 7_701 });
    const prepared = await preflight(state);
    let executions = 0;
    const execute = () => {
      executions += 1;
      return executions;
    };

    const results = await Promise.allSettled([
      coordinateGrantUseV2({
        preflight: prepared,
        storage: state.store,
        execute,
      }),
      coordinateGrantUseV2({
        preflight: prepared,
        storage: state.store,
        execute,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled"))
      .toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected"))
      .toHaveLength(1);
    expect(executions).toBe(1);
    expect((await state.store.getGrant(state.grant.id))?.consumed).toBe(true);
  });

  test("a false claim never executes and wipes the held root", async () => {
    const state = await fixture({ seed: 7_702 });
    const prepared = await preflight(state);
    let claims = 0;
    let executed = false;

    const observed = await observeWipedRoot(() =>
      coordinateGrantUseV2({
        preflight: prepared,
        storage: {
          consumeGrant: () => {
            claims += 1;
            return Promise.resolve(null);
          },
        },
        execute: () => {
          executed = true;
          return "forbidden";
        },
      })
    );

    expect(observed.error).toBeUndefined();
    expect(observed.result).toEqual({ status: "unavailable" });
    expect(observed.wiped).toBe(true);
    expect(claims).toBe(1);
    expect(executed).toBe(false);
  });

  test("revocation after preflight rejects before claim or root exposure", async () => {
    const state = await fixture({ seed: 7_712 });
    const prepared = await preflight(state);
    let claims = 0;
    let executed = false;

    const observed = await observeWipedRoot(() =>
      coordinateGrantUseV2({
        preflight: prepared,
        storage: {
          consumeGrant: () => {
            claims += 1;
            return Promise.resolve(null);
          },
        },
        resolveCurrentAuthorization: () => null,
        execute: () => {
          executed = true;
          return "forbidden";
        },
      } as Parameters<typeof coordinateGrantUseV2<string>>[0] & {
        readonly resolveCurrentAuthorization: () => null;
      })
    );

    expect(observed.result).toEqual({ status: "unavailable" });
    expect(observed.wiped).toBe(true);
    expect({ claims, executed }).toEqual({ claims: 0, executed: false });
  });

  test("fresh Grant authorization rejects every revoked or stale security axis before claim", async () => {
    const variants: readonly ((
      context: GrantUseAuthorizationContextV2,
    ) => GrantUseAuthorizationDecisionV2)[] = [
      (context) => ({
        ...allowDecision(context),
        context: {
          ...context,
          grantId: grantId("grant-substituted"),
        },
      }),
      (context) => ({
        ...allowDecision(context),
        context: {
          ...context,
          grantHash: new Uint8Array(32).fill(0xff),
        },
      }),
      (context) => ({
        ...allowDecision(context),
        context: {
          ...context,
          grantBytes: new Uint8Array(context.grantBytes.length).fill(0xff),
        },
      }),
      (context) => ({
        ...allowDecision(context),
        context: {
          ...context,
          issuingDeviceId: cryptoDeviceId("substituted-device"),
        },
      }),
      (context) => ({
        ...allowDecision(context),
        issuingDeviceActive: false,
      }),
      (context) => ({
        ...allowDecision(context),
        context: {
          ...context,
          recipientAgentId: agentId("substituted-agent"),
        },
      }),
      (context) => ({
        ...allowDecision(context),
        recipientAgentAuthorized: false,
      }),
      (context) => ({
        ...allowDecision(context),
        context: {
          ...context,
          operation: "encrypt",
        },
      }),
      (context) => ({
        ...allowDecision(context),
        requestedNamespacesAuthorized: false,
      }),
      (context) => ({
        ...allowDecision(context),
        context: {
          ...context,
          requestedNamespaceHeads: [{
            ...context.requestedNamespaceHeads[0]!,
            accessRevision:
              context.requestedNamespaceHeads[0]!.accessRevision + 1,
          }],
        },
      }),
      (context) => ({
        ...allowDecision(context),
        requestedDomainsAuthorized: false,
      }),
      (context) => ({
        ...allowDecision(context),
        context: {
          ...context,
          requestedDomains: [{
            ...context.requestedDomains[0]!,
            domainEpoch: context.requestedDomains[0]!.domainEpoch + 1,
          }],
        },
      }),
      (context) => ({
        ...allowDecision(context),
        context: {
          ...context,
          requestedDomains: [{
            ...context.requestedDomains[0]!,
            agentAuthorizationRevision:
              context.requestedDomains[0]!.agentAuthorizationRevision + 1,
          }],
        },
      }),
      (context) => ({
        ...allowDecision(context),
        currentTime: context.preflightTime - 1,
      }),
      (context) => ({
        ...allowDecision(context),
        currentTime: context.expiresAt,
      }),
      (context) => ({
        ...allowDecision(context),
        currentSingleUseStatus: "claimed-by-preflight",
      }),
    ];

    for (const [index, resolve] of variants.entries()) {
      const state = await fixture({ seed: 7_730 + index });
      const prepared = await preflight(state);
      let claims = 0;
      let executed = false;
      const observed = await observeWipedRoot(() =>
        coordinateGrantUseV2({
          preflight: prepared,
          storage: {
            consumeGrant: () => {
              claims += 1;
              return Promise.resolve(null);
            },
          },
          resolveCurrentAuthorization: resolve,
          execute: () => {
            executed = true;
            return "forbidden";
          },
        })
      );

      expect(observed.result).toEqual({ status: "unavailable" });
      expect(observed.wiped).toBe(true);
      expect({ claims, executed }).toEqual({
        claims: 0,
        executed: false,
      });
    }
  });

  test("accepts the exact inclusive issue and preflight-time boundary", async () => {
    const state = await fixture({ seed: 7_799 });
    const prepared = await preflightGrantUseV2(
      state.crypto,
      state.grant,
      {
        ...state.authorization,
        now: state.grant.issuedAt,
      },
    );
    expect(prepared).not.toBeNull();
    if (prepared === null) throw new Error("expected boundary preflight");

    const result = await coordinateGrantUseV2({
      preflight: prepared,
      storage: state.store,
      resolveCurrentAuthorization: (context) => {
        expect(context.preflightTime).toBe(context.issuedAt);
        return {
          ...allowDecision(context),
          currentTime: context.issuedAt,
        };
      },
      execute: () => "boundary",
    });

    expect(result).toEqual({ status: "executed", value: "boundary" });
  });

  test("rejects malformed resolver object and collection shapes exactly before claim", async () => {
    const cases: readonly Readonly<{
      readonly decide: (
        context: GrantUseAuthorizationContextV2,
      ) => unknown;
      readonly message: string;
    }>[] = [
      {
        decide: () => undefined,
        message: "Grant use authorization decision must be an object",
      },
      {
        decide: (context) =>
          Object.assign(
            () => undefined,
            allowDecision(context),
          ),
        message: "Grant use authorization decision must be an object",
      },
      {
        decide: (context) => ({
          ...allowDecision(context),
          unexpected: true,
        }),
        message: "Grant use authorization decision has an invalid field set",
      },
      {
        decide: (context) => {
          const {
            hostAllowsOperation: _omitted,
            ...missingField
          } = allowDecision(context);
          return missingField;
        },
        message: "Grant use authorization decision has an invalid field set",
      },
      {
        decide: (context) => ({
          ...allowDecision(context),
          context: null,
        }),
        message: "Grant use authorization context must be an object",
      },
      {
        decide: (context) => ({
          ...allowDecision(context),
          context: Object.assign(() => undefined, context),
        }),
        message: "Grant use authorization context must be an object",
      },
      {
        decide: (context) => ({
          ...allowDecision(context),
          context: {
            ...context,
            unexpected: true,
          },
        }),
        message: "Grant use authorization context has an invalid field set",
      },
      {
        decide: (context) => {
          const {
            recipientKeyId: _omitted,
            ...missingField
          } = context;
          return {
            ...allowDecision(context),
            context: missingField,
          };
        },
        message: "Grant use authorization context has an invalid field set",
      },
      {
        decide: (context) => ({
          ...allowDecision(context),
          context: {
            ...context,
            requestedNamespaceHeads: {
              map: (
                visit: (
                  value: GrantUseAuthorizationContextV2[
                    "requestedNamespaceHeads"
                  ][number],
                ) => unknown,
              ) => context.requestedNamespaceHeads.map(visit),
            },
          },
        }),
        message: "Requested Grant Namespace heads must be an array",
      },
      {
        decide: (context) => ({
          ...allowDecision(context),
          context: {
            ...context,
            requestedNamespaceHeads: [{
              ...context.requestedNamespaceHeads[0]!,
              participants: {
                map: (visit: (value: string) => unknown) =>
                  context.requestedNamespaceHeads[0]!.participants.map(visit),
              },
            }],
          },
        }),
        message: "Requested Grant Namespace participants must be an array",
      },
      {
        decide: (context) => ({
          ...allowDecision(context),
          context: {
            ...context,
            requestedDomains: {
              map: (
                visit: (
                  value: GrantUseAuthorizationContextV2[
                    "requestedDomains"
                  ][number],
                ) => unknown,
              ) => context.requestedDomains.map(visit),
            },
          },
        }),
        message: "Requested Grant Domains must be an array",
      },
      {
        decide: (context) => ({
          ...allowDecision(context),
          context: {
            ...context,
            coveredDomains: {
              map: (
                visit: (
                  value: GrantUseAuthorizationContextV2[
                    "coveredDomains"
                  ][number],
                ) => unknown,
              ) => context.coveredDomains.map(visit),
            },
          },
        }),
        message: "Covered Grant Domains must be an array",
      },
      {
        decide: (context) => ({
          ...allowDecision(context),
          context: {
            ...context,
            requestedNamespaceHeads: [{
              ...context.requestedNamespaceHeads[0]!,
              unexpected: true,
            }],
          },
        }),
        message: "Requested Grant Namespace head has an invalid field set",
      },
      {
        decide: (context) => ({
          ...allowDecision(context),
          context: {
            ...context,
            requestedDomains: [{
              ...context.requestedDomains[0]!,
              unexpected: true,
            }],
          },
        }),
        message: "Requested Grant Domain has an invalid field set",
      },
      {
        decide: (context) => ({
          ...allowDecision(context),
          context: {
            ...context,
            coveredDomains: [{
              ...context.coveredDomains[0]!,
              unexpected: true,
            }],
          },
        }),
        message: "Covered Grant Domain has an invalid field set",
      },
      {
        decide: (context) => ({
          ...allowDecision(context),
          context: {
            ...context,
            preflightId: "not a portable id",
          },
        }),
        message: "Grant preflight id",
      },
    ];

    for (const [index, entry] of cases.entries()) {
      const observed = await observeResolverDecision(
        7_800 + index,
        entry.decide,
      );
      expect(observed.error).toBeInstanceOf(Error);
      expect((observed.error as Error).message).toContain(entry.message);
      expect(observed.wiped).toBe(true);
      expect({
        claims: observed.claims,
        executions: observed.executions,
      }).toEqual({ claims: 0, executions: 0 });
    }
  });

  test("rejects every malformed resolver context scalar before claim", async () => {
    const mutations: readonly ((
      context: GrantUseAuthorizationContextV2,
    ) => Record<string, unknown>)[] = [
      (context) => ({ ...context, purpose: "authorize-something-else" }),
      (context) => ({ ...context, phase: "after-execute" }),
      (context) => ({ ...context, singleUseStatus: "consumed" }),
      (context) => ({ ...context, grantHash: "hash" }),
      (context) => ({ ...context, grantHash: new Uint8Array(31) }),
      (context) => ({ ...context, grantBytes: "grant" }),
      (context) => ({
        ...context,
        issuingDeviceSigningPublicKeyHash: "hash",
      }),
      (context) => ({
        ...context,
        issuingDeviceSigningPublicKeyHash: new Uint8Array(31),
      }),
      (context) => ({ ...context, issuedAt: Number.NaN }),
      (context) => ({ ...context, expiresAt: Number.NaN }),
      (context) => ({ ...context, preflightTime: Number.NaN }),
    ];

    for (const [index, mutate] of mutations.entries()) {
      const observed = await observeResolverDecision(
        7_820 + index,
        (context) => ({
          ...allowDecision(context),
          context: mutate(context),
        }),
      );
      expect(observed.error).toBeInstanceOf(TypeError);
      expect((observed.error as Error).message).toBe(
        "Grant use authorization context is invalid",
      );
      expect(observed.wiped).toBe(true);
      expect({
        claims: observed.claims,
        executions: observed.executions,
      }).toEqual({ claims: 0, executions: 0 });
    }
  });

  test("rejects every malformed resolver decision scalar before claim", async () => {
    const mutations: readonly ((
      decision: GrantUseAuthorizationDecisionV2,
    ) => Record<string, unknown>)[] = [
      (decision) => ({ ...decision, currentTime: Number.NaN }),
      (decision) => ({ ...decision, issuingDeviceActive: "yes" }),
      (decision) => ({ ...decision, recipientAgentAuthorized: "yes" }),
      (decision) => ({ ...decision, requestedNamespacesAuthorized: "yes" }),
      (decision) => ({ ...decision, requestedDomainsAuthorized: "yes" }),
      (decision) => ({ ...decision, hostAllowsOperation: "yes" }),
      (decision) => ({
        ...decision,
        currentSingleUseStatus: "consumed",
      }),
    ];

    for (const [index, mutate] of mutations.entries()) {
      const observed = await observeResolverDecision(
        7_840 + index,
        (context) => mutate(allowDecision(context)),
      );
      expect(observed.error).toBeInstanceOf(TypeError);
      expect((observed.error as Error).message).toBe(
        "Grant use authorization decision is invalid",
      );
      expect(observed.wiped).toBe(true);
      expect({
        claims: observed.claims,
        executions: observed.executions,
      }).toEqual({ claims: 0, executions: 0 });
    }
  });

  test("resolver failure consumes the preflight and wipes without claim or execute", async () => {
    const state = await fixture({ seed: 7_740 });
    const prepared = await preflight(state);
    const cause = new Error("fresh Grant authorization unavailable");
    let claims = 0;
    let executed = false;
    const observed = await observeWipedRoot(() =>
      coordinateGrantUseV2({
        preflight: prepared,
        storage: {
          consumeGrant: () => {
            claims += 1;
            return Promise.resolve(null);
          },
        },
        resolveCurrentAuthorization: () => {
          throw cause;
        },
        execute: () => {
          executed = true;
          return "forbidden";
        },
      })
    );

    expect(observed.error).toBe(cause);
    expect(observed.wiped).toBe(true);
    expect({ claims, executed }).toEqual({ claims: 0, executed: false });
    expect(
      coordinateGrantUseV2({
        preflight: prepared,
        storage: state.store,
        execute: () => "forbidden",
      }),
    ).rejects.toThrow("already used");
  });

  test("revocation during the claim await consumes storage but never exposes the root", async () => {
    const state = await fixture({ seed: 7_741 });
    const prepared = await preflight(state);
    let resolverCalls = 0;
    let executed = false;
    const observed = await observeWipedRoot(() =>
      coordinateGrantUseV2({
        preflight: prepared,
        storage: state.store,
        resolveCurrentAuthorization: (context) => {
          resolverCalls += 1;
          return resolverCalls === 1
            ? allowDecision(context)
            : {
              ...allowDecision(context),
              issuingDeviceActive: false,
            };
        },
        execute: () => {
          executed = true;
          return "forbidden";
        },
      })
    );

    expect(observed.result).toEqual({ status: "unavailable" });
    expect(observed.wiped).toBe(true);
    expect({ resolverCalls, executed }).toEqual({
      resolverCalls: 2,
      executed: false,
    });
    expect((await state.store.getGrant(state.grant.id))?.consumed).toBe(true);
  });

  test("throw-before-commit is surfaced, never retried, and wipes", async () => {
    const state = await fixture({ seed: 7_703 });
    const prepared = await preflight(state);
    const cause = new Error("claim failed before commit");
    let attempts = 0;
    const observed = await observeWipedRoot(() =>
      coordinateGrantUseV2({
        preflight: prepared,
        storage: {
          consumeGrant: () => {
            attempts += 1;
            return Promise.reject(cause);
          },
        },
        execute: () => "forbidden",
      })
    );

    expect(observed.error).toBeInstanceOf(GrantClaimOutcomeUnknownV2);
    expect((observed.error as Error).name).toBe(
      "GrantClaimOutcomeUnknownV2",
    );
    expect((observed.error as Error).message).toBe(
      "Single-use Grant claim outcome is ambiguous; retry is forbidden",
    );
    expect((observed.error as Error & { cause?: unknown }).cause).toBe(cause);
    expect(observed.wiped).toBe(true);
    expect(attempts).toBe(1);
    expect((await state.store.getGrant(state.grant.id))?.consumed).toBe(false);
    expect(
      coordinateGrantUseV2({
        preflight: prepared,
        storage: state.store,
        execute: () => "forbidden",
      }),
    ).rejects.toThrow("already used");
  });

  test("throw-after-commit remains ambiguous and never enters the crypto tail", async () => {
    const state = await fixture({ seed: 7_704 });
    const prepared = await preflight(state);
    const cause = new Error("ambiguous claim outcome");
    let executed = false;
    const observed = await observeWipedRoot(() =>
      coordinateGrantUseV2({
        preflight: prepared,
        storage: {
          async consumeGrant(id) {
            await state.store.consumeGrant(id);
            throw cause;
          },
        },
        execute: () => {
          executed = true;
          return "forbidden";
        },
      })
    );

    expect(observed.error).toBeInstanceOf(GrantClaimOutcomeUnknownV2);
    expect((observed.error as Error).name).toBe(
      "GrantClaimOutcomeUnknownV2",
    );
    expect((observed.error as Error).message).toBe(
      "Single-use Grant claim outcome is ambiguous; retry is forbidden",
    );
    expect((observed.error as Error & { cause?: unknown }).cause).toBe(cause);
    expect(observed.wiped).toBe(true);
    expect(executed).toBe(false);
    expect((await state.store.getGrant(state.grant.id))?.consumed).toBe(true);
    expect(
      coordinateGrantUseV2({
        preflight: prepared,
        storage: state.store,
        execute: () => "forbidden",
      }),
    ).rejects.toThrow("already used");
  });

  test("rejects every malformed raw claim-record shape before execute", async () => {
    const malformed: readonly unknown[] = [
      undefined,
      "claim",
      {},
      {
        grantId: "grant-coordinate",
        grantBytes: new Uint8Array(),
      },
      {
        grantId: "grant-coordinate",
        grantBytes: new Uint8Array(),
        consumed: true,
        unexpected: true,
      },
      {
        grantId: 7,
        grantBytes: new Uint8Array(),
        consumed: true,
      },
      {
        grantId: "grant-coordinate",
        grantBytes: "wire",
        consumed: true,
      },
      {
        grantId: "grant-coordinate",
        grantBytes: new Uint8Array(),
        consumed: "yes",
      },
    ];

    for (const [index, claimed] of malformed.entries()) {
      const state = await fixture({ seed: 7_720 + index });
      const prepared = await preflight(state);
      let executed = false;
      const observed = await observeWipedRoot(() =>
        coordinateGrantUseV2({
          preflight: prepared,
          storage: {
            consumeGrant: () =>
              Promise.resolve(claimed as GrantWireRecordV2),
          },
          execute: () => {
            executed = true;
            return "forbidden";
          },
        })
      );

      expect(observed.error).toBeInstanceOf(TypeError);
      expect((observed.error as Error).message).toBe(
        "Claimed Grant wire record is malformed",
      );
      expect(observed.wiped).toBe(true);
      expect(executed).toBe(false);
    }
  });

  test("rejects function-shaped and extra-field claims even when every Grant coordinate is exact", async () => {
    for (const [index, shape] of [
      (claimed: GrantWireRecordV2): unknown =>
        Object.assign(() => undefined, claimed),
      (claimed: GrantWireRecordV2): unknown => ({
        ...claimed,
        unexpected: true,
      }),
    ].entries()) {
      const state = await fixture({ seed: 7_855 + index });
      const prepared = await preflight(state);
      const claimed = await state.store.consumeGrant(state.grant.id);
      if (claimed === null) throw new Error("expected claimed Grant");
      let executed = false;

      const observed = await observeWipedRoot(() =>
        coordinateGrantUseV2({
          preflight: prepared,
          storage: {
            consumeGrant: () =>
              Promise.resolve(shape(claimed) as GrantWireRecordV2),
          },
          execute: () => {
            executed = true;
            return "forbidden";
          },
        })
      );

      expect(observed.error).toBeInstanceOf(TypeError);
      expect((observed.error as Error).message).toBe(
        "Claimed Grant wire record is malformed",
      );
      expect(observed.wiped).toBe(true);
      expect(executed).toBe(false);
    }
  });

  test("rejects invalid Grant wire and a raw id that disagrees with canonical wire", async () => {
    for (const [index, claimed] of [
      {
        grantId: "grant-coordinate",
        grantBytes: new Uint8Array([0xff]),
        consumed: true,
      },
      {
        grantId: "grant-coordinate",
        grantBytes: serializeGrantV2(
          (await fixture({
            seed: 7_730,
            grantIdValue: "grant-other",
          })).grant,
        ),
        consumed: true,
      },
    ].entries()) {
      const state = await fixture({ seed: 7_731 + index });
      const prepared = await preflight(state);
      const observed = await observeWipedRoot(() =>
        coordinateGrantUseV2({
          preflight: prepared,
          storage: {
            consumeGrant: () => Promise.resolve(claimed),
          },
          execute: () => "forbidden",
        })
      );

      expect(observed.error).toBeInstanceOf(Error);
      expect((observed.error as Error).message).toBe(
        "Claimed Grant wire record is noncanonical",
      );
      expect(observed.wiped).toBe(true);
    }
  });

  test("rejects a different canonical Grant with the same id", async () => {
    const state = await fixture({ seed: 7_740 });
    const substitute = await fixture({ seed: 7_741 });
    const prepared = await preflight(state);
    let executed = false;
    const observed = await observeWipedRoot(() =>
      coordinateGrantUseV2({
        preflight: prepared,
        storage: {
          consumeGrant: () =>
            Promise.resolve({
              grantId: state.grant.id,
              grantBytes: serializeGrantV2(substitute.grant),
              consumed: true,
            }),
        },
        execute: () => {
          executed = true;
          return "forbidden";
        },
      })
    );

    expect(observed.error).toBeInstanceOf(Error);
    expect((observed.error as Error).message).toBe(
      "Claimed Grant record does not match preflight",
    );
    expect(observed.wiped).toBe(true);
    expect(executed).toBe(false);
  });

  test("rejects a canonical claimed Grant whose id differs from the preflight", async () => {
    const state = await fixture({ seed: 7_742 });
    const other = await fixture({
      seed: 7_743,
      grantIdValue: "grant-other",
    });
    const prepared = await preflight(state);
    let executed = false;
    const observed = await observeWipedRoot(() =>
      coordinateGrantUseV2({
        preflight: prepared,
        storage: {
          consumeGrant: () =>
            Promise.resolve({
              grantId: other.grant.id,
              grantBytes: serializeGrantV2(other.grant),
              consumed: true,
            }),
        },
        execute: () => {
          executed = true;
          return "forbidden";
        },
      })
    );

    expect(observed.error).toBeInstanceOf(Error);
    expect((observed.error as Error).message).toBe(
      "Claimed Grant record does not match preflight",
    );
    expect(observed.wiped).toBe(true);
    expect(executed).toBe(false);
  });

  test("rejects every substituted claim-record coordinate before execute and wipes", async () => {
    for (const [index, substitute] of [
      (claimed: GrantWireRecordV2): GrantWireRecordV2 => ({
        ...claimed,
        grantId: "grant-substituted",
      }),
      (claimed: GrantWireRecordV2): GrantWireRecordV2 => ({
        ...claimed,
        consumed: false,
      }),
      (claimed: GrantWireRecordV2): GrantWireRecordV2 => {
        const ciphertext = claimed.grantBytes.slice();
        ciphertext[0] = ciphertext[0]! ^ 0xff;
        return {
          ...claimed,
          grantBytes: ciphertext,
        };
      },
      (claimed: GrantWireRecordV2): GrantWireRecordV2 => ({
        ...claimed,
        grantBytes: claimed.grantBytes.slice(0, -1),
      }),
    ].entries()) {
      const state = await fixture({ seed: 7_705 + index });
      const prepared = await preflight(state);
      const claimed = await state.store.consumeGrant(state.grant.id);
      if (claimed === null) throw new Error("expected claimed Grant");
      let executed = false;
      const observed = await observeWipedRoot(() =>
        coordinateGrantUseV2({
          preflight: prepared,
          storage: {
            consumeGrant: () => Promise.resolve(substitute(claimed)),
          },
          execute: () => {
            executed = true;
            return "forbidden";
          },
        })
      );

      expect(observed.error).toBeInstanceOf(Error);
      expect(observed.wiped).toBe(true);
      expect(executed).toBe(false);
    }
  });

  test("owns the canonical Grant snapshot across the HPKE await", async () => {
    const state = await fixture({ seed: 7_709 });
    const unstableGrant: GrantV2 = { ...state.grant };
    const originalOpen = state.crypto.openSealed.bind(state.crypto);
    state.crypto.openSealed = async (...args) => {
      const plaintext = await originalOpen(...args);
      Object.defineProperty(unstableGrant, "signature", {
        configurable: true,
        value: new Uint8Array(63),
      });
      return plaintext;
    };

    const prepared = await preflightGrantUseV2(
      state.crypto,
      unstableGrant,
      state.authorization,
    );
    expect(prepared).not.toBeNull();
    if (prepared === null) throw new Error("expected Grant preflight");
    const result = await coordinateGrantUseV2({
      preflight: prepared,
      storage: state.store,
      execute: (opened) => opened.domainId,
    });
    expect(result).toEqual({
      status: "executed",
      value: state.authorization.domainId,
    });
  });

  test("snapshots every mutable authorization coordinate before the HPKE await", async () => {
    const state = await fixture({ seed: 7_742 });
    const authorization = {
      ...state.authorization,
      issuingDeviceSigningPublicKey:
        state.authorization.issuingDeviceSigningPublicKey.slice(),
      recipientEncryptionPrivateKey:
        state.authorization.recipientEncryptionPrivateKey.slice(),
      namespaceParticipants: [...state.authorization.namespaceParticipants],
    };
    const originalOpen = state.crypto.openSealed.bind(state.crypto);
    state.crypto.openSealed = async (...args) => {
      const plaintext = await originalOpen(...args);
      authorization.issuingDeviceSigningPublicKey.fill(0);
      authorization.recipientEncryptionPrivateKey.fill(0);
      authorization.namespaceParticipants[0] = humanId("mallory");
      authorization.namespaceId = namespaceId("room-substituted");
      authorization.namespaceAccessRevision = accessRevision(99);
      authorization.domainId = cryptoDomainId("domain-substituted");
      authorization.domainEpoch = domainEpoch(99);
      authorization.agentAuthorizationRevision = authorizationRevision(99);
      return plaintext;
    };

    const prepared = await preflightGrantUseV2(
      state.crypto,
      state.grant,
      authorization,
    );
    expect(prepared).not.toBeNull();
    if (prepared === null) throw new Error("expected Grant preflight");
    let observed: GrantUseAuthorizationContextV2 | null = null;
    const result = await coordinateGrantUseV2({
      preflight: prepared,
      storage: state.store,
      resolveCurrentAuthorization: (context) => {
        observed = context;
        return allowDecision(context);
      },
      execute: (opened) => opened.domainId,
    });

    expect(result).toEqual({
      status: "executed",
      value: state.authorization.domainId,
    });
    expect(observed).toMatchObject({
      issuingDeviceId: state.grant.issuingDeviceId,
      recipientAgentId: state.grant.recipientAgentId,
      operation: state.authorization.operation,
      requestedNamespaceHeads: [{
        namespaceId: state.authorization.namespaceId,
        accessRevision: state.authorization.namespaceAccessRevision,
      }],
      requestedDomains: [{
        domainId: state.authorization.domainId,
        domainEpoch: state.authorization.domainEpoch,
        agentAuthorizationRevision:
          state.authorization.agentAuthorizationRevision,
      }],
    });
  });

  test("detaches every resolver-owned authorization byte field before later property access", async () => {
    const fields = [
      ["grantHash", "issuingDeviceId"],
      ["grantBytes", "issuingDeviceId"],
      ["issuingDeviceSigningPublicKeyHash", "recipientAgentId"],
    ] as const;

    for (const [index, [field, triggerField]] of fields.entries()) {
      const state = await fixture({ seed: 7_860 + index });
      const prepared = await preflight(state);
      const result = await coordinateGrantUseV2({
        preflight: prepared,
        storage: state.store,
        resolveCurrentAuthorization: (context) => {
          const mutableBytes = context[field].slice();
          const decisionContext = {
            ...context,
            [field]: mutableBytes,
          };
          Object.defineProperty(decisionContext, triggerField, {
            configurable: true,
            enumerable: true,
            get() {
              mutableBytes.fill(0xff);
              return context[triggerField];
            },
          });
          return {
            ...allowDecision(context),
            context: decisionContext,
          };
        },
        execute: () => "executed",
      });
      expect(result).toEqual({ status: "executed", value: "executed" });
    }
  });

  test("detaches provider-owned Grant and issuer-key hash outputs at preflight", async () => {
    const state = await fixture({ seed: 7_863 });
    const originalHash = state.crypto.hash.bind(state.crypto);
    const expectedGrantHash = originalHash(serializeGrantV2(state.grant));
    const expectedIssuerKeyHash = originalHash(
      state.authorization.issuingDeviceSigningPublicKey,
    );
    const providerHashes: Uint8Array[] = [];
    state.crypto.hash = (value) => {
      const result = originalHash(value);
      providerHashes.push(result);
      return result;
    };
    const prepared = await preflight(state);
    providerHashes.forEach((hash) => hash.fill(0xff));

    const result = await coordinateGrantUseV2({
      preflight: prepared,
      storage: state.store,
      resolveCurrentAuthorization: (context) => {
        expect(context.grantHash).toEqual(expectedGrantHash);
        expect(context.issuingDeviceSigningPublicKeyHash).toEqual(
          expectedIssuerKeyHash,
        );
        return allowDecision(context);
      },
      execute: () => "executed",
    });

    expect(result).toEqual({ status: "executed", value: "executed" });
  });

  test("reusable Grants execute without a storage claim, one preflight at a time", async () => {
    const state = await fixture({
      seed: 7_706,
      singleUse: false,
      grantIdValue: "grant-reusable",
    });
    let claims = 0;
    let resolverCalls = 0;
    const storage = {
      consumeGrant(): Promise<null> {
        claims += 1;
        return Promise.resolve(null);
      },
    };

    for (let index = 0; index < 2; index += 1) {
      const prepared = await preflight(state);
      const result = await coordinateGrantUseV2({
        preflight: prepared,
        storage,
        resolveCurrentAuthorization: (context) => {
          resolverCalls += 1;
          expect(context.phase).toBe("before-execute");
          expect(context.singleUseStatus).toBe("reusable");
          return allowDecision(context);
        },
        execute: (opened) => opened.aiRoot[0],
      });
      expect(result).toEqual({ status: "executed", value: 0xab });
    }
    expect(claims).toBe(0);
    expect(resolverCalls).toBe(2);
    expect((await state.store.getGrant(state.grant.id))?.consumed).toBe(false);
  });

  test("reusable denial returns the exact unavailable result without claiming or executing", async () => {
    const state = await fixture({
      seed: 7_864,
      singleUse: false,
      grantIdValue: "grant-reusable-denied",
    });
    const prepared = await preflight(state);
    let claims = 0;
    let executions = 0;

    const result = await coordinateGrantUseV2({
      preflight: prepared,
      storage: {
        consumeGrant: () => {
          claims += 1;
          return Promise.resolve(null);
        },
      },
      resolveCurrentAuthorization: (context) => ({
        ...allowDecision(context),
        hostAllowsOperation: false,
      }),
      execute: () => {
        executions += 1;
        return "forbidden";
      },
    });

    expect(result).toEqual({ status: "unavailable" });
    expect({ claims, executions }).toEqual({ claims: 0, executions: 0 });
  });

  test("requires an exact resolver function and consumes the preflight on rejection", async () => {
    const state = await fixture({ seed: 7_865 });
    const prepared = await preflight(state);

    const observed = await observeWipedRoot(() =>
      coordinateGrantUseWithAuthorizationV2({
        preflight: prepared,
        storage: state.store,
        resolveCurrentAuthorization:
          undefined as unknown as ResolveCurrentGrantUseAuthorizationV2,
        execute: () => "forbidden",
      })
    );

    expect(observed.error).toBeInstanceOf(TypeError);
    expect((observed.error as Error).message).toBe(
      "Current Grant use authorization resolver is required",
    );
    expect(observed.wiped).toBe(true);
    expect(
      coordinateGrantUseV2({
        preflight: prepared,
        storage: state.store,
        execute: () => "forbidden",
      }),
    ).rejects.toThrow("already used");
  });

  test("forged capabilities fail and the supported root exposes no direct root opener", async () => {
    const state = await fixture({ seed: 7_707 });
    const forged = Object.freeze({
      grantId: state.grant.id,
      singleUse: true,
    }) as GrantUsePreflightV2;

    expect(
      coordinateGrantUseV2({
        preflight: forged,
        storage: state.store,
        execute: () => "forbidden",
      }),
    ).rejects.toThrow("untrusted");
    expect("openGrantV2ForOperation" in publicApi).toBe(false);
    expect("preflightGrantUse" in publicApi).toBe(true);
    expect("abortGrantUse" in publicApi).toBe(true);
    expect("coordinateGrantUse" in publicApi).toBe(true);
  });
});

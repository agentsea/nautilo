import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  portableIdIsValid,
} from "@nautilo/lattice-crypto";

import {
  createProtectedCheckpointCellCrypto,
  type ProtectedCheckpointCellAuthorityPort,
  type ProtectedCheckpointInvocationScope,
  type ProtectedCheckpointNamespaceMaterial,
} from "../../src/checkpoint/protected-checkpoint-cell-crypto";

const encoder = new TextEncoder();

const SCOPE: ProtectedCheckpointInvocationScope = Object.freeze({
  logicalThreadId: "room:room-a:bot:agent-a",
  namespaceId: "namespace-a",
  keyClass: "ai",
  expectedAccessRevision: 7,
  expectedPolicyRevision: 11,
  authorizationSession: Object.freeze({ viewId: "view-a" }),
});

const COORDINATE = Object.freeze({
  kind: "write" as const,
  threadId: "nautilo:encrypted-checkpoint-shadow:v1:thread-a",
  checkpointNs: "nautilo:encrypted-checkpoint-shadow:v1:checkpoint-ns-a",
  checkpointId: "checkpoint-a",
  taskId: "task-a",
  index: 2,
  channel: "messages",
});

async function expectCheckpointError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error("expected protected checkpoint operation to reject");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

async function expectErrorMessage(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await promise;
    throw new Error("expected protected checkpoint operation to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
  }
}

function fixture(options: Readonly<{
  currentGeneration?: number;
  accessRevision?: number;
  policyRevision?: number;
}> = {}) {
  let next = 0;
  const crypto = new LatticeCrypto({
    bytes(length) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = (next++ * 29 + 17) & 0xff;
      }
      return bytes;
    },
  });
  const currentKey = new Uint8Array(32).fill(0x31);
  const previousKey = new Uint8Array(32).fill(0x22);
  const calls: Array<Readonly<{
    operation: string;
    namespaceId: string;
    domainId: string;
    entrypointId: string;
  }>> = [];
  const material: ProtectedCheckpointNamespaceMaterial = Object.freeze({
    namespaceId: "namespace-a",
    domainId: "domain-a",
    domainEpoch: 2,
    accessRevision: options.accessRevision ?? 7,
    agentAuthorizationRevision: options.policyRevision ?? 11,
    bindingHash: new Uint8Array(32).fill(0x23),
    currentGeneration: options.currentGeneration ?? 4,
    generations: Object.freeze([
      Object.freeze({ generation: 3, key: previousKey }),
      Object.freeze({ generation: 4, key: currentKey }),
    ]),
  });
  let active = true;
  let remainingMs = 5_000;
  const authority: ProtectedCheckpointCellAuthorityPort = {
    execute: async (input) => {
      calls.push({
        operation: input.operation,
        namespaceId: input.namespaceId,
        domainId: input.domainId,
        entrypointId: input.entrypointId,
      });
      const controller = new AbortController();
      try {
        return await input.execute({
          signal: controller.signal,
          assertActive() {
            if (!active) throw new Error("authority stale");
          },
          assertCommitAllowed() {
            if (!active) {
              return Promise.reject(new Error("authority stale"));
            }
            return Promise.resolve();
          },
          remainingMs() {
            return remainingMs;
          },
          material,
        });
      } finally {
        for (const entry of material.generations) entry.key.fill(0);
      }
    },
  };
  const cellCrypto = createProtectedCheckpointCellCrypto({
    crypto,
    authority,
    domainId: "domain-a",
    entrypointId: "foreground.main",
  });
  return {
    calls,
    cellCrypto,
    currentKey,
    previousKey,
    revoke() {
      active = false;
    },
    setRemainingMs(value: number) {
      remainingMs = value;
    },
  };
}

describe("protected checkpoint cell crypto", () => {
  test("bounds physical coordinates independently of portable authority IDs and authenticates every byte", async () => {
    const coordinate = {
      ...COORDINATE,
      threadId: "t".repeat(4_096),
      checkpointNs: "n".repeat(4_096),
    };
    expect(portableIdIsValid("t".repeat(129))).toBeFalse();
    const state = fixture();
    const plaintext = encoder.encode("private checkpoint write");
    const ciphertext = await state.cellCrypto.executeAuthorizedOperation({
      operation: "write", scope: SCOPE,
      execute: (context) => state.cellCrypto.seal({
        scope: SCOPE, coordinate, plaintext, signal: context.signal,
      }),
    });
    const reader = fixture();
    await reader.cellCrypto.executeAuthorizedOperation({
      operation: "read", scope: SCOPE,
      execute: async (context) => {
        const opened = await reader.cellCrypto.open({
          scope: SCOPE, coordinate, ciphertext, signal: context.signal,
        });
        expect(opened).toEqual(plaintext);
        opened.fill(0);
        for (const field of ["threadId", "checkpointNs"] as const) {
          await expectCheckpointError(reader.cellCrypto.open({
            scope: SCOPE,
            coordinate: { ...coordinate, [field]: `${coordinate[field].slice(0, -1)}x` },
            ciphertext, signal: context.signal,
          }), "authentication_failed");
        }
      },
    });
    await expectCheckpointError(state.cellCrypto.executeAuthorizedOperation({
      operation: "write",
      scope: { ...SCOPE, logicalThreadId: "t".repeat(129) },
      execute: () => Promise.resolve(),
    }), "scope_invalid");
  });

  test.each(["", "_invalid", "has space", "has|separator", "has\u0000control", "non-ascii-é", "x".repeat(4_097)])(
    "rejects malformed or oversized physical coordinates (%#)", async (value) => {
      const state = fixture();
      await state.cellCrypto.executeAuthorizedOperation({
        operation: "write", scope: SCOPE,
        execute: async (context) => {
          for (const field of ["threadId", "checkpointNs"] as const) {
            await expectCheckpointError(state.cellCrypto.seal({
              scope: SCOPE, coordinate: { ...COORDINATE, [field]: value },
              plaintext: encoder.encode("private write"), signal: context.signal,
            }), "coordinate_invalid");
          }
        },
      });
    },
  );

  test.each([
    {
      kind: "channel" as const,
      threadId: COORDINATE.threadId,
      checkpointNs: COORDINATE.checkpointNs,
      channel: "__start__",
      version: "1",
    },
    { ...COORDINATE, channel: "__no_writes__" },
  ])("binds reserved LangGraph $channel without accepting unknown names or coordinate substitution", async (coordinate) => {
    const writer = fixture();
    const plaintext = encoder.encode("private initial graph input");
    const ciphertext = await writer.cellCrypto.executeAuthorizedOperation({
      operation: "write",
      scope: SCOPE,
      execute: (context) => writer.cellCrypto.seal({
        scope: SCOPE, coordinate, plaintext, signal: context.signal,
      }),
    });
    const reader = fixture();
    await reader.cellCrypto.executeAuthorizedOperation({
      operation: "read",
      scope: SCOPE,
      execute: async (context) => {
        await expectCheckpointError(reader.cellCrypto.open({
          scope: SCOPE,
          coordinate: { ...coordinate, channel: "__unknown_reserved__" },
          ciphertext,
          signal: context.signal,
        }), "coordinate_invalid");
        await expectCheckpointError(reader.cellCrypto.open({
          scope: SCOPE,
          coordinate: { ...coordinate, channel: "__error__" },
          ciphertext,
          signal: context.signal,
        }), "authentication_failed");
        const opened = await reader.cellCrypto.open({
          scope: SCOPE, coordinate, ciphertext, signal: context.signal,
        });
        expect(opened).toEqual(plaintext);
        opened.fill(0);
      },
    });
  });

  test("seals and opens only inside fresh exact-scope operation leases", async () => {
    const state = fixture();
    let ciphertext: Uint8Array = new Uint8Array();
    const plaintext = encoder.encode("confidential checkpoint value");

    await state.cellCrypto.executeAuthorizedOperation({
      operation: "write",
      scope: SCOPE,
      execute: async (context) => {
        ciphertext = await state.cellCrypto.seal({
          scope: SCOPE,
          coordinate: COORDINATE,
          plaintext,
          signal: context.signal,
        });
      },
    });
    expect(ciphertext).not.toEqual(plaintext);
    expect(state.currentKey).toEqual(new Uint8Array(32));
    expect(state.previousKey).toEqual(new Uint8Array(32));

    const readState = fixture();
    let opened: Uint8Array = new Uint8Array();
    await readState.cellCrypto.executeAuthorizedOperation({
      operation: "read",
      scope: SCOPE,
      execute: async (context) => {
        opened = await readState.cellCrypto.open({
          scope: SCOPE,
          coordinate: COORDINATE,
          ciphertext,
          signal: context.signal,
        });
      },
    });

    expect(new TextDecoder().decode(opened)).toBe(
      "confidential checkpoint value",
    );
    opened.fill(0);
    expect(state.calls).toEqual([{
      operation: "encrypt",
      namespaceId: "namespace-a",
      domainId: "domain-a",
      entrypointId: "foreground.main",
    }]);
    expect(readState.calls).toEqual([{
      operation: "decrypt",
      namespaceId: "namespace-a",
      domainId: "domain-a",
      entrypointId: "foreground.main",
    }]);
  });

  test("authenticates the exact physical coordinate and scope revisions", async () => {
    const write = fixture();
    let ciphertext: Uint8Array = new Uint8Array();
    await write.cellCrypto.executeAuthorizedOperation({
      operation: "write",
      scope: SCOPE,
      execute: async (context) => {
        ciphertext = await write.cellCrypto.seal({
          scope: SCOPE,
          coordinate: COORDINATE,
          plaintext: encoder.encode("bound"),
          signal: context.signal,
        });
      },
    });

    for (const changed of [
      { ...COORDINATE, checkpointId: "checkpoint-b" },
      { ...COORDINATE, taskId: "task-b" },
      { ...COORDINATE, index: 3 },
      { ...COORDINATE, channel: "other" },
    ]) {
      const read = fixture();
      await expectCheckpointError(
        read.cellCrypto.executeAuthorizedOperation({
        operation: "read",
        scope: SCOPE,
        execute: async (context) => {
          await read.cellCrypto.open({
            scope: SCOPE,
            coordinate: changed,
            ciphertext,
            signal: context.signal,
          });
        },
        }),
        "authentication_failed",
      );
    }

    const revisedScope = Object.freeze({
      ...SCOPE,
      expectedAccessRevision: 8,
    });
    const revised = fixture({ accessRevision: 8 });
    await expectCheckpointError(
      revised.cellCrypto.executeAuthorizedOperation({
        operation: "read",
        scope: revisedScope,
        execute: async (context) => {
          await revised.cellCrypto.open({
            scope: revisedScope,
            coordinate: COORDINATE,
            ciphertext,
            signal: context.signal,
          });
        },
      }),
      "authentication_failed",
    );
  });

  test("opens retained historical Namespace generations", async () => {
    const old = fixture({ currentGeneration: 3 });
    let ciphertext: Uint8Array = new Uint8Array();
    await old.cellCrypto.executeAuthorizedOperation({
      operation: "write",
      scope: SCOPE,
      execute: async (context) => {
        ciphertext = await old.cellCrypto.seal({
          scope: SCOPE,
          coordinate: COORDINATE,
          plaintext: encoder.encode("generation three"),
          signal: context.signal,
        });
      },
    });

    const current = fixture({ currentGeneration: 4 });
    let opened: Uint8Array = new Uint8Array();
    await current.cellCrypto.executeAuthorizedOperation({
      operation: "read",
      scope: SCOPE,
      execute: async (context) => {
        opened = await current.cellCrypto.open({
          scope: SCOPE,
          coordinate: COORDINATE,
          ciphertext,
          signal: context.signal,
        });
      },
    });
    expect(new TextDecoder().decode(opened)).toBe("generation three");
    opened.fill(0);
  });

  test("fails closed outside a live matching operation and after revocation", async () => {
    const state = fixture();
    await expectCheckpointError(state.cellCrypto.seal({
      scope: SCOPE,
      coordinate: COORDINATE,
      plaintext: encoder.encode("no lease"),
      signal: new AbortController().signal,
    }), "authorization_unavailable");

    await expectErrorMessage(state.cellCrypto.executeAuthorizedOperation({
      operation: "delete",
      scope: SCOPE,
      execute: async (context) => {
        state.revoke();
        context.assertActive();
      },
    }), "authority stale");

    const expired = fixture();
    expired.setRemainingMs(0);
    await expectCheckpointError(expired.cellCrypto.executeAuthorizedOperation({
      operation: "cleanup",
      scope: SCOPE,
      execute: async () => undefined,
    }), "authorization_unavailable");

    const cleanup = fixture();
    await cleanup.cellCrypto.executeAuthorizedOperation({
      operation: "delete",
      scope: SCOPE,
      execute: async () => undefined,
    });
    expect(cleanup.calls).toEqual([{
      operation: "encrypt",
      namespaceId: "namespace-a",
      domainId: "domain-a",
      entrypointId: "foreground.main",
    }]);
  });

  test("rejects tamper, wrong direction, and caller mutation", async () => {
    const state = fixture();
    const plaintext = encoder.encode("immutable input");
    let ciphertext: Uint8Array = new Uint8Array();
    await state.cellCrypto.executeAuthorizedOperation({
      operation: "write",
      scope: SCOPE,
      execute: async (context) => {
        ciphertext = await state.cellCrypto.seal({
          scope: SCOPE,
          coordinate: COORDINATE,
          plaintext,
          signal: context.signal,
        });
        await expectCheckpointError(state.cellCrypto.open({
          scope: SCOPE,
          coordinate: COORDINATE,
          ciphertext,
          signal: context.signal,
        }), "operation_mismatch");
      },
    });
    expect(new TextDecoder().decode(plaintext)).toBe("immutable input");

    ciphertext[ciphertext.length - 1]! ^= 0x80;
    const read = fixture();
    await expectCheckpointError(read.cellCrypto.executeAuthorizedOperation({
      operation: "read",
      scope: SCOPE,
      execute: async (context) => {
        await read.cellCrypto.open({
          scope: SCOPE,
          coordinate: COORDINATE,
          ciphertext,
          signal: context.signal,
        });
      },
    }), "authentication_failed");
  });
});

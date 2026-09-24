import { describe, expect, test } from "bun:test";

import {
  bindEncryptionDataOperationOwner,
  ClassifiedDataOperationError,
  type DataOperationPolicySnapshot,
} from "../../src/transition/encryption-data-operation-owner.ts";
import {
  mutateTaskContentV1,
  readTaskContentV1,
} from "../../src/task/task-content-operation.ts";
import {
  TASK_CONTENT_PAYLOAD_VERSION_V1,
  deriveTaskContentCryptoObjectIdV1,
  type PreparedTaskContentCryptoRevisionV1,
  type TaskContentPayloadV1,
} from "../../src/task/task-content-repository.ts";

const coordinate = Object.freeze({
  kind: "definition" as const,
  taskId: "10000000-0000-4000-8000-000000000001",
  contentRevision: 1,
});
const content = Object.freeze({
  coordinate,
  payload: Object.freeze({
    formatVersion: 1 as const,
    prompt: "Private task",
    expectedOutput: null,
    protectedMetadata: Object.freeze({ target: "file:///private" }),
  }),
} satisfies TaskContentPayloadV1);

function operationOwner(
  snapshot: DataOperationPolicySnapshot,
  calls: string[],
) {
  return bindEncryptionDataOperationOwner({
    policy: {
      async resolve() {
        calls.push("resolve");
        return snapshot;
      },
      async revalidate(token) {
        calls.push(`revalidate:${token}`);
      },
    },
  });
}

function prepared(): PreparedTaskContentCryptoRevisionV1 {
  return Object.freeze({
    coordinate,
    objectId: deriveTaskContentCryptoObjectIdV1(coordinate),
    objectType: "nautilo-task-definition-v1",
    payloadVersion: TASK_CONTENT_PAYLOAD_VERSION_V1,
    namespaceId: "20000000-0000-4000-8000-000000000001",
    authorityFingerprint: new Uint8Array(32).fill(1),
  });
}

describe("Task content transition operation", () => {
  test.each([
    [
      { mode: "plaintext_only", shadowBehavior: "fallback" } as const,
      "ordinary",
    ],
    [
      { mode: "shadow_encryption", shadowBehavior: "strict" } as const,
      "dual",
    ],
    [
      { mode: "encrypted_only", shadowBehavior: "fallback" } as const,
      "protected",
    ],
  ])("prepares only the selected %s mutation", async (policy, expected) => {
    const calls: string[] = [];
    const result = await mutateTaskContentV1({
      owner: operationOwner({ policy, revalidationToken: 7 }, calls),
      content,
      ports: {
        async prepareProtected(input) {
          calls.push(`prepare:${new TextDecoder().decode(input.canonicalBytes)}`);
          return prepared();
        },
        async reserveProtected(plan, context) {
          calls.push(`reserve:${plan.representation}:${context.revalidationToken}`);
        },
        async publish(plan, context) {
          calls.push(`publish:${plan.representation}:${context.revalidationToken}`);
          return plan.representation;
        },
      },
    });

    expect(result).toBe(expected as "ordinary" | "dual" | "protected");
    expect(calls.some((entry) => entry.startsWith("prepare:"))).toBe(
      expected !== "ordinary",
    );
    expect(calls.some((entry) => entry.startsWith("reserve:"))).toBe(
      expected !== "ordinary",
    );
    expect(calls.at(-1)).toBe(`publish:${expected}:7`);
  });

  test("fallback Shadow re-resolves before publishing ordinary content", async () => {
    const calls: string[] = [];
    let resolves = 0;
    const owner = bindEncryptionDataOperationOwner({
      policy: {
        async resolve() {
          resolves += 1;
          calls.push("resolve");
          return {
            policy: { mode: "shadow_encryption", shadowBehavior: "fallback" },
            revalidationToken: resolves,
          };
        },
        async revalidate(token) {
          calls.push(`revalidate:${token}`);
        },
      },
    });

    const result = await mutateTaskContentV1({
      owner,
      content,
      ports: {
        prepareProtected: () => Promise.reject(
          new ClassifiedDataOperationError(
            "recoverable_availability",
            "Namespace key is waiting",
          ),
        ),
        async reserveProtected() {
          calls.push("reserve");
        },
        async publish(plan, context) {
          calls.push(`publish:${plan.representation}:${context.revalidationToken}`);
          return plan.representation;
        },
      },
    });

    expect(result).toBe("ordinary");
    expect(calls.at(-1)).toBe("publish:ordinary:2");
  });

  test("reads protected first and validates exact returned coordinates", async () => {
    const calls: string[] = [];
    const result = await readTaskContentV1({
      owner: operationOwner({
        policy: { mode: "shadow_encryption", shadowBehavior: "strict" },
        revalidationToken: 9,
      }, calls),
      coordinate,
      ports: {
        async readOrdinary() {
          calls.push("ordinary");
          return content;
        },
        async readProtected() {
          calls.push("protected");
          return content;
        },
      },
    });
    expect(result).toMatchObject({ representation: "protected", value: content });
    expect(calls).not.toContain("ordinary");

    expect(readTaskContentV1({
      owner: operationOwner({
        policy: { mode: "encrypted_only", shadowBehavior: "fallback" },
        revalidationToken: 10,
      }, []),
      coordinate,
      ports: {
        readOrdinary: async () => content,
        readProtected: async () => Object.freeze({
          ...content,
          coordinate: Object.freeze({ ...coordinate, contentRevision: 2 }),
        }),
      },
    })).rejects.toThrow("coordinates disagree");
  });
});

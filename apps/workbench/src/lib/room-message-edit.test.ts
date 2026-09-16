import { expect, test } from "bun:test";
import { editRoomMessageWithPolicy } from "./room-message-edit";
import { bindEncryptionDataOperationOwner, ClassifiedDataOperationError } from "@nautilo/lattice-bridge";

function fixture(mode: string) {
  const calls: string[] = [];
  const input = {
    api: { editRoomMessage: async () => {
      calls.push("ordinary");
      return { message: { content: "edited", editRevision: 1 } } as never;
    } },
    owner: bindEncryptionDataOperationOwner({ policy: {
      resolve: async () => {
        if (mode === "unknown") throw new Error("policy unavailable");
        return {
          policy: {
            mode: mode as "plaintext_only" | "shadow_encryption" | "encrypted_only",
            shadowBehavior: "fallback" as const,
          },
          revalidationToken: 7,
        };
      },
      revalidate: async (revision: number) => {
        calls.push(`fence:${revision}`);
      },
    } }),
    protectedEdit: async () => {
      calls.push("protected");
      return { content: "edited", editRevision: 1 };
    },
    roomId: "room", messageId: "123",
    body: { content: "private draft", expectedRevision: 0 },
  };
  return { calls, input };
}

test("Full edits exclusively use device custody", async () => {
  const { input, calls } = fixture("encrypted_only");
  expect(await editRoomMessageWithPolicy(input)).toEqual({ content: "edited", editRevision: 1 });
  expect(calls).toEqual(["fence:7", "protected"]);
});

test("Full missing custody and rejected edit never fall back", async () => {
  const { input, calls } = fixture("encrypted_only");
  await expect(editRoomMessageWithPolicy({ ...input, protectedEdit: undefined })).rejects.toThrow();
  await expect(editRoomMessageWithPolicy({ ...input, protectedEdit: async () => {
    throw new Error("conflict");
  } })).rejects.toThrow("conflict");
  expect(calls).toEqual(["fence:7"]);
  expect(input.body.content).toBe("private draft");
});

test("unavailable or unreadable policy prevents both transports", async () => {
  const { input, calls } = fixture("unknown");
  await expect(editRoomMessageWithPolicy(input)).rejects.toThrow();
  await expect(editRoomMessageWithPolicy({ ...input, owner: bindEncryptionDataOperationOwner({ policy: {
    resolve: async () => { throw new Error("offline"); },
    revalidate: async () => undefined,
  } }) })).rejects.toThrow("offline");
  expect(calls).toEqual([]);
});

test("Plain retains the ordinary edit", async () => {
  const mode = "plaintext_only";
  const { input, calls } = fixture(mode);
  await editRoomMessageWithPolicy(input);
  expect(calls).toEqual(["fence:7", "ordinary"]);
});

test.each(["fallback", "strict"] as const)("Shadow %s uses the protected edit", async (shadowBehavior) => {
  const { input, calls } = fixture("shadow_encryption");
  await editRoomMessageWithPolicy({
    ...input,
    owner: bindEncryptionDataOperationOwner({ policy: {
      resolve: async () => ({
        policy: { mode: "shadow_encryption", shadowBehavior },
        revalidationToken: 7,
      }),
      revalidate: async (revision: number) => { calls.push(`fence:${revision}`); },
    } }),
  });
  expect(calls).toEqual(["fence:7", "protected"]);
});

test("Fallback Shadow retries an explicitly eligible protected failure", async () => {
  const { input, calls } = fixture("shadow_encryption");
  await editRoomMessageWithPolicy({
    ...input,
    protectedEdit: async () => {
      calls.push("protected");
      throw new ClassifiedDataOperationError("key_waiting", "key waiting");
    },
  });
  expect(calls).toEqual(["fence:7", "protected", "fence:7", "ordinary"]);
});

test("Fallback never infers retry authority from an arbitrary error string", async () => {
  const { input, calls } = fixture("shadow_encryption");
  await expect(editRoomMessageWithPolicy({ ...input, protectedEdit: () =>
    Promise.reject(new Error("authority stale key_unavailable")),
  })).rejects.toThrow("authority stale");
  expect(calls).toEqual(["fence:7"]);
});

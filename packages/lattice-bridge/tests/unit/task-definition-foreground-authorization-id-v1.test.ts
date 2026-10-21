import { expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  deriveTaskDefinitionForegroundRecipientKeyIdV1,
  taskDefinitionForegroundAuthorizationIdV1,
} from "../../src/task/task-definition-foreground-authorization-id-v1";

test("Task recipient identity binds its exact authorization and parent signer within the existing ID format", () => {
  const crypto = new LatticeCrypto();
  const parentAgentSignerPublicKey = new Uint8Array(32).fill(1);
  const authorization = (parentOperationId: string) => taskDefinitionForegroundAuthorizationIdV1(crypto, {
    parentOperationId, taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    operation: "create", targetContentRevision: 1, workDescriptorDigest: new Uint8Array(32).fill(2),
  });
  const authorizationId = authorization("operation:original");
  const first = deriveTaskDefinitionForegroundRecipientKeyIdV1(crypto, {
    authorizationId, parentAgentSignerPublicKey,
  });
  expect(first).toMatch(/^task-key:[0-9a-f]{64}$/u);
  expect(new TextEncoder().encode(first)).toHaveLength(73);
  expect(deriveTaskDefinitionForegroundRecipientKeyIdV1(crypto, {
    authorizationId, parentAgentSignerPublicKey: parentAgentSignerPublicKey.slice(),
  })).toBe(first);
  expect(deriveTaskDefinitionForegroundRecipientKeyIdV1(crypto, {
    authorizationId, parentAgentSignerPublicKey: new Uint8Array(32).fill(3),
  })).not.toBe(first);
  expect(deriveTaskDefinitionForegroundRecipientKeyIdV1(crypto, {
    authorizationId: authorization("operation:another"), parentAgentSignerPublicKey,
  })).not.toBe(first);
  expect(parentAgentSignerPublicKey.every(byte => byte === 1)).toBe(true);
  expect(() => deriveTaskDefinitionForegroundRecipientKeyIdV1(crypto, {
    authorizationId: `${authorizationId}x`, parentAgentSignerPublicKey,
  })).toThrow();
  expect(() => deriveTaskDefinitionForegroundRecipientKeyIdV1(crypto, {
    authorizationId, parentAgentSignerPublicKey: new Uint8Array(31),
  })).toThrow();
});

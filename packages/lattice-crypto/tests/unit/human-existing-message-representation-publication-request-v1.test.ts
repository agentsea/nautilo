import { describe, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_MAX_TTL_MS_V1,
  MAX_HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1,
  decodeHumanExistingMessageRepresentationPublicationRequestV1,
  encodeHumanExistingMessageRepresentationPublicationRequestV1,
  humanExistingMessageRepresentationPublicationRequestSigningBytesV1,
  prepareHumanExistingMessageRepresentationPublicationRequestV1,
  verifyHumanExistingMessageRepresentationPublicationRequestExactReplayV1,
  verifyHumanExistingMessageRepresentationPublicationRequestV1,
  type HumanExistingMessageRepresentationAuthorRoleV1,
} from "../../src/message/existing-representation-publication-request-v1.ts";
import {
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

function fixture(
  authorRole: HumanExistingMessageRepresentationAuthorRoleV1 = "assistant",
) {
  const crypto = new LatticeCrypto(seededRng(0x274_50), { now: () => 1 });
  const device = crypto.generateSigningKeyPair();
  const created = prepareHumanExistingMessageRepresentationPublicationRequestV1(crypto, {
    subjectHumanId: humanId("human-message-request"),
    operationId: "operation-message-request",
    sessionId: "00000000-0000-4000-8000-000000000274",
    roomId: "00000000-0000-4000-8000-000000000275",
    messageId: 42,
    revision: 3,
    createdAt: unixTimestamp(1_800_000_000_000),
    authorRole,
    authorHumanTurnId: authorRole === "user" ? "human-turn-original" : null,
    sessionAgentId: agentId("agent-message-author"),
    cryptoObjectId: objectId("object-message-request"),
    namespaceId: namespaceId("namespace-message-request"),
    namespaceBindingHash: new Uint8Array(32).fill(1),
    namespaceAccessRevision: 7,
    namespaceKeyGeneration: 4,
    bindingRevisionAtWrap: 7,
    ciphertextPayloadHash: new Uint8Array(32).fill(2),
    plaintextPayloadHash: new Uint8Array(32).fill(3),
    accessManifestHash: new Uint8Array(32).fill(4),
    envelopeHash: new Uint8Array(32).fill(5),
    issuedAt: unixTimestamp(1_800_000_000_000),
    deadlineAt: unixTimestamp(1_800_000_030_000),
    committerDeviceId: cryptoDeviceId("device-message-request"),
    hostAuthorizationRevision: authorizationRevision(9),
    committerSigningPublicKey: device.publicKey,
    committerSigningPrivateKey: device.privateKey,
  });
  return { crypto, device, created };
}

describe("Human existing Message representation publication request v1", () => {
  test("pins canonical bytes and verifies current short-lived authority", () => {
    const { crypto, device, created } = fixture();
    expect(encodeHumanExistingMessageRepresentationPublicationRequestV1(
      decodeHumanExistingMessageRepresentationPublicationRequestV1(created.bytes),
    )).toEqual(created.bytes);
    expect(bytesToHex(crypto.hash(created.bytes))).toBe(
      "ca2ad9ccd1d63dbe13cf06ae780d8dd926e7517dcf1a4609a06233d1b0d750ff",
    );
    expect(verifyHumanExistingMessageRepresentationPublicationRequestV1(crypto, {
      requestBytes: created.bytes,
      now: unixTimestamp(1_800_000_029_999),
      resolveCurrentAuthority: (context) => {
        expect(context.purpose).toBe(
          "human-existing-message-representation-publication-verify",
        );
        expect(String(context.subjectHumanId)).toBe("human-message-request");
        expect(context.operationId).toBe("operation-message-request");
        expect(String(context.committerDeviceId)).toBe("device-message-request");
        expect(Number(context.hostAuthorizationRevision)).toBe(9);
        return device.publicKey;
      },
    }).cryptoObjectId).toBe(objectId("object-message-request"));
  });

  test("binds every immutable author role without changing the Human publisher", () => {
    for (const role of ["user", "assistant", "tool", "system"] as const) {
      const { crypto, device, created } = fixture(role);
      const verified = verifyHumanExistingMessageRepresentationPublicationRequestV1(
        crypto,
        {
          requestBytes: created.bytes,
          now: unixTimestamp(1_800_000_000_001),
          resolveCurrentAuthority: () => device.publicKey,
        },
      );
      expect(verified.authorRole).toBe(role);
      expect(verified.authorHumanTurnId).toBe(
        role === "user" ? "human-turn-original" : null,
      );
      expect(String(verified.sessionAgentId)).toBe("agent-message-author");
      expect(String(verified.subjectHumanId)).toBe("human-message-request");
      expect(String(verified.committerDeviceId)).toBe("device-message-request");
    }
  });

  test("rejects invented Human provenance on non-user rows", () => {
    const { crypto, device, created } = fixture("assistant");
    const { formatVersion, purpose, signature, ...unsigned } = created.request;
    void formatVersion;
    void purpose;
    void signature;
    expect(() => prepareHumanExistingMessageRepresentationPublicationRequestV1(
      crypto,
      {
        ...unsigned,
        authorHumanTurnId: "invented-human-turn",
        committerSigningPublicKey: device.publicKey,
        committerSigningPrivateKey: device.privateKey,
      },
    )).toThrow("Only a user Message");
  });

  test("rejects expiry, authority substitution, and byte tampering", () => {
    const { crypto, device, created } = fixture();
    const verify = (requestBytes: Uint8Array, now: number, publicKey = device.publicKey) =>
      verifyHumanExistingMessageRepresentationPublicationRequestV1(crypto, {
        requestBytes,
        now: unixTimestamp(now),
        resolveCurrentAuthority: () => publicKey,
      });
    expect(() => verify(created.bytes, 1_800_000_030_000))
      .toThrow("not currently valid");
    expect(() => verify(
      created.bytes,
      1_800_000_000_001,
      crypto.generateSigningKeyPair().publicKey,
    )).toThrow("signature is invalid");
    const tampered = created.bytes.slice();
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() => verify(tampered, 1_800_000_000_001))
      .toThrow("signature is invalid");
  });

  test("authenticates an expired request only against its durable exact digest", () => {
    const { crypto, device, created } = fixture();
    const digest = crypto.hash(created.bytes);
    expect(verifyHumanExistingMessageRepresentationPublicationRequestExactReplayV1(crypto, {
      requestBytes: created.bytes,
      expectedRequestDigest: digest,
      resolveCurrentAuthority: () => device.publicKey,
    }).operationId).toBe("operation-message-request");

    const wrongDigest = digest.slice();
    wrongDigest[0] = wrongDigest[0]! ^ 1;
    expect(() => verifyHumanExistingMessageRepresentationPublicationRequestExactReplayV1(
      crypto,
      {
        requestBytes: created.bytes,
        expectedRequestDigest: wrongDigest,
        resolveCurrentAuthority: () => device.publicKey,
      },
    )).toThrow("durable digest");
    expect(() => verifyHumanExistingMessageRepresentationPublicationRequestExactReplayV1(
      crypto,
      {
        requestBytes: created.bytes,
        expectedRequestDigest: digest,
        resolveCurrentAuthority: () =>
          crypto.generateSigningKeyPair().publicKey,
      },
    )).toThrow("signature is invalid");
  });

  test("validates exact shape, identifiers, hashes, counters, times, and keys", () => {
    const { crypto, device, created } = fixture("user");
    const { formatVersion, purpose, signature, ...input } = created.request;
    void formatVersion;
    void purpose;
    void signature;
    const prepareInput = {
      ...input,
      committerSigningPublicKey: device.publicKey,
      committerSigningPrivateKey: device.privateKey,
    };
    const failures: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ operationId: "" }, "operation ID"],
      [{ sessionId: `x${input.sessionId}` }, "Session ID"],
      [{ sessionId: `${input.sessionId}x` }, "Session ID"],
      [{ roomId: `x${input.roomId}` }, "Room ID"],
      [{ roomId: `${input.roomId}x` }, "Room ID"],
      [{ messageId: 0 }, "Message ID"],
      [{ messageId: 2_147_483_648 }, "Message ID"],
      [{ revision: -1 }, "revision"],
      [{ revision: 2_147_483_648 }, "revision"],
      [{ authorRole: "developer" }, "author role"],
      [{ authorHumanTurnId: null, authorRole: "user" }, ""],
      [{ authorHumanTurnId: "" }, "Human turn ID"],
      [{ namespaceBindingHash: new Uint8Array(31) }, "binding hash"],
      [{ ciphertextPayloadHash: new Uint8Array(31) }, "ciphertext payload hash"],
      [{ plaintextPayloadHash: new Uint8Array(31) }, "plaintext payload hash"],
      [{ accessManifestHash: new Uint8Array(31) }, "access manifest hash"],
      [{ envelopeHash: new Uint8Array(31) }, "envelope hash"],
      [{ namespaceAccessRevision: -1 }, "Access revision"],
      [{ bindingRevisionAtWrap: -1 }, "Access revision"],
      [{ deadlineAt: input.issuedAt }, "lifetime"],
      [{
        deadlineAt: unixTimestamp(
          Number(input.issuedAt)
            + HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_MAX_TTL_MS_V1 + 1,
        ),
      }, "lifetime"],
      [{ committerSigningPublicKey: new Uint8Array(31) }, "signing public key"],
      [{ committerSigningPrivateKey: new Uint8Array(31) }, "signing private key"],
    ];
    for (const [patch, message] of failures) {
      const action = () =>
        prepareHumanExistingMessageRepresentationPublicationRequestV1(
          crypto,
          { ...prepareInput, ...patch } as never,
        );
      if (message === "") expect(action).not.toThrow();
      else expect(action).toThrow(message);
    }
    expect(() => prepareHumanExistingMessageRepresentationPublicationRequestV1(
      crypto,
      {
        ...prepareInput,
        authorRole: "assistant",
        authorHumanTurnId: "human-turn-forged",
      },
    )).toThrow("Only a user Message");
    expect(() => prepareHumanExistingMessageRepresentationPublicationRequestV1(
      crypto,
      {
        ...prepareInput,
        deadlineAt: unixTimestamp(
          Number(input.issuedAt)
            + HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_MAX_TTL_MS_V1,
        ),
      },
    )).not.toThrow();
    expect(() => prepareHumanExistingMessageRepresentationPublicationRequestV1(
      crypto,
      {
        ...prepareInput,
        committerSigningPrivateKey: crypto.generateSigningKeyPair().privateKey,
      },
    )).toThrow("signing keys do not match");
  });

  test("rejects structural and wire boundary drift before granting authority", () => {
    const { crypto, device, created } = fixture("system");
    const { signature: _, ...unsigned } = created.request;
    expect(() => humanExistingMessageRepresentationPublicationRequestSigningBytesV1(
      null as never,
    )).toThrow("must be an object");
    expect(() => humanExistingMessageRepresentationPublicationRequestSigningBytesV1(
      Object.assign(() => undefined, unsigned) as never,
    )).toThrow("must be an object");
    expect(() => humanExistingMessageRepresentationPublicationRequestSigningBytesV1({
      ...unsigned,
      extra: true,
    } as never)).toThrow("invalid field set");
    expect(() => humanExistingMessageRepresentationPublicationRequestSigningBytesV1({
      ...unsigned,
      formatVersion: 2,
    } as never)).toThrow("version or purpose");
    expect(() => humanExistingMessageRepresentationPublicationRequestSigningBytesV1({
      ...unsigned,
      purpose: "message.future",
    } as never)).toThrow("version or purpose");
    const replaced = { ...unsigned } as Record<string, unknown>;
    delete replaced["purpose"];
    replaced["futurePurpose"] = "message.existing_representation_publish";
    expect(() => humanExistingMessageRepresentationPublicationRequestSigningBytesV1(
      replaced as never,
    )).toThrow("invalid field set");
    expect(() => encodeHumanExistingMessageRepresentationPublicationRequestV1({
      ...created.request,
      signature: new Uint8Array(63),
    })).toThrow("signature");
    expect(() => decodeHumanExistingMessageRepresentationPublicationRequestV1(
      null as never,
    )).toThrow("must be Uint8Array");
    expect(() => decodeHumanExistingMessageRepresentationPublicationRequestV1(
      new Uint8Array(
        MAX_HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1 + 1,
      ),
    )).toThrow("wire limit");
    expect(verifyHumanExistingMessageRepresentationPublicationRequestV1(crypto, {
      requestBytes: created.bytes,
      now: created.request.issuedAt,
      resolveCurrentAuthority: () => device.publicKey,
    }).operationId).toBe(created.request.operationId);
    expect(() => verifyHumanExistingMessageRepresentationPublicationRequestV1(
      crypto,
      {
        requestBytes: created.bytes,
        now: unixTimestamp(Number(created.request.issuedAt) - 1),
        resolveCurrentAuthority: () => device.publicKey,
      },
    )).toThrow("not currently valid");
    expect(() => verifyHumanExistingMessageRepresentationPublicationRequestV1(
      crypto,
      {
        requestBytes: created.bytes,
        now: created.request.issuedAt,
        resolveCurrentAuthority: () => new Uint8Array(31),
      },
    )).toThrow("authority public key");
    expect(() => verifyHumanExistingMessageRepresentationPublicationRequestExactReplayV1(
      crypto,
      {
        requestBytes: created.bytes,
        expectedRequestDigest: new Uint8Array(31),
        resolveCurrentAuthority: () => device.publicKey,
      },
    )).toThrow("durable request digest");
  });
});

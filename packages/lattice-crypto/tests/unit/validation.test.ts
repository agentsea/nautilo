import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  manualClock,
  seededRng,
} from "../../src/crypto/index.ts";
import { parseGrant } from "../../src/format/grant-v1.ts";
import { EnumerationScheme } from "../../src/lattice/enumeration.ts";
import { LATTICE_LIMITS } from "../../src/limits.ts";
import { World } from "../../src/testing/world.ts";
import type { GrantOperation } from "../../src/types/index.ts";
import { fromHex, utf8 } from "../../src/util/bytes.ts";
import { unitWorldConfig } from "./config.ts";

const config = unitWorldConfig;

async function expectRejection(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  const outcome = await promise.then(
    () => "resolved",
    (error: unknown) => String(error),
  );
  expect(outcome).toContain(message);
}

describe("public input limits", () => {
  test("invalid identifiers are rejected before storage mutation", async () => {
    const w = new World(config);

    await expectRejection(w.engine.registerUser(""), "user id");
    await expectRejection(
      w.engine.registerUser("alice\u0000admin"),
      "user id",
    );
    await expectRejection(
      w.engine.registerUser(`a${"x".repeat(LATTICE_LIMITS.idBytes)}`),
      "user id",
    );
    expect(await w.store.listUsers()).toEqual([]);
  });

  test("non-finite, non-positive, and oversized TTLs fail before exporter work", async () => {
    const w = new World(config);
    const deviceId = await w.device("alice");
    await w.namespace(["alice"]);
    const session = await w.engine.createDelegationSession();
    const original = w.group.exporterSecret.bind(w.group);
    let exporterCalls = 0;
    w.group.exporterSecret = async (...args) => {
      exporterCalls++;
      return original(...args);
    };

    for (const ttlMs of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0,
      -1,
      LATTICE_LIMITS.grantTtlMs + 1,
    ]) {
      await expectRejection(
        w.engine.mintGrant({
          issuer: w.deviceCapability(deviceId),
          scope: ["alice"],
          recipientPublicKey: session.keyPair.publicKey,
          ttlMs,
        }),
        "ttlMs",
      );
    }
    expect(exporterCalls).toBe(0);
  });

  test("empty, duplicate, and unknown operation sets are rejected", async () => {
    const w = new World(config);
    const deviceId = await w.device("alice");
    await w.namespace(["alice"]);
    const session = await w.engine.createDelegationSession();

    for (const operations of [
      [],
      ["decrypt", "decrypt"],
      ["admin"],
    ] as GrantOperation[][]) {
      await expectRejection(
        w.engine.mintGrant({
          issuer: w.deviceCapability(deviceId),
          scope: ["alice"],
          recipientPublicKey: session.keyPair.publicKey,
          ttlMs: 60_000,
          operations,
        }),
        "operations",
      );
    }
  });

  test("scope, retained epochs, plaintext, and batches have hard ceilings", async () => {
    const w = new World(config);
    const deviceId = await w.device("alice");
    const namespaceId = await w.namespace(["alice"]);
    const session = await w.engine.createDelegationSession();
    const grant = await w.engine.mintGrant({
      issuer: w.deviceCapability(deviceId),
      scope: ["alice"],
      recipientPublicKey: session.keyPair.publicKey,
      ttlMs: 60_000,
    });

    await expectRejection(
      w.engine.mintGrant({
        issuer: w.deviceCapability(deviceId),
        scope: Array.from(
          { length: LATTICE_LIMITS.grantScope + 1 },
          (_, index) => `user_${index}`,
        ),
        recipientPublicKey: session.keyPair.publicKey,
        ttlMs: 60_000,
      }),
      "scope",
    );

    await expectRejection(
      w.engine.mintGrant({
        issuer: w.deviceCapability(deviceId),
        scope: ["alice"],
        recipientPublicKey: session.keyPair.publicKey,
        ttlMs: 60_000,
        historicalEpochs: {
          [namespaceId]: Array.from(
            { length: LATTICE_LIMITS.epochsPerNamespace + 1 },
            (_, index) => index,
          ),
        },
      }),
      "historical epochs",
    );

    await expectRejection(
      w.engine.encryptObject(
        namespaceId,
        new Uint8Array(LATTICE_LIMITS.plaintextBytes + 1),
        w.deviceCapability(deviceId),
      ),
      "plaintext",
    );

    const tooManyIds = Array.from(
      { length: LATTICE_LIMITS.batchItems + 1 },
      () => "obj_missing",
    );
    await expectRejection(
      w.engine.decryptMany(tooManyIds, grant, session),
      "batch",
    );
    await expectRejection(
      w.engine.encryptMany(
        tooManyIds.map(() => ({
          namespaceId,
          plaintext: new Uint8Array(),
        })),
        grant,
        session,
      ),
      "batch",
    );
  });
});

describe("untrusted grant, object, and scheme input", () => {
  test("malformed grants fail closed before signature or HPKE work", async () => {
    const w = new World(config);
    const deviceId = await w.device("alice");
    await w.namespace(["alice"]);
    const agent = await w.grantToAgent(deviceId, ["alice"]);

    agent.grant.expiresAt = Number.POSITIVE_INFINITY;
    expect(await w.engine.verifyGrant(agent.grant)).toEqual({
      ok: false,
      reason: "invalid_input",
    });

    agent.grant.expiresAt = 61_000;
    agent.grant.encryptedSecret = new Uint8Array(
      LATTICE_LIMITS.grantSecretBytes + 1,
    );
    expect(await w.engine.verifyGrant(agent.grant)).toEqual({
      ok: false,
      reason: "invalid_input",
    });

    agent.grant.encryptedSecret = new Uint8Array([1]);
    agent.grant.coveredEpochs = Object.fromEntries(
      Array.from(
        { length: LATTICE_LIMITS.coveredNamespaces + 1 },
        (_, index) => [`ns_${index}`, [0]],
      ),
    );
    expect(await w.engine.verifyGrant(agent.grant)).toEqual({
      ok: false,
      reason: "invalid_input",
    });
  });

  test("oversized and malformed persisted blobs fail closed", async () => {
    const w = new World(config);
    const deviceId = await w.device("alice");
    const namespaceId = await w.namespace(["alice"]);
    const objectId = await w.encrypt(namespaceId, "secret");
    const agent = await w.grantToAgent(deviceId, ["alice"]);
    const object = await w.store.getObject(objectId);
    if (!object) throw new Error("expected stored object");

    object.ciphertext = new Uint8Array(
      LATTICE_LIMITS.ciphertextBytes + 1,
    );
    await w.store.putObject(object);
    expect(await w.agentRead(objectId, agent)).toEqual({
      ok: false,
      reason: "invalid_input",
    });

    object.ciphertext = new Uint8Array(1);
    await w.store.putObject(object);
    expect(await w.agentRead(objectId, agent)).toEqual({
      ok: false,
      reason: "invalid_input",
    });
  });

  test("grant parser rejects oversized, truncated, and trailing input", () => {
    expect(
      parseGrant(new Uint8Array(LATTICE_LIMITS.grantWireBytes + 1)),
    ).toBeNull();
    expect(parseGrant(new Uint8Array([0, 0, 0, 10, 1]))).toBeNull();
  });

  test("enumeration access decoding rejects malformed JSON and invalid key hex", async () => {
    const crypto = new LatticeCrypto(seededRng(7), manualClock(1_000));
    const recipient = await crypto.generateEncryptionKeyPair();
    const scheme = new EnumerationScheme();

    const malformed = await crypto.sealTo(
      recipient.publicKey,
      utf8("{not-json"),
    );
    expect(
      await scheme.openGrantSecret(
        malformed,
        recipient.privateKey,
        crypto,
      ),
    ).toBeNull();

    const invalidHex = await crypto.sealTo(
      recipient.publicKey,
      utf8('{"ns_valid":{"0":"not-hex"}}'),
    );
    expect(
      await scheme.openGrantSecret(
        invalidHex,
        recipient.privateKey,
        crypto,
      ),
    ).toBeNull();
    expect(() => fromHex("0g")).toThrow("hex");
    expect(() => fromHex("abc")).toThrow("hex");
    expect(() => fromHex("AB")).toThrow("hex");
    expect(
      await scheme.wrapDekWithAccess(
        new Uint8Array(32),
        {
          formatVersion: 1,
          objectId: "obj_valid",
          namespaceId: "ns_valid",
          epoch: 0,
        },
        null as unknown as object,
        crypto,
      ),
    ).toBeNull();
  });
});

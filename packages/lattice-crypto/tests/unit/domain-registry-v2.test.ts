import { describe, expect, test } from "bun:test";
import {
  findOrCreateCryptoDomain,
} from "../../src/domain/registry.ts";
import {
  InMemoryV2Store,
  type CryptoDomainPublicRecordV2,
} from "../../src/storage/v2-store.ts";
import {
  participantDigest,
} from "../../src/domain/participants.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";
import {
  cryptoDomainId,
  humanId,
} from "../../src/v2-types/ids.ts";

describe("v2 canonical Crypto Domain registry", () => {
  test("two and fifty callers reuse one Domain for the same exact Human set", async () => {
    const store = new InMemoryV2Store();
    let sequence = 0;
    const createDomainId = () => cryptoDomainId(`domain-${sequence++}`);
    const calls = Array.from({ length: 50 }, () =>
      findOrCreateCryptoDomain(store, {
        participants: [humanId("bob"), humanId("alice")],
        createDomainId,
        rosterBytes: new Uint8Array([1, 2, 3]),
      })
    );

    const results = await Promise.all(calls);

    expect(new Set(results.map((result) => result.domain.id)).size).toBe(1);
    expect(results[0]?.domain.participants).toEqual(["alice", "bob"]);
    expect(await store.listDomains()).toHaveLength(1);
  });

  test("different exact Human sets never reuse a Domain", async () => {
    const store = new InMemoryV2Store();
    let sequence = 0;
    const createDomainId = () => cryptoDomainId(`domain-${sequence++}`);

    const ab = await findOrCreateCryptoDomain(store, {
      participants: [humanId("alice"), humanId("bob")],
      createDomainId,
      rosterBytes: new Uint8Array([1]),
    });
    const ac = await findOrCreateCryptoDomain(store, {
      participants: [humanId("alice"), humanId("carol")],
      createDomainId,
      rosterBytes: new Uint8Array([2]),
    });

    expect(ab.domain.id).not.toBe(ac.domain.id);
    expect(await store.listDomains()).toHaveLength(2);
  });

  test("invalid participant sets fail before Domain id allocation or storage mutation", async () => {
    const store = new InMemoryV2Store();
    let allocations = 0;
    const createDomainId = () => {
      allocations += 1;
      return cryptoDomainId(`domain-${allocations}`);
    };

    expect(
      findOrCreateCryptoDomain(store, {
        participants: [],
        createDomainId,
        rosterBytes: new Uint8Array(),
      }),
    ).rejects.toThrow("must not be empty");
    expect(
      findOrCreateCryptoDomain(store, {
        participants: [humanId("alice"), humanId("alice")],
        createDomainId,
        rosterBytes: new Uint8Array(),
      }),
    ).rejects.toThrow("duplicate");

    expect(allocations).toBe(0);
    expect(await store.listDomains()).toEqual([]);
  });

  test("rejects a non-byte roster with its exact diagnostic before storage access", async () => {
    let accessedStorage = false;
    const storage = {
      findDomain: async () => {
        accessedStorage = true;
        return null;
      },
      createDomainIfAbsent: async () => {
        accessedStorage = true;
        throw new Error("must not create");
      },
    };

    expect(findOrCreateCryptoDomain(storage, {
      participants: [humanId("alice")],
      createDomainId: () => cryptoDomainId("domain-a"),
      rosterBytes: "not-bytes" as unknown as Uint8Array,
    })).rejects.toEqual(
      new TypeError("Crypto Domain roster must be encoded bytes"),
    );
    expect(accessedStorage).toBe(false);
  });

  test("rejects an oversized roster before any storage access or Domain id allocation", async () => {
    let accessedStorage = false;
    let allocations = 0;

    expect(findOrCreateCryptoDomain({
      findDomain: () => {
        accessedStorage = true;
        return Promise.resolve(null);
      },
      createDomainIfAbsent: () => {
        accessedStorage = true;
        throw new Error("must not create");
      },
    }, {
      participants: [humanId("alice")],
      createDomainId: () => {
        allocations += 1;
        return cryptoDomainId("must-not-be-created");
      },
      rosterBytes: new Uint8Array(V2_LIMITS.ciphertextBytes + 1),
    })).rejects.toThrow("Crypto Domain roster bytes exceeds");
    expect(accessedStorage).toBe(false);
    expect(allocations).toBe(0);
  });

  test("returns an exact existing result without allocating or attempting creation", async () => {
    const store = new InMemoryV2Store();
    const created = await findOrCreateCryptoDomain(store, {
      participants: [humanId("alice")],
      createDomainId: () => cryptoDomainId("domain-a"),
      rosterBytes: new Uint8Array([1]),
    });
    let allocations = 0;

    const existing = await findOrCreateCryptoDomain(store, {
      participants: [humanId("alice")],
      createDomainId: () => {
        allocations += 1;
        return cryptoDomainId("must-not-be-created");
      },
      rosterBytes: new Uint8Array([2]),
    });

    expect(existing).toEqual({
      status: "existing",
      domain: created.domain,
    });
    expect(allocations).toBe(0);
    expect(await store.listDomains()).toHaveLength(1);
  });

  test("passes a detached roster snapshot into create-if-absent", async () => {
    const rosterBytes = Buffer.from([4, 5, 6]);
    let receivedRoster: Uint8Array | undefined;
    const storage = {
      findDomain: async () => null,
      createDomainIfAbsent: async (
        domain: Parameters<InMemoryV2Store["createDomainIfAbsent"]>[0],
      ) => {
        receivedRoster = domain.rosterBytes;
        return { status: "created" as const, domain };
      },
    };

    const pending = findOrCreateCryptoDomain(storage, {
      participants: [humanId("alice")],
      createDomainId: () => cryptoDomainId("domain-a"),
      rosterBytes,
    });
    rosterBytes.fill(0xff);
    const result = await pending;

    expect(receivedRoster).not.toBe(rosterBytes);
    expect(receivedRoster).toEqual(new Uint8Array([4, 5, 6]));
    expect(Buffer.isBuffer(receivedRoster)).toBeFalse();
    expect(result.domain.rosterBytes).toEqual(new Uint8Array([4, 5, 6]));
  });

  test("returned and persisted roster bytes are detached from the caller", async () => {
    const store = new InMemoryV2Store();
    const rosterBytes = new Uint8Array([4, 5, 6]);
    const result = await findOrCreateCryptoDomain(store, {
      participants: [humanId("alice")],
      createDomainId: () => cryptoDomainId("domain-a"),
      rosterBytes,
    });

    rosterBytes[0] = 0xff;
    result.domain.rosterBytes[1] = 0xff;

    const stored = await store.listDomains();
    expect(stored[0]?.rosterBytes).toEqual(new Uint8Array([4, 5, 6]));
  });

  test("fails closed when storage substitutes an inexact participant record", async () => {
    const requested = [humanId("alice")];
    const dishonest: CryptoDomainPublicRecordV2 = {
      id: cryptoDomainId("domain-mallory"),
      participantDigest: participantDigest([humanId("mallory")]),
      participants: [humanId("mallory")],
      epoch: 0,
      authorizationRevision: 0,
      rosterBytes: new Uint8Array([9]),
    };
    let allocations = 0;

    expect(findOrCreateCryptoDomain({
      findDomain: async () => dishonest,
      createDomainIfAbsent: async () => {
        throw new Error("must not create");
      },
    }, {
      participants: requested,
      createDomainId: () => {
        allocations += 1;
        return cryptoDomainId("must-not-be-created");
      },
      rosterBytes: new Uint8Array([1]),
    })).rejects.toThrow(
      "Crypto Domain storage returned a record for different participants",
    );
    expect(allocations).toBe(0);
  });

  test("fails closed when create-if-absent returns a substituted record", async () => {
    const requested = [humanId("alice")];
    const dishonest: CryptoDomainPublicRecordV2 = {
      id: cryptoDomainId("domain-mallory"),
      participantDigest: participantDigest([humanId("mallory")]),
      participants: [humanId("mallory")],
      epoch: 0,
      authorizationRevision: 0,
      rosterBytes: new Uint8Array([9]),
    };

    expect(findOrCreateCryptoDomain({
      findDomain: async () => null,
      createDomainIfAbsent: async () => ({
        status: "existing",
        domain: dishonest,
      }),
    }, {
      participants: requested,
      createDomainId: () => cryptoDomainId("domain-alice"),
      rosterBytes: new Uint8Array([1]),
    })).rejects.toThrow(
      "Crypto Domain storage returned a record for different participants",
    );
  });

  test("binds a created response to the exact proposed initial record", async () => {
    const participants = [humanId("alice")];
    const digest = participantDigest(participants);
    const proposedRoster = new Uint8Array([1, 2, 3]);
    const substitutions: CryptoDomainPublicRecordV2[] = [
      {
        id: cryptoDomainId("domain-substituted"),
        participantDigest: digest,
        participants,
        epoch: 0,
        authorizationRevision: 0,
        rosterBytes: proposedRoster,
      },
      {
        id: cryptoDomainId("domain-proposed"),
        participantDigest: digest,
        participants,
        epoch: 1,
        authorizationRevision: 0,
        rosterBytes: proposedRoster,
      },
      {
        id: cryptoDomainId("domain-proposed"),
        participantDigest: digest,
        participants,
        epoch: 0,
        authorizationRevision: 1,
        rosterBytes: proposedRoster,
      },
      {
        id: cryptoDomainId("domain-proposed"),
        participantDigest: digest,
        participants,
        epoch: 0,
        authorizationRevision: 0,
        rosterBytes: new Uint8Array([9]),
      },
    ];

    for (const substituted of substitutions) {
      expect(findOrCreateCryptoDomain({
        findDomain: () => Promise.resolve(null),
        createDomainIfAbsent: () => Promise.resolve({
          status: "created",
          domain: substituted,
        }),
      }, {
        participants,
        createDomainId: () => cryptoDomainId("domain-proposed"),
        rosterBytes: proposedRoster,
      })).rejects.toThrow(
        "created response does not match the proposed initial record",
      );
    }
  });

  test("deep-detaches existing and created adapter records before returning", async () => {
    const participants = [humanId("alice")];
    const digest = participantDigest(participants);
    const adapterRecord: CryptoDomainPublicRecordV2 = {
      id: cryptoDomainId("domain-adapter-owned"),
      participantDigest: digest,
      participants,
      epoch: 0,
      authorizationRevision: 0,
      rosterBytes: new Uint8Array([1, 2, 3]),
    };
    const existing = await findOrCreateCryptoDomain({
      findDomain: () => Promise.resolve(adapterRecord),
      createDomainIfAbsent: () => {
        throw new Error("must not create");
      },
    }, {
      participants,
      createDomainId: () => cryptoDomainId("must-not-create"),
      rosterBytes: new Uint8Array([9]),
    });

    expect(existing.domain).not.toBe(adapterRecord);
    expect(existing.domain.participantDigest).not.toBe(
      adapterRecord.participantDigest,
    );
    expect(existing.domain.participants).not.toBe(adapterRecord.participants);
    expect(existing.domain.rosterBytes).not.toBe(adapterRecord.rosterBytes);
    existing.domain.participantDigest[0] = 0;
    (existing.domain.participants as string[])[0] = "mallory";
    existing.domain.rosterBytes[0] = 0;
    expect(adapterRecord.participantDigest).toEqual(digest);
    expect(adapterRecord.participants).toEqual(["alice"]);
    expect(adapterRecord.rosterBytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("rejects every malformed existing adapter record shape exactly", async () => {
    const participants = [humanId("alice")];
    const digest = participantDigest(participants);
    const valid: CryptoDomainPublicRecordV2 = {
      id: cryptoDomainId("domain-adapter"),
      participantDigest: digest,
      participants,
      epoch: 0,
      authorizationRevision: 0,
      rosterBytes: new Uint8Array([1]),
    };
    const resolve = (record: unknown) =>
      findOrCreateCryptoDomain({
        findDomain: () => Promise.resolve(record as never),
        createDomainIfAbsent: () => {
          throw new Error("must not create");
        },
      }, {
        participants,
        createDomainId: () => cryptoDomainId("must-not-create"),
        rosterBytes: new Uint8Array([9]),
      });

    expect(resolve("not-a-record")).rejects.toEqual(
      new TypeError("Crypto Domain storage returned a non-object record"),
    );
    for (const record of [
      { ...valid, unexpected: true },
      {
        participantDigest: valid.participantDigest,
        participants: valid.participants,
        epoch: valid.epoch,
        authorizationRevision: valid.authorizationRevision,
        rosterBytes: valid.rosterBytes,
      },
      {
        unexpected: valid.id,
        participantDigest: valid.participantDigest,
        participants: valid.participants,
        epoch: valid.epoch,
        authorizationRevision: valid.authorizationRevision,
        rosterBytes: valid.rosterBytes,
      },
    ]) {
      expect(resolve(record)).rejects.toEqual(
        new TypeError(
          "Crypto Domain storage returned a record with an invalid field set",
        ),
      );
    }

    expect(resolve({
      ...valid,
      rosterBytes: "not-bytes",
    })).rejects.toEqual(
      new TypeError(
        "Crypto Domain storage returned a record with a non-byte roster",
      ),
    );
    expect(resolve({
      ...valid,
      rosterBytes: new Uint8Array(V2_LIMITS.ciphertextBytes + 1),
    })).rejects.toThrow(
      `Crypto Domain storage roster bytes exceeds the ${V2_LIMITS.ciphertextBytes} limit`,
    );
    expect(resolve({
      ...valid,
      participantDigest: "not-bytes",
    })).rejects.toEqual(
      new TypeError(
        "Crypto Domain storage returned invalid participant coordinates",
      ),
    );
    expect(resolve({
      ...valid,
      participants: "not-an-array",
    })).rejects.toEqual(
      new TypeError(
        "Crypto Domain storage returned invalid participant coordinates",
      ),
    );
  });

  test("rejects each independent exact-participant and digest substitution", async () => {
    const participants = [
      humanId("alice"),
      humanId("bob"),
      humanId("carol"),
    ];
    const digest = participantDigest(participants);
    const valid: CryptoDomainPublicRecordV2 = {
      id: cryptoDomainId("domain-adapter"),
      participantDigest: digest,
      participants,
      epoch: 0,
      authorizationRevision: 0,
      rosterBytes: new Uint8Array([1]),
    };
    const mismatchedSameLengthDigest = digest.slice();
    mismatchedSameLengthDigest[0] = mismatchedSameLengthDigest[0]! ^ 0xff;
    const mismatchedShortDigest = digest.slice(0, -1);
    const records: readonly CryptoDomainPublicRecordV2[] = [
      {
        ...valid,
        participants: [humanId("alice")],
      },
      {
        ...valid,
        participants: [
          humanId("alice"),
          humanId("bob"),
          humanId("dave"),
        ],
      },
      {
        ...valid,
        participants: [
          humanId("alice"),
          humanId("carol"),
          humanId("bob"),
        ],
      },
      {
        ...valid,
        participantDigest: mismatchedSameLengthDigest,
      },
      {
        ...valid,
        participantDigest: mismatchedShortDigest,
      },
    ];

    for (const record of records) {
      expect(findOrCreateCryptoDomain({
        findDomain: () => Promise.resolve(record),
        createDomainIfAbsent: () => {
          throw new Error("must not create");
        },
      }, {
        participants,
        createDomainId: () => cryptoDomainId("must-not-create"),
        rosterBytes: new Uint8Array([9]),
      })).rejects.toThrow(
        "Crypto Domain storage returned a record for different participants",
      );
    }
  });

  test("rejects every malformed create-if-absent result envelope exactly", async () => {
    const participants = [humanId("alice")];
    const digest = participantDigest(participants);
    const domain: CryptoDomainPublicRecordV2 = {
      id: cryptoDomainId("domain-proposed"),
      participantDigest: digest,
      participants,
      epoch: 0,
      authorizationRevision: 0,
      rosterBytes: new Uint8Array([1]),
    };
    const create = (result: unknown) =>
      findOrCreateCryptoDomain({
        findDomain: () => Promise.resolve(null),
        createDomainIfAbsent: () => Promise.resolve(result as never),
      }, {
        participants,
        createDomainId: () => cryptoDomainId("domain-proposed"),
        rosterBytes: new Uint8Array([1]),
      });

    for (const result of [null, "not-a-record"]) {
      expect(create(result)).rejects.toEqual(
        new TypeError("Crypto Domain storage returned a non-object record"),
      );
    }
    for (const result of [
      { status: "created" },
      { status: "created", domain, unexpected: true },
      { status: "created", unexpected: domain },
    ]) {
      expect(create(result)).rejects.toEqual(
        new TypeError(
          "Crypto Domain storage returned a record with an invalid field set",
        ),
      );
    }
    expect(create({ status: "invalid", domain })).rejects.toEqual(
      new TypeError(
        "Crypto Domain storage returned an invalid creation status",
      ),
    );
  });
});

import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  seededRng,
} from "../../src/crypto/index.ts";
import {
  mintGrantV2,
  openGrantV2ForOperation,
  type GrantOperationAuthorizationV2,
} from "../../src/grant/authorization.ts";
import {
  grantV2SigningBytes,
  parseGrantV2,
  serializeGrantSecretV2,
  serializeGrantV2,
  type GrantV2,
} from "../../src/format/grant-v2.ts";
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
import { V2LimitError, V2_LIMITS } from "../../src/v2-types/limits.ts";

const NOW = 1_800_000_000_000;

function bytes(fill: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(32).fill(fill);
}

function expectWiped(
  value: Uint8Array | null,
): void {
  expect(value).not.toBeNull();
  if (value === null) throw new Error("expected a captured secret buffer");
  expect(value).toEqual(new Uint8Array(value.length));
}

async function setup() {
  const crypto = new LatticeCrypto(seededRng(720));
  const issuer = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const domainAb = cryptoDomainId("domain-ab");
  const domainAbc = cryptoDomainId("domain-abc");
  const aiRootAb = bytes(0xab);
  const aiRootAbc = bytes(0xac);
  const grant = await mintGrantV2(crypto, {
    id: grantId("grant-720"),
    issuingDeviceId: cryptoDeviceId("alice-phone"),
    issuingHumanId: humanId("alice"),
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: agentId("genie"),
    recipientKeyId: "invocation-720",
    recipientEncryptionPublicKey: recipient.publicKey,
    scope: [humanId("alice")],
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    coveredDomains: [
      {
        domainId: domainAb,
        domainEpoch: domainEpoch(4),
        agentAuthorizationRevision: authorizationRevision(8),
        aiRoot: aiRootAb,
      },
      {
        domainId: domainAbc,
        domainEpoch: domainEpoch(2),
        agentAuthorizationRevision: authorizationRevision(3),
        aiRoot: aiRootAbc,
      },
    ],
    singleUse: true,
  });
  const authorization: GrantOperationAuthorizationV2 = {
    now: NOW + 1,
    expectedIssuingDeviceId: cryptoDeviceId("alice-phone"),
    issuingDeviceHumanId: humanId("alice"),
    issuingDeviceSigningPublicKey: issuer.publicKey,
    issuingDeviceActive: true,
    recipientAgentId: agentId("genie"),
    recipientKeyId: "invocation-720",
    recipientEncryptionPrivateKey: recipient.privateKey,
    operation: "decrypt",
    singleUseAvailable: true,
    namespaceId: namespaceId("room-ab"),
    namespaceAccessRevision: accessRevision(9),
    namespaceParticipants: [humanId("alice"), humanId("bob")],
    domainId: domainAb,
    domainEpoch: domainEpoch(4),
    agentAuthorizationRevision: authorizationRevision(8),
    hostAllowsOperation: true,
  };
  return {
    aiRootAb,
    aiRootAbc,
    authorization,
    crypto,
    domainAb,
    domainAbc,
    grant,
    issuer,
    recipient,
  };
}

async function resignGrantWithSecret(
  state: Awaited<ReturnType<typeof setup>>,
  secret: Parameters<typeof serializeGrantSecretV2>[0],
): Promise<GrantV2> {
  const plaintext = serializeGrantSecretV2(secret);
  try {
    const encryptedSecret = await state.crypto.sealTo(
      state.recipient.publicKey,
      plaintext,
    );
    const unsigned = {
      ...state.grant,
      encryptedSecret,
    };
    return {
      ...unsigned,
      signature: state.crypto.sign(
        state.issuer.privateKey,
        grantV2SigningBytes(unsigned),
      ),
    };
  } finally {
    plaintext.fill(0);
  }
}

describe("GrantV2 mint and dynamic operation authorization", () => {
  test("mints to an invocation key and opens exactly one covered AI Domain root", async () => {
    const { aiRootAb, authorization, crypto, grant } = await setup();

    const opened = await openGrantV2ForOperation(
      crypto,
      grant,
      authorization,
    );

    expect(opened).not.toBeNull();
    expect(opened?.domainId).toBe(authorization.domainId);
    expect(opened?.aiRoot).toEqual(aiRootAb);
    expect(opened?.aiRoot).not.toBe(aiRootAb);
    expect(opened?.namespaceId).toBe(authorization.namespaceId);
    expect(opened?.namespaceAccessRevision).toBe(
      authorization.namespaceAccessRevision,
    );
  });

  test("mints, serializes, parses, and opens an exact 16K Domain grant", async () => {
    const crypto = new LatticeCrypto(seededRng(315));
    const issuer = crypto.generateSigningKeyPair();
    const recipient = await crypto.generateEncryptionKeyPair();
    const coveredDomains = Array.from(
      { length: V2_LIMITS.agentGrantDomains },
      (_, index) => ({
        domainId: cryptoDomainId(
          `domain-m315-${index.toString().padStart(5, "0")}`,
        ),
        domainEpoch: domainEpoch(1),
        agentAuthorizationRevision: authorizationRevision(1),
        aiRoot: new Uint8Array(32).fill(index % 251),
      }),
    );
    const grant = await mintGrantV2(crypto, {
      id: grantId("grant-m315-16k"),
      issuingDeviceId: cryptoDeviceId("device-m315"),
      issuingHumanId: humanId("alice"),
      issuingDeviceSigningPrivateKey: issuer.privateKey,
      recipientAgentId: agentId("genie"),
      recipientKeyId: "invocation-m315",
      recipientEncryptionPublicKey: recipient.publicKey,
      scope: [humanId("alice")],
      operations: ["decrypt", "encrypt"],
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
      coveredDomains,
      singleUse: false,
    });
    const wire = serializeGrantV2(grant);
    const parsed = parseGrantV2(wire);
    expect(parsed).not.toBeNull();
    expect(parsed?.coveredDomains).toHaveLength(V2_LIMITS.agentGrantDomains);
    expect(wire.length).toBeLessThanOrEqual(V2_LIMITS.agentGrantWireBytes);

    const target = coveredDomains.at(-1)!;
    const opened = await openGrantV2ForOperation(crypto, parsed!, {
      now: NOW + 1,
      expectedIssuingDeviceId: cryptoDeviceId("device-m315"),
      issuingDeviceHumanId: humanId("alice"),
      issuingDeviceSigningPublicKey: issuer.publicKey,
      issuingDeviceActive: true,
      recipientAgentId: agentId("genie"),
      recipientKeyId: "invocation-m315",
      recipientEncryptionPrivateKey: recipient.privateKey,
      operation: "decrypt",
      singleUseAvailable: true,
      namespaceId: namespaceId("namespace-m315"),
      namespaceAccessRevision: accessRevision(1),
      namespaceParticipants: [humanId("alice")],
      domainId: target.domainId,
      domainEpoch: target.domainEpoch,
      agentAuthorizationRevision: target.agentAuthorizationRevision,
      hostAllowsOperation: true,
    });
    expect(opened?.aiRoot).toEqual(target.aiRoot);
    opened?.aiRoot.fill(0);

    expect(mintGrantV2(crypto, {
      id: grantId("grant-m315-too-large"),
      issuingDeviceId: cryptoDeviceId("device-m315"),
      issuingHumanId: humanId("alice"),
      issuingDeviceSigningPrivateKey: issuer.privateKey,
      recipientAgentId: agentId("genie"),
      recipientKeyId: "invocation-m315",
      recipientEncryptionPublicKey: recipient.publicKey,
      scope: [humanId("alice")],
      operations: ["decrypt"],
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
      coveredDomains: [
        ...coveredDomains,
        {
          domainId: cryptoDomainId("domain-m315-16384"),
          domainEpoch: domainEpoch(1),
          agentAuthorizationRevision: authorizationRevision(1),
          aiRoot: new Uint8Array(32),
        },
      ],
      singleUse: false,
    })).rejects.toBeInstanceOf(V2LimitError);
  }, 30_000);

  test("zeroizes temporary sealed and opened grant-secret plaintext", async () => {
    const crypto = new LatticeCrypto(seededRng(721));
    const issuer = crypto.generateSigningKeyPair();
    const recipient = await crypto.generateEncryptionKeyPair();
    let sealedPlaintext: Uint8Array | null = null;
    const originalSeal = crypto.sealTo.bind(crypto);
    crypto.sealTo = (publicKey, plaintext) => {
      sealedPlaintext = plaintext;
      return originalSeal(publicKey, plaintext);
    };
    const grant = await mintGrantV2(crypto, {
      id: grantId("grant-zeroize"),
      issuingDeviceId: cryptoDeviceId("alice-phone"),
      issuingHumanId: humanId("alice"),
      issuingDeviceSigningPrivateKey: issuer.privateKey,
      recipientAgentId: agentId("genie"),
      recipientKeyId: "invocation-zeroize",
      recipientEncryptionPublicKey: recipient.publicKey,
      scope: [humanId("alice")],
      operations: ["decrypt"],
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
      coveredDomains: [{
        domainId: cryptoDomainId("domain-ab"),
        domainEpoch: domainEpoch(4),
        agentAuthorizationRevision: authorizationRevision(8),
        aiRoot: bytes(0xab),
      }],
      singleUse: false,
    });
    expectWiped(sealedPlaintext);

    let openedPlaintext: Uint8Array | null = null;
    const originalOpen = crypto.openSealed.bind(crypto);
    crypto.openSealed = async (...args) => {
      const result = await originalOpen(...args);
      if (result !== null) openedPlaintext = result;
      return result;
    };
    const opened = await openGrantV2ForOperation(crypto, grant, {
      now: NOW + 1,
      expectedIssuingDeviceId: cryptoDeviceId("alice-phone"),
      issuingDeviceHumanId: humanId("alice"),
      issuingDeviceSigningPublicKey: issuer.publicKey,
      issuingDeviceActive: true,
      recipientAgentId: agentId("genie"),
      recipientKeyId: "invocation-zeroize",
      recipientEncryptionPrivateKey: recipient.privateKey,
      operation: "decrypt",
      singleUseAvailable: true,
      namespaceId: namespaceId("room-ab"),
      namespaceAccessRevision: accessRevision(9),
      namespaceParticipants: [humanId("alice"), humanId("bob")],
      domainId: cryptoDomainId("domain-ab"),
      domainEpoch: domainEpoch(4),
      agentAuthorizationRevision: authorizationRevision(8),
      hostAllowsOperation: true,
    });
    expect(opened?.aiRoot).toEqual(bytes(0xab));
    expectWiped(openedPlaintext);
  });

  test("zeroizes every parsed Domain root after returning a detached selected root", async () => {
    const state = await setup();
    const fills: Array<{
      readonly target: Uint8Array;
      readonly before: Uint8Array;
    }> = [];
    const originalFill = Uint8Array.prototype.fill;
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      if (value === 0) {
        fills.push({
          target: this,
          before: this.slice(),
        });
      }
      return originalFill.call(this, value, start, end);
    };
    let opened;
    try {
      opened = await openGrantV2ForOperation(
        state.crypto,
        state.grant,
        state.authorization,
      );
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }

    expect(opened?.aiRoot).toEqual(state.aiRootAb);
    const wipedRoots = fills.filter(({ before, target }) =>
      before.length === 32
      && (
        before.every((value) => value === 0xab)
        || before.every((value) => value === 0xac)
      )
      && target.every((value) => value === 0)
    );
    expect(wipedRoots).toHaveLength(2);
    expect(opened?.aiRoot.every((value) => value === 0xab)).toBe(true);
  });

  test("rejects byte and participant lookalikes before invoking crypto", async () => {
    const state = await setup();
    const fakeSigningKey = {
      slice: () => state.authorization.issuingDeviceSigningPublicKey.slice(),
    } as unknown as Uint8Array;
    const fakePrivateKey = {
      slice: () => state.authorization.recipientEncryptionPrivateKey.slice(),
    } as unknown as Uint8Array;
    const fakeParticipants = {
      map: state.authorization.namespaceParticipants.map.bind(
        state.authorization.namespaceParticipants,
      ),
    } as unknown as GrantOperationAuthorizationV2[
      "namespaceParticipants"
    ];

    for (const authorization of [
      {
        ...state.authorization,
        issuingDeviceSigningPublicKey: fakeSigningKey,
      },
      {
        ...state.authorization,
        recipientEncryptionPrivateKey: fakePrivateKey,
      },
      {
        ...state.authorization,
        namespaceParticipants: fakeParticipants,
      },
    ]) {
      expect(
        await openGrantV2ForOperation(
          state.crypto,
          state.grant,
          authorization,
        ),
      ).toBeNull();
    }
  });

  test("owns the signing-key snapshot during verification and wipes its private-key snapshot", async () => {
    const state = await setup();
    const authorization: GrantOperationAuthorizationV2 = {
      ...state.authorization,
      issuingDeviceSigningPublicKey:
        state.authorization.issuingDeviceSigningPublicKey.slice(),
      recipientEncryptionPrivateKey:
        state.authorization.recipientEncryptionPrivateKey.slice(),
    };
    const callerSigningKey = authorization.issuingDeviceSigningPublicKey;
    const callerPrivateKey = authorization.recipientEncryptionPrivateKey;
    const originalVerify = state.crypto.verify.bind(state.crypto);
    let verifiedSigningKey: Uint8Array | null = null;
    state.crypto.verify = (publicKey, message, signature) => {
      verifiedSigningKey = publicKey;
      callerSigningKey.fill(0);
      return originalVerify(publicKey, message, signature);
    };
    const originalOpen = state.crypto.openSealed.bind(state.crypto);
    let openedPrivateKey: Uint8Array | null = null;
    state.crypto.openSealed = async (privateKey, ciphertext) => {
      openedPrivateKey = privateKey;
      return await originalOpen(privateKey, ciphertext);
    };

    const opened = await openGrantV2ForOperation(
      state.crypto,
      state.grant,
      authorization,
    );

    expect(opened?.aiRoot).toEqual(state.aiRootAb);
    expect(verifiedSigningKey).not.toBe(callerSigningKey);
    expect(openedPrivateKey).not.toBe(callerPrivateKey);
    expect(openedPrivateKey).not.toBeNull();
    expect(openedPrivateKey!.every((byte) => byte === 0)).toBe(true);
    expect(callerPrivateKey).toEqual(
      state.authorization.recipientEncryptionPrivateKey,
    );
  });

  test("rechecks every dynamic device, recipient, operation, and host gate", async () => {
    const { authorization, crypto, grant } = await setup();
    const wrongRecipient = await crypto.generateEncryptionKeyPair();
    const denials: GrantOperationAuthorizationV2[] = [
      { ...authorization, now: grant.expiresAt },
      { ...authorization, expectedIssuingDeviceId: cryptoDeviceId("other") },
      { ...authorization, issuingDeviceHumanId: humanId("charlie") },
      { ...authorization, issuingDeviceActive: false },
      { ...authorization, recipientAgentId: agentId("other-agent") },
      { ...authorization, recipientKeyId: "other-invocation" },
      {
        ...authorization,
        recipientEncryptionPrivateKey: wrongRecipient.privateKey,
      },
      { ...authorization, singleUseAvailable: false },
      { ...authorization, operation: "encrypt", hostAllowsOperation: false },
    ];

    for (const denied of denials) {
      expect(
        await openGrantV2ForOperation(crypto, grant, denied),
      ).toBeNull();
    }

    expect(
      await openGrantV2ForOperation(
        crypto,
        { ...grant, operations: ["decrypt"] },
        { ...authorization, operation: "encrypt" },
      ),
    ).toBeNull();
    expect(
      await openGrantV2ForOperation(
        crypto,
        { ...grant, consumed: true },
        authorization,
      ),
    ).toBeNull();
  });

  test("rejects stale Domain epoch/revision and any Namespace outside the subset rule", async () => {
    const { authorization, crypto, grant } = await setup();
    const staleOrWidened: GrantOperationAuthorizationV2[] = [
      { ...authorization, domainEpoch: domainEpoch(5) },
      {
        ...authorization,
        agentAuthorizationRevision: authorizationRevision(9),
      },
      { ...authorization, domainId: cryptoDomainId("domain-new") },
      {
        ...authorization,
        namespaceParticipants: [humanId("bob")],
      },
      {
        ...authorization,
        namespaceParticipants: [
          humanId("bob"),
          humanId("alice"),
        ],
      },
      {
        ...authorization,
        namespaceParticipants: [
          humanId("alice"),
          humanId("alice"),
          humanId("bob"),
        ],
      },
    ];

    for (const denied of staleOrWidened) {
      expect(
        await openGrantV2ForOperation(crypto, grant, denied),
      ).toBeNull();
    }
  });

  test("locks time boundaries, validates authorization fields, and requires the full participant subset", async () => {
    const state = await setup();
    const boundaryGrant = {
      ...state.grant,
      issuedAt: 0,
      expiresAt: 60_000,
      singleUse: false,
    };
    boundaryGrant.signature = state.crypto.sign(
      state.issuer.privateKey,
      grantV2SigningBytes(boundaryGrant),
    );
    expect(
      await openGrantV2ForOperation(state.crypto, boundaryGrant, {
        ...state.authorization,
        now: 0,
      }),
    ).not.toBeNull();

    const invalid = [
      { ...state.authorization, now: Number.NaN },
      { ...state.authorization, now: -1 },
      { ...state.authorization, now: NOW - 1 },
      {
        ...state.authorization,
        namespaceId: "not a namespace" as typeof state.authorization.namespaceId,
      },
      {
        ...state.authorization,
        singleUseAvailable: 1 as unknown as boolean,
      },
      {
        ...state.authorization,
        namespaceParticipants: [humanId("alice")],
      },
    ];
    const twoHumanGrant = {
      ...state.grant,
      scope: [humanId("alice"), humanId("bob")],
      singleUse: false,
    };
    twoHumanGrant.signature = state.crypto.sign(
      state.issuer.privateKey,
      grantV2SigningBytes(twoHumanGrant),
    );
    const reusableGrant = {
      ...state.grant,
      singleUse: false,
    };
    reusableGrant.signature = state.crypto.sign(
      state.issuer.privateKey,
      grantV2SigningBytes(reusableGrant),
    );
    for (const authorization of invalid) {
      expect(
        await openGrantV2ForOperation(
          state.crypto,
          authorization.namespaceParticipants.length === 1
            ? twoHumanGrant
            : reusableGrant,
          authorization,
        ),
      ).toBeNull();
    }
  });

  test("selects the exact covered Domain and rejects incomplete or substituted secret inventories", async () => {
    const state = await setup();
    const secondAuthorization = {
      ...state.authorization,
      domainId: state.domainAbc,
      domainEpoch: domainEpoch(2),
      agentAuthorizationRevision: authorizationRevision(3),
    };
    const second = await openGrantV2ForOperation(
      state.crypto,
      state.grant,
      secondAuthorization,
    );
    expect(second?.aiRoot).toEqual(state.aiRootAbc);

    const incomplete = await resignGrantWithSecret(state, [{
      domainId: state.domainAb,
      aiRoot: state.aiRootAb,
    }]);
    expect(
      await openGrantV2ForOperation(
        state.crypto,
        incomplete,
        state.authorization,
      ),
    ).toBeNull();

    const substituted = await resignGrantWithSecret(state, [
      {
        domainId: state.domainAb,
        aiRoot: state.aiRootAb,
      },
      {
        domainId: cryptoDomainId("domain-zzz"),
        aiRoot: state.aiRootAbc,
      },
    ]);
    expect(
      await openGrantV2ForOperation(
        state.crypto,
        substituted,
        state.authorization,
      ),
    ).toBeNull();
  });

  test("normalizes unexpected crypto failures to an explicit null denial", async () => {
    const state = await setup();
    state.crypto.verify = () => {
      throw new Error("injected verification failure");
    };
    expect(
      await openGrantV2ForOperation(
        state.crypto,
        state.grant,
        state.authorization,
      ),
    ).toBeNull();

    const decryptionFailure = await setup();
    decryptionFailure.crypto.openSealed = () =>
      Promise.reject(new Error("injected decryption failure"));
    expect(
      await openGrantV2ForOperation(
        decryptionFailure.crypto,
        decryptionFailure.grant,
        decryptionFailure.authorization,
      ),
    ).toBeNull();
  });

  test("rejects signature, covered-root, and issuer-key substitution", async () => {
    const { authorization, crypto, grant } = await setup();
    const otherIssuer = crypto.generateSigningKeyPair();
    const tamperedSignature = grant.signature.slice();
    tamperedSignature[0] = tamperedSignature[0]! ^ 0x01;

    expect(
      await openGrantV2ForOperation(
        crypto,
        { ...grant, signature: tamperedSignature },
        authorization,
      ),
    ).toBeNull();
    expect(
      await openGrantV2ForOperation(
        crypto,
        grant,
        {
          ...authorization,
          issuingDeviceSigningPublicKey: otherIssuer.publicKey,
        },
      ),
    ).toBeNull();
    expect(
      await openGrantV2ForOperation(
        crypto,
        {
          ...grant,
          coveredDomains: [{
            ...grant.coveredDomains[0]!,
            domainEpoch: domainEpoch(99),
          }, grant.coveredDomains[1]!],
        },
        authorization,
      ),
    ).toBeNull();
  });

  test("minting fails before HPKE output when owner/scope, ordering, or root inventory diverges", async () => {
    const { crypto, issuer, recipient } = await setup();
    const base = {
      id: grantId("grant-invalid"),
      issuingDeviceId: cryptoDeviceId("alice-phone"),
      issuingHumanId: humanId("alice"),
      issuingDeviceSigningPrivateKey: issuer.privateKey,
      recipientAgentId: agentId("genie"),
      recipientKeyId: "invocation-invalid",
      recipientEncryptionPublicKey: recipient.publicKey,
      scope: [humanId("alice")],
      operations: ["decrypt"] as const,
      issuedAt: NOW,
      expiresAt: NOW + 1_000,
      coveredDomains: [{
        domainId: cryptoDomainId("domain-ab"),
        domainEpoch: domainEpoch(4),
        agentAuthorizationRevision: authorizationRevision(8),
        aiRoot: bytes(0xab),
      }],
      singleUse: false,
    };

    expect(
      mintGrantV2(crypto, {
        ...base,
        scope: [humanId("bob")],
      }),
    ).rejects.toThrow("issuing Human");
    expect(
      mintGrantV2(crypto, {
        ...base,
        coveredDomains: [
          {
            domainId: cryptoDomainId("domain-z"),
            domainEpoch: domainEpoch(1),
            agentAuthorizationRevision: authorizationRevision(1),
            aiRoot: bytes(1),
          },
          base.coveredDomains[0]!,
        ],
      }),
    ).rejects.toThrow("canonical");
    expect(
      mintGrantV2(crypto, {
        ...base,
        coveredDomains: [{
          ...base.coveredDomains[0]!,
          aiRoot: new Uint8Array(31),
        }],
      }),
    ).rejects.toThrow("AI root");
  });

  test("mint preflight distinguishes invalid scope, root type/width, and duplicate or unsorted Domains", async () => {
    const { crypto, issuer, recipient } = await setup();
    const base = {
      id: grantId("grant-preflight-exact"),
      issuingDeviceId: cryptoDeviceId("alice-phone"),
      issuingHumanId: humanId("alice"),
      issuingDeviceSigningPrivateKey: issuer.privateKey,
      recipientAgentId: agentId("genie"),
      recipientKeyId: "invocation-preflight-exact",
      recipientEncryptionPublicKey: recipient.publicKey,
      scope: [humanId("alice")],
      operations: ["decrypt"] as const,
      issuedAt: NOW,
      expiresAt: NOW + 1_000,
      coveredDomains: [{
        domainId: cryptoDomainId("domain-a"),
        domainEpoch: domainEpoch(1),
        agentAuthorizationRevision: authorizationRevision(1),
        aiRoot: bytes(1),
      }],
      singleUse: false,
    };
    const scopeError =
      "Grant scope must be canonical and contain the issuing Human";
    expect(mintGrantV2(crypto, {
      ...base,
      scope: [
        humanId("alice"),
        humanId("charlie"),
        humanId("bob"),
      ],
    })).rejects.toThrow(scopeError);
    expect(mintGrantV2(crypto, {
      ...base,
      scope: [
        humanId("alice"),
        "not a portable id" as ReturnType<typeof humanId>,
      ],
    })).rejects.toThrow(scopeError);
    expect(mintGrantV2(crypto, {
      ...base,
      scope: [
        humanId("alice"),
        humanId("alice"),
      ],
    })).rejects.toThrow(scopeError);

    const fakeRoot = {
      length: 32,
      slice: () => bytes(9),
    } as unknown as Uint8Array;
    expect(mintGrantV2(crypto, {
      ...base,
      coveredDomains: [{
        ...base.coveredDomains[0]!,
        aiRoot: fakeRoot,
      }],
    })).rejects.toThrow("Grant AI root must be exactly 32 bytes");
    expect(mintGrantV2(crypto, {
      ...base,
      coveredDomains: [{
        ...base.coveredDomains[0]!,
        aiRoot: new Uint8Array(31),
      }],
    })).rejects.toThrow("Grant AI root must be exactly 32 bytes");

    const canonicalError =
      "Grant covered Domains must be canonical and unique";
    const second = {
      domainId: cryptoDomainId("domain-b"),
      domainEpoch: domainEpoch(1),
      agentAuthorizationRevision: authorizationRevision(1),
      aiRoot: bytes(2),
    };
    expect(mintGrantV2(crypto, {
      ...base,
      coveredDomains: [second, base.coveredDomains[0]!],
    })).rejects.toThrow(canonicalError);
    expect(mintGrantV2(crypto, {
      ...base,
      coveredDomains: [
        base.coveredDomains[0]!,
        {
          ...base.coveredDomains[0]!,
          aiRoot: bytes(3),
        },
      ],
    })).rejects.toThrow(canonicalError);
  });

  test("zeroizes validator-owned root copies on both mint success and later preflight failure", async () => {
    const { crypto, issuer, recipient } = await setup();
    const base = {
      issuingDeviceId: cryptoDeviceId("alice-phone"),
      issuingHumanId: humanId("alice"),
      issuingDeviceSigningPrivateKey: issuer.privateKey,
      recipientAgentId: agentId("genie"),
      recipientEncryptionPublicKey: recipient.publicKey,
      scope: [humanId("alice")],
      operations: ["decrypt"] as const,
      issuedAt: NOW,
      expiresAt: NOW + 1_000,
      singleUse: false,
    };

    const originalFill = Uint8Array.prototype.fill;
    const zeroized: Array<{
      readonly before: Uint8Array;
      readonly target: Uint8Array;
    }> = [];
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      const before = this.slice();
      const result = originalFill.call(this, value, start, end);
      if (value === 0 && this.length === 32) {
        zeroized.push({ before, target: this });
      }
      return result;
    };
    try {
      const successfulRoot = Buffer.from(bytes(0x31));
      await mintGrantV2(crypto, {
        ...base,
        id: grantId("grant-root-wipe-success"),
        recipientKeyId: "invocation-root-wipe-success",
        coveredDomains: [{
          domainId: cryptoDomainId("domain-a"),
          domainEpoch: domainEpoch(1),
          agentAuthorizationRevision: authorizationRevision(1),
          aiRoot: successfulRoot,
        }],
      });
      expect(zeroized.some(({ before, target }) =>
        !Buffer.isBuffer(target)
        && before.every((byte) => byte === 0x31)
        && target.every((byte) => byte === 0)
      )).toBeTrue();
      expect(Array.from(successfulRoot)).toEqual(Array.from(bytes(0x31)));

      zeroized.length = 0;
      const failedRoot = Buffer.from(bytes(0x41));
      expect(mintGrantV2(crypto, {
        ...base,
        id: grantId("grant-root-wipe-failure"),
        recipientKeyId: "invocation-root-wipe-failure",
        coveredDomains: [
          {
            domainId: cryptoDomainId("domain-a"),
            domainEpoch: domainEpoch(1),
            agentAuthorizationRevision: authorizationRevision(1),
            aiRoot: failedRoot,
          },
          {
            domainId: cryptoDomainId("domain-b"),
            domainEpoch: domainEpoch(1),
            agentAuthorizationRevision: authorizationRevision(1),
            aiRoot: {
              length: 32,
              slice: () => bytes(5),
            } as unknown as Uint8Array,
          },
        ],
      })).rejects.toThrow("Grant AI root must be exactly 32 bytes");
      expect(zeroized.some(({ before, target }) =>
        !Buffer.isBuffer(target)
        && before.every((byte) => byte === 0x41)
        && target.every((byte) => byte === 0)
      )).toBeTrue();
      expect(Array.from(failedRoot)).toEqual(Array.from(bytes(0x41)));
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
  });

  test("owns detached HPKE ciphertext and signature bytes returned by crypto providers", async () => {
    const crypto = new LatticeCrypto(seededRng(722));
    const issuer = crypto.generateSigningKeyPair();
    const recipient = await crypto.generateEncryptionKeyPair();
    const providerCiphertext = new Uint8Array(48).fill(0xc1);
    const providerSignature = new Uint8Array(64).fill(0x51);
    crypto.sealTo = async () => providerCiphertext;
    crypto.sign = () => providerSignature;

    const grant = await mintGrantV2(crypto, {
      id: grantId("grant-provider-ownership"),
      issuingDeviceId: cryptoDeviceId("alice-phone"),
      issuingHumanId: humanId("alice"),
      issuingDeviceSigningPrivateKey: issuer.privateKey,
      recipientAgentId: agentId("genie"),
      recipientKeyId: "invocation-provider-ownership",
      recipientEncryptionPublicKey: recipient.publicKey,
      scope: [humanId("alice")],
      operations: ["decrypt"],
      issuedAt: NOW,
      expiresAt: NOW + 1_000,
      coveredDomains: [{
        domainId: cryptoDomainId("domain-a"),
        domainEpoch: domainEpoch(1),
        agentAuthorizationRevision: authorizationRevision(1),
        aiRoot: bytes(1),
      }],
      singleUse: false,
    });
    const ciphertextSnapshot = grant.encryptedSecret.slice();
    const signatureSnapshot = grant.signature.slice();
    expect(grant.encryptedSecret).not.toBe(providerCiphertext);
    expect(grant.signature).not.toBe(providerSignature);
    providerCiphertext.fill(0);
    providerSignature.fill(0);
    expect(grant.encryptedSecret).toEqual(ciphertextSnapshot);
    expect(grant.signature).toEqual(signatureSnapshot);
  });

  test("snapshots every mint coordinate and signing key before HPKE", async () => {
    const crypto = new LatticeCrypto(seededRng(723));
    const issuer = crypto.generateSigningKeyPair();
    const recipient = await crypto.generateEncryptionKeyPair();
    const signingKey = Buffer.from(issuer.privateKey);
    const scope = [humanId("alice")];
    const operations: Array<"decrypt" | "encrypt"> = ["decrypt"];
    let releaseSeal = (): void => {};
    const sealGate = new Promise<void>((resolve) => {
      releaseSeal = resolve;
    });
    const originalSeal = crypto.sealTo.bind(crypto);
    crypto.sealTo = async (publicKey, plaintext) => {
      await sealGate;
      return originalSeal(publicKey, plaintext);
    };

    const pendingGrant = mintGrantV2(crypto, {
      id: grantId("grant-mint-snapshot"),
      issuingDeviceId: cryptoDeviceId("alice-phone"),
      issuingHumanId: humanId("alice"),
      issuingDeviceSigningPrivateKey: signingKey,
      recipientAgentId: agentId("genie"),
      recipientKeyId: "invocation-mint-snapshot",
      recipientEncryptionPublicKey: recipient.publicKey,
      scope,
      operations,
      issuedAt: NOW,
      expiresAt: NOW + 1_000,
      coveredDomains: [{
        domainId: cryptoDomainId("domain-a"),
        domainEpoch: domainEpoch(1),
        agentAuthorizationRevision: authorizationRevision(1),
        aiRoot: bytes(1),
      }],
      singleUse: false,
    });
    scope[0] = humanId("mallory");
    operations[0] = "encrypt";
    signingKey.fill(0);
    releaseSeal();

    const grant = await pendingGrant;
    expect(grant.scope).toEqual([humanId("alice")]);
    expect(grant.operations).toEqual(["decrypt"]);
    expect(
      crypto.verify(
        issuer.publicKey,
        grantV2SigningBytes(grant),
        grant.signature,
      ),
    ).toBe(true);
  });
});

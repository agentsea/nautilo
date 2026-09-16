import { describe, expect, test } from "bun:test";

import {
  BACKGROUND_AUTHORIZATION_RESPONSE_DOMAIN_V1,
  BACKGROUND_AUTHORIZATION_RESPONSE_FORMAT_VERSION_V1,
  BACKGROUND_AUTHORIZATION_RESPONSE_MAX_TTL_MS_V1,
  MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V1,
  backgroundAuthorizationResponseSigningBytesV1,
  createBackgroundAuthorizationResponseV1,
  decodeBackgroundAuthorizationResponseV1,
  encodeBackgroundAuthorizationResponseV1,
  verifyCurrentBackgroundAuthorizationResponseV1,
  verifyHistoricalBackgroundAuthorizationResponseV1,
  type BackgroundAuthorizationResponseIssuerContextV1,
} from "../../src/background/background-authorization-response-v1.ts";
import {
  PROCESSOR_CREDENTIAL_FIXTURE_NOW,
} from "../helpers/processor-credential-v1-fixture.ts";
import {
  createBackgroundAuthorizationResponseFixtureV1,
} from "../helpers/background-authorization-response-v1-fixture.ts";

describe("BackgroundAuthorizationResponseV1", () => {
  test("locks the public format and wire limits", () => {
    expect(BACKGROUND_AUTHORIZATION_RESPONSE_DOMAIN_V1).toBe(
      "nautilo/lattice-crypto/background-authorization-response/v1",
    );
    expect(BACKGROUND_AUTHORIZATION_RESPONSE_MAX_TTL_MS_V1).toBe(600_000);
    expect(MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V1)
      .toBe(200_704);
  });

  test("round-trips a strict response and verifies current and historical authority", async () => {
    const state = await createBackgroundAuthorizationResponseFixtureV1();
    const decoded =
      decodeBackgroundAuthorizationResponseV1(state.response.bytes);
    const expectedContext = {
      requestId: state.descriptor.requestId,
      recipientGeneration: state.descriptor.recipientGeneration,
      recipientKeyId: state.descriptor.recipientKeyId,
      recipientPublicKey: state.descriptor.recipientPublicKey,
      credentialHash: state.created.hash,
      issuingHumanId: state.created.credential.issuingHumanId,
      issuingDeviceId: state.created.credential.issuingDeviceId,
      issuingDeviceAuthorizationRevision:
        state.created.credential.issuingDeviceAuthorizationRevision,
      issuerSigningPublicKeyHash:
        state.created.credential.issuerSigningPublicKeyHash,
      workDescriptorHash: state.created.credential.workDescriptorHash,
      namespaceId: state.descriptor.namespaceId,
      domainId: state.descriptor.domainId,
      domainEpoch: state.descriptor.expectedDomainEpoch,
      namespaceAccessRevision:
        state.descriptor.expectedNamespaceAccessRevision,
      policyRevision: state.descriptor.expectedPolicyRevision,
      issuedAt: state.descriptor.issuedAt,
      notBefore: state.descriptor.notBefore,
      expiresAt: state.descriptor.expiresAt,
    } satisfies Omit<BackgroundAuthorizationResponseIssuerContextV1, "purpose">;
    let currentContext: BackgroundAuthorizationResponseIssuerContextV1
      | undefined;
    let historicalContext: BackgroundAuthorizationResponseIssuerContextV1
      | undefined;

    const current =
      await verifyCurrentBackgroundAuthorizationResponseV1(state.crypto, {
        responseBytes: state.response.bytes,
        now: state.descriptor.notBefore,
        resolveCurrentIssuingDevicePublicKey: (context) => {
          currentContext = structuredClone(context);
          return state.issuer.publicKey;
        },
      });
    const historical =
      await verifyHistoricalBackgroundAuthorizationResponseV1(
        state.crypto,
        {
          responseBytes: state.response.bytes,
          resolveHistoricalIssuingDevicePublicKey: (context) => {
            historicalContext = structuredClone(context);
            return state.issuer.publicKey;
          },
        },
      );

    expect(decoded.formatVersion)
      .toBe(BACKGROUND_AUTHORIZATION_RESPONSE_FORMAT_VERSION_V1);
    expect(encodeBackgroundAuthorizationResponseV1(decoded))
      .toEqual(state.response.bytes);
    const { signature: _, ...unsigned } = decoded;
    const signingBytes =
      backgroundAuthorizationResponseSigningBytesV1(unsigned);
    expect(signingBytes).toEqual(state.response.bytes.slice(0, -68));
    signingBytes.fill(0);
    expect(state.response.bytes.at(0)).not.toBe(0xff);
    expect(decoded.credentialBytes).toEqual(state.created.bytes);
    expect(decoded.credentialHash).toEqual(state.created.hash);
    expect(decoded.requestId).toBe(state.descriptor.requestId);
    expect(decoded.recipientGeneration)
      .toBe(state.descriptor.recipientGeneration);
    expect(decoded.recipientKeyId).toBe(state.descriptor.recipientKeyId);
    expect(decoded.recipientPublicKey)
      .toEqual(state.descriptor.recipientPublicKey);
    expect(current.workDescriptor).toEqual(state.descriptor);
    expect(current.responseHash).toEqual(state.response.hash);
    expect(historical.workDescriptor).toEqual(state.descriptor);
    expect(currentContext).toEqual({
      purpose: "verify-current-background-authorization-response",
      ...expectedContext,
    });
    expect(historicalContext).toEqual({
      purpose: "verify-historical-background-authorization-response",
      ...expectedContext,
    });
  });

  test("derives every security field from the signed credential and enforces the ten-minute limit", async () => {
    const state = await createBackgroundAuthorizationResponseFixtureV1(
      24_501,
    );
    const response = state.response.response;

    expect(response.expiresAt - response.issuedAt)
      .toBeLessThanOrEqual(BACKGROUND_AUTHORIZATION_RESPONSE_MAX_TTL_MS_V1);
    expect(response.requestId).toBe(state.descriptor.requestId);
    expect(response.workDescriptorHash)
      .toEqual(state.created.credential.workDescriptorHash);
    expect(response.domainEpoch)
      .toBe(state.descriptor.expectedDomainEpoch);
    expect(response.namespaceAccessRevision)
      .toBe(state.descriptor.expectedNamespaceAccessRevision);
    expect(response.policyRevision)
      .toBe(state.descriptor.expectedPolicyRevision);
    expect(() =>
      createBackgroundAuthorizationResponseV1(state.crypto, {
        credentialBytes: state.created.bytes,
        issuingDeviceSigningPublicKey:
          state.crypto.generateSigningKeyPair().publicKey,
        issuingDeviceSigningPrivateKey:
          state.issuer.privateKey,
      })
    ).toThrow("do not match");
    expect(() =>
      createBackgroundAuthorizationResponseV1(state.crypto, {
        credentialBytes: state.created.bytes,
        issuingDeviceSigningPublicKey: state.issuer.publicKey,
        issuingDeviceSigningPrivateKey:
          state.crypto.generateSigningKeyPair().privateKey,
      })
    ).toThrow("do not match");
  });

  test("enforces not-before and expiry for current acceptance but preserves historical verification", async () => {
    const state = await createBackgroundAuthorizationResponseFixtureV1(
      24_502,
    );
    const verifyAt = (now: number) =>
      verifyCurrentBackgroundAuthorizationResponseV1(state.crypto, {
        responseBytes: state.response.bytes,
        now,
        resolveCurrentIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      });

    expect(verifyAt(state.descriptor.notBefore - 1))
      .rejects.toThrow("not currently valid");
    expect(verifyAt(state.descriptor.notBefore)).resolves.toBeDefined();
    expect(verifyAt(state.descriptor.expiresAt - 1))
      .resolves.toBeDefined();
    expect(verifyAt(state.descriptor.expiresAt))
      .rejects.toThrow("not currently valid");
    expect(verifyHistoricalBackgroundAuthorizationResponseV1(
      state.crypto,
      {
        responseBytes: state.response.bytes,
        resolveHistoricalIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      },
    )).resolves.toBeDefined();
  });

  test("fails closed on unknown fields, trailing bytes, oversized wires, and absent authority", async () => {
    const state = await createBackgroundAuthorizationResponseFixtureV1(
      24_503,
    );
    expect(() =>
      encodeBackgroundAuthorizationResponseV1({
        ...state.response.response,
        unexpected: true,
      } as never)
    ).toThrow("field set");
    const { signature: _signature, ...withoutSignature } =
      state.response.response;
    expect(() =>
      encodeBackgroundAuthorizationResponseV1(withoutSignature as never)
    ).toThrow("field set");
    expect(() =>
      decodeBackgroundAuthorizationResponseV1(
        new Uint8Array([...state.response.bytes, 0]),
      )
    ).toThrow("trailing");
    expect(() =>
      decodeBackgroundAuthorizationResponseV1(
        new Uint8Array(
          MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V1 + 1,
        ),
      )
    ).toThrow("wire limit");
    expect(verifyCurrentBackgroundAuthorizationResponseV1(state.crypto, {
      responseBytes: state.response.bytes,
      now: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 1,
      resolveCurrentIssuingDevicePublicKey: () => null,
    })).rejects.toThrow("not currently authorized");

    const response = state.response.response;
    const { credentialHash: _, ...withoutCredentialHash } = response;
    const malformed: Array<readonly [unknown, string]> = [
      [null, "must be an object"],
      [[], "must be an object"],
      ["response", "must be an object"],
      [{ ...withoutCredentialHash, credentialDigest: response.credentialHash },
        "field set"],
      [{ ...response, formatVersion: 2 }, "format version"],
      [{ ...response, recipientPublicKey: new Uint8Array(64) },
        "exactly 65 bytes"],
      [{ ...response, credentialBytes: new Uint8Array() }, "must contain"],
      [{ ...response, credentialHash: new Uint8Array(31) },
        "exactly 32 bytes"],
      [{ ...response, credentialHash: new Uint8Array(32) },
        "credential hash does not match"],
      [{ ...response, issuerSigningPublicKeyHash: new Uint8Array(31) },
        "exactly 32 bytes"],
      [{ ...response, workDescriptorHash: new Uint8Array(31) },
        "exactly 32 bytes"],
      [{ ...response, signature: new Uint8Array(63) },
        "exactly 64 bytes"],
      [{ ...response, issuedAt: response.notBefore + 1 }, "ten-minute TTL"],
      [{ ...response, notBefore: response.expiresAt }, "ten-minute TTL"],
      [{
        ...response,
        expiresAt: response.issuedAt
          + BACKGROUND_AUTHORIZATION_RESPONSE_MAX_TTL_MS_V1 + 1,
      }, "ten-minute TTL"],
    ];
    for (const [value, message] of malformed) {
      expect(() =>
        encodeBackgroundAuthorizationResponseV1(value as never)
      ).toThrow(message);
    }

    expect(() => decodeBackgroundAuthorizationResponseV1(null as never))
      .toThrow("must be Uint8Array");
    expect(verifyCurrentBackgroundAuthorizationResponseV1(state.crypto, {
      responseBytes: state.response.bytes,
      now: state.descriptor.notBefore,
      resolveCurrentIssuingDevicePublicKey: null as never,
    })).rejects.toThrow("resolver is required");
    expect(verifyCurrentBackgroundAuthorizationResponseV1(state.crypto, {
      responseBytes: state.response.bytes,
      now: state.descriptor.notBefore,
      resolveCurrentIssuingDevicePublicKey: () => new Uint8Array(31),
    })).rejects.toThrow("exactly 32 bytes");

    expect(verifyCurrentBackgroundAuthorizationResponseV1(state.crypto, {
      responseBytes: new Uint8Array([0]),
      now: state.descriptor.notBefore,
      resolveCurrentIssuingDevicePublicKey: () => state.issuer.publicKey,
    })).rejects.toThrow("truncated u32");
    expect(verifyCurrentBackgroundAuthorizationResponseV1(state.crypto, {
      responseBytes: new Uint8Array(
        MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V1,
      ),
      now: state.descriptor.notBefore,
      resolveCurrentIssuingDevicePublicKey: () => state.issuer.publicKey,
    })).rejects.toThrow("domain mismatch");
    expect(verifyCurrentBackgroundAuthorizationResponseV1(state.crypto, {
      responseBytes: state.response.bytes,
      now: -1,
      resolveCurrentIssuingDevicePublicKey: () => state.issuer.publicKey,
    })).rejects.toThrow("verification time");
    const wrongDomain = state.response.bytes.slice();
    const domainTail = BACKGROUND_AUTHORIZATION_RESPONSE_DOMAIN_V1.length - 1;
    wrongDomain[domainTail] = wrongDomain[domainTail]! ^ 1;
    expect(() => decodeBackgroundAuthorizationResponseV1(wrongDomain))
      .toThrow("domain mismatch");
  });
});

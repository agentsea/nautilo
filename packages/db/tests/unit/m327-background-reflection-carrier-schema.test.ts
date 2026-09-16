import { describe, expect, test } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import {
  MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
  MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V2,
} from "../../../lattice-crypto/src/background/processor-authorization-v2.ts";
import {
  MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  MAX_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
} from "../../../lattice-crypto/src/background/work-descriptor-v2.ts";
import {
  BACKGROUND_AUTHORIZATION_BYTE_LIMITS,
  backgroundCryptoAuthorizationRequests,
  processorCryptoSignerAuthorizations,
} from "../../src/schema/crypto-storage.ts";

function checkSql(
  table: Parameters<typeof getTableConfig>[0],
  name: string,
): string {
  const constraint = getTableConfig(table).checks.find(
    (candidate) => candidate.name === name,
  );
  expect(constraint, name).toBeDefined();
  return new PgDialect().sqlToQuery(constraint!.value).sql
    .replaceAll(/"[^"]+"\./g, "")
    .replaceAll(/\s+/g, " ")
    .trim();
}

describe("M327 Reflection background authorization carrier schema", () => {
  test("keeps the durable exact maxima equal to the additive V2 codecs", () => {
    expect(Number(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.descriptor)).toBe(
      MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
    );
    expect(Number(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.processorResponse)).toBe(
      MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
    );
    expect(Number(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.response)).toBe(
      MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
    );
    expect(Number(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.signerAuthorization)).toBe(
      MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V2,
    );
    expect(MAX_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2).toBeLessThanOrEqual(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.legacyDescriptor);
    expect(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.legacyDescriptor).toBe(
      MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2,
    );
  });

  test("widens only Reflection while retaining Stenographer and Agent ceilings", () => {
    const requestDescriptor = checkSql(
      backgroundCryptoAuthorizationRequests,
      "background_crypto_authorization_requests_descriptor_coherent",
    );
    expect(requestDescriptor).toContain(
      `octet_length("descriptor_bytes") between 1 and ${
        MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2
      }`,
    );

    const response = checkSql(
      backgroundCryptoAuthorizationRequests,
      "background_crypto_authorization_requests_response_coherent",
    );
    expect(response).toContain(
      `"accepted_response_kind" = 'processor' and octet_length("accepted_response_bytes") between 1 and ${
        MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2
      }`,
    );
    expect(response).toContain(
      `"accepted_response_kind" = 'agent' and octet_length("accepted_response_bytes") between 1 and 16912384`,
    );

    const legacyRequest = checkSql(
      backgroundCryptoAuthorizationRequests,
      "background_crypto_authorization_requests_legacy_carrier_bounds",
    );
    expect(legacyRequest).toContain(
      `"processor_kind" is not distinct from 'reflection' or`,
    );
    expect(legacyRequest).toContain(
      `octet_length("descriptor_bytes") <= ${
        BACKGROUND_AUTHORIZATION_BYTE_LIMITS.legacyDescriptor
      }`,
    );
    expect(legacyRequest).toContain(
      `octet_length("accepted_response_bytes") <= ${
        BACKGROUND_AUTHORIZATION_BYTE_LIMITS.legacyProcessorResponse
      }`,
    );

    const signerDescriptor = checkSql(
      processorCryptoSignerAuthorizations,
      "processor_crypto_signer_authorizations_descriptor_size",
    );
    expect(signerDescriptor).toContain(
      `octet_length("work_descriptor_bytes") between 1 and ${
        MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2
      }`,
    );
    const signerAuthorization = checkSql(
      processorCryptoSignerAuthorizations,
      "processor_crypto_signer_authorizations_authorization_size",
    );
    expect(signerAuthorization).toContain(
      `octet_length("authorization_bytes") between 1 and ${
        MAX_PROCESSOR_SIGNER_AUTHORIZATION_WIRE_BYTES_V2
      }`,
    );
    const legacySigner = checkSql(
      processorCryptoSignerAuthorizations,
      "processor_crypto_signer_authorizations_legacy_carrier_bounds",
    );
    expect(legacySigner).toContain(
      `"processor_kind" is not distinct from 'reflection' or`,
    );
    expect(legacySigner).toContain(
      `octet_length("work_descriptor_bytes") <= ${
        BACKGROUND_AUTHORIZATION_BYTE_LIMITS.legacyDescriptor
      }`,
    );
    expect(legacySigner).toContain(
      `octet_length("authorization_bytes") <= ${
        BACKGROUND_AUTHORIZATION_BYTE_LIMITS.legacySignerAuthorization
      }`,
    );
  });
});

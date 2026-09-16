import { describe, expect, test } from "bun:test";

import {
  auditDtoDeclarations,
  type DtoDeclaration,
  type DtoInventoryObservation,
} from "../../src/node/dto-inventory";

const routeObservation: DtoInventoryObservation = {
  id: "wire.http.request-response.get-api-example",
  surface: "wire",
  locator: "http:request_response:GET /api/example",
  transport: "http",
  direction: "request_response",
  contract: "GET /api/example",
  sourcePath: "packages/server/src/routes/example.ts",
  structuralSignatures: [],
  arbitraryPayloads: [],
};

const arbitraryObservation: DtoInventoryObservation = {
  id: "wire.http.accepted-arbitrary.example-body",
  surface: "wire",
  locator: "http:accepted_arbitrary:packages/server/src/routes/example.ts#ExampleBody",
  transport: "http",
  direction: "accepted_arbitrary",
  contract: "ExampleBody",
  sourcePath: "packages/server/src/routes/example.ts",
  structuralSignatures: [],
  arbitraryPayloads: ["metadata", "parts[].payload"],
};

const routeDeclaration: DtoDeclaration = {
  observationId: routeObservation.id,
  locator: routeObservation.locator,
  arbitraryPayloads: [],
};

const arbitraryDeclaration: DtoDeclaration = {
  observationId: arbitraryObservation.id,
  locator: arbitraryObservation.locator,
  arbitraryPayloads: [
    { path: "metadata", schema: "ClosedExampleMetadataV1" },
    { path: "parts[].payload", schema: "ClosedExamplePartPayloadV1" },
  ],
};

describe("DTO declaration drift audit", () => {
  test("rejects duplicate, missing, and stale structural signatures", () => {
    const observation: DtoInventoryObservation = {
      ...routeObservation,
      structuralSignatures: ["request.body:{secret:string}", "response.body:{ok:boolean}"],
    };
    const result = auditDtoDeclarations({
      observations: [observation],
      declarations: [{
        ...routeDeclaration,
        structuralSignatures: [
          "request.body:{secret:string}",
          "request.body:{secret:string}",
          "response.body:{legacy:boolean}",
        ],
      }],
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        `${observation.locator}: duplicate structural signature: request.body:{secret:string}`,
        `${observation.locator}: missing structural signature: response.body:{ok:boolean}`,
        `${observation.locator}: stale structural signature: response.body:{legacy:boolean}`,
      ],
    });
  });

  test("accepts one exact declaration per observation with closed arbitrary schemas", () => {
    expect(
      auditDtoDeclarations({
        observations: [arbitraryObservation, routeObservation],
        declarations: [routeDeclaration, arbitraryDeclaration],
      }),
    ).toEqual({
      ok: true,
      counts: { observations: 2, declarations: 2, arbitraryPayloads: 2 },
    });
  });

  test("accepts an exact owned baseline-debt reference instead of pretending an open payload has a schema", () => {
    expect(
      auditDtoDeclarations({
        observations: [arbitraryObservation],
        declarations: [{
          observationId: arbitraryObservation.id,
          locator: arbitraryObservation.locator,
          arbitraryPayloads: [
            { path: "metadata", debtId: "debt.wire.example.metadata" },
            { path: "parts[].payload", debtId: "debt.wire.example.parts-payload" },
          ],
        }],
      }),
    ).toEqual({
      ok: true,
      counts: { observations: 1, declarations: 1, arbitraryPayloads: 2 },
    });
  });

  test("fails deterministically on new, stale, and duplicate declarations", () => {
    expect(
      auditDtoDeclarations({
        observations: [routeObservation, arbitraryObservation],
        declarations: [
          routeDeclaration,
          routeDeclaration,
          {
            observationId: "wire.http.stale",
            locator: "http:request_response:GET /api/stale",
            arbitraryPayloads: [],
          },
        ],
      }),
    ).toEqual({
      ok: false,
      errors: [
        `duplicate DTO declaration id: ${routeObservation.id}`,
        `duplicate DTO declaration locator: ${routeObservation.locator}`,
        `missing DTO declaration: ${arbitraryObservation.locator}`,
        "stale DTO declaration: http:request_response:GET /api/stale",
      ],
    });
  });

  test("fails on duplicate observations before a manifest can hide discovery bugs", () => {
    expect(
      auditDtoDeclarations({
        observations: [routeObservation, routeObservation],
        declarations: [routeDeclaration],
      }),
    ).toEqual({
      ok: false,
      errors: [
        `duplicate DTO observation id: ${routeObservation.id}`,
        `duplicate DTO observation locator: ${routeObservation.locator}`,
      ],
    });
  });

  test("requires exact paths and concrete closed schema names for arbitrary payloads", () => {
    expect(
      auditDtoDeclarations({
        observations: [arbitraryObservation],
        declarations: [{
          observationId: arbitraryObservation.id,
          locator: arbitraryObservation.locator,
          arbitraryPayloads: [
            { path: "metadata", schema: "Record<string, unknown>" },
            { path: "metadata", schema: "DuplicateMetadataV1" },
            { path: "parts.*", schema: "WildcardParts" },
            { path: "unexpected", schema: "UnexpectedPayloadV1" },
          ],
        }],
      }),
    ).toEqual({
      ok: false,
      errors: [
        `${arbitraryObservation.locator}: arbitrary payload path must be exact: parts.*`,
        `${arbitraryObservation.locator}: duplicate arbitrary payload declaration: metadata`,
        `${arbitraryObservation.locator}: schema must be concrete for metadata`,
        `${arbitraryObservation.locator}: missing arbitrary payload declaration: parts[].payload`,
        `${arbitraryObservation.locator}: unexpected arbitrary payload declaration: parts.*`,
        `${arbitraryObservation.locator}: unexpected arbitrary payload declaration: unexpected`,
      ],
    });
  });

  test("rejects a locator mismatch even when an observation id was copied correctly", () => {
    expect(
      auditDtoDeclarations({
        observations: [routeObservation],
        declarations: [{
          ...routeDeclaration,
          locator: "http:request_response:GET /api/not-example",
        }],
      }),
    ).toEqual({
      ok: false,
      errors: [
        `${routeObservation.id}: declaration locator does not match observation`,
      ],
    });
  });

  test.each([
    "",
    " metadata",
    "metadata ",
    ".metadata",
    "metadata.",
    "meta*data",
  ])("rejects non-exact arbitrary payload path %p", (path) => {
    const result = auditDtoDeclarations({
      observations: [arbitraryObservation],
      declarations: [{
        observationId: arbitraryObservation.id,
        locator: arbitraryObservation.locator,
        arbitraryPayloads: [{ path, schema: "ClosedMetadataV1" }],
      }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        `${arbitraryObservation.locator}: arbitrary payload path must be exact: ${path}`,
      );
    }
  });

  test.each([
    "ab",
    " ClosedMetadataV1 ",
    " unknown ",
    "Unknown[]",
    "ANY",
    " JSON ",
    "Record<string,MetadataV1>",
    "Record<string, MetadataV1>",
    "Record<string, unknown>",
    "Metadata*",
  ])("rejects non-concrete arbitrary payload schema %p", (schema) => {
    const result = auditDtoDeclarations({
      observations: [arbitraryObservation],
      declarations: [{
        observationId: arbitraryObservation.id,
        locator: arbitraryObservation.locator,
        arbitraryPayloads: [
          { path: "metadata", schema },
          { path: "parts[].payload", schema: "ClosedPartPayloadV1" },
        ],
      }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        `${arbitraryObservation.locator}: schema must be concrete for metadata`,
      );
    }
  });

  test("accepts the exact minimum concrete schema-name length", () => {
    expect(auditDtoDeclarations({
      observations: [arbitraryObservation],
      declarations: [{
        observationId: arbitraryObservation.id,
        locator: arbitraryObservation.locator,
        arbitraryPayloads: [
          { path: "metadata", schema: "Ab1" },
          { path: "parts[].payload", schema: "Cd2" },
        ],
      }],
    }).ok).toBe(true);
  });

  test.each([
    "",
    "debt",
    "xdebt.wire.metadata",
    "debt.wire.metadata!",
    "debt..wire",
  ])("rejects malformed arbitrary payload debt ID %p", (debtId) => {
    const result = auditDtoDeclarations({
      observations: [arbitraryObservation],
      declarations: [{
        observationId: arbitraryObservation.id,
        locator: arbitraryObservation.locator,
        arbitraryPayloads: [
          { path: "metadata", debtId },
          { path: "parts[].payload", schema: "ClosedPartPayloadV1" },
        ],
      }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        `${arbitraryObservation.locator}: schema must be concrete for metadata`,
      );
    }
  });

  test.each([
    { path: "metadata" },
    { path: "metadata", schema: 42 },
    { path: "metadata", debtId: 42 },
    {
      path: "metadata",
      debtId: { toString: () => "debt.wire.metadata" },
    },
  ])("rejects malformed schema/debt declaration %p", (payload) => {
    const result = auditDtoDeclarations({
      observations: [arbitraryObservation],
      declarations: [{
        observationId: arbitraryObservation.id,
        locator: arbitraryObservation.locator,
        arbitraryPayloads: [
          payload as never,
          { path: "parts[].payload", schema: "ClosedPartPayloadV1" },
        ],
      }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        `${arbitraryObservation.locator}: schema must be concrete for metadata`,
      );
    }
  });

  test("sorts multiple duplicate, missing, stale, and unexpected failures", () => {
    const secondObservation = {
      ...routeObservation,
      id: "wire.http.request-response.get-api-alpha",
      locator: "http:request_response:GET /api/alpha",
    };
    const result = auditDtoDeclarations({
      observations: [routeObservation, secondObservation],
      declarations: [
        {
          observationId: "wire.http.stale-zeta",
          locator: "http:request_response:GET /api/zeta",
          arbitraryPayloads: [],
        },
        {
          observationId: "wire.http.stale-beta",
          locator: "http:request_response:GET /api/beta",
          arbitraryPayloads: [],
        },
      ],
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        "missing DTO declaration: http:request_response:GET /api/alpha",
        "missing DTO declaration: http:request_response:GET /api/example",
        "stale DTO declaration: http:request_response:GET /api/beta",
        "stale DTO declaration: http:request_response:GET /api/zeta",
      ],
    });
  });

  test("sorts multiple duplicate IDs and locators independently", () => {
    const alpha = {
      ...routeObservation,
      id: "wire.http.alpha",
      locator: "http:request_response:GET /api/alpha",
    };
    const zeta = {
      ...routeObservation,
      id: "wire.http.zeta",
      locator: "http:request_response:GET /api/zeta",
    };
    const result = auditDtoDeclarations({
      observations: [zeta, zeta, alpha, alpha],
      declarations: [],
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        "duplicate DTO observation id: wire.http.alpha",
        "duplicate DTO observation id: wire.http.zeta",
        "duplicate DTO observation locator: http:request_response:GET /api/alpha",
        "duplicate DTO observation locator: http:request_response:GET /api/zeta",
        "missing DTO declaration: http:request_response:GET /api/alpha",
        "missing DTO declaration: http:request_response:GET /api/alpha",
        "missing DTO declaration: http:request_response:GET /api/zeta",
        "missing DTO declaration: http:request_response:GET /api/zeta",
      ],
    });
  });

  test("sorts multiple invalid, missing, and unexpected arbitrary paths", () => {
    const result = auditDtoDeclarations({
      observations: [arbitraryObservation],
      declarations: [{
        observationId: arbitraryObservation.id,
        locator: arbitraryObservation.locator,
        arbitraryPayloads: [
          { path: "zeta.*", schema: "ClosedZetaV1" },
          { path: "alpha.*", schema: "ClosedAlphaV1" },
          { path: "zeta", schema: "ClosedZetaV1" },
          { path: "alpha", schema: "ClosedAlphaV1" },
        ],
      }],
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        `${arbitraryObservation.locator}: arbitrary payload path must be exact: alpha.*`,
        `${arbitraryObservation.locator}: arbitrary payload path must be exact: zeta.*`,
        `${arbitraryObservation.locator}: missing arbitrary payload declaration: metadata`,
        `${arbitraryObservation.locator}: missing arbitrary payload declaration: parts[].payload`,
        `${arbitraryObservation.locator}: unexpected arbitrary payload declaration: alpha`,
        `${arbitraryObservation.locator}: unexpected arbitrary payload declaration: alpha.*`,
        `${arbitraryObservation.locator}: unexpected arbitrary payload declaration: zeta`,
        `${arbitraryObservation.locator}: unexpected arbitrary payload declaration: zeta.*`,
      ],
    });
  });

  test("sorts multiple missing arbitrary paths from an unsorted observation", () => {
    const observation = {
      ...arbitraryObservation,
      arbitraryPayloads: ["zeta", "alpha"],
    };
    expect(auditDtoDeclarations({
      observations: [observation],
      declarations: [{
        observationId: observation.id,
        locator: observation.locator,
        arbitraryPayloads: [],
      }],
    })).toEqual({
      ok: false,
      errors: [
        `${observation.locator}: missing arbitrary payload declaration: alpha`,
        `${observation.locator}: missing arbitrary payload declaration: zeta`,
      ],
    });
  });
});

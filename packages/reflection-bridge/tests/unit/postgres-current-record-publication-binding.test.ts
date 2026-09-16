import { describe, expect, test } from "bun:test";

import {
  PostgresCurrentRecordPublicationBinding,
  protectedRecordCurrentHeadOriginJoinSql,
} from "../../src/server/postgres-current-record-publication-binding";
import {
  verifyRecordProductPostgresHandle,
  type RecordProductPostgresConnection,
  type RecordProductPostgresExecutor,
  type RecordProductPostgresRow,
  type RecordProductPostgresScalar,
} from "../../src/server/product-postgres";

const ORIGIN_NAMESPACE = "66000000-0000-4000-8000-000000000001";
const ACCESS_NAMESPACE = "66000000-0000-4000-8000-000000000002";
const SECOND_ACCESS_NAMESPACE = "66000000-0000-4000-8000-000000000003";
const ORIGIN_BINDING = `journal:namespace:${ORIGIN_NAMESPACE}:protected:v1`;
const ORDINARY_ORIGIN_BINDING = `journal:namespace:${ORIGIN_NAMESPACE}:ordinary:v1`;

function connectionFor(
  query: (
    statement: string,
    parameters: readonly RecordProductPostgresScalar[] | undefined,
  ) => readonly RecordProductPostgresRow[],
): RecordProductPostgresConnection {
  return {
    async query<Row extends RecordProductPostgresRow>(
      statement: string,
      parameters?: readonly RecordProductPostgresScalar[],
    ) {
      if (statement.includes("current_user AS current_role")) {
        return [{
          current_role: "nautilo",
          session_role: "nautilo",
        }] as unknown as readonly Row[];
      }
      return query(statement, parameters) as readonly Row[];
    },
    async transaction<Result>(
      callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>,
    ) {
      return callback(this);
    },
  };
}

function isOriginQuery(statement: string): boolean {
  return statement.includes('from "reflection_record_publications"')
    && statement.includes("order by")
    && !statement.includes("!~*");
}

function isOriginAgreementQuery(statement: string): boolean {
  return statement.includes('from "reflection_record_publications"')
    && statement.includes("!~*");
}

function isCurrentPublicationQuery(statement: string): boolean {
  return statement.includes('from "reflection_record_publications"')
    && !statement.includes("order by")
    && !isOriginAgreementQuery(statement);
}

function originBindingPattern(
  parameters: readonly RecordProductPostgresScalar[] | undefined,
): RegExp {
  const source = parameters?.find((parameter) => (
    typeof parameter === "string" && parameter.startsWith("^journal:namespace:")
  ));
  if (typeof source !== "string") throw new Error("Missing origin binding pattern");
  return new RegExp(source, "iu");
}

describe("Postgres current Record publication binding", () => {
  test("renders the canonical protected-head proof for fixed and correlated origins", () => {
    const fixed = protectedRecordCurrentHeadOriginJoinSql({
      representationParameter: 8,
      originBindingParameter: 9,
    });
    expect(fixed).toContain(
      "publication.publication_binding_ref = $9",
    );
    expect(fixed).toContain(
      "representation_head.current_representation_generation",
    );

    const correlated = protectedRecordCurrentHeadOriginJoinSql({
      representationParameter: 10,
      originBindingExpression: "requested.binding_ref",
      representationHeadAlias: "head",
    });
    expect(correlated).toContain(
      "publication.publication_binding_ref = requested.binding_ref",
    );
    expect(correlated).toContain("head.current_representation_generation");
    expect(correlated).not.toContain(
      "representation_head.current_representation_generation",
    );
    expect(correlated).toContain(
      "native_receipt.target_crypto_object_id = current_payload.crypto_object_id",
    );
  });

  test("reads immutable origin without requiring a selected protected head", async () => {
    let headReads = 0;
    let originStatement = "";
    const handle = await verifyRecordProductPostgresHandle(connectionFor((statement) => {
      if (statement.includes('from "reflection_record_payload_representation_heads"')) {
        headReads += 1;
        return [];
      }
      if (isOriginQuery(statement)) {
        originStatement = statement;
        return [{ publication_binding_ref: ORDINARY_ORIGIN_BINDING }];
      }
      if (isOriginAgreementQuery(statement)) return [];
      throw new Error(`Unexpected query: ${statement}`);
    }));
    const reader = new PostgresCurrentRecordPublicationBinding(handle, {
      selectedRepresentation: "protected",
      migrationGeneration: 1,
    });

    expect(await reader.readOrigin("record:protected-only"))
      .toBe(ORDINARY_ORIGIN_BINDING);
    expect(headReads).toBe(0);
    expect(originStatement).toContain("coalesce(");
    expect(originStatement).toContain('"origin_publication_binding_ref"');
  });

  test("resolves an ordinary publication without decoding its ordering timestamp", async () => {
    let originStatement = "";
    const handle = await verifyRecordProductPostgresHandle(connectionFor((statement) => {
      if (statement.includes('from "reflection_record_payload_representation_heads"')) {
        return [{
          current_representation_generation: 1,
          crypto_object_id: null,
          disposition: "available",
        }];
      }
      if (isOriginQuery(statement)) {
        originStatement = statement;
        return [{
          created_at: "2026-09-01 10:00:00+00",
          publication_binding_ref: ORDINARY_ORIGIN_BINDING,
        }];
      }
      if (isOriginAgreementQuery(statement)) return [];
      if (isCurrentPublicationQuery(statement)) {
        return [{ publication_binding_ref: ORDINARY_ORIGIN_BINDING }];
      }
      if (statement.includes('from "reflection_record_authority_projections"')) return [];
      throw new Error(`Unexpected query: ${statement}`);
    }));
    const reader = new PostgresCurrentRecordPublicationBinding(handle, {
      selectedRepresentation: "ordinary",
      migrationGeneration: 1,
    });

    expect(await reader.read("record:one")).toEqual({
      originPublicationBindingRef: ORDINARY_ORIGIN_BINDING,
      currentAccessBindingRefs: [ORDINARY_ORIGIN_BINDING],
      representationGeneration: 1,
      authorityProjectionGeneration: null,
    });
    expect(originStatement.slice(0, originStatement.indexOf(" from ")))
      .not.toContain('"created_at"');
    expect(originStatement).toContain("order by");
  });

  test("anchors a protected current head to the cross-representation logical origin", async () => {
    let originStatement = "";
    const handle = await verifyRecordProductPostgresHandle(connectionFor((statement) => {
      if (statement.includes('from "reflection_record_payload_representation_heads"')) {
        return [{
          current_representation_generation: 1,
          crypto_object_id: "object:one",
          disposition: "available",
        }];
      }
      if (isOriginQuery(statement)) {
        originStatement = statement;
        return [{
          created_at: new Date("2026-09-01T10:00:00.000Z"),
          publication_binding_ref: ORDINARY_ORIGIN_BINDING,
        }];
      }
      if (isOriginAgreementQuery(statement)) return [];
      if (isCurrentPublicationQuery(statement)) {
        return [{ publication_binding_ref: ORIGIN_BINDING }];
      }
      if (statement.includes('from "reflection_record_authority_projections"')) return [];
      throw new Error(`Unexpected query: ${statement}`);
    }));
    const reader = new PostgresCurrentRecordPublicationBinding(handle, {
      selectedRepresentation: "protected",
      migrationGeneration: 1,
    });

    expect(await reader.read("record:one")).toEqual({
      originPublicationBindingRef: ORDINARY_ORIGIN_BINDING,
      currentAccessBindingRefs: [ORIGIN_BINDING],
      representationGeneration: 1,
      authorityProjectionGeneration: null,
    });
    expect(originStatement).not.toContain(
      '"reflection_record_publications"."representation"',
    );
  });

  test("preserves a complete initial publication before authority is ready", async () => {
    const handle = await verifyRecordProductPostgresHandle(connectionFor((statement) => {
      if (statement.includes('from "reflection_record_payload_representation_heads"')) {
        return [{
          current_representation_generation: 1,
          crypto_object_id: "object:one",
          disposition: "available",
        }];
      }
      if (isOriginQuery(statement)) {
        return [{
          created_at: new Date("2026-09-01T10:00:00.000Z"),
          publication_binding_ref: ORIGIN_BINDING,
        }];
      }
      if (isOriginAgreementQuery(statement)) return [];
      if (isCurrentPublicationQuery(statement)) {
        return [{ publication_binding_ref: ORIGIN_BINDING }];
      }
      if (statement.includes('from "reflection_record_authority_projections"')) return [];
      throw new Error(`Unexpected query: ${statement}`);
    }));
    const reader = new PostgresCurrentRecordPublicationBinding(handle, {
      selectedRepresentation: "protected",
      migrationGeneration: 1,
    });

    expect(await reader.read("record:one")).toEqual({
      originPublicationBindingRef: ORIGIN_BINDING,
      currentAccessBindingRefs: [ORIGIN_BINDING],
      representationGeneration: 1,
      authorityProjectionGeneration: null,
    });
  });

  test("resolves a reprojected head from its complete authority receipt", async () => {
    const handle = await verifyRecordProductPostgresHandle(connectionFor((statement) => {
      if (statement.includes('from "reflection_record_payload_representation_heads"')) {
        return [{
          current_representation_generation: 2,
          crypto_object_id: "object:two",
          disposition: "available",
        }];
      }
      if (isOriginQuery(statement)) {
        return [{
          created_at: new Date("2026-09-01T10:00:00.000Z"),
          publication_binding_ref: ORIGIN_BINDING,
        }];
      }
      if (isOriginAgreementQuery(statement)) return [];
      if (isCurrentPublicationQuery(statement)) return [];
      if (statement.includes('from "reflection_record_authority_projections"')) {
        return [{
          projection_generation: 2,
          source_change_generation: 7,
          processing_state: "current",
        }];
      }
      if (statement.includes('from "reflection_record_authority_reconciliations"')) {
        return [{ reconciliation_id: "reconciliation:two" }];
      }
      if (statement.includes('from "reflection_record_authority_alternatives"')) {
        return [
          { access_namespace_id: ACCESS_NAMESPACE },
          { access_namespace_id: SECOND_ACCESS_NAMESPACE },
        ];
      }
      throw new Error(`Unexpected query: ${statement}`);
    }));
    const reader = new PostgresCurrentRecordPublicationBinding(handle, {
      selectedRepresentation: "protected",
      migrationGeneration: 1,
    });

    expect(await reader.read("record:one")).toEqual({
      originPublicationBindingRef: ORIGIN_BINDING,
      currentAccessBindingRefs: [
        `journal:namespace:${ACCESS_NAMESPACE}:protected:v1`,
        `journal:namespace:${SECOND_ACCESS_NAMESPACE}:protected:v1`,
      ],
      representationGeneration: 2,
      authorityProjectionGeneration: 2,
    });
  });

  test("fails closed for dirty authority or a missing matching receipt", async () => {
    for (const outcome of ["dirty", "missing_receipt"] as const) {
      const handle = await verifyRecordProductPostgresHandle(connectionFor((statement) => {
        if (statement.includes('from "reflection_record_payload_representation_heads"')) {
          return [{
            current_representation_generation: 2,
            crypto_object_id: "object:two",
            disposition: "available",
          }];
        }
        if (isOriginQuery(statement)) {
          return [{
            created_at: new Date("2026-09-01T10:00:00.000Z"),
            publication_binding_ref: ORIGIN_BINDING,
          }];
        }
        if (isOriginAgreementQuery(statement)) return [];
        if (isCurrentPublicationQuery(statement)) return [];
        if (statement.includes('from "reflection_record_authority_projections"')) {
          return [{
            projection_generation: 2,
            source_change_generation: 7,
            processing_state: outcome === "dirty" ? "dirty" : "current",
          }];
        }
        if (statement.includes('from "reflection_record_authority_reconciliations"')) {
          return [];
        }
        if (statement.includes('from "reflection_record_authority_alternatives"')) {
          return [{ access_namespace_id: ACCESS_NAMESPACE }];
        }
        throw new Error(`Unexpected query: ${statement}`);
      }));
      const reader = new PostgresCurrentRecordPublicationBinding(handle, {
        selectedRepresentation: "protected",
        migrationGeneration: 1,
      });

      expect(await reader.read("record:one")).toBeNull();
    }
  });

  test("accepts equal-time ordinary/protected siblings with one semantic origin", async () => {
    const handle = await verifyRecordProductPostgresHandle(connectionFor((statement) => {
      if (statement.includes('from "reflection_record_payload_representation_heads"')) {
        return [{
          current_representation_generation: 1,
          crypto_object_id: "object:one",
          disposition: "available",
        }];
      }
      if (isOriginQuery(statement)) {
        return [{
          created_at: new Date("2026-09-01T10:00:00.000Z"),
          publication_binding_ref: ORIGIN_BINDING,
        }];
      }
      if (isOriginAgreementQuery(statement)) return [];
      if (isCurrentPublicationQuery(statement)) {
        return [{ publication_binding_ref: ORIGIN_BINDING }];
      }
      if (statement.includes('from "reflection_record_authority_projections"')) return [];
      throw new Error(`Unexpected query: ${statement}`);
    }));
    const reader = new PostgresCurrentRecordPublicationBinding(handle, {
      selectedRepresentation: "protected",
      migrationGeneration: 1,
    });

    expect(await reader.read("record:one")).toEqual({
      originPublicationBindingRef: ORIGIN_BINDING,
      currentAccessBindingRefs: [ORIGIN_BINDING],
      representationGeneration: 1,
      authorityProjectionGeneration: null,
    });
  });

  test("rejects equally earliest publications with conflicting origin Namespaces", async () => {
    const conflictingNamespace = "66000000-0000-4000-8000-000000000099";
    const handle = await verifyRecordProductPostgresHandle(connectionFor((statement) => {
      if (statement.includes('from "reflection_record_payload_representation_heads"')) {
        return [{
          current_representation_generation: 1,
          crypto_object_id: "object:one",
          disposition: "available",
        }];
      }
      if (isOriginQuery(statement)) {
        return [{
          created_at: new Date("2026-09-01T10:00:00.000Z"),
          publication_binding_ref: ORIGIN_BINDING,
        }];
      }
      if (isOriginAgreementQuery(statement)) {
        return [{ publication_id: `publication:${conflictingNamespace}` }];
      }
      throw new Error(`Unexpected query: ${statement}`);
    }));
    const reader = new PostgresCurrentRecordPublicationBinding(handle, {
      selectedRepresentation: "protected",
      migrationGeneration: 1,
    });

    expect(await reader.read("record:one")).toBeNull();
  });

  test("rejects a conflicting third publication among three equally earliest rows", async () => {
    const createdAt = new Date("2026-09-01T10:00:00.000Z");
    const conflictingNamespace = "66000000-0000-4000-8000-000000000099";
    const equallyEarliestBindings = [
      ORIGIN_BINDING,
      ORDINARY_ORIGIN_BINDING,
      `journal:namespace:${conflictingNamespace}:protected:v1`,
    ] as const;
    let originStatement = "";
    let agreementStatement = "";
    let agreementParameters: readonly RecordProductPostgresScalar[] | undefined;
    const handle = await verifyRecordProductPostgresHandle(connectionFor((
      statement,
      parameters,
    ) => {
      if (statement.includes('from "reflection_record_payload_representation_heads"')) {
        return [{
          current_representation_generation: 1,
          crypto_object_id: "object:one",
          disposition: "available",
        }];
      }
      if (isOriginQuery(statement)) {
        originStatement = statement;
        return [{
          created_at: createdAt,
          publication_binding_ref: equallyEarliestBindings[0],
        }];
      }
      if (isOriginAgreementQuery(statement)) {
        agreementStatement = statement;
        agreementParameters = parameters;
        const pattern = originBindingPattern(parameters);
        return equallyEarliestBindings.some((binding) => !pattern.test(binding))
          ? [{ publication_id: "publication:three" }]
          : [];
      }
      throw new Error(`Unexpected query: ${statement}`);
    }));
    const reader = new PostgresCurrentRecordPublicationBinding(handle, {
      selectedRepresentation: "protected",
      migrationGeneration: 1,
    });

    expect(await reader.read("record:one")).toBeNull();
    expect(equallyEarliestBindings).toHaveLength(3);
    expect(originStatement).toContain("limit");
    expect(agreementStatement).toContain("limit");
    expect(agreementStatement).toContain('inner join (select "created_at"');
    expect(agreementParameters).not.toContain(createdAt.toISOString());
    expect(agreementParameters).toContain(
      `^journal:namespace:${ORIGIN_NAMESPACE}:(ordinary|protected):v[1-9][0-9]*$`,
    );
  });

  test("rejects a malformed equally earliest publication binding", async () => {
    const malformedBinding =
      `journal:namespace:${ORIGIN_NAMESPACE}:protected:v0`;
    const handle = await verifyRecordProductPostgresHandle(connectionFor((
      statement,
      parameters,
    ) => {
      if (statement.includes('from "reflection_record_payload_representation_heads"')) {
        return [{
          current_representation_generation: 1,
          crypto_object_id: "object:one",
          disposition: "available",
        }];
      }
      if (isOriginQuery(statement)) {
        return [{
          created_at: new Date("2026-09-01T10:00:00.000Z"),
          publication_binding_ref: ORIGIN_BINDING,
        }];
      }
      if (isOriginAgreementQuery(statement)) {
        return originBindingPattern(parameters).test(malformedBinding)
          ? []
          : [{ publication_id: "publication:malformed" }];
      }
      throw new Error(`Unexpected query: ${statement}`);
    }));
    const reader = new PostgresCurrentRecordPublicationBinding(handle, {
      selectedRepresentation: "protected",
      migrationGeneration: 1,
    });

    expect(await reader.read("record:one")).toBeNull();
  });

  test("rejects missing heads and blocked Records", async () => {
    const scenarios = ["missing", "blocked"] as const;
    for (const scenario of scenarios) {
      const handle = await verifyRecordProductPostgresHandle(connectionFor((statement) => {
        if (statement.includes('from "reflection_record_payload_representation_heads"')) {
          return scenario === "missing"
            ? []
            : [{
                current_representation_generation: 1,
                crypto_object_id: "object:one",
                disposition: scenario === "blocked" ? "blocked" : "available",
              }];
        }
        if (isOriginQuery(statement)) {
          return [{
            created_at: new Date("2026-09-01T10:00:00.000Z"),
            publication_binding_ref: ORIGIN_BINDING,
          }];
        }
        if (isOriginAgreementQuery(statement)) return [];
        throw new Error(`Unexpected query: ${statement}`);
      }));
      const reader = new PostgresCurrentRecordPublicationBinding(handle, {
        selectedRepresentation: "protected",
        migrationGeneration: 1,
      });

      expect(await reader.read("record:one")).toBeNull();
    }
  });
});

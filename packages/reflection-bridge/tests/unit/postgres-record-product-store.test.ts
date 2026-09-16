import { describe, expect, test } from "bun:test";
import type { DurableRecordPublication } from "@nautilo/reflection/durable";

import { PostgresRecordProductStore } from "../../src/server/postgres-record-product-store";
import { encodeDurableRecordEnvelope } from "../../src/server/record-mapping";
import {
  verifyRecordProductPostgresHandle,
  type RecordProductPostgresConnection,
  type RecordProductPostgresExecutor,
  type RecordProductPostgresRow,
} from "../../src/server/product-postgres";

function normalizedSql(statement: string): string {
  return statement.replaceAll('"', "").replaceAll(/\s+/g, " ").trim().toLowerCase();
}

function protectedPublication(input: Readonly<{
  recordRef: string;
  lifecycle?: "current" | "stale";
  childRecordRefs?: readonly string[];
  structuralHeight?: number;
  terminalAuthorityLeafHandles?: readonly string[];
}>): DurableRecordPublication {
  return {
    record: {
      recordRef: input.recordRef,
      lifecycle: input.lifecycle ?? "current",
      structuralHeight: input.structuralHeight ?? 0,
      processingGeneration: 1,
      semantic: {
        observedContentFingerprint: `sha256:${input.recordRef}`,
        posture: "derived",
        statement: "Protected reflection.",
        sourceDependencies: [],
        anchors: [],
        childRecordRefs: [...(input.childRecordRefs ?? [])],
        producer: { producerRef: "test", policyVersion: "m327" },
        terminalAuthorityLeafHandles: [...(input.terminalAuthorityLeafHandles ?? [])],
      },
    },
    idempotencyKey: `publication:${input.recordRef}`,
    publicationBindingRef: `binding:${input.recordRef}`,
  };
}

function protectedAttachmentFixture(
  resolve?: (sql: string) => readonly RecordProductPostgresRow[] | undefined,
  leaseToken: string | null = null,
): Readonly<{
  connection: RecordProductPostgresConnection;
  statements: string[];
  parameters: readonly unknown[][];
}> {
  const statements: string[] = [];
  const parameters: unknown[][] = [];
  const connection: RecordProductPostgresConnection = {
    async query<Row extends RecordProductPostgresRow>(statement: string) {
      if (statement.includes("current_user AS current_role")) {
        return [{
          current_role: "nautilo",
          session_role: "nautilo",
        }] as unknown as readonly Row[];
      }
      return [];
    },
    async transaction<Result>(
      callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>,
    ) {
      const executor: RecordProductPostgresExecutor = {
        async query<Row extends RecordProductPostgresRow>(statement: string, values?: readonly unknown[]) {
          statements.push(statement);
          parameters.push([...(values ?? [])]);
          const sql = normalizedSql(statement);
          if (
            sql.includes(
              "select state, record_id, crypto_object_id, request_commitment, lease_token from reflection_record_publications",
            )
          ) {
            return [{
              state: "crypto_complete",
              record_id: "record:protected",
              crypto_object_id: "crypto:protected",
              request_commitment: new Uint8Array(32).fill(7),
              lease_token: leaseToken,
            }] as unknown as readonly Row[];
          }
          return (resolve?.(sql) ?? []) as readonly Row[];
        },
      };
      return callback(executor);
    },
  };
  return { connection, statements, parameters };
}

function ordinarySiblingFixture(input?: Readonly<{
  ordinary?: "exact" | "mismatched" | "newer";
}>): Readonly<{
  connection: RecordProductPostgresConnection;
  statements: string[];
}> {
  const statements: string[] = [];
  const publication = protectedPublication({ recordRef: "record:protected" });
  const payload = encodeDurableRecordEnvelope(publication.record);
  const ordinary = input?.ordinary;
  const connection: RecordProductPostgresConnection = {
    async query<Row extends RecordProductPostgresRow>(statement: string) {
      if (statement.includes("current_user AS current_role")) {
        return [{ current_role: "nautilo", session_role: "nautilo" }] as unknown as readonly Row[];
      }
      return [];
    },
    async transaction<Result>(callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>) {
      const executor: RecordProductPostgresExecutor = {
        async query<Row extends RecordProductPostgresRow>(statement: string) {
          statements.push(statement);
          const sql = normalizedSql(statement);
          if (sql.includes("from reflection_record_publications")
            && sql.includes("join reflection_record_payload_representation_heads")
            && sql.includes("join reflection_records")) {
            return [{
              record_id: "record:protected",
              representation: "protected",
              representation_generation: 1,
              payload_version: 1,
              request_commitment: new Uint8Array(32).fill(7),
              publication_binding_ref: "binding:record:protected",
              origin_publication_binding_ref: null,
              state: "complete",
              replay_structural_height: 0,
              replay_processing_generation: 1,
              replay_predecessor_record_id: null,
              replay_predecessor_relation: null,
              disposition: "available",
              current_representation_generation: 1,
            }] as unknown as readonly Row[];
          }
          if (sql.includes("from reflection_record_payload_representations")
            && sql.includes("plaintext_payload_bytes")) {
            return ordinary === undefined ? [] : [{
              representation_generation: ordinary === "newer" ? 2 : 1,
              payload_version: 1,
              plaintext_payload_bytes: ordinary === "mismatched"
                ? new Uint8Array([9])
                : payload,
              crypto_object_id: null,
            }] as unknown as readonly Row[];
          }
          if (sql.includes("from reflection_record_payload_representation_heads")
            && !sql.includes("join reflection_record_publications")) {
            return ordinary === undefined ? [] : [{
              current_representation_generation: ordinary === "newer" ? 2 : 1,
            }] as unknown as readonly Row[];
          }
          if (sql.includes("from reflection_record_publications")
            && sql.includes("reserved_crypto_object_id")
            && !sql.includes("join reflection_records")) {
            return ordinary === undefined ? [] : [{
              publication_id: "publication:record:protected:ordinary",
              record_id: "record:protected",
              representation: "ordinary",
              representation_generation: ordinary === "newer" ? 2 : 1,
              payload_version: 1,
              request_commitment: new Uint8Array(32).fill(8),
              publication_binding_ref: "binding:record:protected:ordinary",
              origin_publication_binding_ref: null,
              crypto_object_id: null,
              reserved_crypto_object_id: null,
              state: "complete",
            }] as unknown as readonly Row[];
          }
          return [] as readonly Row[];
        },
      };
      return callback(executor);
    },
  };
  return { connection, statements };
}

describe("Postgres Record product disposition", () => {
  test("attaches only the ordinary sibling rows for an authenticated protected publication", async () => {
    const fixture = ordinarySiblingFixture();
    const store = new PostgresRecordProductStore(await verifyRecordProductPostgresHandle(fixture.connection));
    const protectedValue = protectedPublication({ recordRef: "record:protected" });
    const ordinary = {
      ...protectedValue,
      idempotencyKey: "publication:record:protected:ordinary",
      publicationBindingRef: "binding:record:protected:ordinary",
    };
    expect(await store.attachOrdinarySibling({
      protectedPublicationId: protectedValue.idempotencyKey,
      protectedRequestCommitment: new Uint8Array(32).fill(7),
      ordinaryPublication: ordinary,
      ordinaryPayloadBytes: encodeDurableRecordEnvelope(ordinary.record),
      ordinaryRequestCommitment: new Uint8Array(32).fill(8),
    })).toBe("attached");
    const inserts = fixture.statements.map(normalizedSql).filter(sql => sql.startsWith("insert into"));
    expect(inserts).toHaveLength(3);
    expect(inserts.filter(sql => sql.includes("reflection_record_payload_representations"))).toHaveLength(1);
    expect(inserts.filter(sql => sql.includes("reflection_record_payload_representation_heads"))).toHaveLength(1);
    expect(inserts.filter(sql => sql.includes("reflection_record_publications"))).toHaveLength(1);
    expect(inserts.some(sql => sql.includes("reflection_records "))).toBeFalse();
    expect(inserts.some(sql => sql.includes("reflection_record_dependencies"))).toBeFalse();
  });

  test("replays an exact ordinary sibling without another product write", async () => {
    const fixture = ordinarySiblingFixture({ ordinary: "exact" });
    const store = new PostgresRecordProductStore(await verifyRecordProductPostgresHandle(fixture.connection));
    const protectedValue = protectedPublication({ recordRef: "record:protected" });
    const ordinary = {
      ...protectedValue,
      idempotencyKey: "publication:record:protected:ordinary",
      publicationBindingRef: "binding:record:protected:ordinary",
    };
    expect(await store.attachOrdinarySibling({
      protectedPublicationId: protectedValue.idempotencyKey,
      protectedRequestCommitment: new Uint8Array(32).fill(7),
      ordinaryPublication: ordinary,
      ordinaryPayloadBytes: encodeDurableRecordEnvelope(ordinary.record),
      ordinaryRequestCommitment: new Uint8Array(32).fill(8),
    })).toBe("replayed");
    expect(fixture.statements.map(normalizedSql).some(sql => sql.startsWith("insert into"))).toBeFalse();
  });

  test.each(["mismatched", "newer"] as const)(
    "rejects a %s ordinary sibling without overwriting its head",
    async (ordinaryState) => {
      const fixture = ordinarySiblingFixture({ ordinary: ordinaryState });
      const store = new PostgresRecordProductStore(await verifyRecordProductPostgresHandle(fixture.connection));
      const protectedValue = protectedPublication({ recordRef: "record:protected" });
      const ordinary = {
        ...protectedValue,
        idempotencyKey: "publication:record:protected:ordinary",
        publicationBindingRef: "binding:record:protected:ordinary",
      };
      expect(await store.attachOrdinarySibling({
        protectedPublicationId: protectedValue.idempotencyKey,
        protectedRequestCommitment: new Uint8Array(32).fill(7),
        ordinaryPublication: ordinary,
        ordinaryPayloadBytes: encodeDurableRecordEnvelope(ordinary.record),
        ordinaryRequestCommitment: new Uint8Array(32).fill(8),
      })).toBe("conflict");
      expect(fixture.statements.map(normalizedSql).some(sql => sql.startsWith("insert into"))).toBeFalse();
      expect(fixture.statements.map(normalizedSql).some(sql => sql.startsWith("update"))).toBeFalse();
    },
  );

  test("binds a protected output hint without advancing publication state", async () => {
    const statements: string[] = [];
    let reservedCryptoObjectId: string | null = null;
    const connection: RecordProductPostgresConnection = {
      async query<Row extends RecordProductPostgresRow>(statement: string) {
        if (statement.includes("current_user AS current_role")) {
          return [{ current_role: "nautilo", session_role: "nautilo" }] as unknown as readonly Row[];
        }
        statements.push(statement);
        const sql = normalizedSql(statement);
        if (sql.includes("from reflection_record_publications") && sql.includes("for update")) {
          return [{
            record_id: "record:protected",
            representation: "protected",
            request_commitment: new Uint8Array(32).fill(7),
            state: "reserved",
            crypto_object_id: null,
            reserved_crypto_object_id: reservedCryptoObjectId,
          }] as unknown as readonly Row[];
        }
        if (sql.startsWith("update reflection_record_publications")) {
          reservedCryptoObjectId = "crypto:planned";
        }
        return [];
      },
      async transaction<Result>(callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>) {
        return callback(this);
      },
    };
    const handle = await verifyRecordProductPostgresHandle(connection);
    const store = new PostgresRecordProductStore(handle);

    expect(await store.bindProtectedOutput({
      idempotencyKey: "publication:record:protected",
      recordId: "record:protected",
      cryptoObjectId: "crypto:planned",
      requestCommitment: new Uint8Array(32).fill(7),
    })).toBe("updated");

    const update = statements.map(normalizedSql).find((sql) =>
      sql.startsWith("update reflection_record_publications")
    );
    expect(update).toContain("set reserved_crypto_object_id");
    expect(update).not.toMatch(/(?:set|,) crypto_object_id =/);
    expect(update).not.toContain("state =");
    expect(await store.bindProtectedOutput({
      idempotencyKey: "publication:record:protected",
      recordId: "record:protected",
      cryptoObjectId: "crypto:planned",
      requestCommitment: new Uint8Array(32).fill(7),
    })).toBe("replayed");
    expect(await store.bindProtectedOutput({
      idempotencyKey: "publication:record:protected",
      recordId: "record:protected",
      cryptoObjectId: "crypto:different",
      requestCommitment: new Uint8Array(32).fill(7),
    })).toBe("conflict");
  });

  test("rejects a protected output binding with a forged commitment", async () => {
    const statements: string[] = [];
    const connection: RecordProductPostgresConnection = {
      async query<Row extends RecordProductPostgresRow>(statement: string) {
        if (statement.includes("current_user AS current_role")) {
          return [{ current_role: "nautilo", session_role: "nautilo" }] as unknown as readonly Row[];
        }
        statements.push(statement);
        if (normalizedSql(statement).includes("for update")) {
          return [{
            record_id: "record:protected",
            representation: "protected",
            request_commitment: new Uint8Array(32).fill(7),
            state: "reserved",
            crypto_object_id: null,
            reserved_crypto_object_id: null,
          }] as unknown as readonly Row[];
        }
        return [];
      },
      async transaction<Result>(callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>) {
        return callback(this);
      },
    };
    const handle = await verifyRecordProductPostgresHandle(connection);
    const store = new PostgresRecordProductStore(handle);

    expect(await store.bindProtectedOutput({
      idempotencyKey: "publication:record:protected",
      recordId: "record:protected",
      cryptoObjectId: "crypto:planned",
      requestCommitment: new Uint8Array(32).fill(8),
    })).toBe("conflict");
    expect(statements.map(normalizedSql).some((sql) =>
      sql.startsWith("update reflection_record_publications")
    )).toBeFalse();
  });

  test("marks crypto complete while preserving an exact live lease", async () => {
    const statements: string[] = [];
    const leaseToken = "00000000-0000-4000-8000-000000000001";
    let leaseLive = true;
    let reservedCryptoObjectId: string | null = null;
    const connection: RecordProductPostgresConnection = {
      async query<Row extends RecordProductPostgresRow>(statement: string) {
        if (statement.includes("current_user AS current_role")) {
          return [{ current_role: "nautilo", session_role: "nautilo" }] as unknown as readonly Row[];
        }
        statements.push(statement);
        const sql = normalizedSql(statement);
        if (sql.includes("from reflection_record_publications") && sql.includes("lease_live") && sql.includes("for update")) {
          return [{
            state: "reserved",
            record_id: "record:protected",
            crypto_object_id: null,
            reserved_crypto_object_id: reservedCryptoObjectId,
            lease_token: leaseToken,
            lease_live: leaseLive,
          }] as unknown as readonly Row[];
        }
        return [];
      },
      async transaction<Result>(callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>) {
        return callback(this);
      },
    };
    const handle = await verifyRecordProductPostgresHandle(connection);
    const store = new PostgresRecordProductStore(handle);

    expect(await store.markProtectedCryptoComplete({
      idempotencyKey: "publication:record:protected",
      recordId: "record:protected",
      cryptoObjectId: "crypto:protected",
      leaseToken,
    })).toBe("updated");
    const update = statements.map(normalizedSql).find((sql) =>
      sql.startsWith("update reflection_record_publications")
    );
    expect(update).toContain("state");
    expect(update).not.toContain("lease_token");
    expect(update).not.toContain("lease_expires_at");
    const updatesBeforeExpiredAttempt = statements.map(normalizedSql).filter((sql) =>
      sql.startsWith("update reflection_record_publications")
    ).length;
    leaseLive = false;
    expect(await store.markProtectedCryptoComplete({
      idempotencyKey: "publication:record:protected",
      recordId: "record:protected",
      cryptoObjectId: "crypto:protected",
      leaseToken,
    })).toBe("conflict");
    expect(statements.map(normalizedSql).filter((sql) =>
      sql.startsWith("update reflection_record_publications")
    )).toHaveLength(updatesBeforeExpiredAttempt);
    leaseLive = true;
    reservedCryptoObjectId = "crypto:different";
    expect(await store.markProtectedCryptoComplete({
      idempotencyKey: "publication:record:protected",
      recordId: "record:protected",
      cryptoObjectId: "crypto:protected",
      leaseToken,
    })).toBe("conflict");
    expect(statements.map(normalizedSql).filter((sql) =>
      sql.startsWith("update reflection_record_publications")
    )).toHaveLength(updatesBeforeExpiredAttempt);
  });

  test("returns the reserved protected output hint from a due claim", async () => {
    const statements: string[] = [];
    const connection: RecordProductPostgresConnection = {
      async query<Row extends RecordProductPostgresRow>(statement: string) {
        if (statement.includes("current_user AS current_role")) {
          return [{ current_role: "nautilo", session_role: "nautilo" }] as unknown as readonly Row[];
        }
        statements.push(statement);
        if (normalizedSql(statement).startsWith("with candidates as")) {
          return [{
            publication_id: "publication:record:protected",
            record_id: "record:protected",
            state: "reserved",
            crypto_object_id: null,
            reserved_crypto_object_id: "crypto:planned",
            lease_token: "00000000-0000-4000-8000-000000000001",
            publication_binding_ref: "binding:record:protected",
            request_commitment: new Uint8Array(32).fill(7),
            replay_structural_height: 0,
            replay_processing_generation: 1,
            replay_predecessor_record_id: null,
            replay_predecessor_relation: null,
          }] as unknown as readonly Row[];
        }
        return [];
      },
      async transaction<Result>(callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>) {
        return callback(this);
      },
    };
    const handle = await verifyRecordProductPostgresHandle(connection);
    const store = new PostgresRecordProductStore(handle);

    expect(await store.claimDueProtected(1)).toEqual([expect.objectContaining({
      idempotencyKey: "publication:record:protected",
      reservedCryptoObjectId: "crypto:planned",
    })]);
    expect(normalizedSql(statements[0]!)).not.toContain(
      "reserved_crypto_object_id is not null",
    );
    expect(await store.claimDueProtected(1, {
      requireReservedOutput: true,
    })).toEqual([expect.objectContaining({
      reservedCryptoObjectId: "crypto:planned",
    })]);
    expect(normalizedSql(statements[1]!)).toContain(
      "reserved_crypto_object_id is not null",
    );
  });

  test("attaches a valid protected Record graph", async () => {
    const fixture = protectedAttachmentFixture();
    const handle = await verifyRecordProductPostgresHandle(fixture.connection);
    const store = new PostgresRecordProductStore(handle);

    expect(await store.attachProtected({
      publication: protectedPublication({ recordRef: "record:protected" }),
      cryptoObjectId: "crypto:protected",
      requestCommitment: new Uint8Array(32).fill(7),
    })).toBe("attached");

    expect(fixture.statements.some((statement) =>
      normalizedSql(statement).includes("insert into reflection_records")
    )).toBeTrue();
    expect(fixture.statements.some((statement) =>
      normalizedSql(statement).includes(
        "insert into reflection_record_payload_representations",
      )
    )).toBeTrue();
    expect(fixture.statements.some((statement) =>
      normalizedSql(statement).includes(
        "update reflection_record_publications set state",
      )
    )).toBeTrue();
  });

  for (const leaseToken of [undefined, "00000000-0000-4000-8000-000000000001"]) {
    test(`installs the verified initial closure atomically during ${leaseToken === undefined ? "live" : "recovery"} protected attachment`, async () => {
      const fixture = protectedAttachmentFixture(undefined, leaseToken ?? null);
      const handle = await verifyRecordProductPostgresHandle(fixture.connection);
      const store = new PostgresRecordProductStore(handle);
      expect(await store.attachProtected({
        publication: protectedPublication({recordRef: "record:protected",
          terminalAuthorityLeafHandles: ["namespace:uncited-memory", "namespace:child"]}),
        cryptoObjectId: "crypto:protected", requestCommitment: new Uint8Array(32).fill(7),
        ...(leaseToken === undefined ? {} : {leaseToken}),
      })).toBe("attached");
      const sql = fixture.statements.map(normalizedSql);
      const graph = sql.findIndex(value => value.startsWith("insert into reflection_records"));
      const closure = sql.findIndex(value => value.startsWith("insert into reflection_record_authority_closure"));
      const projection = sql.findIndex(value => value.startsWith("insert into reflection_record_authority_projections"));
      const head = sql.findIndex(value => value.startsWith("insert into reflection_record_payload_representation_heads"));
      expect(closure).toBeGreaterThan(graph);
      expect(projection).toBeGreaterThan(closure);
      expect(head).toBeGreaterThan(projection);
      expect(fixture.parameters[closure]).toEqual([
        "record:protected", "namespace:child", 1,
        "record:protected", "namespace:uncited-memory", 1,
      ]);
      expect(fixture.parameters[projection]).toContain("dirty");
      expect(sql.some(value => value.startsWith("insert into reflection_record_access_alternatives"))).toBeFalse();
    });
  }

  test("authority installation failure aborts attachment before head or completion writes", async () => {
    const fixture = protectedAttachmentFixture(sql => {
      if (sql.startsWith("insert into reflection_record_authority_projections")) {
        throw new Error("authority projection storage failed");
      }
      return undefined;
    });
    const handle = await verifyRecordProductPostgresHandle(fixture.connection);
    const outcome = await new PostgresRecordProductStore(handle).attachProtected({
      publication: protectedPublication({recordRef: "record:protected"}),
      cryptoObjectId: "crypto:protected", requestCommitment: new Uint8Array(32).fill(7),
    }).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("authority projection storage failed");
    expect(fixture.statements.map(normalizedSql).some(sql =>
      sql.startsWith("insert into reflection_record_payload_representation_heads")
      || sql.startsWith("update reflection_record_publications"),
    )).toBeFalse();
  });

  test("rejects an invalid protected Record shape before graph insertion", async () => {
    const fixture = protectedAttachmentFixture();
    const handle = await verifyRecordProductPostgresHandle(fixture.connection);
    const store = new PostgresRecordProductStore(handle);

    expect(await store.attachProtected({
      publication: protectedPublication({
        recordRef: "record:protected",
        lifecycle: "stale",
      }),
      cryptoObjectId: "crypto:protected",
      requestCommitment: new Uint8Array(32).fill(7),
    })).toBe("conflict");

    expect(fixture.statements.some((statement) =>
      normalizedSql(statement).includes("insert into reflection_records")
    )).toBeFalse();
  });

  test("rejects a protected attachment with a mismatched request commitment", async () => {
    const fixture = protectedAttachmentFixture();
    const handle = await verifyRecordProductPostgresHandle(fixture.connection);
    const store = new PostgresRecordProductStore(handle);

    expect(await store.attachProtected({
      publication: protectedPublication({ recordRef: "record:protected" }),
      cryptoObjectId: "crypto:protected",
      requestCommitment: new Uint8Array(32).fill(8),
    })).toBe("conflict");

    expect(fixture.statements.some((statement) =>
      normalizedSql(statement).includes("insert into reflection_records")
    )).toBeFalse();
    expect(fixture.statements.some(statement =>
      normalizedSql(statement).includes("reflection_record_authority_"),
    )).toBeFalse();
  });

  test("rejects a protected attachment with a stale reconciliation lease", async () => {
    const fixture = protectedAttachmentFixture(
      undefined,
      "00000000-0000-4000-8000-000000000001",
    );
    const handle = await verifyRecordProductPostgresHandle(fixture.connection);
    const store = new PostgresRecordProductStore(handle);

    expect(await store.attachProtected({
      publication: protectedPublication({ recordRef: "record:protected" }),
      cryptoObjectId: "crypto:protected",
      requestCommitment: new Uint8Array(32).fill(7),
      leaseToken: "00000000-0000-4000-8000-000000000002",
    })).toBe("conflict");

    expect(fixture.statements.some((statement) =>
      normalizedSql(statement).includes("insert into reflection_records")
    )).toBeFalse();
  });

  test("rejects a protected graph whose child has another current parent", async () => {
    const fixture = protectedAttachmentFixture((sql) => {
      if (
        sql.includes(
          "select record_id, structural_height, disposition from reflection_records",
        )
      ) {
        return [
          { record_id: "record:a", structural_height: 0, disposition: "available" },
          { record_id: "record:b", structural_height: 0, disposition: "available" },
        ];
      }
      if (sql.includes("as current_parent_ids")) {
        return [{
          child_record_id: "record:a",
          current_parent_ids: ["record:existing-parent"],
        }];
      }
      return undefined;
    });
    const handle = await verifyRecordProductPostgresHandle(fixture.connection);
    const store = new PostgresRecordProductStore(handle);

    expect(await store.attachProtected({
      publication: protectedPublication({
        recordRef: "record:protected",
        childRecordRefs: ["record:a", "record:b"],
        structuralHeight: 1,
      }),
      cryptoObjectId: "crypto:protected",
      requestCommitment: new Uint8Array(32).fill(7),
    })).toBe("conflict");

    expect(fixture.statements.some((statement) =>
      normalizedSql(statement).includes("insert into reflection_records")
    )).toBeFalse();
  });

  test("rejects a child that already has another current parent", async () => {
    const statements: string[] = [];
    const connection: RecordProductPostgresConnection = {
      async query<Row extends RecordProductPostgresRow>(statement: string) {
        if (statement.includes("current_user AS current_role")) {
          return [{ current_role: "nautilo", session_role: "nautilo" }] as unknown as Row[];
        }
        statements.push(statement);
        const sql = normalizedSql(statement);
        if (sql.includes("select record_id, structural_height, disposition from reflection_records")) {
          return [
            { record_id: "record:a", structural_height: 0, disposition: "available" },
            { record_id: "record:b", structural_height: 0, disposition: "available" },
          ] as unknown as Row[];
        }
        if (sql.includes("as current_parent_ids")) {
          return [{
            child_record_id: "record:a",
            current_parent_ids: ["record:existing-parent"],
          }] as unknown as Row[];
        }
        return [];
      },
      async transaction<Result>(
        callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>,
      ) {
        return callback(this);
      },
    };
    const handle = await verifyRecordProductPostgresHandle(connection);
    const store = new PostgresRecordProductStore(handle);
    const result = await store.publishOrdinary({
      publication: {
        record: {
          recordRef: "record:new-parent",
          lifecycle: "current",
          structuralHeight: 1,
          processingGeneration: 1,
          semantic: {
            observedContentFingerprint: "sha256:new-parent",
            posture: "derived",
            statement: "A and B are related.",
            sourceDependencies: [],
            anchors: [],
            childRecordRefs: ["record:a", "record:b"],
            producer: { producerRef: "test", policyVersion: "m288" },
            terminalAuthorityLeafHandles: [],
          },
        },
        idempotencyKey: "publication:new-parent",
        publicationBindingRef: "binding:one",
      },
      payloadBytes: new Uint8Array([1]),
      requestCommitment: new Uint8Array(32).fill(2),
    });
    expect(result).toEqual({
      status: "rejected",
      recordRef: "record:new-parent",
      reason: "structural_conflict",
      structuralReason: "child_parent_changed",
    });
    expect(statements.some((statement) =>
      normalizedSql(statement).includes("insert into reflection_records")
    )).toBeFalse();
  });

  test("resolves only a completed selected-representation publication receipt", async () => {
    const connection: RecordProductPostgresConnection = {
      async query<Row extends RecordProductPostgresRow>(statement: string) {
        if (statement.includes("current_user AS current_role")) {
          return [{ current_role: "nautilo", session_role: "nautilo" }] as unknown as Row[];
        }
        const sql = normalizedSql(statement);
        if (
          sql.includes("from reflection_record_publications")
          && sql.includes("left join reflection_records")
          && sql.includes("publication_id")
        ) {
          return [{
            record_id: "record:completed",
            state: "complete",
            disposition: "available",
          }] as unknown as Row[];
        }
        return [];
      },
      async transaction<Result>(
        callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>,
      ) {
        return callback(this);
      },
    };
    const handle = await verifyRecordProductPostgresHandle(connection);
    const store = new PostgresRecordProductStore(handle);
    expect(await store.readCompletedPublicationRecordId({
      idempotencyKey: "publication:completed",
    })).toEqual({ status: "available", recordId: "record:completed" });
  });

  test("admits semantic work inside the ordinary publication transaction", async () => {
    const statements: string[] = [];
    const connection: RecordProductPostgresConnection = {
      async query<Row extends RecordProductPostgresRow>(statement: string) {
        if (statement.includes("current_user AS current_role")) {
          return [{
            current_role: "nautilo",
            session_role: "nautilo",
          }] as unknown as Row[];
        }
        return [];
      },
      async transaction<Result>(
        callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>,
      ) {
        const executor: RecordProductPostgresExecutor = {
          async query<Row extends RecordProductPostgresRow>(statement: string) {
            statements.push(statement);
            return [] as Row[];
          },
        };
        return callback(executor);
      },
    };
    const handle = await verifyRecordProductPostgresHandle(connection);
    const store = new PostgresRecordProductStore(handle, {
      async attachPublicationWithinTransaction(tx) {
        await tx.query("SELECT 'semantic-admission' AS marker");
      },
      async recordChangedWithinTransaction() {},
    });
    const publication: DurableRecordPublication = {
      record: {
        recordRef: "record:ordinary",
        lifecycle: "current",
        structuralHeight: 0,
        processingGeneration: 1,
        semantic: {
          observedContentFingerprint: "sha256:one",
          posture: "derived",
          statement: "statement",
          sourceDependencies: [],
          anchors: [],
          childRecordRefs: [],
          producer: { producerRef: "test", policyVersion: "v1" },
          terminalAuthorityLeafHandles: [],
        },
      },
      idempotencyKey: "publication:ordinary",
      publicationBindingRef: "binding:ordinary",
    };
    expect(await store.publishOrdinary({
      publication,
      payloadBytes: new Uint8Array([1]),
      requestCommitment: new Uint8Array(32).fill(2),
    })).toMatchObject({ status: "published" });
    const recordInsert = statements.findIndex((statement) =>
      normalizedSql(statement).includes("insert into reflection_records")
    );
    const semanticAdmission = statements.indexOf("SELECT 'semantic-admission' AS marker");
    const payloadInsert = statements.findIndex((statement) =>
      statement.includes("reflection_record_payload_representations")
    );
    expect(recordInsert).toBeGreaterThanOrEqual(0);
    expect(semanticAdmission).toBeGreaterThan(recordInsert);
    expect(payloadInsert).toBeGreaterThan(semanticAdmission);
  });

  test("deletes the plaintext search projection in the purge transaction", async () => {
    const transactions: string[][] = [];
    const connection: RecordProductPostgresConnection = {
      async query<Row extends RecordProductPostgresRow>(statement: string) {
        if (statement.includes("current_user AS current_role")) {
          return [{
            current_role: "nautilo",
            session_role: "nautilo",
          }] as unknown as readonly Row[];
        }
        return [];
      },
      async transaction<Result>(
        callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>,
      ) {
        const statements: string[] = [];
        transactions.push(statements);
        const executor: RecordProductPostgresExecutor = {
          async query<Row extends RecordProductPostgresRow>(statement: string) {
            statements.push(statement);
            if (normalizedSql(statement).includes(
              "select disposition, processing_generation from reflection_records",
            )) {
              return [{
                disposition: "available",
                processing_generation: 3,
              }] as unknown as readonly Row[];
            }
            return [];
          },
        };
        return callback(executor);
      },
    };
    const handle = await verifyRecordProductPostgresHandle(connection);
    const changed: unknown[] = [];
    const store = new PostgresRecordProductStore(handle, {
      async attachPublicationWithinTransaction() {},
      async recordChangedWithinTransaction(_tx, input) {
        changed.push(input);
      },
    });

    expect(await store.purge({ recordRef: "record:purge-projection" }))
      .toMatchObject({ status: "purged", replayed: false });

    const dispositionTransaction = transactions[0] ?? [];
    expect(dispositionTransaction.some((statement) =>
      normalizedSql(statement).includes("update reflection_records set disposition")
    )).toBeTrue();
    expect(dispositionTransaction.some((statement) =>
      normalizedSql(statement).includes("delete from reflection_record_search_projections")
    )).toBeTrue();
    expect(changed).toEqual([{
      recordRef: "record:purge-projection",
      changeRef: "disposition:purged:v3",
    }]);
    expect(transactions.slice(1).some((transaction) => transaction.some((statement) =>
      statement.includes("reflection_record_search_projections")
    ))).toBeFalse();
  });

  test("reserves parent repair inside a direct lifecycle transition", async () => {
    const connection: RecordProductPostgresConnection = {
      async query<Row extends RecordProductPostgresRow>(statement: string) {
        if (statement.includes("current_user AS current_role")) {
          return [{
            current_role: "nautilo",
            session_role: "nautilo",
          }] as unknown as readonly Row[];
        }
        return [];
      },
      async transaction<Result>(
        callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>,
      ) {
        const executor: RecordProductPostgresExecutor = {
          async query<Row extends RecordProductPostgresRow>(statement: string) {
            if (normalizedSql(statement).includes(
              "select lifecycle, processing_generation, disposition from reflection_records",
            )) {
              return [{
                lifecycle: "current",
                processing_generation: 2,
                disposition: "available",
              }] as unknown as readonly Row[];
            }
            return [];
          },
        };
        return callback(executor);
      },
    };
    const changed: unknown[] = [];
    const handle = await verifyRecordProductPostgresHandle(connection);
    const store = new PostgresRecordProductStore(handle, {
      async attachPublicationWithinTransaction() {},
      async recordChangedWithinTransaction(_tx, input) {
        changed.push(input);
      },
    });

    expect(await store.transitionLifecycle({
      recordRef: "record:terminal",
      expectedProcessingGeneration: 2,
      from: "current",
      to: "sunset",
    })).toEqual({
      status: "transitioned",
      recordRef: "record:terminal",
      lifecycle: "sunset",
      replayed: false,
    });
    expect(changed).toEqual([{
      recordRef: "record:terminal",
      changeRef: "lifecycle:current:sunset:v3",
    }]);
  });

  test("rejects restoring a stale parent when one of its children has another current parent", async () => {
    const statements: string[] = [];
    const connection: RecordProductPostgresConnection = {
      async query<Row extends RecordProductPostgresRow>(statement: string) {
        if (statement.includes("current_user AS current_role")) {
          return [{
            current_role: "nautilo",
            session_role: "nautilo",
          }] as unknown as readonly Row[];
        }
        return [];
      },
      async transaction<Result>(
        callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>,
      ) {
        const executor: RecordProductPostgresExecutor = {
          async query<Row extends RecordProductPostgresRow>(statement: string) {
            statements.push(statement);
            const sql = normalizedSql(statement);
            if (sql.includes("select child_record_id from reflection_record_dependencies")) {
              return [{ child_record_id: "record:child" }] as unknown as readonly Row[];
            }
            if (sql.includes(
              "select lifecycle, processing_generation, disposition from reflection_records",
            )) {
              return [{
                lifecycle: "stale",
                processing_generation: 2,
                disposition: "available",
              }] as unknown as readonly Row[];
            }
            if (sql.includes("parent.record_id <> $2")) {
              return [{ found: 1 }] as unknown as readonly Row[];
            }
            return [];
          },
        };
        return callback(executor);
      },
    };
    const handle = await verifyRecordProductPostgresHandle(connection);
    const store = new PostgresRecordProductStore(handle);

    expect(await store.transitionLifecycle({
      recordRef: "record:stale-parent",
      expectedProcessingGeneration: 2,
      from: "stale",
      to: "current",
    })).toEqual({
      status: "conflict",
      recordRef: "record:stale-parent",
      replayed: false,
    });
    expect(statements.some((statement) =>
      normalizedSql(statement).includes("update reflection_records set lifecycle")
    )).toBeFalse();
  });
});

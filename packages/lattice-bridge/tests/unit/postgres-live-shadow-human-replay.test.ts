import { describe, expect, test } from "bun:test";

import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeExecutor,
  PostgresJsBridgeRow,
} from "@nautilo/db";
import { LatticeCrypto } from "@nautilo/lattice-crypto";

import { inspectPostgresHumanLiveShadowReplay } from
  "../../src/server/message/postgres-live-shadow-human-replay.ts";

const OPERATION = "00000000-0000-4000-8000-000000000001";
const SESSION = "00000000-0000-4000-8000-000000000002";
const ROOM = "00000000-0000-4000-8000-000000000003";
const NAMESPACE = "00000000-0000-4000-8000-000000000004";
const AGENT = "00000000-0000-4000-8000-000000000005";
const JOB = "00000000-0000-4000-8000-000000000006";
const OBJECT = "message:live-shadow:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

class ProductConnection implements PostgresJsBridgeConnection {
  constructor(readonly row: PostgresJsBridgeRow) {}
  query<Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(): Promise<readonly Row[]> {
    return Promise.resolve([this.row] as unknown as Row[]);
  }
  transaction<Result>(callback: (transaction: PostgresJsBridgeExecutor) => Promise<Result>): Promise<Result> {
    return callback(this);
  }
  transactionOnce<Result>(callback: (transaction: PostgresJsBridgeExecutor) => Promise<Result>): Promise<Result> {
    return callback(this);
  }
}

describe("Postgres Human live Shadow replay", () => {
  test("reconstructs only the exact durably authenticated Human sibling", async () => {
    const crypto = new LatticeCrypto();
    const planBytes = new Uint8Array([1, 2, 3]);
    const requestBytes = new Uint8Array([4, 5, 6]);
    const grantBytes = new Uint8Array([7, 8, 9]);
    const product = new ProductConnection({
      operation_id: OPERATION,
      session_id: SESSION,
      room_id: ROOM,
      namespace_id: NAMESPACE,
      agent_id: AGENT,
      human_message_id: 41,
      human_message_created_at: new Date("2027-01-15T08:00:00.000Z"),
      plan_digest: crypto.hash(planBytes),
      human_request_digest: crypto.hash(requestBytes),
      grant_digest: crypto.hash(grantBytes),
      job_id: JOB,
      state: "running",
      crypto_object_id: OBJECT,
      completion: "complete",
      disposition: "mapped",
      parity_status: "client_verified",
      representation_mode: "shadow_encryption",
      publication_policy_revision: null,
      policy_revision: 1,
      author_role: "user",
      role: "user",
      content: "hello",
      edit_revision: 0,
      mapped_object_id: OBJECT,
    });
    const storage = {
      getObject: async () => ({
        objectId: OBJECT,
        payloadBytes: new Uint8Array([10, 11]),
      }),
      getObjectAccessState: async () => ({
        head: {
          objectId: OBJECT,
          accessRevision: 0,
          manifestHash: new Uint8Array(32).fill(1),
          manifestBytes: new Uint8Array([12, 13]),
        },
        namespaceEnvelopes: [{
          namespaceId: NAMESPACE,
          envelopeHash: new Uint8Array(32).fill(2),
          envelopeBytes: new Uint8Array([14, 15]),
        }],
      }),
    };

    const replay = await inspectPostgresHumanLiveShadowReplay({
      product,
      storage,
      crypto,
      operationId: OPERATION,
      expectedContent: "hello",
      planBytes,
      requestBytes,
      grantBytes,
    });
    expect(replay).toMatchObject({
      status: "replayed",
      messageId: 41,
      content: "hello",
      jobId: JOB,
    });
    expect(replay.status === "replayed"
      ? replay.protectedMessage.protectedPayload.status
      : null).toBe("encrypted");

    expect(await inspectPostgresHumanLiveShadowReplay({
      product,
      storage,
      crypto,
      operationId: OPERATION,
      expectedContent: "hello",
      planBytes,
      requestBytes: new Uint8Array([4, 5, 7]),
      grantBytes,
    })).toEqual({ status: "conflict" });
  });
});

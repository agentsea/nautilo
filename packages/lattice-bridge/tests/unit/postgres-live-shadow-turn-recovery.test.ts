import { describe, expect, test } from "bun:test";

import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeExecutor,
  PostgresJsBridgeRow,
} from "@nautilo/db";
import { recoverPostgresLiveShadowTurn } from "@nautilo/lattice-bridge/server";

const USER = "00000000-0000-4000-8000-000000000001";
const HUMAN = "00000000-0000-4000-8000-000000000002";
const ROOM = "00000000-0000-4000-8000-000000000003";
const SESSION = "00000000-0000-4000-8000-000000000004";
const NAMESPACE = "00000000-0000-4000-8000-000000000005";
const AGENT = "00000000-0000-4000-8000-000000000006";
const JOB = "00000000-0000-4000-8000-000000000007";
const OPERATION = "live-shadow:m282:recovery";
const HUMAN_OBJECT = "message:live-shadow:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AGENT_OBJECT = "message:live-shadow:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

class ScriptedConnection implements PostgresJsBridgeConnection {
  readonly results: readonly PostgresJsBridgeRow[][];
  cursor = 0;
  constructor(results: readonly PostgresJsBridgeRow[][]) {
    this.results = results;
  }
  query<Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(): Promise<readonly Row[]> {
    return Promise.resolve((this.results[this.cursor++] ?? []) as Row[]);
  }
  transaction<Result>(callback: (transaction: PostgresJsBridgeExecutor) => Promise<Result>): Promise<Result> {
    return callback(this);
  }
  transactionOnce<Result>(callback: (transaction: PostgresJsBridgeExecutor) => Promise<Result>): Promise<Result> {
    return callback(this);
  }
}

function transcriptRow(input: Readonly<{
  ordinal: number;
  role: "user" | "assistant";
  objectId: string;
  content: string;
}>) {
  return {
    message_id: 40 + input.ordinal,
    edit_revision: 0,
    crypto_object_id: input.objectId,
    shadow_transcript_ordinal: input.ordinal,
    shadow_durable_event_digest: input.ordinal === 1
      ? null
      : new Uint8Array(32).fill(9),
    completion: "complete",
    disposition: "mapped",
    parity_status: input.ordinal === 1 ? "client_verified" : "server_verified",
    author_role: input.role,
    role: input.role,
    content: input.content,
    tool_calls: null,
    tool_name: null,
    created_at: new Date(`2027-01-15T08:00:0${input.ordinal}.000Z`),
    mapped_object_id: input.objectId,
    representation_mode: "shadow_encryption",
    publication_policy_revision: null,
  };
}

describe("Postgres live Shadow turn recovery", () => {
  test("returns ordered durable siblings without replaying transient frames", async () => {
    const product = new ScriptedConnection([[
      {
        operation_id: OPERATION,
        session_id: SESSION,
        room_id: ROOM,
        namespace_id: NAMESPACE,
        agent_id: AGENT,
        policy_revision: 3,
        owner_id: USER,
        human_actor_id: HUMAN,
        state: "completed",
        job_id: JOB,
        terminal_reason: null,
        mode: "shadow_encryption",
        current_policy_revision: 3,
      },
    ], [
      transcriptRow({ ordinal: 1, role: "user", objectId: HUMAN_OBJECT, content: "hello" }),
      transcriptRow({ ordinal: 2, role: "assistant", objectId: AGENT_OBJECT, content: "hi" }),
    ]]);
    const storage = {
      getObject: async (objectId: string) => ({
        objectId,
        payloadBytes: new Uint8Array([1, objectId === HUMAN_OBJECT ? 1 : 2]),
      }),
      getObjectAccessState: async (objectId: string) => ({
        head: {
          objectId,
          accessRevision: 0,
          manifestHash: new Uint8Array(32).fill(1),
          manifestBytes: new Uint8Array([2, 3]),
        },
        namespaceEnvelopes: [{
          namespaceId: NAMESPACE,
          envelopeHash: new Uint8Array(32).fill(2),
          envelopeBytes: new Uint8Array([4, 5]),
        }],
      }),
    };
    const result = await recoverPostgresLiveShadowTurn({ product, storage }, {
      authority: { userId: USER, humanActorId: HUMAN },
      roomId: ROOM,
      operationId: OPERATION,
    });
    expect(result).toMatchObject({
      status: "completed",
      state: "completed",
      jobId: JOB,
      human: { projection: { role: "user" } },
    });
    if (result.status !== "completed") throw new Error("recovery missing");
    expect(result.human.projection.role).toBe("user");
    expect(result.durableEvents).toHaveLength(1);
    expect(result.durableEvents[0]).toMatchObject({
      type: "message.shadow_durable",
      operationId: OPERATION,
      transcriptOrdinal: 2,
      protectedMessage: { projection: { role: "assistant" } },
    });
  });
});

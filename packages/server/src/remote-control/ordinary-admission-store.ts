import { getSharedDirectDb, ordinaryRequestAdmissions, sql } from "@nautilo/db";

export interface OrdinaryOriginAdmission {
  readonly requestId: string;
  readonly userId: string;
  readonly actorId: string;
  readonly controllerInstallationId: string;
  readonly installationGeneration: number;
  readonly bodySha256: string;
  readonly admittedAt: Date;
  readonly expiresAt: Date;
}

export interface OrdinaryAdmissionStore {
  /** Atomic insert: false means this request id was already admitted. */
  admitOnce(input: OrdinaryOriginAdmission): Promise<boolean>;
  /** Bounded deletion of already-expired replay receipts. */
  cleanupExpired(input: { now: Date; limit: number }): Promise<number>;
}

function makeDefaultStore(): OrdinaryAdmissionStore {
  return {
    async admitOnce(input) {
      const rows = await getSharedDirectDb()
        .insert(ordinaryRequestAdmissions)
        .values(input)
        .onConflictDoNothing({ target: ordinaryRequestAdmissions.requestId })
        .returning({ requestId: ordinaryRequestAdmissions.requestId });
      return rows.length === 1;
    },

    async cleanupExpired({ now, limit }) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
        throw new Error("ordinary admission cleanup limit must be between 1 and 10000");
      }
      const result = await getSharedDirectDb().execute(sql`
        WITH expired AS (
          SELECT request_id
          FROM ordinary_request_admissions
          WHERE expires_at <= ${now.toISOString()}::timestamptz
          ORDER BY expires_at, request_id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM ordinary_request_admissions AS admission
        USING expired
        WHERE admission.request_id = expired.request_id
        RETURNING admission.request_id
      `);
      return result.length;
    },
  };
}

const store: OrdinaryAdmissionStore = makeDefaultStore();

export function getOrdinaryAdmissionStore(): OrdinaryAdmissionStore {
  return store;
}

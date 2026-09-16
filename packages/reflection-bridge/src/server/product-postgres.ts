import {
  compileOfflineDirectQuery,
  createOfflineDirectDb,
  type OfflineDirectQuery,
  type OfflineDirectQueryRow,
} from "@nautilo/db";

export type RecordProductPostgresScalar =
  | string
  | number
  | bigint
  | boolean
  | Uint8Array
  | readonly string[]
  | readonly number[]
  | Date
  | null;

export type RecordProductPostgresRow = Readonly<
  Record<string, RecordProductPostgresScalar>
>;

export interface RecordProductPostgresExecutor {
  query<Row extends RecordProductPostgresRow = RecordProductPostgresRow>(
    statement: string,
    parameters?: readonly RecordProductPostgresScalar[],
  ): Promise<readonly Row[]>;
}

export const recordProductTypedDb = createOfflineDirectDb();

export type CompiledRecordProductQuery<Result = unknown> =
  OfflineDirectQuery<Result>;

function typedProductQueryParameters(
  values: readonly unknown[],
): readonly RecordProductPostgresScalar[] {
  return values.map((value) => {
    if (
      value === null
      || typeof value === "string"
      || typeof value === "number"
      || typeof value === "bigint"
      || typeof value === "boolean"
      || value instanceof Date
      || value instanceof Uint8Array
    ) return value;
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      return value;
    }
    if (Array.isArray(value) && value.every((entry) => typeof entry === "number")) {
      return value;
    }
    throw new TypeError("typed Record product query emitted an unsupported parameter");
  });
}

/** Compile a schema-typed builder and execute it on an already verified role. */
export function executeTypedRecordProductQuery<
  Query extends CompiledRecordProductQuery,
>(
  executor: RecordProductPostgresExecutor,
  query: Query,
): Promise<readonly OfflineDirectQueryRow<
  Query,
  RecordProductPostgresScalar
>[]> {
  const compiled = compileOfflineDirectQuery(query);
  return executor.query(
    compiled.sql,
    typedProductQueryParameters(compiled.params),
  ) as unknown as Promise<readonly OfflineDirectQueryRow<
    Query,
    RecordProductPostgresScalar
  >[]>;
}

export interface RecordProductPostgresConnection
  extends RecordProductPostgresExecutor {
  transaction<Result>(
    callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>,
    options: Readonly<{ isolationLevel: "serializable" | "read committed" }>,
  ): Promise<Result>;
}

declare const verifiedRecordProductHandleBrand: unique symbol;

export interface RecordProductPostgresHandle
  extends RecordProductPostgresConnection {
  readonly role: "nautilo";
  readonly [verifiedRecordProductHandleBrand]: true;
}

const verifiedHandles = new WeakSet<object>();

export function assertVerifiedRecordProductPostgresHandle(
  handle: RecordProductPostgresHandle,
): void {
  if (!verifiedHandles.has(handle)) {
    throw new TypeError("Record repository requires a verified product handle");
  }
}

/** Reject SET ROLE impersonation and every non-product database identity. */
export async function verifyRecordProductPostgresHandle(
  connection: RecordProductPostgresConnection,
): Promise<RecordProductPostgresHandle> {
  const rows = await connection.query<{
    current_role: string;
    session_role: string;
  }>("SELECT current_user AS current_role, session_user AS session_role");
  const row = rows[0];
  if (
    rows.length !== 1
    || row?.current_role !== "nautilo"
    || row.session_role !== "nautilo"
  ) {
    throw new TypeError("Record product connection has an invalid direct role");
  }
  const handle = Object.freeze({
    role: "nautilo" as const,
    query: connection.query.bind(connection),
    transaction: connection.transaction.bind(connection),
  }) as RecordProductPostgresHandle;
  verifiedHandles.add(handle);
  return handle;
}

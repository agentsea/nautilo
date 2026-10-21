import {
  backgroundCryptoAuthorizationRequests, eq,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  cryptoTypedDb, executeTypedCryptoQuery, verifyCryptoPostgresHandle,
  withVerifiedCryptoPostgresTransaction, type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";
import { hasTaskTerminalMessageCryptoPublication } from "./postgres-task-terminal-message-staging.ts";

declare const unstagedTaskTerminalMessageAuthorityBrand: unique symbol;

/** Callback-only proof that the exact terminal publication remains absent. */
export type UnstagedTaskTerminalMessageAuthority = Readonly<{
  readonly [unstagedTaskTerminalMessageAuthorityBrand]: true;
}>;

type Coordinates = Readonly<{ requestId: string; objectId: string }>;
const active = new WeakMap<UnstagedTaskTerminalMessageAuthority, Coordinates>();
const REQUEST_ID = /^task-run-delivery-message-authorization:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const OBJECT_ID = /^message:v2:[0-9a-f]{64}$/u;

export function assertUnstagedTaskTerminalMessageAuthority(
  authority: UnstagedTaskTerminalMessageAuthority,
  expected: Coordinates,
): void {
  const coordinates = active.get(authority);
  if (coordinates === undefined || coordinates.requestId !== expected.requestId
    || coordinates.objectId !== expected.objectId) {
    throw new TypeError("Unstaged terminal Message authority is not current");
  }
}

/** Caller already holds canonical stopped Task/Run and destination authority. */
export async function withUnstagedTaskTerminalMessagePublication<Value>(input: Readonly<{
  restricted: PostgresJsBridgeConnection;
  requestId: string;
  objectId: string;
  use(handle: CryptoPostgresHandle, authority: UnstagedTaskTerminalMessageAuthority): Promise<Value>;
}>): Promise<Readonly<{ status: "unstaged"; value: Value } | { status: "publication_exists" }>> {
  const { restricted, requestId, objectId, use } = input;
  if (!REQUEST_ID.test(requestId) || !OBJECT_ID.test(objectId)
    || typeof use !== "function") {
    throw new TypeError("Unstaged terminal Message coordinates are invalid");
  }
  const coordinates = Object.freeze({ requestId, objectId });
  const handle = await verifyCryptoPostgresHandle(restricted);
  return withVerifiedCryptoPostgresTransaction(handle, async scoped => {
    // Match staging's request -> object order even when the request is new.
    await executeTypedCryptoQuery(scoped, cryptoTypedDb.select({
      request_id: backgroundCryptoAuthorizationRequests.requestId,
    }).from(backgroundCryptoAuthorizationRequests).where(eq(
      backgroundCryptoAuthorizationRequests.requestId, requestId,
    )).for("update"));
    await scoped.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
      [objectId],
    );
    if (await hasTaskTerminalMessageCryptoPublication(scoped, coordinates)) {
      return { status: "publication_exists" };
    }
    const authority = Object.freeze({}) as UnstagedTaskTerminalMessageAuthority;
    active.set(authority, coordinates);
    try {
      const value = await use(scoped, authority);
      if (await hasTaskTerminalMessageCryptoPublication(scoped, coordinates)) {
        throw new TypeError("Terminal Message publication appeared during unstaged authority");
      }
      return { status: "unstaged", value };
    } finally {
      active.delete(authority);
    }
  });
}

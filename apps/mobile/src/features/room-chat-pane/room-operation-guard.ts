/**
 * Owns the current Room operation identity for one chat-controller instance.
 * A route/Human/server change advances the epoch synchronously, so completions
 * from the former scope cannot publish state into the newly selected Room.
 */
export type RoomOperationScope = Readonly<{
  serverId: string | null;
  viewerId: string | null;
  roomId: string | null;
}>;

export type RoomOperationToken = Readonly<{
  epoch: number;
  scopeKey: string;
}>;

export type RoomOperationGuard = Readonly<{
  activate(scope: RoomOperationScope): void;
  begin(): RoomOperationToken;
  isCurrent(token: RoomOperationToken): boolean;
  beginInitialHistory(): RoomOperationToken;
  isCurrentInitialHistory(token: RoomOperationToken): boolean;
  acquireSend(token: RoomOperationToken): boolean;
  releaseSend(token: RoomOperationToken): void;
  acquirePaging(token: RoomOperationToken): boolean;
  isCurrentPaging(token: RoomOperationToken): boolean;
  releasePaging(token: RoomOperationToken): void;
}>;

function scopeKey(scope: RoomOperationScope): string {
  return JSON.stringify([scope.serverId, scope.viewerId, scope.roomId]);
}

/**
 * This deliberately has no scheduling, retry, or transport behavior. It is
 * only a synchronous ownership fence for work already started by the caller.
 */
export function createRoomOperationGuard(): RoomOperationGuard {
  let activeScopeKey = scopeKey({ serverId: null, viewerId: null, roomId: null });
  let epoch = 0;
  let initialHistoryGeneration = 0;
  let sendLease: RoomOperationToken | null = null;
  let pagingLease: RoomOperationToken | null = null;
  const initialHistoryGenerations = new WeakMap<RoomOperationToken, number>();

  const isCurrent = (token: RoomOperationToken): boolean =>
    token.epoch === epoch && token.scopeKey === activeScopeKey;

  return {
    activate(scope) {
      const nextScopeKey = scopeKey(scope);
      if (nextScopeKey === activeScopeKey) return;
      activeScopeKey = nextScopeKey;
      epoch += 1;
      initialHistoryGeneration = 0;
      // A lease belongs to the former exact scope. Do not make Room B wait
      // for Room A's network completion before it can send.
      sendLease = null;
      pagingLease = null;
    },
    begin() {
      return Object.freeze({ epoch, scopeKey: activeScopeKey });
    },
    isCurrent,
    beginInitialHistory() {
      const token = Object.freeze({ epoch, scopeKey: activeScopeKey });
      initialHistoryGeneration += 1;
      initialHistoryGenerations.set(token, initialHistoryGeneration);
      return token;
    },
    isCurrentInitialHistory(token) {
      return isCurrent(token)
        && initialHistoryGenerations.get(token) === initialHistoryGeneration;
    },
    acquireSend(token) {
      if (!isCurrent(token) || sendLease !== null) return false;
      sendLease = token;
      return true;
    },
    releaseSend(token) {
      if (sendLease === token) sendLease = null;
    },
    acquirePaging(token) {
      if (!isCurrent(token) || pagingLease !== null) return false;
      pagingLease = token;
      return true;
    },
    isCurrentPaging(token) {
      return isCurrent(token) && pagingLease === token;
    },
    releasePaging(token) {
      if (pagingLease === token) pagingLease = null;
    },
  };
}

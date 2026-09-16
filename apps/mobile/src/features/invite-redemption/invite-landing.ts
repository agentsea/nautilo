/**
 * The post-invite landing seam is deliberately tiny: a returned room ID is a
 * destination hint, never proof that the newly created Human may open it.
 * The active exact server's ordinary readable-room list remains authoritative.
 */

export const INVITE_COMPLETION_NOTICE = "Account created — invitation completed";
export const INVITE_COMPLETION_NOTICE_PARAM = "invite-completed";

export type InviteLandingServer = Readonly<{ id: string; serverUrl: string }>;

export type InviteLandingDecision =
  | Readonly<{ kind: "room"; roomId: string }>
  | Readonly<{ kind: "chats"; notice: typeof INVITE_COMPLETION_NOTICE }>;

export type InviteLandingInput = Readonly<{
  ceremonyServerId: string;
  landingRoomId: string | null;
}>;

export type InviteLandingDependencies = Readonly<{
  getActiveServer: () => InviteLandingServer | null;
  /** `true` means a fresh, exact-server viewer identity was verified. */
  refreshViewer: () => Promise<boolean>;
  listRooms: (serverUrl: string) => Promise<Readonly<{ rooms: readonly Readonly<{ id: string }>[] }>>;
}>;

const chatsFallback = (): InviteLandingDecision => ({
  kind: "chats",
  notice: INVITE_COMPLETION_NOTICE,
});

/** Pure authorization decision after the supplied read-only directory result. */
export function decideInviteLanding(input: InviteLandingInput & Readonly<{
  activeServerId: string | null;
  readableRoomIds: readonly string[];
}>): InviteLandingDecision {
  if (
    !input.landingRoomId
    || input.activeServerId !== input.ceremonyServerId
    || !input.readableRoomIds.includes(input.landingRoomId)
  ) {
    return chatsFallback();
  }
  return { kind: "room", roomId: input.landingRoomId };
}

/**
 * Refresh identity once, then take one authoritative readable-room snapshot.
 * Missing/delayed membership intentionally falls back immediately—this flow
 * does not poll, guess another Room, or retry into an auth loop.
 */
export async function resolveInviteLanding(
  input: InviteLandingInput,
  dependencies: InviteLandingDependencies,
): Promise<InviteLandingDecision> {
  const initialServer = dependencies.getActiveServer();
  if (initialServer?.id !== input.ceremonyServerId) return chatsFallback();

  try {
    if (!await dependencies.refreshViewer()) return chatsFallback();
    // Refresh may have raced a manual server switch. Always take the list
    // base URL from the currently active, still exact record.
    const exactServer = dependencies.getActiveServer();
    if (exactServer?.id !== input.ceremonyServerId) return chatsFallback();
    const response = await dependencies.listRooms(exactServer.serverUrl);
    // Do not navigate based on a directory response obtained while another
    // server became active in the meantime.
    const activeAfterList = dependencies.getActiveServer();
    return decideInviteLanding({
      ...input,
      activeServerId: activeAfterList?.id ?? null,
      readableRoomIds: response.rooms.map((room) => room.id),
    });
  } catch {
    return chatsFallback();
  }
}

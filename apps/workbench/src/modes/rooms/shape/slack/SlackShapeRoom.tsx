import { type ReactElement } from "react";
import type { RoomMemberDto } from "@nautilo/types";
import { Conversation } from "../../../../components/conversation";
import {
  ProviderSetupEmptyState,
  shouldShowProviderSetupEmptyState,
} from "../../../../components/provider-setup-empty-state";
import { useSetupStatus } from "../../../../contexts/setup-status-context";
import { useCan } from "../../../../hooks/use-can";
import { RoomAuthorScope } from "../RoomAuthorScope";
import { RoomSilenceBanner } from "../RoomSilenceBanner";

/**
 * Slack-shape room (mixed humans + agents). The legacy `Conversation`
 * component renders the rooms-tab strip + room header + chat surface.
 *
 * D302 follow-up: conductor routing status lives in the docked Members panel
 * under Smart routing, not in this chat surface.
 *
 * D193 / Stack 74 Phase D: room management (members, rename, visibility,
 * archive) lives in the explorer row `⋯` menu → `MembersPanel`. This shell
 * no longer hosts a members trigger or panel.
 */
export function SlackShapeRoom({
  roomId,
  members,
}: {
  readonly roomId?: string | undefined;
  readonly members: readonly RoomMemberDto[];
  readonly onMembershipChanged?: () => void;
}): ReactElement {
  const status = useSetupStatus();
  const can = useCan();
  if (shouldShowProviderSetupEmptyState(status, members)) {
    return <ProviderSetupEmptyState canManageProviders={can("manage_connection_providers") || can("manage_server_settings")} />;
  }

  // D193 follow-up (Smoke-3) / D352 — author/member context for multi-human
  // labels + the @-mention picker + agent identity. The label map is built
  // once per `members` change inside `RoomAuthorScope` (shared with the
  // reader-rail mount in `workbench-shell`, so there is one builder).
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {roomId ? <RoomSilenceBanner roomId={roomId} /> : null}
      <RoomAuthorScope members={members}>
        <Conversation />
      </RoomAuthorScope>
    </div>
  );
}

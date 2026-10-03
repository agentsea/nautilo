import { useEffect, useState, type ReactElement } from "react";
import type { RoomMemberDto } from "@nautilo/types";
import { Conversation } from "../../../../components/conversation";
import {
  ProviderSetupEmptyState,
  needsPersonalChatReadiness,
  personalChatNeedsSetup,
  shouldShowProviderSetupEmptyState,
  type PersonalChatReadiness,
} from "../../../../components/provider-setup-empty-state";
import { useSetupStatus } from "../../../../contexts/setup-status-context";
import { useCan } from "../../../../hooks/use-can";
import { useAuth } from "../../../../hooks/use-auth";
import { apiClient } from "../../../../lib/api";
import { readPersonalChatReadiness } from "../../../../lib/personal-chat-readiness";
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
  const { viewer } = useAuth();
  const canInvokeAgents = can("invoke_agents");
  const canUsePersonalKeys = can("use_personal_provider_credentials");
  const canUseServerKeys = can("use_server_provider_credentials");
  const modelProviderMissing = status?.setupState === "server-needs-keys"
    || status?.providers?.hasLlm === false;
  const roomNeedsModel = members.length === 0 || members.some((member) => member.kind === "agent");
  const checkPersonalReadiness = roomNeedsModel && canInvokeAgents && needsPersonalChatReadiness(canUsePersonalKeys);
  const serverFallbackAvailable = canUseServerKeys && !modelProviderMissing;
  const [readiness, setReadiness] = useState<{
    userId: string | null;
    state: PersonalChatReadiness;
  }>({ userId: null, state: "checking" });
  const [refreshGeneration, setRefreshGeneration] = useState(0);

  useEffect(() => {
    const refresh = () => setRefreshGeneration((generation) => generation + 1);
    window.addEventListener("nautilo:personal-provider-credentials-changed", refresh);
    window.addEventListener("nautilo:personal-provider-policy-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("nautilo:personal-provider-credentials-changed", refresh);
      window.removeEventListener("nautilo:personal-provider-policy-changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  useEffect(() => {
    if (!checkPersonalReadiness || !viewer.sessionUserId) return;
    let cancelled = false;
    setReadiness({ userId: viewer.sessionUserId, state: "checking" });
    void (async () => {
      const next = await readPersonalChatReadiness({
        listCredentials: () => apiClient.listProviderCredentials(),
        getCallerModels: () => apiClient.getCallerModels(),
      }, { serverFallbackAvailable });
      if (!cancelled) setReadiness({ userId: viewer.sessionUserId, state: next });
    })();
    return () => { cancelled = true; };
  }, [checkPersonalReadiness, serverFallbackAvailable, viewer.sessionUserId, refreshGeneration]);

  const personalState = readiness.userId === viewer.sessionUserId
    ? readiness.state
    : "checking";
  if (checkPersonalReadiness && personalChatNeedsSetup(personalState)) {
    return <ProviderSetupEmptyState
      canManageProviders={false}
      personalState={personalState}
      onRetry={() => setRefreshGeneration((generation) => generation + 1)}
    />;
  }
  if (shouldShowProviderSetupEmptyState(status, members)
    && !(checkPersonalReadiness && personalState === "ready")) {
    return <ProviderSetupEmptyState canManageProviders={can("manage_connection_providers") || can("manage_server_settings")} />;
  }

  const foreignGenie = members.find((member) =>
    member.kind === "agent"
    && member.agentOwnerUserId
    && member.agentOwnerUserId !== viewer.sessionUserId,
  );
  const showForeignGenieNotice = foreignGenie && !can("invoke_other_agents");

  // D193 follow-up (Smoke-3) / D352 — author/member context for multi-human
  // labels + the @-mention picker + agent identity. The label map is built
  // once per `members` change inside `RoomAuthorScope` (shared with the
  // reader-rail mount in `workbench-shell`, so there is one builder).
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {roomId ? <RoomSilenceBanner roomId={roomId} /> : null}
      {showForeignGenieNotice ? (
        <p className="border-b border-border bg-background-element px-4 py-2 text-sm text-foreground-muted" role="status">
          This Genie belongs to someone else. You can read this Room, but only members with permission to call other people&apos;s Genies can ask it to respond.
        </p>
      ) : null}
      <RoomAuthorScope members={members}>
        <Conversation />
      </RoomAuthorScope>
    </div>
  );
}

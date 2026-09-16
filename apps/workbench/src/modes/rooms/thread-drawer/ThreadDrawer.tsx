import type { DrawerKind } from "./drawer-state.types";
import { SubthreadSurface } from "./surfaces/SubthreadSurface";
import { PersonDetailsSurface } from "./surfaces/PersonDetailsSurface";
import { BotDetailsSurface } from "./surfaces/BotDetailsSurface";
import { RoomDetailsSurface } from "./surfaces/RoomDetailsSurface";
import { RelationshipDetailsSurface } from "./surfaces/RelationshipDetailsSurface";
import { SubagentTranscriptSurface } from "../subagents/SubagentTranscriptSurface";

export interface ThreadDrawerProps {
  state: DrawerKind;
  onClose: () => void;
}

export function ThreadDrawer({ state }: ThreadDrawerProps) {
  if (state.kind === "closed") {
    return null;
  }

  switch (state.kind) {
    case "thread":
      return (
        <SubthreadSurface
          subthreadRoomId={state.subthreadRoomId}
          anchorMessageId={state.anchorMessageId}
          parentRoomId={state.parentRoomId}
        />
      );
    case "person":
      return <PersonDetailsSurface personActorId={state.personActorId} />;
    case "bot":
      return <BotDetailsSurface agentId={state.agentId} />;
    case "room":
      return <RoomDetailsSurface roomId={state.roomId} />;
    case "relationship":
      return (
        <RelationshipDetailsSurface
          viewerActorId={state.viewerActorId}
          counterpartActorId={state.counterpartActorId}
        />
      );
    case "subagent-transcript":
      return (
        <SubagentTranscriptSurface
          taskId={state.taskId}
          {...(state.taskRunId !== undefined ? { taskRunId: state.taskRunId } : {})}
        />
      );
    default:
      return null;
  }
}

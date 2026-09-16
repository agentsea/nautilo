import type { NautiloProfile } from "../../store/profile-store";
import { emitAgentEvent } from "../../runtime-hooks";

export function emitProfileUpdated(profile: NautiloProfile): void {
  emitAgentEvent({
    type: "profile.updated",
    profileId: profile.id,
    name: profile.name,
    onboardingCompleted: profile.onboardingCompleted,
    // The WS publisher only forwards profile.updated to a client when the
    // event carries a userId (delivery is scoped to that user's sockets).
    // Without this, agent-driven avatar/profile changes never reached the
    // workbench and the panel/chat stayed stale until a manual reload.
    userId: profile.userId,
  });
}

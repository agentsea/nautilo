import type { EventFeed } from "@nautilo/event-feed";
import type { WorkspaceArtifactCreatedFact } from "@nautilo/agent";
import type { CommittedArtifactShareEffect } from "@nautilo/trust";

type Author = Readonly<{ actorId: string; kind: "human" | "agent"; userId: string }>;

export interface ArtifactEventProducerDeps {
  feed: Pick<EventFeed, "recordBestEffort">;
  resolveAuthor: (actor: WorkspaceArtifactCreatedFact["actor"]) => Promise<Author | null>;
  resolvePeople: (actorIds: readonly string[]) => Promise<readonly string[]>;
  resolveCreationRoom: (namespaceId: string) => Promise<string | null>;
  listHumanUserIdsInRoom: (roomId: string) => Promise<readonly string[]>;
  warn?: (message: string) => void;
}

/** Feed effects are subordinate to committed business truth, including audience lookup. */
export function createArtifactEventProducer(deps: ArtifactEventProducerDeps) {
  const guarded = async (run: () => Promise<void>) => {
    try { await run(); } catch {
      try { deps.warn?.("artifact feed projection failed"); } catch { /* best effort */ }
    }
  };
  const recipients = (users: readonly string[], author: Author) =>
    [...new Set(users)].filter(id => author.kind !== "human" || id !== author.userId);

  return {
    created: (fact: WorkspaceArtifactCreatedFact) => guarded(async () => {
      const author = await deps.resolveAuthor(fact.actor);
      const roomId = await deps.resolveCreationRoom(fact.namespaceId);
      if (!author || !roomId) return;
      await deps.feed.recordBestEffort({
        key: [fact.occurrenceKey, "artifact.added", fact.artifactInternalId, roomId].join(":"),
        type: "artifact.added", actorId: author.actorId, actorKind: author.kind,
        recipientUserIds: recipients(await deps.listHumanUserIdsInRoom(roomId), author),
        data: { artifactId: fact.artifactInternalId, roomId },
      });
    }),
    shared: (effect: CommittedArtifactShareEffect) => guarded(async () => {
        // Agent admission retains the authorizing Human actorId. It is not
        // the visible author: resolve the separately admitted Agent identity.
        const author: Author | null = effect.requester.kind === "agent"
          ? await deps.resolveAuthor({ kind: "agent", agentId: effect.requester.agentId })
          : { actorId: effect.requester.actorId, userId: effect.requester.userId, kind: "human" };
        if (!author) return;
        if (effect.target.kind === "room") {
          const roomId = effect.target.roomId;
          await deps.feed.recordBestEffort({
            key: [effect.operationId, "artifact.shared", effect.artifactId, "room", roomId].join(":"),
            type: "artifact.shared", actorId: author.actorId, actorKind: author.kind,
            recipientUserIds: recipients(await deps.listHumanUserIdsInRoom(roomId), author),
            data: { artifactId: effect.artifactId, destination: { kind: "room", roomId } },
          });
        } else {
          for (const userId of recipients(await deps.resolvePeople(effect.target.personActorIds), author)) {
            await deps.feed.recordBestEffort({
              key: [effect.operationId, "artifact.shared", effect.artifactId, "person", userId].join(":"),
              type: "artifact.shared", actorId: author.actorId, actorKind: author.kind,
              recipientUserIds: [userId],
              data: { artifactId: effect.artifactId, destination: { kind: "person", userId } },
            });
          }
        }
    }),
  };
}

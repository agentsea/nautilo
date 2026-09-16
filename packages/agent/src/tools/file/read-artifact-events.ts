import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  agentDb,
  drainPendingArtifactEventsForNamespaces,
  findArtifactByPathForNamespaces,
} from "@nautilo/db";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { envelopeReadableNamespaces } from "@nautilo/trust";
import { withAgentTrustContext } from "../../store/trust-agent-db";

interface ReadArtifactEventsContext {
  userId?: string;
  memoryAccessEnvelope?: MemoryAccessEnvelope | null;
}

const inputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Workspace logical path, e.g. "artifacts/foo.html".'),
});

function serializeEvent(row: {
  id: string;
  topic: string;
  payload: unknown;
  createdAt: Date;
  namespaceId: string;
}) {
  return {
    id: row.id,
    topic: row.topic,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
    namespaceId: row.namespaceId,
  };
}

export function createReadArtifactEventsTool(context?: ReadArtifactEventsContext) {
  return new DynamicStructuredTool({
    name: "read_artifact_events",
    description:
      "Drain pending channel-3 notifications from a workspace artifact " +
      "(signals emitted via nwState.emit while you were idle). Call on your " +
      "next turn after authoring or monitoring interactive HTML artifacts — " +
      "events are removed from the queue once returned (at-most-once). Does " +
      "not read artifact bytes or UI state; use the file tool for content.",
    schema: inputSchema,
    func: async ({ path }) => {
      const envelope = context?.memoryAccessEnvelope ?? null;
      const agentId = envelope?.agentId;
      if (!agentId) {
        return JSON.stringify({ ok: false, error: "no_agent_in_envelope" });
      }
      const readableNamespaceIds = envelopeReadableNamespaces(envelope);
      if (readableNamespaceIds.length === 0) {
        return JSON.stringify({ ok: false, error: "no_readable_namespaces" });
      }
      const userId = context?.userId ?? envelope?.ownerId ?? "";
      if (!userId) {
        return JSON.stringify({ ok: false, error: "no_agent_in_envelope" });
      }

      const artifact = await withAgentTrustContext(
        { userId, agentId },
        async (tx) => {
          const conn = tx as unknown as typeof agentDb;
          return findArtifactByPathForNamespaces(
            { path, readableNamespaceIds },
            conn,
          );
        },
      );
      if (!artifact) {
        return JSON.stringify({ ok: false, error: "artifact_not_found", path });
      }

      const rows = await withAgentTrustContext(
        { userId, agentId },
        async (tx) => {
          const conn = tx as unknown as typeof agentDb;
          return drainPendingArtifactEventsForNamespaces(
            {
              readableNamespaceIds,
              agentId,
              artifactId: artifact.artifactId,
            },
            conn,
          );
        },
      );

      const events = rows.map(serializeEvent);
      return JSON.stringify({
        ok: true,
        path,
        artifactId: artifact.artifactId,
        count: events.length,
        events,
        drained: true,
      });
    },
  });
}

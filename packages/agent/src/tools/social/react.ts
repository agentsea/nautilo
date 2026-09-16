import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  findAgentActorForAgent,
  resolveRoomMessageByAuthorAndTime,
} from "@nautilo/trust";
import { isValidEmojiString, EMOJI_MAX_LENGTH } from "@nautilo/types";
import { addReaction, removeReaction } from "../../store/message-reactions-store";

interface ReactToolContext {
  roomId?: string;
  memoryAccessEnvelope?: MemoryAccessEnvelope | null;
}

const inputSchema = z.object({
  author_handle: z.string().min(1).max(64).optional(),
  // Optional. Bracketed UTC time of the target line if you can see it, e.g.
  // "2026-06-01T13:02:11Z". Omit to target the most recent message — this is
  // the right choice for reacting to the message you're replying to right now.
  at: z.string().min(16).max(40).optional(),
  emoji: z.string().min(1).max(EMOJI_MAX_LENGTH),
  action: z.enum(["add", "remove"]).default("add"),
});

export function createReactTool(context?: ReactToolContext) {
  return new DynamicStructuredTool({
    name: "react",
    description:
      "React to a message in the current room with an emoji instead of a " +
      "short text reply like 'ok'/'got it'/'thumbs up'. To react to the " +
      "message you're replying to right now, just pass `emoji` and leave " +
      "`at` and `author_handle` empty — it targets the most recent message. " +
      "To target an older message, pass `author_handle` (the handle without " +
      "'@') and optionally `at` (the bracketed UTC time on its transcript " +
      "line, e.g. \"2026-06-01T13:02:11Z\"; an approximate time is fine). " +
      "Use action='remove' to undo. Reactions do not trigger another turn " +
      "from your room partners - they're free.",
    schema: inputSchema,
    func: async (args) => {
      if (!isValidEmojiString(args.emoji)) {
        return JSON.stringify({ ok: false, error: "invalid_emoji" });
      }
      const env = context?.memoryAccessEnvelope ?? null;
      const agentId = env?.agentId;
      if (!agentId) {
        return JSON.stringify({ ok: false, error: "no_agent_in_envelope" });
      }
      const actor = await findAgentActorForAgent(agentId);
      if (!actor) {
        return JSON.stringify({ ok: false, error: "no_actor_for_agent" });
      }
      const roomId = context?.roomId ?? env?.roomId ?? "";
      if (!roomId) {
        return JSON.stringify({ ok: false, error: "not_in_a_room" });
      }
      const messageId = await resolveRoomMessageByAuthorAndTime({
        roomId,
        authorHandle: args.author_handle ?? null,
        atIso: args.at ?? null,
        // M121 fix — never self-target this agent's own (often empty
        // tool-call) turn when the anchor is omitted; resolve to the
        // message actually being replied to.
        excludeCallerAgentId: agentId,
      });
      if (messageId == null) {
        return JSON.stringify({ ok: false, error: "message_not_found" });
      }
      const ctx = { userId: env?.ownerId ?? "", agentId };
      if (args.action === "add") {
        const { created } = await addReaction({
          messageId,
          actorId: actor.id,
          emoji: args.emoji,
          roomId,
          ctx,
        });
        return JSON.stringify({ ok: true, action: "add", created });
      }
      const { removed } = await removeReaction({
        messageId,
        actorId: actor.id,
        emoji: args.emoji,
        roomId,
        ctx,
      });
      return JSON.stringify({ ok: true, action: "remove", removed });
    },
  });
}

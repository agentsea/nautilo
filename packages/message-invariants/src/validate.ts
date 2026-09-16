import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

export interface ValidationResult {
  messages: BaseMessage[];
  repairs: string[];
}

export function hasToolCalls(msg: BaseMessage): boolean {
  if (!AIMessage.isInstance(msg)) return false;
  return Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
}

export function getToolCalls(msg: BaseMessage): Array<{ id?: string; name: string; args: Record<string, unknown> }> {
  if (!AIMessage.isInstance(msg)) return [];
  return msg.tool_calls ?? [];
}

export function getContentAsString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === "string" ? b : (b as { text?: string })?.text ?? "")).join("");
  }
  return "";
}

function filterContentToolUse(content: unknown, idsToRemove: Set<string>): unknown {
  if (!Array.isArray(content)) return content;
  return content.filter((block) => {
    if (block && typeof block === "object" && "type" in block) {
      const b = block as { type: string; id?: string };
      if (b.type === "tool_use" && b.id) return !idsToRemove.has(b.id);
    }
    return true;
  });
}

/**
 * Exported within `@nautilo/message-invariants` (not re-exported from
 * the package barrel) so the sibling `merge.ts` module can reuse the
 * same "strip these tool_call ids + their content tool_use blocks +
 * drop the AIMessage if nothing remains" logic. Returns `null` when
 * the AIMessage has no remaining tool_calls AND its content is empty
 * after the strip — callers must handle the drop case explicitly.
 */
export function removeToolCallsFromAIMessage(msg: BaseMessage, idsToRemove: Set<string>): AIMessage | null {
  if (!AIMessage.isInstance(msg)) return null;
  const remaining = (msg.tool_calls ?? []).filter((tc) => !tc.id || !idsToRemove.has(tc.id));
  const filteredContent = filterContentToolUse(msg.content, idsToRemove);
  const baseFields: Record<string, unknown> = { content: filteredContent, additional_kwargs: msg.additional_kwargs };
  if (msg.id) baseFields["id"] = msg.id;

  if (remaining.length === 0) {
    if (getContentAsString(filteredContent).trim().length > 0) return new AIMessage(baseFields as ConstructorParameters<typeof AIMessage>[0]);
    return null;
  }
  return new AIMessage({ ...baseFields, tool_calls: remaining } as ConstructorParameters<typeof AIMessage>[0]);
}

/**
 * D143 Layer 3 — dedupe ToolMessages by tool_call_id, keeping the
 * LATEST occurrence. Belt-and-suspenders for Layer 1: if a
 * mid-pipeline transform (sanitizeImagesForModel, normalize-for-
 * provider, future code paths) strips the stable id assigned by
 * Layer 1, the messagesStateReducer's native dedupe can't fire —
 * this guarantees the invariant holds at the final-validation
 * boundary regardless.
 *
 * Latest-wins encoding: a duplicate from a retry / approval-resume
 * / fork-splice is more likely to be the "real" result than the
 * first one (which may have been a partial / superseded by a
 * re-execution).
 */
export function dedupeToolMessagesByCallId(
  messages: BaseMessage[],
): { messages: BaseMessage[]; repairs: string[] } {
  const lastIdxByCallId = new Map<string, number>();
  messages.forEach((msg, i) => {
    if (msg instanceof ToolMessage && msg.tool_call_id) {
      lastIdxByCallId.set(msg.tool_call_id, i);
    }
  });
  const repairs: string[] = [];
  const deduped = messages.filter((msg, i) => {
    if (!(msg instanceof ToolMessage) || !msg.tool_call_id) return true;
    if (i === lastIdxByCallId.get(msg.tool_call_id)) return true;
    repairs.push(
      `Dropped duplicate ToolMessage tool_call_id=${msg.tool_call_id} at idx ${i} (kept later occurrence)`,
    );
    return false;
  });
  return { messages: deduped, repairs };
}

/**
 * D143 Layer 3 — dedupe duplicate tool_call ids WITHIN a single
 * AIMessage's `tool_calls[]` array AND its `content` array's
 * `tool_use` blocks. Keeps the LATEST occurrence (last array index)
 * per id. Latest-wins matches the cross-message dedupe and the
 * merge helper's semantics, so the invariant is uniform across all
 * three repair sites.
 *
 * Rare in practice (an LLM rarely emits duplicate ids within a
 * single tool_use batch) but a real shape from retry/replay paths
 * where a streaming-chunk reducer mis-merges two emit-windows. Per
 * Anthropic's wire protocol, two `tool_use` blocks with the same
 * id in one assistant turn is invalid regardless of how they got
 * there.
 */
export function dedupeToolCallIdsWithinAIMessages(
  messages: BaseMessage[],
): { messages: BaseMessage[]; repairs: string[] } {
  const repairs: string[] = [];
  const result = messages.map((msg, msgIdx) => {
    if (!AIMessage.isInstance(msg)) return msg;
    const tcs = msg.tool_calls ?? [];
    // Dedupe tool_calls[] by id (last-occurrence wins).
    const lastTcIdxById = new Map<string, number>();
    tcs.forEach((tc, i) => { if (tc.id) lastTcIdxById.set(tc.id, i); });
    const dedupedTcs = tcs.filter((tc, i) => {
      if (!tc.id) return true;
      if (i === lastTcIdxById.get(tc.id)) return true;
      repairs.push(
        `Dropped duplicate tool_call id=${tc.id} within AIMessage at idx ${msgIdx}, tc-position ${i} (kept later occurrence in same message)`,
      );
      return false;
    });
    // Dedupe content[] tool_use blocks by id (last-occurrence wins).
    let dedupedContent: unknown = msg.content;
    if (Array.isArray(msg.content)) {
      const lastContentIdxById = new Map<string, number>();
      msg.content.forEach((b, i) => {
        if (b && typeof b === "object" && "type" in b) {
          const blk = b as { type: string; id?: string };
          if (blk.type === "tool_use" && blk.id) lastContentIdxById.set(blk.id, i);
        }
      });
      const newContent = msg.content.filter((b, i) => {
        if (!b || typeof b !== "object" || !("type" in b)) return true;
        const blk = b as { type: string; id?: string };
        if (blk.type !== "tool_use" || !blk.id) return true;
        if (i === lastContentIdxById.get(blk.id)) return true;
        repairs.push(
          `Dropped duplicate content tool_use block id=${blk.id} within AIMessage at idx ${msgIdx}, content-position ${i} (kept later occurrence in same message)`,
        );
        return false;
      });
      if (newContent.length !== msg.content.length) dedupedContent = newContent;
    }
    const tcChanged = dedupedTcs.length !== tcs.length;
    const ctChanged = dedupedContent !== msg.content;
    if (!tcChanged && !ctChanged) return msg;
    const baseFields: Record<string, unknown> = {
      content: dedupedContent,
      additional_kwargs: msg.additional_kwargs,
    };
    if (msg.id) baseFields["id"] = msg.id;
    if (dedupedTcs.length > 0) baseFields["tool_calls"] = dedupedTcs;
    return new AIMessage(baseFields as ConstructorParameters<typeof AIMessage>[0]);
  });
  return { messages: result, repairs };
}

/**
 * D143 Layer 3 — collect every tool_use id that an AIMessage claims
 * as a source. Scans BOTH surfaces an Anthropic-shaped message
 * carries:
 *
 *   - `tool_calls[]` — LangChain's normalized parallel field
 *   - `content[]` blocks with `type: "tool_use"` — Anthropic's raw
 *     wire format
 *
 * In a normal production pipeline both surfaces are populated in
 * parallel: `@langchain/anthropic`'s `message_outputs.js` creates
 * `tool_call_chunks` AND `content` `tool_use` blocks on every
 * `content_block_start` event, and `AIMessageChunk.concat` merges
 * them in parallel via `_mergeLists`. The two surfaces stay in
 * parity through the entire stream.
 *
 * Defense in depth: a future provider adapter that doesn't maintain
 * parity, OR a manual `new AIMessage({content: [tool_use blocks]})`
 * construction that doesn't pass `tool_calls`, would produce an
 * AIMessage where `tool_calls[]` is empty but `content[]` carries
 * the tool_use. Scanning BOTH surfaces means the validator stays
 * correct under such future drift. Today the contribution from
 * `content[]` is always a subset of `tool_calls[]` ids; tomorrow
 * it might not be.
 */
function collectToolUseIdsFromAIMessage(msg: AIMessage): Set<string> {
  const ids = new Set<string>();
  for (const tc of msg.tool_calls ?? []) {
    if (tc.id) ids.add(tc.id);
  }
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block && typeof block === "object" && "type" in block) {
        const b = block as { type: string; id?: string };
        if (b.type === "tool_use" && b.id) ids.add(b.id);
      }
    }
  }
  return ids;
}

/**
 * D143 Layer 3 — dedupe duplicate tool_call ids ACROSS AIMessages.
 * For each tool_call_id appearing in multiple AIMessages' tool_calls,
 * keep ONLY the LATEST AIMessage's reference. Strip the tool_call
 * (and its corresponding `tool_use` content block) from all earlier
 * AIMessages.
 *
 * This is the load-bearing repair for the approval-resume bug class
 * the reviewer flagged: a retry/resume emits a SECOND AIMessage with
 * the same tool_call_id as an earlier turn, producing two `tool_use`
 * blocks with one tool_use_id (which Anthropic rejects). The earlier
 * AIMessage's tool_call is stale once the ToolMessage dedupe keeps
 * only the later ToolMessage — leaving an unfulfilled tool_call in
 * the earlier AIMessage that the existing orphan/unfulfilled logic
 * doesn't catch because the `toolCallInfo.set()` loop overwrites
 * with the later AIMessage's index, hiding the earlier AIMessage's
 * stale reference.
 *
 * Scans BOTH `tool_calls[]` AND `content[]` tool_use blocks as
 * tool_use sources (see `collectToolUseIdsFromAIMessage` rationale).
 *
 * Latest-wins. AIMessages that end up with no remaining tool_calls
 * AND no content are dropped entirely via `removeToolCallsFromAIMessage`.
 * Preserves order of all surviving messages.
 */
export function dedupeToolCallIdsAcrossAIMessages(
  messages: BaseMessage[],
): { messages: BaseMessage[]; repairs: string[] } {
  const repairs: string[] = [];
  // First pass: find the LATEST msg-idx that claims each tool_use id
  // as a source. Scan BOTH tool_calls[] AND content[] tool_use
  // blocks — they should be in parity per Anthropic adapter
  // guarantees, but the scan covers both as defense-in-depth.
  const latestMsgIdxByCallId = new Map<string, number>();
  messages.forEach((msg, i) => {
    if (!AIMessage.isInstance(msg)) return;
    for (const id of collectToolUseIdsFromAIMessage(msg)) {
      latestMsgIdxByCallId.set(id, i);
    }
  });
  // Second pass: for each AIMessage, identify tool_calls whose id has
  // a LATER AIMessage somewhere → strip those.
  const result: BaseMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (!AIMessage.isInstance(msg)) {
      result.push(msg);
      continue;
    }
    // Identify ALL tool_use ids this AIMessage claims (both
    // surfaces) whose latest owner is a later AIMessage. Strip
    // them. `removeToolCallsFromAIMessage` handles both surfaces
    // (tool_calls[] entries AND content[] tool_use blocks via
    // filterContentToolUse), so stripping is consistent.
    const myIds = collectToolUseIdsFromAIMessage(msg);
    const idsToStrip = new Set<string>();
    for (const id of myIds) {
      if ((latestMsgIdxByCallId.get(id) ?? -1) > i) {
        idsToStrip.add(id);
      }
    }
    if (idsToStrip.size === 0) {
      result.push(msg);
      continue;
    }
    for (const id of idsToStrip) {
      repairs.push(
        `Stripped stale tool_call id=${id} from AIMessage at idx ${i} (later AIMessage at idx ${latestMsgIdxByCallId.get(id)} owns this tool_call_id)`,
      );
    }
    const modified = removeToolCallsFromAIMessage(msg, idsToStrip);
    if (modified) result.push(modified);
    // else: the AIMessage had nothing left after the strip → drop entirely
  }
  return { messages: result, repairs };
}

/**
 * D143 Layer 3 — full assistant-tool-result invariant validation.
 * Composes the dedupe-and-repair steps in dependency order:
 *
 *   1. Dedupe ToolMessages by tool_call_id (keep LATEST).
 *   2. Dedupe tool_call ids WITHIN each AIMessage (rare; covers
 *      retry/replay shapes where one assistant turn emits duplicate
 *      ids in its own tool_calls[] or content[] arrays).
 *   3. Dedupe tool_call ids ACROSS AIMessages (the load-bearing
 *      repair for the approval-resume bug class — strip stale
 *      tool_calls from earlier AIMessages when a later AIMessage
 *      owns the same id).
 *   4. Final orphan/unfulfilled sweep: any ToolMessage whose
 *      tool_call_id has no surviving AIMessage source becomes
 *      orphan and is dropped; any AIMessage tool_call whose id has
 *      no surviving ToolMessage becomes unfulfilled and is stripped
 *      (with `removeToolCallsFromAIMessage` dropping the AIMessage
 *      if nothing remains).
 *
 * After this function returns, the messages array satisfies the
 * full Anthropic / OpenAI invariant:
 *   - Every `tool_use` block in any AIMessage has exactly one
 *     matching `tool_result` ToolMessage somewhere AFTER it.
 *   - No two `tool_use` blocks share an id anywhere in the
 *     conversation.
 *   - No orphan `tool_result` blocks.
 *   - Message order is preserved for all survivors.
 */
export function validateMessageHistory(messages: BaseMessage[]): ValidationResult {
  const repairs: string[] = [];

  // Step 1: dedupe ToolMessages (latest wins).
  const step1 = dedupeToolMessagesByCallId(messages);
  let current = step1.messages;
  repairs.push(...step1.repairs);

  // Step 2: dedupe tool_call ids within each AIMessage.
  const step2 = dedupeToolCallIdsWithinAIMessages(current);
  current = step2.messages;
  repairs.push(...step2.repairs);

  // Step 3: dedupe tool_call ids across AIMessages (latest wins).
  const step3 = dedupeToolCallIdsAcrossAIMessages(current);
  current = step3.messages;
  repairs.push(...step3.repairs);

  if (current.length === 0) return { messages: [], repairs };

  // Step 4: orphan + unfulfilled sweep. After steps 1-3 each
  // unique tool_call_id has exactly ONE AIMessage owner and AT MOST
  // ONE ToolMessage. This sweep catches the residual mismatches —
  // tool_call without ToolMessage (unfulfilled, strip) and
  // ToolMessage without tool_call (orphan, drop).
  const toolCallInfo = new Map<string, { aiMsgIndex: number; fulfilled: boolean }>();
  const orphanedToolIndices = new Set<number>();

  for (let i = 0; i < current.length; i++) {
    const msg = current[i]!;
    if (AIMessage.isInstance(msg)) {
      // Register tool_use ids from BOTH surfaces (defense in depth
      // against future provider adapters that don't maintain parity;
      // see `collectToolUseIdsFromAIMessage`). If only content[] has
      // the id (no parallel tool_calls[] entry), the matching
      // ToolMessage still pairs correctly via this lookup.
      for (const id of collectToolUseIdsFromAIMessage(msg)) {
        toolCallInfo.set(id, { aiMsgIndex: i, fulfilled: false });
      }
    } else if (msg instanceof ToolMessage) {
      const id = msg.tool_call_id;
      if (id && toolCallInfo.has(id)) toolCallInfo.get(id)!.fulfilled = true;
      else { orphanedToolIndices.add(i); repairs.push(`Removed orphaned ToolMessage at index ${i}`); }
    }
  }

  const unfulfilledByAi = new Map<number, Set<string>>();
  for (const [tcId, info] of toolCallInfo) {
    if (!info.fulfilled) {
      if (!unfulfilledByAi.has(info.aiMsgIndex)) unfulfilledByAi.set(info.aiMsgIndex, new Set());
      unfulfilledByAi.get(info.aiMsgIndex)!.add(tcId);
    }
  }

  const result: BaseMessage[] = [];
  for (let i = 0; i < current.length; i++) {
    if (orphanedToolIndices.has(i)) continue;
    const msg = current[i]!;
    // Repair AIMessages with unfulfilled tool_use ids — and check
    // BOTH surfaces (tool_calls[] AND content[] tool_use blocks) so
    // a content-only AIMessage with unfulfilled tool_use isn't
    // silently passed through. `removeToolCallsFromAIMessage` strips
    // from both surfaces via `filterContentToolUse`, so the repair
    // is consistent regardless of which surface carried the id.
    if (AIMessage.isInstance(msg) && collectToolUseIdsFromAIMessage(msg).size > 0) {
      const unfulfilled = unfulfilledByAi.get(i);
      if (!unfulfilled || unfulfilled.size === 0) { result.push(msg); continue; }
      repairs.push(`Repaired AIMessage at index ${i}: removed ${unfulfilled.size} unfulfilled tool_calls`);
      const modified = removeToolCallsFromAIMessage(msg, unfulfilled);
      if (modified) result.push(modified);
    } else {
      result.push(msg);
    }
  }
  return { messages: result, repairs };
}

/**
 * D143 Layer 3 — alias for `validateMessageHistory` used at the
 * pre_model boundary right before send-to-LLM. Self-documenting
 * name so the call site reads:
 *
 *   const preparedMessages = finalSafetyNetPass(modalitySafe.messages);
 *
 * Pure re-export; same function. The alias exists to make the
 * intent of the wiring obvious in the agent code (vs. "another
 * call to validateMessageHistory — why?").
 */
export function finalSafetyNetPass(messages: BaseMessage[]): BaseMessage[] {
  return validateMessageHistory(messages).messages;
}

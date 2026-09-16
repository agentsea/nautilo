import {
  packOpenedPromptBriefMemories,
  type PromptBriefMemory,
  type PromptBriefMemoryStructuralCursor,
  type PromptBriefMemoryStructuralPage,
  type StagedPromptBriefMemories,
} from "@nautilo/agent";
import type { ForegroundMemoryContextItem } from "@nautilo/lattice-bridge";

/**
 * Page through the complete ranked Memory set while retaining only admitted
 * prompt bodies. Each opened page becomes unreachable before the next loads.
 */
export async function stageProtectedPromptMemoryBrief(input: Readonly<{
  signal?: AbortSignal;
  loadPage(cursor?: PromptBriefMemoryStructuralCursor): Promise<PromptBriefMemoryStructuralPage>;
  openPage(
    page: PromptBriefMemoryStructuralPage["memories"],
  ): Promise<readonly ForegroundMemoryContextItem[]>;
}>): Promise<StagedPromptBriefMemories> {
  let cursor: PromptBriefMemoryStructuralCursor | undefined;
  let selected: readonly PromptBriefMemory[] = [];
  const overflowIds: string[] = [];
  do {
    input.signal?.throwIfAborted();
    const page = await input.loadPage(cursor);
    if (page.memories.length === 0) break;
    input.signal?.throwIfAborted();
    const opened = await input.openPage(page.memories);
    input.signal?.throwIfAborted();
    if (opened.length !== page.memories.length) {
      throw new Error("Protected prompt Memory page is incomplete");
    }
    const packed = packOpenedPromptBriefMemories([...selected, ...opened]);
    selected = packed.memories;
    overflowIds.push(...packed.overflowIds);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return Object.freeze({
    memories: selected,
    overflowIds: Object.freeze(overflowIds),
  });
}

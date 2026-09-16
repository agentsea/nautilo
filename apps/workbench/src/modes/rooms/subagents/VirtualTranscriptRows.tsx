import { memo, useCallback, useRef, type ReactElement, type Ref } from "react";
import { TranscriptWindow, type TranscriptWindowHandle } from "../../../components/transcript-window";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { ToolCard } from "../../../components/tool-card/tool-card";
import type { ToolActivityEvent } from "../../../adapters/runtime-contexts";
import { isToolRow, type TranscriptMessageVM } from "./transcript-vm";

/** Reuse the chat's measured window without competing with its scroll owner. */
export function VirtualTranscriptRows({ messages, isRunning = false, handleRef }: {
  readonly messages: readonly TranscriptMessageVM[];
  readonly isRunning?: boolean;
  readonly handleRef?: Ref<TranscriptWindowHandle>;
}): ReactElement {
  const { scrollRef } = useStickToBottomContext();
  const expansion = useRef(new Map<string, boolean>());
  const itemKey = useCallback((index: number) => messages[index]?.key ?? `${messages[index]?.createdAt}:${index}`, [messages]);
  return <TranscriptWindow count={messages.length} getItemKey={itemKey} viewportRef={scrollRef}
    isRunning={isRunning} handleRef={handleRef}
    renderItem={(index, key) => <div className="pb-2">
      <TranscriptRow message={messages[index]} index={index} expanded={expansion.current.get(key)}
        onExpandedChange={(expanded) => { expansion.current.set(key, expanded); }} />
    </div>} />;
}

/** The inline Task and full drawer share the same measured, complete history. */
export function ScrollableTaskTranscript({ messages, isRunning = false }: { readonly messages: readonly TranscriptMessageVM[]; readonly isRunning?: boolean }): ReactElement {
  return <StickToBottom className="h-96 min-h-0" resize="instant" initial="instant">
    <StickToBottom.Content className="p-1" scrollClassName="overflow-y-auto">
      <VirtualTranscriptRows messages={messages} isRunning={isRunning} />
    </StickToBottom.Content>
  </StickToBottom>;
}

export const TranscriptRow = memo(function TranscriptRow({
  message,
  index,
  expanded,
  onExpandedChange,
}: {
  readonly message: TranscriptMessageVM;
  readonly index: number;
  readonly expanded?: boolean;
  readonly onExpandedChange?: (expanded: boolean) => void;
}): ReactElement {
  if (isToolRow(message)) {
    const toolName = message.toolName ?? "tool";
    const args = message.args ?? {};
    // Synthetic complete event so the decoupled ToolCard renders from static
    // props (no live useToolActivity match needed). createdAt drives a stable
    // start time; we don't have a real duration in the fixture.
    const startedAt = Date.parse(message.createdAt);
    const syntheticEvent: ToolActivityEvent = {
      toolCallId: message.toolCallId ?? `transcript-${index}`,
      toolName,
      args,
      status: message.toolStatus === "error" ? "error" : "ok",
      startedAt: Number.isNaN(startedAt) ? Date.now() : startedAt,
      ...(message.resultText !== undefined ? { result: message.resultText } : {}),
    };
    return (
      <ToolCard
        toolName={toolName}
        toolCallId={syntheticEvent.toolCallId}
        args={args}
        result={message.resultText}
        status={{ type: "complete" }}
        activityOverride={syntheticEvent}
        isError={message.toolStatus === "error"}
        stateOverride={message.toolStatus === "error" ? "error" : message.toolStatus === "success" ? "success" : "unknown"}
        defaultExpanded={expanded ?? true}
        savedExpansionChoice={expanded}
        onExpandedChange={onExpandedChange}
      />
    );
  }

  return (
    <div
      className="rounded-lg border border-border bg-background-element px-3 py-2 text-sm"
      data-transcript-role={message.role}
    >
      <div className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-foreground-dim">
        {message.role}
      </div>
      <p className="whitespace-pre-wrap break-words text-foreground">{message.content}</p>
    </div>
  );
});

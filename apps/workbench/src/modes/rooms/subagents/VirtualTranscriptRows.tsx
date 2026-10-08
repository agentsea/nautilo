import { memo, useCallback, useRef, type ReactElement, type Ref } from "react";
import { TranscriptWindow, type TranscriptWindowHandle } from "../../../components/transcript-window";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { ToolCard } from "../../../components/tool-card/tool-card";
import { ToolActivityContext, type ToolActivityEvent } from "../../../adapters/runtime-contexts";
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
    if (message.resultText === undefined) {
      // A recorded call is not an execution receipt. Isolate this saved row
      // from live activity with a coincident call ID and expose no controls.
      return <ToolActivityContext.Provider value={[]}>
        <ToolCard readOnly toolName={toolName}
          toolCallId={message.toolCallId ?? `transcript-${index}`} args={args}
          status={{ type: "pending" }} stateOverride="pending"
          defaultExpanded={expanded ?? true} savedExpansionChoice={expanded}
          onExpandedChange={onExpandedChange} />
      </ToolActivityContext.Provider>;
    }
    // A durable result supplies transport completion; its receipt remains
    // authoritative for the actual process state and outcome.
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
      <div className="mb-1 flex items-baseline gap-1.5 text-[0.65rem] font-semibold uppercase tracking-wide text-foreground-dim">
        <span>{message.role}</span>
      </div>
      <p className="whitespace-pre-wrap break-words text-foreground">{message.content}</p>
    </div>
  );
});

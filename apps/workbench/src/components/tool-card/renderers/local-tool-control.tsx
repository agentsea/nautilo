import { localToolControlDisplaySchema, taskPreparationText } from "@nautilo/types";

type ControlDisplay = ReturnType<typeof localToolControlDisplaySchema.parse>;

/** The caller also requires an authoritative tool-error status. */
export function parseLocalToolControlDisplay(toolName: string, text: string | undefined): ControlDisplay | null {
  if (!text) return null;
  try {
    const parsed = localToolControlDisplaySchema.safeParse(JSON.parse(text));
    return parsed.success && parsed.data.toolName === toolName ? parsed.data : null;
  } catch { return null; }
}

export function LocalToolControlBody({ receipt }: { receipt: ControlDisplay }) {
  const recovery = receipt.runtimeRecovery;
  return <section aria-label="Tool not executed" className="border-t border-border px-3 py-2 space-y-2 text-xs">
    <p className="font-semibold text-tool-error">Not executed</p>
    <p className="text-foreground-muted">The {receipt.toolName} {receipt.requestedOperation} request was rejected before dispatch.</p>
    <pre className="whitespace-pre-wrap break-words text-tool-error">{receipt.error.message}</pre>
    {recovery && <div aria-label="Runtime recovery" className="space-y-1 text-foreground-muted">
      <p>{taskPreparationText({ stage: "using_tools", contextRecovery: { phase: recovery.phase,
        pendingInputs: recovery.pendingInputCount, recoveredInputBytes: recovery.recoveredInputBytes,
        retainedUnconsolidatedPages: recovery.retainedUnconsolidatedPages } })}</p>
      <p>{recovery.recoveredInputBytes} historical input bytes recovered · {recovery.retainedUnconsolidatedPages} recovered pages await consolidation. This rejected request inspected no source.</p>
    </div>}
  </section>;
}

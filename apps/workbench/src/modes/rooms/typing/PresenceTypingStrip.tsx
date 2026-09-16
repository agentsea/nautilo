import { useSyncExternalStore, type ReactElement } from "react";
import type { TypingOther } from "./use-typing-others";
import {
  buildPresenceStrip,
  getAgentStreamingVisibleOutputSnapshot,
  subscribeAgentStreamingVisibleOutput,
  type PresenceChip,
} from "./presence-typing-strip-model";
import { useVoiceControls } from "../../../adapters/runtime-contexts";

/**
 * D278 §8.3 — unified presence/typing strip (model C, D313 refinement).
 *
 * One component that answers "who is responding right now" — bots and humans
 * share one `●●●` vocabulary — in a single compact row above the composer.
 * Replaces the duplicated `AssistantActivityIndicator` copy in
 * conversation.tsx and folds in the standalone `TypingIndicator`.
 * There is no standalone "{name} is thinking" string.
 *
 * D313: the bot chip stays visible for the whole live job except while visible
 * assistant text is actively streaming. Quiet gaps between bubbles show the
 * chip again. Humans persist while typing.
 *
 * Renders nothing (null) when nobody is responding, so it collapses to zero
 * height like the old `TypingIndicator`.
 *
 * Collapse logic lives in `presence-typing-strip-model.ts` (runtime-free,
 * unit-tested). Reads Nautilo's WS-owned running state rather than
 * assistant-ui's run state so the chip survives the post-text / pre-tool gap.
 */
export function PresenceTypingStrip({
  assistantName,
  others = [],
  agentPresent = true,
  agentRunning: agentRunningOverride,
  agentStreamingVisibleOutput: agentStreamingVisibleOutputOverride,
  composerInset,
}: {
  readonly assistantName: string;
  readonly others?: readonly TypingOther[];
  /** Suppress the agent chip in rooms with no agent member. */
  readonly agentPresent?: boolean;
  /** Optional child-room lifecycle state; defaults to the main-room runtime. */
  readonly agentRunning?: boolean;
  /** Optional child-room visible-text state; defaults to the main-room store. */
  readonly agentStreamingVisibleOutput?: boolean;
  /** Match the centered main composer column and its responsive padding. */
  readonly composerInset?: "default" | "compact";
}): ReactElement | null {
  const { isRunning } = useVoiceControls();
  const defaultAgentStreamingVisibleOutput = useSyncExternalStore(
    subscribeAgentStreamingVisibleOutput,
    getAgentStreamingVisibleOutputSnapshot,
    () => false,
  );
  const agentRunning = agentRunningOverride ?? isRunning;
  const agentStreamingVisibleOutput =
    agentStreamingVisibleOutputOverride ?? defaultAgentStreamingVisibleOutput;

  const { visible, overflow } = buildPresenceStrip({
    agentRunning: agentRunning && agentPresent,
    agentStreamingVisibleOutput,
    assistantName,
    others,
  });

  if (visible.length === 0) return null;

  const strip = (
    <div
      className={composerInset
        ? `mx-auto flex w-full max-w-5xl items-center gap-2 py-1 text-xs text-foreground-muted ${composerInset === "compact" ? "px-3" : "px-4"}`
        : "flex items-center gap-2 py-1 pl-[3.25rem] pr-3 text-xs text-foreground-muted"}
      role="status"
      aria-live="polite"
      data-testid="presence-typing-strip"
    >
      {visible.map((chip) => (
        <PresenceChipView key={chip.key} chip={chip} />
      ))}
      {overflow > 0 ? (
        <span data-testid="presence-strip-overflow">+{overflow}</span>
      ) : null}
    </div>
  );

  if (!composerInset) return strip;

  // The main composer has two insets: its panel gutter, then the padding
  // inside the centered max-w-5xl surface. Mirror both so the responding
  // label stays over the input at narrow widths and in a fully expanded room.
  return (
    <div
      className={composerInset === "compact" ? "w-full px-3" : "w-full px-4"}
      data-testid="presence-typing-strip-gutter"
    >
      {strip}
    </div>
  );
}

/**
 * One vocabulary for everyone (model C): `name ●●●`. The chip's `kind` only
 * drives ordering/testing, not appearance.
 */
function PresenceChipView({ chip }: { readonly chip: PresenceChip }): ReactElement {
  return (
    <span
      className="inline-flex items-center gap-1.5"
      data-testid={chip.kind === "agent" ? "presence-chip-agent" : "presence-chip-human"}
    >
      <span>{chip.label}</span>
      <span className="flex items-end gap-0.5" aria-hidden>
        <span className="h-1.5 w-1.5 animate-typing-bounce rounded-full bg-foreground-muted [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-typing-bounce rounded-full bg-foreground-muted [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-typing-bounce rounded-full bg-foreground-muted [animation-delay:300ms]" />
      </span>
    </span>
  );
}

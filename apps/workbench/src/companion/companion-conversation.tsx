import { useEffect, useMemo, useRef } from "react";
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useComposer, useComposerRuntime, useExternalStoreRuntime, useMessage } from "@assistant-ui/react";
import { X } from "lucide-react";
import { CompanionSendButton } from "./companion-send-button";
import type { ThreadMessageLike } from "@assistant-ui/core";
import type { CompanionAttachment, CompanionSnapshot } from "../../../desktop/electron/companion-contract";
import { ConversationTranscriptRows } from "../components/conversation-transcript-rows";
import { MentionAwareLexicalComposerInput } from "../components/composer/MentionAdapter";
import { UserText } from "../components/conversation-message-text";
import { AssistantMarkdownTextPrimitive } from "../components/assistant-markdown-text";
import { ToolCard, type ToolCardProps } from "../components/tool-card/tool-card";
import { stripAssistantArtifacts } from "../lib/strip-assistant-artifacts";
import { hasVisibleAssistantContent } from "../components/conversation-visible-content";
import type { ReactNode } from "react";

function SnapshotTool(props: ToolCardProps) { return <ToolCard {...props} readOnly />; }
function SnapshotAssistantText() {
  return <div className="text-sm prose prose-sm max-w-none dark:prose-invert prose-p:my-1 prose-pre:my-2 prose-ul:my-1 prose-ol:my-1 prose-headings:my-2">
    <AssistantMarkdownTextPrimitive preprocess={stripAssistantArtifacts} smooth={false} />
  </div>;
}
const userComponents = { Text: UserText };
const assistantComponents = { Text: SnapshotAssistantText, tools: { Fallback: SnapshotTool } };

/** Compact message chrome; body rendering and history projection are shared with the Room. */
function SnapshotMessage({ name }: { name: string }) {
  const role = useMessage(s => s.role);
  const visible = useMessage(s => s.role !== "assistant" || hasVisibleAssistantContent(s.content));
  const sending = useMessage(s => typeof s.metadata.custom?.optimisticRequestId === "string");
  const sendFailed = useMessage(s => s.metadata.custom?.sendFailed === true);
  if (!visible) return null;
  return <MessagePrimitive.Root className="min-w-0 py-2" data-companion-message>
    {role !== "system" && <div className="mb-1 text-xs font-semibold text-foreground-muted">{role === "user" ? "You" : name}</div>}
    <MessagePrimitive.Content components={role === "user" ? userComponents : assistantComponents} />
    {role === "user" && (sendFailed || sending) && <p role="status" className="mt-1 text-xs text-foreground-muted">{sendFailed ? "Send not confirmed" : "Sending…"}</p>}
  </MessagePrimitive.Root>;
}

const identityMessage = (message: ThreadMessageLike) => message;

export function CompanionConversationProvider({ snapshot, children }: { snapshot: CompanionSnapshot; children: ReactNode }) {
  // Presentation only. The authenticated parent owns history, sending and all network access.
  const runtime = useExternalStoreRuntime({ messages: snapshot.messages, convertMessage: identityMessage, isRunning: snapshot.busy || snapshot.workRunning,
    onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

export function CompanionTranscript({ snapshot }: { snapshot: CompanionSnapshot }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const components = useMemo(() => ({ Message: () => <SnapshotMessage name={snapshot.binding.name} /> }), [snapshot.binding.name]);
  return <ThreadPrimitive.Root className="companion-transcript-root">
    <ThreadPrimitive.Viewport ref={viewportRef} className="companion-transcript-viewport" autoScroll scrollToBottomOnInitialize scrollToBottomOnRunStart={false}>
      {snapshot.hasEarlier && <p className="companion-note">Recent messages · open the Room for earlier history.</p>}
      <ConversationTranscriptRows components={components} roomId={snapshot.binding.roomId} viewportRef={viewportRef} />
      {!snapshot.messages.length && !snapshot.error && <p className="companion-note">Send a message to begin.</p>}
    </ThreadPrimitive.Viewport>
  </ThreadPrimitive.Root>;
}

export function CompanionComposer({ draft, name, busy, onDraft, onSubmit, controls, attachments = [], onRemoveAttachment, error, sending = false, voiceStop, capture = "idle" }: {
  voiceStop?: ReactNode; capture?: CompanionSnapshot["capture"];
  sending?: boolean; controls?: ReactNode; attachments?: CompanionAttachment[]; onRemoveAttachment?: (id: string) => void; error?: string | null;
  draft: string; name: string; busy: boolean; onDraft: (text: string) => void; onSubmit: (text: string) => void;
}) {
  const composer = useComposerRuntime();
  const text = useComposer(s => s.text);
  const callback = useRef(onDraft);
  callback.current = onDraft;
  useEffect(() => { if (composer.getState().text !== draft) composer.setText(draft); }, [composer, draft]);
  useEffect(() => composer.subscribe(() => callback.current(composer.getState().text)), [composer]);
  function send() { if ((text.trim() || attachments.length) && !busy) onSubmit(text); }
  return <ComposerPrimitive.Root className="companion-room-composer" onSubmit={event => { event.preventDefault(); send(); }}>
    {attachments.length > 0 && <div className="companion-attachments">{attachments.map(a => <div key={a.id} className="companion-attachment" title={a.error ?? a.name}>
      <span>{a.name}<small>{a.status === "pending" ? "Uploading…" : a.status === "error" ? a.error : "Ready"}</small></span>
      <button type="button" disabled={sending} onClick={() => onRemoveAttachment?.(a.id)} aria-label={`Remove ${a.name}`}><X size={13} /></button>
    </div>)}</div>}
    {error && <p className="companion-control-error" role="alert">{error}</p>}
    <div className="companion-voice-stop">{voiceStop}</div>
    <MentionAwareLexicalComposerInput autoFocus aria-label={`Message ${name}`} placeholder={capture === "listening" ? "Listening…" : `Message ${name}…`}
      className="companion-lexical-input" submitMode="none" cancelOnEscape
      onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
    <div className="companion-composer-controls">{controls}
      <CompanionSendButton capture={capture} sending={sending} disabled={busy}
        hasContent={Boolean(text.trim() || attachments.length)} onSend={send} />
    </div>
  </ComposerPrimitive.Root>;
}

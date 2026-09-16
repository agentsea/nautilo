// D424 Phase 4.1 — shared room-chat surface barrel.
//
// Public pane API for embedding room chat (transcript + composer) into any
// surface. The full-screen chat route consumes this today; the docked
// artifact-viewer pane (Phase 4.2) will consume the same controller + pane +
// composer with docked capabilities.
//
// - `useRoomChatController` — room-independent controller (state, streaming,
//   send, reactions, typing, paging, approvals, voice, attachments, model).
// - `RoomChatPane` — transcript column (loading/error/empty/paged list).
// - `RoomChatComposer` — composer strip (auto-approve, approvals, typing,
//   routing receipt, reply preview, composer primitive).
// - `FULL_CHAT_CAPABILITIES` / `RoomChatComposerCapabilities` — explicit
//   opt-out surface for docked-v1 omissions (voice input + attachments).
export { RoomChatPane } from "@/components/room-chat-pane";
export {
  RoomChatComposer,
} from "./room-chat-composer";
export {
  useRoomChatController,
  FULL_CHAT_CAPABILITIES,
  type RoomChatController,
  type RoomChatComposerCapabilities,
  type RoomChatControllerOptions,
  type PendingAttachment,
  type ReplyTarget,
  type MessageItem,
} from "@/hooks/use-room-chat-controller";

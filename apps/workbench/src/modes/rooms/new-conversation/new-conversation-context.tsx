/**
 * D182 / Phase 11.6.E.2 — NewConversationDialog mount lifted to a
 * shell-level provider so multiple triggers (explorer "+", RoomsPanel
 * "+ New conversation…", future entry points) can open the same
 * dialog instance. Caller is just `useNewConversation().open()`.
 *
 * D187 P2: the provider no longer prefetches the whole human directory.
 * The dialog's picker is now server-search-driven (`GET /api/directory/
 * search`, humans + agents in one call), so the directory is never fully
 * loaded — the provider only owns open/close state.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useRoomNavigation } from "../../../contexts/room-navigation-context";
import { NewConversationDialog } from "./NewConversationDialog";

interface NewConversationApi {
  /** Open the dialog. The dialog searches the directory on demand. */
  open: () => void;
  /** Close any open dialog. No-op if already closed. */
  close: () => void;
  /** True when the dialog is currently mounted. */
  isOpen: boolean;
}

const Ctx = createContext<NewConversationApi | null>(null);

export function NewConversationProvider({ children }: { children: ReactNode }): ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const roomNav = useRoomNavigation();

  const handleOpen = useCallback(() => {
    setIsOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  const handleCreated = useCallback(
    async (roomId: string) => {
      // CRITICAL: refresh the rooms list FIRST, then switch active.
      // setActiveRoom navigates the URL, but the "active room" UX
      // gates on activeResolution.kind which depends on roomId being
      // in roomNav.rooms. Without awaiting the refresh, the new room
      // briefly renders as "This chat room is not available" until
      // the next refresh tick lands the new row. Yes, this delays
      // the navigate by one round-trip; it's worth it for the
      // user-visible smoothness.
      await roomNav.refreshRooms();
      roomNav.setActiveRoom(roomId);
    },
    [roomNav],
  );

  const api: NewConversationApi = useMemo(
    () => ({ open: handleOpen, close: handleClose, isOpen }),
    [handleOpen, handleClose, isOpen],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      {isOpen ? (
        <NewConversationDialog
          onClose={handleClose}
          onCreated={(roomId) => {
            void handleCreated(roomId);
          }}
        />
      ) : null}
    </Ctx.Provider>
  );
}

export function useNewConversation(): NewConversationApi {
  const api = useContext(Ctx);
  if (!api) {
    throw new Error("useNewConversation must be used within NewConversationProvider");
  }
  return api;
}

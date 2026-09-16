import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import type { DrawerKind, DrawerState } from "./drawer-state.types";

/**
 * Events temporarily covers the trailing drawer without replacing its state.
 * Room-bound drawers are safe to reveal again only while their owning Room is
 * still the active one; the other detail drawers remain valid across Room
 * navigation.
 */
export function canRestoreDrawerInRoom(
  drawer: DrawerKind,
  activeRoomId: string | null,
): boolean {
  if (drawer.kind === "thread") return drawer.parentRoomId === activeRoomId;
  if (drawer.kind === "room") return drawer.roomId === activeRoomId;
  return true;
}

const DrawerStateContext = createContext<DrawerState | null>(null);

type DrawerAction =
  | { type: "OPEN"; payload: Exclude<DrawerKind, { kind: "closed" }> }
  | { type: "CLOSE" }
  | { type: "SWAP"; payload: Exclude<DrawerKind, { kind: "closed" }> };

function drawerReducer(state: DrawerKind, action: DrawerAction): DrawerKind {
  switch (action.type) {
    case "OPEN":
      return action.payload;
    case "CLOSE":
      return { kind: "closed" };
    case "SWAP":
      return action.payload;
    default:
      return state;
  }
}

export function DrawerProvider({ children }: { children: ReactNode }) {
  const [current, dispatch] = useReducer(drawerReducer, { kind: "closed" });

  const open = useCallback((kind: Exclude<DrawerKind, { kind: "closed" }>) => {
    dispatch({ type: "OPEN", payload: kind });
  }, []);

  const close = useCallback(() => {
    dispatch({ type: "CLOSE" });
  }, []);

  const swapTo = useCallback((kind: Exclude<DrawerKind, { kind: "closed" }>) => {
    dispatch({ type: "SWAP", payload: kind });
  }, []);

  const value = useMemo<DrawerState>(
    () => ({ current, open, close, swapTo }),
    [current, open, close, swapTo],
  );

  return <DrawerStateContext.Provider value={value}>{children}</DrawerStateContext.Provider>;
}

export function useDrawer(): DrawerState {
  const ctx = useContext(DrawerStateContext);
  if (!ctx) {
    throw new Error("useDrawer must be used within <DrawerProvider>");
  }
  return ctx;
}

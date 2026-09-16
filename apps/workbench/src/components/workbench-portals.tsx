import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const WorkbenchPortalContext = createContext<HTMLElement | undefined>(undefined);

/** Keep product overlays inside the same DOM admission boundary as the workspace.
 * Recovery/sign-in UI outside this provider retains its ordinary portal target.
 * Mount children only after the host exists: no first-paint escape to body. */
export function WorkbenchPortalProvider({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return <>
    <div ref={setContainer} data-workbench-portals="" style={{ display: "contents" }} />
    {container === null ? null : (
      <WorkbenchPortalContext.Provider value={container}>
        {children}
      </WorkbenchPortalContext.Provider>
    )}
  </>;
}

/** Also used by editor libraries that accept an explicit overlay container. */
export function useWorkbenchPortalContainer(): HTMLElement | undefined {
  return useContext(WorkbenchPortalContext);
}

function WorkbenchPortal({ children, container }: {
  children: ReactNode;
  container: Element | DocumentFragment;
}) {
  const productContainer = useWorkbenchPortalContainer();
  const target = productContainer !== undefined
    && typeof document !== "undefined" && container === document.body
    ? productContainer : container;
  return createPortal(children, target);
}

/** Preserve explicitly local targets, but route body overlays through their
 * owning workspace. Context crosses portals; DOM hidden/inert does not. */
export function createWorkbenchPortal(
  children: ReactNode,
  container: Element | DocumentFragment,
  key?: string | null,
) {
  return <WorkbenchPortal key={key} container={container}>{children}</WorkbenchPortal>;
}

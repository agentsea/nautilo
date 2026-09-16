import "../bun-dom-preload";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, mock, test } from "bun:test";
import { ConnectionRecoveryPortalContext } from "../../src/components/footer/connection-recovery-portal";
import { Toast, ToastProvider, useToast, type ToastContextValue } from "../../src/components/toast";
import { WorkbenchPortalProvider } from "../../src/components/workbench-portals";

afterEach(cleanup);

test("only the connection recovery toast escapes a paused workspace and stays hidden on denial", () => {
  const recoveryHost = document.createElement("div");
  document.body.append(recoveryHost);
  let api: ToastContextValue;
  function Harness() {
    api = useToast();
    return <Toast />;
  }
  const view = render(
    <ConnectionRecoveryPortalContext.Provider value={recoveryHost}>
      <div inert>
        <WorkbenchPortalProvider>
          <ToastProvider><Harness /></ToastProvider>
        </WorkbenchPortalProvider>
      </div>
    </ConnectionRecoveryPortalContext.Provider>,
  );
  const reload = mock(() => undefined);
  act(() => api.show({
    recovery: "connection", variant: "warning", message: "Connection issues",
    duration: 0, action: { label: "Reload", onClick: reload },
  }));
  const button = recoveryHost.querySelectorAll("button")[1];
  expect(button.textContent).toBe("Reload");
  expect(button.closest("[inert]")).toBeNull();
  fireEvent.click(button);
  expect(reload).toHaveBeenCalledTimes(1);
  recoveryHost.hidden = true;
  expect(button.closest("[hidden]")).toBe(recoveryHost);

  act(() => api.show({ variant: "info", message: "Product notification", duration: 0 }));
  expect(recoveryHost.textContent).toBe("");
  expect(view.getByText("Product notification").closest("[inert]")).not.toBeNull();
  view.unmount();
  recoveryHost.remove();
});

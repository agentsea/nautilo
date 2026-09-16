import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { createWorkbenchPortal, WorkbenchPortalProvider } from "../../src/components/workbench-portals";

beforeEach(reapplyHappyDomGlobals);
afterEach(cleanup);

test("recovery portals outside the protected provider retain their body target", () => {
  const view = render(createWorkbenchPortal(<button>Recover device</button>, document.body));
  expect(view.getByRole("button").parentElement).toBe(document.body);
  view.unmount();
  expect(document.body.textContent).not.toContain("Recover device");
});

test("owned portals preserve explicit local containers and clean up on unmount", () => {
  const local = document.createElement("div");
  document.body.append(local);
  const view = render(<WorkbenchPortalProvider>
    {createWorkbenchPortal(<button>Product popup</button>, document.body)}
    {createWorkbenchPortal(<button>Local popup</button>, local)}
  </WorkbenchPortalProvider>);
  expect(view.getByRole("button", { name: "Product popup" }).closest("[data-workbench-portals]")).not.toBeNull();
  expect(view.getByRole("button", { name: "Local popup" }).parentElement).toBe(local);
  view.unmount();
  expect(document.querySelector("[data-workbench-portals]")).toBeNull();
  expect(local.childElementCount).toBe(0);
  local.remove();
});

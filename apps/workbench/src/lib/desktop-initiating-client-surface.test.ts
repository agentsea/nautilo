import { expect, test } from "bun:test";
import { initiatingClientSurfaceForWorkbench } from "./desktop";

test("Workbench declares desktop only when its preload bridge is present", () => {
  expect(initiatingClientSurfaceForWorkbench({ isDesktop: false, desktopAPI: null }))
    .toBe("workbench.browser");
  expect(initiatingClientSurfaceForWorkbench({ isDesktop: true, desktopAPI: null }))
    .toBe("workbench.browser");
  expect(initiatingClientSurfaceForWorkbench({ isDesktop: true, desktopAPI: {} as never }))
    .toBe("workbench.desktop");
});

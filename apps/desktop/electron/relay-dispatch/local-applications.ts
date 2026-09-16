import {
  createOpenHueHandler,
  type OpenHueExecutor,
} from "@nautilo/relay";

import {
  FIXED_DESKTOP_DISPATCH_NOT_HANDLED,
  type FixedDesktopDispatchHandler,
} from "./router.ts";

/** Fixed Hue lane over the existing OpenHue executor and binary owner. */
export function createHueDispatchHandler(ports: {
  readonly executor: OpenHueExecutor;
  readonly resolveBinary: () => string;
}): FixedDesktopDispatchHandler {
  return async ({ request }) => {
    if (request.toolName !== "hue_lights") {
      return FIXED_DESKTOP_DISPATCH_NOT_HANDLED;
    }
    const handleOpenHue = createOpenHueHandler({
      executor: ports.executor,
      binaryPath: ports.resolveBinary(),
    });
    return {
      handled: true,
      result: await handleOpenHue(request.args),
    };
  };
}

import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionSegment } from "../../src/components/footer/connection-segment";
import { RuntimeShellStateContext, WsStateContext } from "../../src/adapters/runtime-contexts";
import { applyMaintenanceStatus, resetMaintenanceNoticeForTest } from "../../src/components/maintenance-notice-state";

const lastOpenAt = Date.now() - 60_000;
function markup(idle = false, state: "open" | "closed" = "closed") {
  return renderToStaticMarkup(
    <WsStateContext.Provider value={{ state, lastOpenAt }}>
      <RuntimeShellStateContext.Provider value={idle
        ? { kind: "authenticated_idle" }
        : { kind: "authenticated_disconnected", lastOpenAt }}>
        <ConnectionSegment />
      </RuntimeShellStateContext.Provider>
    </WsStateContext.Provider>,
  );
}

afterEach(resetMaintenanceNoticeForTest);

test("a real sustained disconnect shows one quiet footer recovery action", () => {
  const html = markup();
  expect(html).toContain("Connection lost");
  expect(html).toContain("Retry");
  expect(html).not.toContain("Reconnecting securely");
});

test("connected and deliberately idle sessions have no recovery action", () => {
  expect(markup(false, "open")).toContain("Connected");
  expect(markup(false, "open")).not.toContain("Retry");
  expect(markup(true)).not.toContain("Connection lost");
  expect(markup(true)).not.toContain("Retry");
});

test.each(["draining", "applying"] as const)("%s maintenance owns recovery", (state) => {
  applyMaintenanceStatus({ state });
  expect(markup()).not.toContain("Retry");
});

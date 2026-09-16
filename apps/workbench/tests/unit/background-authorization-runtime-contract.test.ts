import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const runtime = readFileSync(
  join(import.meta.dir, "../../src/adapters/nautilo-runtime.tsx"),
  "utf8",
);

describe("M317 background authorization runtime lifecycle", () => {
  test("treats realtime as a payload-free wake for full durable discovery", () => {
    const eventBranch = runtime.slice(
      runtime.indexOf('event.type === "crypto.background_authorization_requested"'),
      runtime.indexOf("const receivingAdmissionGeneration"),
    );
    expect(eventBranch).toContain("backgroundAuthorizationWakeRef.current()");
    expect(eventBranch.match(/event\./gu)).toHaveLength(1);
    expect(runtime).toContain("createCoalescedBackgroundAuthorizationSweepV2({");
    expect(runtime).toContain("client.service({signal: abort.signal})");
  });

  test("pulls without realtime and tears down on lifecycle transitions", () => {
    const start = runtime.indexOf(
      "// Durable background authorization is discovered",
    );
    const end = runtime.indexOf("\n  useEffect(() => {", start + 500);
    const lifecycle = runtime.slice(start, end);
    const guard = lifecycle.slice(
      lifecycle.indexOf("useEffect(() => {"),
      lifecycle.indexOf("const abort"),
    );
    const dependencies = lifecycle.slice(lifecycle.lastIndexOf("}, ["));
    expect(guard).not.toContain("wsState");
    expect(dependencies).toContain("wsState");
    expect(lifecycle).toContain("admissionResumeGeneration");
    expect(lifecycle).toContain('window.addEventListener("online", service)');
    expect(lifecycle).toContain('document.addEventListener("visibilitychange", onVisibility)');
    expect(lifecycle).toContain("service();");
    expect(lifecycle).toContain("abort.abort()");
    expect(lifecycle).toContain("idle?.()");
    expect(lifecycle).not.toContain("setTimeout");
    expect(lifecycle).not.toContain("setInterval");
  });

  test("uses Desktop main custody and Browser foreground custody", () => {
    expect(runtime).toContain(
      "desktopForegroundShadow.serviceBackgroundAuthorization!()",
    );
    expect(runtime).toContain("createBrowserBackgroundAuthorizationClientV2({");
    expect(runtime).toContain("readOrCreateBrowserCryptoInstallationId({");
  });

  test("wakes background authorization after Domain delivery and the viewer fence", () => {
    const start = runtime.indexOf(
      'event.type === "crypto.domain_key_catch_up_delivered"',
    );
    const end = runtime.indexOf(
      'event.type === "message.shadow_stream_start"',
      start,
    );
    const delivery = runtime.slice(start, end);
    const receive = delivery.indexOf(
      "await liveShadowMessageClient.receiveDomainKeyDelivery(",
    );
    const currentViewerFence = delivery.indexOf(
      "if (!sameReceivingViewer()) return;",
      receive,
    );
    const authorizationWake = delivery.indexOf(
      "backgroundAuthorizationWakeRef.current()",
      currentViewerFence,
    );

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(receive).toBeGreaterThanOrEqual(0);
    expect(currentViewerFence).toBeGreaterThan(receive);
    expect(authorizationWake).toBeGreaterThan(currentViewerFence);
  });
});

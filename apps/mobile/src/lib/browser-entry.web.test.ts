import { expect, test } from "bun:test";

import { currentServingOrigin, fullWorkbenchUrl, independentMobileWebUrl } from "./browser-entry.web";

test("Mobile Web derives only an exact secure or loopback serving origin", () => {
  expect(currentServingOrigin({ origin: "https://nautilo.example" } as Location)).toBe("https://nautilo.example");
  expect(currentServingOrigin({ origin: "HTTPS://NAUTILO.EXAMPLE:443" } as Location)).toBe("https://nautilo.example");
  expect(currentServingOrigin({ origin: "http://127.0.0.1:3001" } as Location)).toBe("http://127.0.0.1:3001");
  expect(currentServingOrigin({ origin: "http://nautilo.example" } as Location)).toBeNull();
  expect(currentServingOrigin({ origin: "https://user:pass@nautilo.example" } as Location)).toBeNull();
  expect(currentServingOrigin({ origin: "https://nautilo.example/mobile?returnTo=secret" } as Location)).toBeNull();
  expect(fullWorkbenchUrl("https://nautilo.example/mobile")).toBe("https://nautilo.example/?nautilo-interface=workbench");
  expect(independentMobileWebUrl("https://other.example/path?code=secret")).toBe("https://other.example/mobile");
  expect(independentMobileWebUrl("http://other.example")).toBeNull();
  expect(independentMobileWebUrl("https://user:pass@other.example")).toBeNull();
  expect(independentMobileWebUrl("nautilo://other.example/mobile")).toBeNull();
});

test("Mobile Web entry uses current-origin admission without QR, polling, or a timer", async () => {
  const source = await Bun.file(new URL("../app/(onboarding)/add-server.web.tsx", import.meta.url)).text();
  expect(source).not.toMatch(/scan-qr|setInterval|setTimeout/);
  expect(source).toContain("addServer(origin)");
  expect(source).toContain("Open Full Workbench");
  expect(source).toContain("independent Mobile Web sign-in");
});

test("Mobile Web drawer exposes no multi-server or native controller affordance", async () => {
  const source = await Bun.file(new URL("../components/drawer-content.web.tsx", import.meta.url)).text();
  expect(source).not.toMatch(/Add server|handlePickServer|switchTo|Computers/);
  expect(source).toContain("Open Full Workbench");
  expect(source).toContain("Open another server");
  expect(source).toContain("Scheduled work");
});

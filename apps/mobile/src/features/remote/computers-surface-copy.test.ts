import { describe, expect, test } from "bun:test";

const drawerSource = await Bun.file(
  new URL("../../components/drawer-content.tsx", import.meta.url),
).text();
const drawerLayoutSource = await Bun.file(
  new URL("../../app/(drawer)/_layout.tsx", import.meta.url),
).text();
const computersSource = await Bun.file(
  new URL("../../app/(drawer)/computers/index.tsx", import.meta.url),
).text();
const manualSource = await Bun.file(
  new URL("../../app/(drawer)/computers/manual.tsx", import.meta.url),
).text();
const scannerSource = await Bun.file(
  new URL("../../app/(onboarding)/scan-computer-qr.tsx", import.meta.url),
).text();
const pairingSources = [computersSource, manualSource, scannerSource].join("\n");

describe("paired computers mobile surface", () => {
  test("uses the approved Computers entry and pairing language", () => {
    expect(drawerSource).toContain('label="Computers"');
    expect(drawerLayoutSource).toContain('<Drawer.Screen name="computers" />');
    expect(drawerLayoutSource).not.toContain('<Drawer.Screen name="remote" />');
    expect(computersSource).toContain('title="Computers"');
    expect(computersSource).toContain("Pair a computer");
    expect(computersSource).toContain("Settings → Mobile access");
    expect(pairingSources).not.toContain("Remote control");
  });

  test("the drawer-only Computers screen has a direct route back to Chats", () => {
    expect(drawerSource).toContain('label="Chats"');
    expect(drawerSource).toContain('goTab("/")');
    expect(drawerSource.indexOf('label="Chats"')).toBeLessThan(
      drawerSource.indexOf('label="Computers"'),
    );
  });

  test("keeps the approved QR and manual pairing routes", () => {
    expect(pairingSources).toContain('"/(drawer)/computers"');
    expect(pairingSources).toContain('"/(drawer)/computers/manual"');
    expect(pairingSources).toContain('"/(onboarding)/scan-computer-qr"');
  });

  test("does not move pairing into mobile Settings", () => {
    expect(pairingSources).not.toContain('router.push("/settings")');
    expect(pairingSources).not.toContain('router.replace("/settings")');
    expect(pairingSources).not.toContain('"/(tabs)/settings"');
  });

  test("names phone identity separately from computer relationships", () => {
    expect(computersSource).toContain("This phone");
    expect(computersSource).toContain("Paired with this phone");
    expect(computersSource).toContain("Rename this phone");
    expect(computersSource).not.toContain("Rename host");
    expect(computersSource).not.toContain("beginRename(host)");
  });
});

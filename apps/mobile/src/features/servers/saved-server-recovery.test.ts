import { describe, expect, test } from "bun:test";

const drawerSource = await Bun.file(
  new URL("../../components/drawer-content.tsx", import.meta.url),
).text();
const addServerSource = await Bun.file(
  new URL("../../app/(onboarding)/add-server.tsx", import.meta.url),
).text();
const signInSource = await Bun.file(
  new URL("../../app/(onboarding)/sign-in.tsx", import.meta.url),
).text();

describe("saved server recovery", () => {
  test("lets a Human remove any dead saved server without reaching it", () => {
    expect(drawerSource).toContain("Remove saved server ${s.displayName}");
    expect(drawerSource).toContain("void remove(id)");
    expect(addServerSource).toContain("Saved servers");
    expect(addServerSource).toContain("Remove saved server ${server.displayName}");
    expect(addServerSource).toContain("void remove(id)");
    expect(addServerSource).toContain("The server and its data are not deleted.");
  });

  test("returns a failed sign-in to the saved-server chooser rather than restarting setup", () => {
    expect(signInSource).toContain('error ? "Back to saved servers" : "Use a different server"');
    expect(signInSource).toContain('router.replace("/(onboarding)/add-server")');
    expect(addServerSource).toContain("servers.map((server)");
    expect(addServerSource).toContain("await switchTo(id)");
    expect(addServerSource).toContain('router.replace("/(onboarding)/sign-in")');
    expect(signInSource).toContain("This saved address is incomplete. Remove it and add the server again.");
  });
});

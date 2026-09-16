import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const desktopRoot = join(import.meta.dir, "../..");
const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf8");
const reveal = readFileSync(
  join(desktopRoot, "../../packages/genie-customization-ui/src/screens/RevealScreen.tsx"),
  "utf8",
);

describe("D487 desktop onboarding photo authority", () => {
  it("creates and selects through the canonical typed library client", () => {
    expect(main).toContain("generateAgentPhotoLibraryEntries(");
    expect(main).toContain("getAgentPhotoLibraryCurrent()");
    expect(main).toContain("selectAgentPhotoLibraryEntry(");
    expect(main).not.toContain('fetch(`${serverUrl}/api/profile/generate-avatar');
    expect(main).not.toContain("/api/profile/avatar-gen-status");
    expect(main).toContain('fetch(`${serverUrl}/api/config/setup-flags`)');
    expect(reveal).toContain("avatarTarget: state.avatarTarget");
    expect(reveal).not.toContain("avatar: state.avatarRef");
  });

  it("fetches protected preview bytes with the authenticated client", () => {
    expect(main).toContain('client.getAgentPhotoLibraryMedia(entry.id, "full")');
    expect(main).toContain("media.blob.arrayBuffer()");
    expect(main).toContain("data:${media.contentType};base64");
    expect(main).not.toContain("avatarUrl: new URL(entry.media.fullUrl");
  });

  it("strips all photo authority from the generic profile write", () => {
    expect(main).toContain('delete body["avatarTarget"]');
    expect(main).toContain('delete body["avatar"]');
    expect(main).not.toMatch(/body\["avatar"\]\s*=/);
  });

  it("reports a completed profile save and unverified photo selection without claiming success", () => {
    expect(main).toContain("const PROFILE_SAVED_AVATAR_UNVERIFIED_ERROR");
    expect(main).toContain("Your profile was saved, but Nautilo could not confirm the Agent photo update.");
    expect(main).toContain("Refresh Nautilo to verify the photo, or choose it again in Settings.");
    expect(main).toContain("return ipcErr(PROFILE_SAVED_AVATAR_UNVERIFIED_ERROR);");
  });
});

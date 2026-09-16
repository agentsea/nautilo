import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const conversationSource = readFileSync(`${repoRoot}src/components/conversation.tsx`, "utf8");
const findBarSource = readFileSync(
  `${repoRoot}src/components/rooms/room-transcript-find-bar.tsx`,
  "utf8",
);

describe("D430 Room transcript-find layout", () => {
  test("keeps the find bar as the immediate normal-flow sibling below room tabs", () => {
    const roomTabs = conversationSource.indexOf("<RoomTabStrip");
    const findBar = conversationSource.indexOf("<RoomTranscriptFindBar", roomTabs);
    const missingRoom = conversationSource.indexOf("{missingRoom ?", findBar);
    const viewport = conversationSource.indexOf("<ThreadPrimitive.Viewport", findBar);

    expect(roomTabs).toBeGreaterThan(-1);
    expect(findBar).toBeGreaterThan(roomTabs);
    expect(missingRoom).toBeGreaterThan(findBar);
    expect(viewport).toBeGreaterThan(missingRoom);
    expect(findBarSource).not.toContain("createPortal");
    expect(findBarSource).not.toMatch(/\b(?:fixed|absolute)\b/);
  });

  test("leaves browser find and the existing composer outside this Room-find lane", () => {
    const findBar = conversationSource.indexOf("<RoomTranscriptFindBar");
    const composer = conversationSource.indexOf("<Composer", findBar);

    expect(conversationSource).not.toContain("SaasAppSurface");
    expect(conversationSource).not.toContain("browser-find-bar");
    expect(conversationSource).not.toContain("findInPage");
    expect(composer).toBeGreaterThan(findBar);
  });

  test("passes the canonical jump function through without dropping search focus options", () => {
    expect(conversationSource).toContain(
      "jumpToMessage: navigationController.jumpToMessage",
    );
    expect(conversationSource).not.toMatch(
      /jumpToMessage:\s*\(messageId\)\s*=>\s*navigationController\.jumpToMessage\(messageId\)/,
    );
  });

  test("centers result navigation without a frame-dependent smooth animation", () => {
    expect(conversationSource).toContain(
      'el.scrollIntoView({ behavior: "auto", block: "center" })',
    );
    expect(conversationSource).not.toContain(
      'el.scrollIntoView({ behavior: "smooth", block: "center" })',
    );
  });
});

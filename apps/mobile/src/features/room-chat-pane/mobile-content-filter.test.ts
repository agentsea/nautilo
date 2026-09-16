import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  MOBILE_CONTENT_FILTER_NOTICE,
  assessMobileHumanPosting,
  normalizeMobilePostingText,
} from "./mobile-content-filter";

describe("Mobile Human posting filter", () => {
  test("normalizes Unicode width, case, punctuation, and whitespace", () => {
    expect(normalizeMobilePostingText("  ＫＩＬＬ—ALL...  TESTS\nNOW ")).toBe(
      "kill all tests now",
    );
  });

  test.each([
    "I will kill you",
    "Go kill yourself",
    "Exterminate all Muslims",
    "Gay people are subhuman",
    "underage sexual images",
  ])("blocks an unmistakably objectionable message: %s", (text) => {
    expect(assessMobileHumanPosting({ text })).toBe("blocked");
  });

  test("applies normalization before matching", () => {
    expect(assessMobileHumanPosting({ text: "I’LL—KILL YOU" })).toBe("blocked");
  });

  test.each([
    "We will shoot the video with you tomorrow",
    "This process may kill itself after the timeout",
    "The child picked a nude color for the drawing",
    "Black people are artists",
    "I hate waiting for slow tests",
    "Skilled yourself at the tutorial",
  ])("allows an ordinary boundary or false-positive fixture: %s", (text) => {
    expect(assessMobileHumanPosting({ text })).toBe("allowed");
  });

  test("checks each visible attachment filename", () => {
    expect(assessMobileHumanPosting({
      text: "Please review these files",
      attachmentFilenames: ["holiday.jpg", "underage-sexual-images.zip"],
    })).toBe("blocked");
    expect(assessMobileHumanPosting({
      text: "Please review these files",
      attachmentFilenames: ["shoot-the-video.mov"],
    })).toBe("allowed");
  });

  test("keeps the required rejection copy stable", () => {
    expect(MOBILE_CONTENT_FILTER_NOTICE).toBe(
      "This can't be posted because it may violate the Community Rules. Edit it and try again.",
    );
  });

  test("the controller rejects before optimistic insertion or the send API", () => {
    const controller = readFileSync(
      resolve(import.meta.dir, "../../hooks/use-room-chat-controller.ts"),
      "utf8",
    );
    const admission = controller.indexOf("assessMobileHumanPosting({");
    const blockedReturn = controller.indexOf("setContentFilterNotice(MOBILE_CONTENT_FILTER_NOTICE)", admission);
    const optimistic = controller.indexOf("makeOptimisticUserItem(", admission);
    const sendApi = controller.indexOf(".sendRoomMessage(", admission);

    expect(admission).toBeGreaterThan(-1);
    expect(controller).toContain(
      'MOBILE_CONTENT_FILTER_ENABLED = Platform.OS === "ios" || Platform.OS === "android"',
    );
    expect(blockedReturn).toBeGreaterThan(admission);
    expect(controller.slice(blockedReturn, optimistic)).toContain("return false");
    expect(optimistic).toBeGreaterThan(blockedReturn);
    expect(sendApi).toBeGreaterThan(optimistic);
  });

  test("the controller clears a rejection when the conversation scope changes", () => {
    const controller = readFileSync(
      resolve(import.meta.dir, "../../hooks/use-room-chat-controller.ts"),
      "utf8",
    );
    const scopeReset = controller.indexOf("setTranscriptWindow(returnTranscriptToLatest())");
    const scopeDependencies = controller.indexOf(
      "[activeServer?.id, roomId, viewer]",
      scopeReset,
    );

    expect(scopeReset).toBeGreaterThan(-1);
    expect(scopeDependencies).toBeGreaterThan(scopeReset);
    expect(controller.slice(scopeReset, scopeDependencies)).toContain(
      "setContentFilterNotice(null)",
    );
  });
});

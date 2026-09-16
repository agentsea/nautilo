import { reapplyHappyDomGlobals } from "../../../../../tests/bun-dom-preload";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "bun:test";
import { PresenceTypingStrip } from "../PresenceTypingStrip";

describe("PresenceTypingStrip", () => {
  beforeEach(() => {
    reapplyHappyDomGlobals();
  });

  test("mirrors the expanded conversation composer's centered column and insets", () => {
    const view = render(
      <PresenceTypingStrip
        assistantName="Jeannie"
        agentRunning
        agentStreamingVisibleOutput={false}
        composerInset="default"
      />,
    );

    const gutter = view.getByTestId("presence-typing-strip-gutter");
    const strip = view.getByTestId("presence-typing-strip");

    expect(gutter.className).toContain("px-4");
    expect(strip.className).toContain("mx-auto");
    expect(strip.className).toContain("max-w-5xl");
    expect(strip.className).toContain("px-4");
    expect(strip.textContent).toContain("Jeannie");
  });

  test("uses the compact composer insets in the reader rail", () => {
    const view = render(
      <PresenceTypingStrip
        assistantName="Jeannie"
        agentRunning
        agentStreamingVisibleOutput={false}
        composerInset="compact"
      />,
    );

    expect(view.getByTestId("presence-typing-strip-gutter").className).toContain("px-3");
    expect(view.getByTestId("presence-typing-strip").className).toContain("px-3");
  });
});

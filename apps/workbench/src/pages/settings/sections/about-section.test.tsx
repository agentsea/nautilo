import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";

const getVersion = mock(async () => "1.2.3-rc.4");

mock.module("../../../lib/desktop", () => ({
  isDesktop: true,
  desktopAPI: {
    platform: "darwin",
    electronVersion: "41.2.1",
    getVersion,
  },
}));

const { AboutSection } = await import("./about-section");

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  getVersion.mockClear();
});

describe("AboutSection Desktop version", () => {
  test("reads the packaged application version through the Desktop bridge", async () => {
    const view = render(<AboutSection />);

    await waitFor(() => {
      expect(view.getByText(/Nautilo 1\.2\.3-rc\.4/)).toBeTruthy();
    });
    expect(getVersion).toHaveBeenCalledTimes(1);
    expect(view.getByText("Electron 41.2.1")).toBeTruthy();
  });

  test("renders the shared Privacy and email support destinations", async () => {
    const view = render(<AboutSection />);

    await waitFor(() => {
      expect(view.getByText(/Nautilo 1\.2\.3-rc\.4/)).toBeTruthy();
    });

    const privacy = view.getByRole("link", { name: "Privacy Policy" });
    expect(privacy.getAttribute("href")).toBe("https://nautilo.ai/privacy");
    expect(privacy.getAttribute("target")).toBe("_blank");

    const support = view.getByRole("link", { name: "support@kentauros.ai" });
    expect(support.getAttribute("href")).toBe("mailto:support@kentauros.ai");
  });
});

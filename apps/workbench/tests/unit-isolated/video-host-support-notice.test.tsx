import { beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { VideoHostSupportNotice } from "../../src/apps/video-host-support-notice";

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
});

describe("VideoHostSupportNotice", () => {
  test("warns browser users before paid generation and gives the exact Desktop connection URL", () => {
    const view = render(
      <VideoHostSupportNotice
        serverUrl="http://localhost:7201"
        isDesktopShell={false}
        supportsWorkspaceMedia={false}
      />,
    );
    expect(view.getByText("Video media needs Nautilo Desktop.")).toBeTruthy();
    expect(view.getByTestId("video-host-support-notice").textContent).toContain("starting paid generation require a supported Desktop");
    expect(view.getByTestId("video-host-server-url").textContent).toBe("http://localhost:7201");
    const download = view.getByRole("link", { name: "Get Nautilo Desktop" });
    expect(download.getAttribute("target")).toBe("_blank");
    expect(download.getAttribute("rel")).toContain("noopener");
  });

  test("does not warn a host with native Workspace media support", () => {
    const view = render(
      <VideoHostSupportNotice serverUrl="https://server.example.test" isDesktopShell supportsWorkspaceMedia />,
    );
    expect(view.queryByTestId("video-host-support-notice")).toBeNull();
  });
});

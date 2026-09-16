import React from "react";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

beforeAll(() => {
  mock.module("../../src/pages/settings/sections/startup-section", () => ({
    StartupSection: () => <div data-testid="ready-at-startup-stub">Ready at startup</div>,
  }));
  mock.module("../../src/pages/settings/sections/current-folder-section", () => ({
    CurrentFolderSection: () => <div data-testid="current-folder-stub">Current folder</div>,
  }));
  mock.module("../../src/pages/settings/sections/desktop-permissions-section", () => ({
    DesktopPermissionsSection: () => <div data-testid="macos-permissions-stub">macOS permissions</div>,
  }));
  mock.module("../../src/pages/settings/sections/workstation-access-section", () => ({
    DesktopFilesystemAccessSection: () => <div data-testid="workstation-access-stub">Workstation access</div>,
  }));
});

afterAll(() => {
  mock.restore();
});

describe("ThisMacSection", () => {
  test("renders the four Desktop-owned settings in their approved order", async () => {
    const { ThisMacSection } = await import(
      "../../src/pages/settings/sections/this-mac-section"
    );
    const html = renderToStaticMarkup(<ThisMacSection isDesktopShell />);

    expect(html).toContain('id="this-mac"');
    expect(html).toContain('data-testid="this-mac-details"');
    expect(html).not.toContain("These settings belong to the Nautilo Desktop");
    const positions = [
      "ready-at-startup-stub",
      "current-folder-stub",
      "macos-permissions-stub",
      "workstation-access-stub",
    ].map((testId) => html.indexOf(testId));
    expect(positions.every((position) => position >= 0)).toBeTrue();
    expect(positions.every((position) => position > html.indexOf('data-testid="this-mac-details"')))
      .toBeTrue();
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("does not render on a browser-only client", async () => {
    const { ThisMacSection } = await import(
      "../../src/pages/settings/sections/this-mac-section"
    );
    expect(renderToStaticMarkup(<ThisMacSection isDesktopShell={false} />)).toBe("");
  });
});

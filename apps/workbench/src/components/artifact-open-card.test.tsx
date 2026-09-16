import "../../tests/bun-dom-preload.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { MessageArtifactOpenRef } from "@nautilo/types";

import { setOpenFileDispatcher } from "../adapters/open-file-ref";
import {
  artifactOpenRefsFromMessageMetadata,
  ArtifactOpenCard,
  formatArtifactOpenCardSize,
  MessageArtifactOpenCards,
} from "./artifact-open-card";

const artifact: MessageArtifactOpenRef = {
  artifactInternalId: "7d7d9a55-2c38-42f8-9e2d-8f0e5e3ecf03",
  roomId: "room-marketing",
  basename: "campaign-plan.md",
  mimeType: "text/markdown",
  sizeBytes: 1_536,
};

afterEach(() => {
  cleanup();
  setOpenFileDispatcher(null);
});

describe("ArtifactOpenCard", () => {
  test("renders an accessible Workspace document card with human-readable metadata", () => {
    const view = render(<ArtifactOpenCard artifact={artifact} />);

    expect(view.getByRole("button", {
      name: "Open campaign-plan.md, text/markdown · 2 KB",
    })).toBeTruthy();
    expect(view.getByText("campaign-plan.md")).toBeTruthy();
    expect(view.getByText("text/markdown · 2 KB")).toBeTruthy();
  });

  test("opens exactly the server-authorized artifact target", () => {
    const dispatch = mock(() => {});
    setOpenFileDispatcher(dispatch);
    const view = render(<ArtifactOpenCard artifact={artifact} />);

    fireEvent.click(view.getByRole("button", { name: /Open campaign-plan\.md/ }));

    expect(dispatch).toHaveBeenCalledWith({
      kind: "artifact",
      id: artifact.artifactInternalId,
      path: artifact.basename,
      mimeType: artifact.mimeType,
      roomId: artifact.roomId,
      sizeBytes: artifact.sizeBytes,
    });
  });

  test("formats byte sizes consistently at unit boundaries", () => {
    expect(formatArtifactOpenCardSize(900)).toBe("900 B");
    expect(formatArtifactOpenCardSize(1_536)).toBe("2 KB");
    expect(formatArtifactOpenCardSize(1_572_864)).toBe("1.5 MB");
    expect(formatArtifactOpenCardSize(12 * 1024 * 1024)).toBe("12 MB");
  });

  test("preserves server order for multiple cards and renders no cards without the metadata lane", () => {
    const second = { ...artifact, artifactInternalId: "artifact-2", basename: "launch-notes.pdf" };
    const refs = artifactOpenRefsFromMessageMetadata({
      custom: { artifactOpenRefs: [artifact, second] },
    });
    const view = render(<MessageArtifactOpenCards artifacts={refs} />);

    const labels = view.getAllByRole("button").map((button) => button.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Open campaign-plan.md, text/markdown · 2 KB",
      "Open launch-notes.pdf, text/markdown · 2 KB",
    ]);
    expect(
      artifactOpenRefsFromMessageMetadata({
        custom: { focusedResources: [{ kind: "local-file", path: "/repo/campaign-plan.md" }] },
        text: "@campaign-plan.md",
      }),
    ).toEqual([]);
    view.unmount();
    expect(render(<MessageArtifactOpenCards artifacts={[]} />).container.firstChild).toBeNull();
  });
});

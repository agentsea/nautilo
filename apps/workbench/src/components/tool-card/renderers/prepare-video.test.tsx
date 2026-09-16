import "../../../../tests/bun-dom-preload";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ToolRendererProps } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const created = {
  id: "internal-ref-1",
  artifactId: "external-ref-1",
  path: "video-references/call-1/noir.png",
  mimeType: "image/png",
  size: 1_024,
  revision: 1,
  updatedAt: "2026-08-16T00:00:00Z",
  createdAt: "2026-08-16T00:00:00Z",
  namespaceIds: ["ns-1"],
  canWrite: true,
};
const apiStub = {
  createWorkspaceArtifact: mock(async () => created),
  listWorkspaceArtifacts: mock(async () => ({ artifacts: [created] })),
  getWorkspaceArtifactBytes: mock(async () => new Blob(["png"], { type: "image/png" })),
};
const requestFocusedTurn = mock(() => true);
let renderer: (typeof import("./prepare-video"))["videoGenerationRenderer"];
let root: Root | null = null;
let container: HTMLDivElement | null = null;

const envelope = JSON.stringify({
  kind: "video_generation_brief",
  version: 1,
  mode: "reference",
  model: "seedance-2-5-reference-to-video-basic",
  prompt: "[GOAL]\nThe workshop wakes.",
  settings: { durationSeconds: 12, aspectRatio: "16:9", resolution: "720p", audio: true },
});

beforeAll(async () => {
  mock.module("../../../lib/api", () => ({ apiClient: apiStub }));
  mock.module("../../../contexts/room-navigation-context", () => ({ useRoomNavigation: () => ({ activeRoomId: "room-1" }) }));
  mock.module("../../../adapters/tool-invoke-ref", () => ({
    hasFocusedTurnDispatcher: () => true,
    requestFocusedTurn,
  }));
  ({ videoGenerationRenderer: renderer } = await import("./prepare-video"));
});

beforeEach(() => {
  apiStub.createWorkspaceArtifact.mockClear();
  apiStub.listWorkspaceArtifacts.mockClear();
  apiStub.getWorkspaceArtifactBytes.mockClear();
  requestFocusedTurn.mockClear();
  sessionStorage.clear();
  URL.createObjectURL = mock(() => "blob:reference");
  URL.revokeObjectURL = mock(() => undefined);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function render(resultText = envelope): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const props: ToolRendererProps = {
    toolName: "generate_video",
    args: {},
    result: undefined,
    state: "success",
    event: { toolCallId: "call-1", toolName: "generate_video", args: { action: "prepare" }, status: "ok", startedAt: 1 },
    resultText,
    resultTruncated: false,
  };
  await act(async () => { root!.render(<renderer.ExpandedBody {...props} />); });
}

function typeInControlledInput(input: HTMLInputElement, value: string): void {
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props not found on duration input");
  const props = (input as HTMLInputElement & Record<string, unknown>)[propsKey] as {
    onChange: (event: { target: { value: string } }) => void;
  };
  props.onChange({ target: { value } });
}

describe("Advanced reference-video workcard", () => {
  test("accepts and offers the live 1080p tier", async () => {
    const highResolution = JSON.stringify({
      ...JSON.parse(envelope),
      settings: { ...JSON.parse(envelope).settings, resolution: "1080p" },
    });
    await render(highResolution);
    const resolution = [...(container?.querySelectorAll("select") ?? [])]
      .find((select) => [...select.options].some((option) => option.value === "1080p"));
    expect(resolution?.value).toBe("1080p");
    expect([...resolution!.options].map((option) => option.value)).toEqual(["480p", "720p", "1080p"]);
  });

  test("does not open a workcard for a malformed unpaid brief", async () => {
    await render(JSON.stringify({ ...JSON.parse(envelope), providerUrl: "https://venice.example" }));
    expect(container?.querySelector("[data-testid='advanced-video-workcard']")).toBeNull();
  });

  test("opens empty, selects in the card, and continues with ordered focused refs", async () => {
    await render();
    expect(container?.querySelector("[data-testid='advanced-video-workcard']")).not.toBeNull();
    expect(container?.textContent).toContain("No spend yet");
    const quote = [...(container?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.includes("Get exact quote"));
    expect(quote?.classList.contains("text-[var(--on-primary)]")).toBe(true);
    expect(quote?.disabled).toBe(true);

    const workspace = [...(container?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.includes("Choose from Workspace"));
    await act(async () => { workspace?.click(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    const existing = [...(container?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.includes("video-references/call-1/noir.png"));
    await act(async () => { existing?.click(); });

    expect(apiStub.listWorkspaceArtifacts).toHaveBeenCalledWith({ roomId: "room-1" });
    expect(container?.textContent).toContain("Image 1");
    await act(async () => { await Promise.resolve(); });
    expect(apiStub.getWorkspaceArtifactBytes).toHaveBeenCalledWith("internal-ref-1", { roomId: "room-1" });
    expect(container?.querySelector("img")?.getAttribute("src")).toBe("blob:reference");

    const duration = container?.querySelector("input[type='number']") as HTMLInputElement | null;
    await act(async () => {
      if (!duration) return;
      typeInControlledInput(duration, "18");
    });
    expect(container?.textContent).toContain("Image 1");
    expect(duration?.value).toBe("18");
    expect(quote?.disabled).toBe(false);
    await act(async () => { quote?.click(); });
    expect(requestFocusedTurn).toHaveBeenCalledTimes(1);
    const [text, refs, presentation] = requestFocusedTurn.mock.calls[0] ?? [];
    expect(text).toContain("request its exact quote now");
    expect(text).toContain("durationSeconds=18");
    expect(refs).toEqual([{ kind: "workspace-artifact", artifactId: "external-ref-1" }]);
    expect(presentation).toBe("advanced_video");
    expect(String(text)).not.toContain("internal-ref-1");
  });
});

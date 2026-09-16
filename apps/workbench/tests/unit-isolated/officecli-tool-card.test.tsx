import "../bun-dom-preload";
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { setOpenFileDispatcher } from "../../src/adapters/open-file-ref";
import type { ToolActivityEvent } from "../../src/adapters/runtime-contexts";
import type { ToolRendererProps } from "../../src/components/tool-card/renderers/types";

const INTERNAL_ID = "aa0c122f-2f55-484f-80f1-5de55d1bd467";
const EXTERNAL_ID = "5085c1ed-c58b-4e82-92e9-f80a38ea228c";

const getWorkspaceArtifact = mock(async () => ({
  id: INTERNAL_ID,
  artifactId: EXTERNAL_ID,
  path: "reports/smoke-test-report.docx",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  size: 7_127,
  revision: 1,
  updatedAt: "2026-09-10T16:05:50.000Z",
  createdAt: "2026-09-10T16:05:50.000Z",
  namespaceIds: ["room-namespace"],
  canWrite: true,
}));
const showToast = mock(() => {});

let OfficeCliBody: (props: ToolRendererProps) => React.ReactElement;
let parseReceipt: (typeof import("../../src/components/tool-card/renderers/officecli"))["parseOfficeCliCreatedArtifactReceipt"];
let officeCliRenderer: (typeof import("../../src/components/tool-card/renderers/officecli"))["officeCliRenderer"];
let getToolRenderer: (typeof import("../../src/components/tool-card/renderers/index"))["getToolRenderer"];
let ToolCard: (typeof import("../../src/components/tool-card/tool-card"))["ToolCard"];

const successfulReceipt = JSON.stringify({
  applied: true,
  revisionId: "revision-1",
  path: "reports/smoke-test-report.docx",
  zone: "workspace",
  command: "officecli",
  binary: true,
  artifactInternalId: INTERNAL_ID,
  artifactId: EXTERNAL_ID,
});

beforeAll(async () => {
  mock.module("../../src/lib/api", () => ({
    apiClient: { getWorkspaceArtifact },
  }));
  mock.module("../../src/contexts/room-navigation-context", () => ({
    useRoomNavigation: () => ({ activeRoomId: "room-1" }),
  }));
  mock.module("../../src/components/toast", () => ({
    useToast: () => ({ show: showToast }),
  }));
  const module = await import("../../src/components/tool-card/renderers/officecli");
  OfficeCliBody = module.OfficeCliBody;
  parseReceipt = module.parseOfficeCliCreatedArtifactReceipt;
  officeCliRenderer = module.officeCliRenderer;
  getToolRenderer = (await import("../../src/components/tool-card/renderers/index")).getToolRenderer;
  ToolCard = (await import("../../src/components/tool-card/tool-card")).ToolCard;
});

afterEach(() => {
  cleanup();
  setOpenFileDispatcher(null);
  getWorkspaceArtifact.mockClear();
  showToast.mockClear();
});

function props(overrides: Partial<ToolRendererProps> = {}): ToolRendererProps {
  return {
    args: { command: "create", zone: "workspace" },
    result: undefined,
    state: "success",
    event: undefined,
    resultText: successfulReceipt,
    resultTruncated: false,
    ...overrides,
  };
}

describe("officecli document handoff", () => {
  test("opens a successful create through the authenticated canonical artifact", async () => {
    const dispatch = mock(() => {});
    setOpenFileDispatcher(dispatch);
    const view = render(<OfficeCliBody {...props()} />);

    fireEvent.click(view.getByRole("button", { name: "Open smoke-test-report.docx" }));

    await waitFor(() => expect(getWorkspaceArtifact).toHaveBeenCalledWith(INTERNAL_ID, {
      roomId: "room-1",
    }));
    expect(dispatch).toHaveBeenCalledWith({
      kind: "artifact",
      id: INTERNAL_ID,
      path: "reports/smoke-test-report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      roomId: "room-1",
      sizeBytes: 7_127,
    });
  });

  test("does not trust a receipt whose canonical artifact identity differs", async () => {
    getWorkspaceArtifact.mockResolvedValueOnce({
      ...(await getWorkspaceArtifact()),
      artifactId: "different-public-id",
    });
    const dispatch = mock(() => {});
    setOpenFileDispatcher(dispatch);
    const view = render(<OfficeCliBody {...props()} />);

    fireEvent.click(view.getByRole("button", { name: "Open smoke-test-report.docx" }));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("failure, read-only, truncated, and non-artifact outputs never present an open action", () => {
    const cases: Array<Partial<ToolRendererProps>> = [
      { state: "error", resultText: "Error: document creation failed" },
      { state: "error" },
      { args: { command: "view", zone: "workspace" } },
      { resultTruncated: true },
      { resultText: JSON.stringify({ applied: true, path: "reports/report.docx" }) },
    ];

    for (const item of cases) {
      const view = render(<OfficeCliBody {...props(item)} />);
      expect(view.queryByRole("button", { name: /Open / })).toBeNull();
      view.unmount();
    }
  });

  test("parser requires the exact successful Workspace create receipt", () => {
    expect(parseReceipt({ command: "create" }, successfulReceipt)).toEqual({
      artifactInternalId: INTERNAL_ID,
      artifactId: EXTERNAL_ID,
      path: "reports/smoke-test-report.docx",
    });
    expect(parseReceipt({ command: "create" }, successfulReceipt, true)).toBeNull();
    expect(parseReceipt({ command: "validate" }, successfulReceipt)).toBeNull();
  });

  test("registry specializes only successful create results", () => {
    expect(getToolRenderer("officecli", successfulReceipt, { command: "create" }))
      .toBe(officeCliRenderer);
    expect(getToolRenderer("officecli", successfulReceipt, { command: "set" }))
      .toBeUndefined();
    expect(getToolRenderer("officecli", "Error: failed", { command: "create" }))
      .toBeUndefined();
  });

  test("uses canonical activity args when framework args are empty", async () => {
    const event = {
      toolCallId: "officecli-create",
      toolName: "officecli",
      args: { command: "create", zone: "workspace" },
      status: "ok",
      startedAt: 1,
      endedAt: 2,
      result: successfulReceipt,
    } as ToolActivityEvent;
    const view = render(
      <ToolCard
        toolCallId="officecli-create"
        toolName="officecli"
        args={{}}
        status={{ type: "complete" }}
        activityOverride={event}
      />,
    );

    await waitFor(() => expect(view.getByRole("button", { name: "Open smoke-test-report.docx" })).toBeTruthy());
    expect(view.getByRole("group").getAttribute("aria-label")).toContain("Created smoke-test-report.docx");
  });

  test("does not present an open action for canonical non-create activity", () => {
    const event = {
      toolCallId: "officecli-view",
      toolName: "officecli",
      args: { command: "view", zone: "workspace" },
      status: "ok",
      startedAt: 1,
      endedAt: 2,
      result: successfulReceipt,
    } as ToolActivityEvent;
    const view = render(
      <ToolCard
        toolCallId="officecli-view"
        toolName="officecli"
        args={{}}
        status={{ type: "complete" }}
        activityOverride={event}
        defaultExpanded
      />,
    );

    expect(view.queryByRole("button", { name: /Open / })).toBeNull();
  });
});


describe("native Writer document handoff", () => {
  const writerReceipt = JSON.stringify({
    ok: true, status: "created", artifactPath: "Writer acceptance.doc.html",
    artifactInternalId: INTERNAL_ID, artifactId: EXTERNAL_ID,
    target: { surface: "workspace", path: "Writer acceptance.doc.html" }, opened: false,
  });

  test("the creation card opens the authenticated saved artifact in one click", async () => {
    const dispatch = mock(() => {});
    setOpenFileDispatcher(dispatch);
    getWorkspaceArtifact.mockResolvedValueOnce({
      ...(await getWorkspaceArtifact()), path: "Writer acceptance.doc.html", mimeType: "text/html",
    });
    const view = render(<ToolCard toolCallId="writer-create" toolName="app_nautilo_writer__create_file"
      args={{ filename: "Writer acceptance" }} status={{ type: "complete" }}
      activityOverride={{ toolCallId: "writer-create", toolName: "app_nautilo_writer__create_file",
        args: { filename: "Writer acceptance" }, status: "ok", startedAt: 1, endedAt: 2,
        result: writerReceipt } as ToolActivityEvent} />);
    const button = await view.findByRole("button", { name: "Open Writer acceptance.doc.html" });
    expect(dispatch).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      kind: "artifact", id: INTERNAL_ID, path: "Writer acceptance.doc.html", mimeType: "text/html",
    })));
  });

  test("no open action is inferred from a failed, truncated or local creation", async () => {
    const { parseWriterCreatedArtifactReceipt: parse } = await import("../../src/components/tool-card/renderers/writer-creation");
    expect(parse(writerReceipt, true)).toBeNull();
    expect(parse(JSON.stringify({ ...JSON.parse(writerReceipt), ok: false }))).toBeNull();
    expect(parse(JSON.stringify({ ...JSON.parse(writerReceipt), artifactInternalId: undefined }))).toBeNull();
    expect(parse(JSON.stringify({ ...JSON.parse(writerReceipt), target: { surface: "currentFolder" } }))).toBeNull();
    expect(getToolRenderer("app_nautilo_writer__inspect_document", writerReceipt)).toBeUndefined();
  });
});

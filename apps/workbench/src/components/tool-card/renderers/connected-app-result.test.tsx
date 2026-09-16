import "../../../../tests/bun-dom-preload";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ToolRendererProps } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const artifact = {
  id: "internal-artifact-A",
  artifactId: "artifact-A",
  path: "connected-apps/canva/export-job-A-1.pdf",
  mimeType: "application/pdf",
  size: 4,
  revision: 1,
  updatedAt: "2026-09-02T00:00:00.000Z",
  createdAt: "2026-09-02T00:00:00.000Z",
  namespaceIds: ["room-1"],
  canWrite: true,
};
const apiStub = {
  getConnectedAppResultMedia: mock(async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })),
  listWorkspaceArtifacts: mock(async () => ({ artifacts: [artifact] })),
  downloadArtifact: mock(async () => undefined),
};
const requestOpenFile = mock(() => true);
const openExternal = mock(async () => undefined);
const sendOrdinaryRoomMessage = mock(async () => ({
  accepted: true,
  messageId: 1,
  jobId: "job-airtable-next",
  attachments: [],
  coalesced: false,
}));

let renderer: (typeof import("./connected-app-result"))["connectedAppResultRenderer"];
let transferRenderer: (typeof import("./connected-app-result"))["connectedAppTransferRenderer"];
let isEnvelope: (typeof import("./connected-app-result"))["isConnectedAppPresentationEnvelope"];
let preserveReceipt: (typeof import("./connected-app-receipt"))["preserveConnectedAppResultForCard"];
let airtableRenderer: (typeof import("./airtable-result"))["airtableResultRenderer"];
let root: Root | null = null;
let container: HTMLDivElement | null = null;

const baseReceipt = {
  providerId: "canva",
  operationId: "canva.get_design",
  executionId: "execution-A",
  profileId: "44444444-4444-4444-8444-444444444444",
  effect: "read",
  reconciliation: null,
};

beforeAll(async () => {
  mock.module("../../../lib/api", () => ({ apiClient: apiStub }));
  mock.module("../../../contexts/room-navigation-context", () => ({
    useRoomNavigation: () => ({ activeRoomId: "room-1" }),
  }));
  mock.module("../../../adapters/open-file-ref", () => ({ requestOpenFile }));
  mock.module("../../../lib/desktop", () => ({
    desktopAPI: { browserControl: { openExternal } },
  }));
  mock.module("../../../lib/ordinary-room-message", () => ({ sendOrdinaryRoomMessage }));
  mock.module("react-data-grid", () => ({
    DataGrid: ({ columns, rows, onCellClick, ...props }: {
      columns: readonly {
        key: string;
        name: string;
        renderCell?: (args: { row: { id: string; fields: Record<string, unknown> } }) => ReactNode;
      }[];
      rows: readonly { id: string; fields: Record<string, unknown> }[];
      onCellClick?: (args: { row: { id: string; fields: Record<string, unknown> } }) => void;
      "aria-label"?: string;
    }) => (
      <div role="grid" aria-label={props["aria-label"]}>
        <div role="row">{columns.map((column) => <span key={column.key}>{column.name}</span>)}</div>
        {rows.map((row) => (
          <div
            role="row"
            key={row.id}
            data-testid={`grid-row-${row.id}`}
            onClick={() => onCellClick?.({ row })}
          >
            {row.id}
            {columns.map((column) => (
              <span key={column.key}>
                {column.renderCell?.({ row }) ?? String(row.fields[column.key] ?? "")}
              </span>
            ))}
          </div>
        ))}
      </div>
    ),
  }));
  ({
    connectedAppResultRenderer: renderer,
    connectedAppTransferRenderer: transferRenderer,
    isConnectedAppPresentationEnvelope: isEnvelope,
  } = await import("./connected-app-result"));
  ({ preserveConnectedAppResultForCard: preserveReceipt } = await import("./connected-app-receipt"));
  ({ airtableResultRenderer: airtableRenderer } = await import("./airtable-result"));
});

beforeEach(() => {
  apiStub.getConnectedAppResultMedia.mockClear();
  apiStub.listWorkspaceArtifacts.mockClear();
  apiStub.downloadArtifact.mockClear();
  requestOpenFile.mockClear();
  openExternal.mockClear();
  sendOrdinaryRoomMessage.mockClear();
  URL.createObjectURL = mock(() => "blob:connected-app-preview");
  URL.revokeObjectURL = mock(() => undefined);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function renderResult(toolName: string, receipt: unknown): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const props: ToolRendererProps = {
    toolName,
    args: {},
    result: undefined,
    state: "success",
    event: undefined,
    resultText: JSON.stringify(receipt),
    resultTruncated: false,
  };
  await act(async () => { root!.render(<renderer.ExpandedBody {...props} />); });
  await act(async () => { await Promise.resolve(); });
}

async function renderAirtableResult(
  toolName: string,
  receipt: unknown,
  options: {
    args?: Record<string, unknown>;
    event?: ToolRendererProps["event"];
  } = {},
): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const props: ToolRendererProps = {
    toolName,
    args: options.args ?? {},
    result: undefined,
    state: "success",
    event: options.event,
    resultText: JSON.stringify(receipt),
    resultTruncated: false,
  };
  await act(async () => { root!.render(<airtableRenderer.ExpandedBody {...props} />); });
  await act(async () => { await Promise.resolve(); });
}

describe("connectedAppResultRenderer", () => {
  test("keeps upload and download cards expanded with truthful transfer animation", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const props: ToolRendererProps = {
      toolName: "dropbox_upload_file",
      args: {
        artifactPath: "/quarterly-review.mp4",
        path: "/Nautilo/quarterly-review.mp4",
      },
      result: undefined,
      state: "running",
      event: undefined,
      resultText: undefined,
      resultTruncated: false,
      elapsedMs: 7_200,
    };

    await act(async () => { root!.render(<transferRenderer.ExpandedBody {...props} />); });
    expect(container?.querySelector('[data-testid="connected-app-upload-activity"]')).not.toBeNull();
    expect(container?.textContent).toContain("Workspace");
    expect(container?.textContent).toContain("Dropbox");
    expect(container?.textContent).toContain("Uploading securely · 7s");
    expect(container?.textContent).toContain("No file bytes enter the chat");
    expect(transferRenderer.autoExpandWhileRunning).toBe(true);
    expect(transferRenderer.autoExpandOnResult).toBe(true);
    expect(transferRenderer.sealedResultParser).toBe(true);

    await act(async () => {
      root!.render(<transferRenderer.ExpandedBody
        {...props}
        toolName="dropbox_download_file"
        args={{ path: "/quarterly-review.mp4" }}
      />);
    });
    expect(container?.querySelector('[data-testid="connected-app-download-activity"]')).not.toBeNull();
    expect(container?.textContent).toContain("Downloading and saving securely · 7s");
  });

  test("settles an upload animation into safe file metadata", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const receipt = {
      providerId: "dropbox",
      operationId: "dropbox.upload_file",
      executionId: "execution-upload",
      profileId: "44444444-4444-4444-8444-444444444444",
      effect: "write",
      reconciliation: null,
      result: {
        metadata: {
          name: "quarterly-review.mp4",
          pathDisplay: "/Nautilo/quarterly-review.mp4",
          sizeBytes: 167_304_509,
          privateTransitId: "must-not-render",
        },
      },
    };
    const props: ToolRendererProps = {
      toolName: "dropbox_upload_file",
      args: { artifactPath: "/quarterly-review.mp4", path: "/Nautilo/quarterly-review.mp4" },
      result: undefined,
      state: "success",
      event: undefined,
      resultText: JSON.stringify(receipt),
      resultTruncated: false,
    };

    await act(async () => { root!.render(<transferRenderer.ExpandedBody {...props} />); });
    expect(container?.querySelector('[data-testid="connected-app-upload-complete"]')).not.toBeNull();
    expect(container?.textContent).toContain("Uploaded to Dropbox");
    expect(container?.textContent).toContain("159.6 MB");
    expect(container?.textContent).not.toContain("must-not-render");
  });

  test("renders a private thumbnail and explicit provider links without dumping source JSON", async () => {
    const receipt = {
      ...baseReceipt,
      presentation: {
        version: 1,
        kind: "entity",
        title: "Launch graphic",
        subtitle: "DAH-test",
        preview: { ref: "opaque_preview_A", alt: "Design preview", width: 640, height: 480 },
        links: [
          { label: "Open in Canva", url: "https://www.canva.com/design/DAH-test/view" },
          { label: "Edit in Canva", url: "https://www.canva.com/design/DAH-test/edit" },
        ],
      },
      result: { design: { id: "DAH-test", secretField: "must-not-render" } },
    };
    await renderResult("canva_get_design", receipt);

    expect(apiStub.getConnectedAppResultMedia).toHaveBeenCalledWith("opaque_preview_A", {
      roomId: "room-1",
      signal: expect.any(AbortSignal),
    });
    expect(container?.querySelector('img[src="blob:connected-app-preview"]')).not.toBeNull();
    expect(container?.textContent).toContain("Launch graphic");
    expect(container?.textContent).toContain("DAH-test");
    expect(container?.textContent).not.toContain("must-not-render");
    expect(container?.textContent).not.toContain("www.canva.com");

    const edit = Array.from(container!.querySelectorAll("button"))
      .find((button) => button.textContent === "Edit in Canva");
    await act(async () => { edit?.click(); await Promise.resolve(); });
    expect(openExternal).toHaveBeenCalledWith({ url: "https://www.canva.com/design/DAH-test/edit" });
    expect(renderer.autoExpandOnResult).toBe(true);
    expect(renderer.sealedResultParser).toBe(true);
  });

  test("resolves imported exports through normal Room artifact controls", async () => {
    const receipt = {
      ...baseReceipt,
      operationId: "canva.get_design_export_job",
      presentation: {
        version: 1,
        kind: "artifact_import",
        status: "success",
        state: "ready",
        artifacts: [{
          artifactId: "artifact-A",
          path: "connected-apps/canva/export-job-A-1.pdf",
          mime: "application/pdf",
          bytes: 4,
        }],
        errorCode: null,
      },
      result: { job: { id: "job-A", status: "success", internal: "must-not-render" } },
    };
    await renderResult("canva_get_design_export_job", receipt);

    expect(apiStub.listWorkspaceArtifacts).toHaveBeenCalledWith({ roomId: "room-1" });
    expect(container?.textContent).toContain("Export saved to this Room.");
    expect(container?.textContent).toContain("export-job-A-1.pdf");
    expect(container?.textContent).not.toContain("must-not-render");

    const open = Array.from(container!.querySelectorAll("button"))
      .find((button) => button.textContent === "Open");
    await act(async () => { open?.click(); });
    expect(requestOpenFile).toHaveBeenCalledWith(expect.objectContaining({
      kind: "artifact",
      id: "internal-artifact-A",
      roomId: "room-1",
    }));

    const download = Array.from(container!.querySelectorAll("button"))
      .find((button) => button.textContent === "Download");
    await act(async () => { download?.click(); await Promise.resolve(); });
    expect(apiStub.downloadArtifact).toHaveBeenCalledWith(
      "internal-artifact-A",
      "export-job-A-1.pdf",
      { roomId: "room-1" },
    );
  });

  test("fails closed for malformed presentation envelopes and never falls back to raw bytes", async () => {
    const malformed = JSON.stringify({
      ...baseReceipt,
      presentation: { kind: "entity", title: "Invalid", remoteHtml: "<script>secret</script>" },
      result: { secret: "raw-result-must-not-render" },
    });
    expect(isEnvelope("canva_get_design", malformed)).toBe(true);
    await renderResult("canva_get_design", JSON.parse(malformed) as unknown);
    expect(container?.textContent).toContain("could not be displayed safely");
    expect(container?.textContent).not.toContain("raw-result-must-not-render");
    expect(container?.textContent).not.toContain("script");
  });

  test("does not accept another operation's presentation envelope", () => {
    const receipt = JSON.stringify({
      ...baseReceipt,
      presentation: {
        version: 1,
        kind: "entity",
        title: "Wrong action",
        subtitle: null,
        preview: null,
        links: [],
      },
      result: {},
    });
    expect(isEnvelope("canva_list_designs", receipt)).toBe(false);
  });
});

describe("airtableResultRenderer", () => {
  const airtableReceipt = {
    providerId: "airtable",
    operationId: "airtable.list_records",
    executionId: "airtable-execution-A",
    profileId: "55555555-5555-4555-8555-555555555555",
    effect: "read",
    reconciliation: null,
  };

  test("preserves only complete exact-tool receipts for the sealed native renderer", () => {
    const raw = JSON.stringify({
      ...airtableReceipt,
      operationId: "airtable.get_base_schema",
      result: {
        tables: [{
          id: "tblTable456",
          name: "Acceptance Records",
          fields: [{ id: "fldName123", name: "Name", type: "singleLineText" }],
          views: [{ id: "viwGrid123", name: "Grid view", type: "grid" }],
        }],
      },
    });

    expect(preserveReceipt("airtable_get_base_schema", raw)).toBe(raw);
    expect(preserveReceipt("airtable_list_records", raw)).toBeUndefined();
    expect(preserveReceipt("airtable_get_base_schema", raw.slice(0, -1))).toBeUndefined();
    expect(preserveReceipt("unknown_tool", JSON.stringify({ result: { secret: "not-a-receipt" } }))).toBeUndefined();
  });

  test("renders Airtable records as a grid with expandable complete row details and a provider link", async () => {
    await renderAirtableResult("airtable_list_records", {
      ...airtableReceipt,
      result: {
        records: [
          {
            id: "recAlpha123",
            createdTime: "2026-09-03T00:00:00.000Z",
            fields: {
              Name: "Nautilo",
              Status: "Ready",
              Notes: { complete: true },
              "Attachment Summary": {
                state: "error",
                errorType: "emptyDependency",
                value: null,
                isStale: false,
              },
            },
          },
          { id: "recBeta456", fields: { Name: "OpenConnector", Owner: "Moxie" } },
        ],
        offset: null,
      },
    }, {
      args: { baseId: "appBase123", tableIdOrName: "tblTable456" },
    });

    expect(container?.querySelector('[role="grid"][aria-label="Airtable records"]')).not.toBeNull();
    expect(container?.textContent).toContain("Name");
    expect(container?.textContent).toContain("Status");
    expect(container?.textContent).toContain("Owner");
    expect(container?.textContent).toContain("Waiting for source value");
    expect(container?.textContent).not.toContain("emptyDependency");
    expect(container?.textContent).not.toContain("55555555-5555-4555-8555-555555555555");

    const row = container?.querySelector<HTMLButtonElement>('[data-testid="grid-row-recAlpha123"]');
    await act(async () => { row?.click(); });
    expect(container?.querySelector('[data-testid="airtable-record-details"]')).not.toBeNull();
    expect(container?.textContent).toContain("complete");
    expect(container?.textContent).toContain("2026-09-03T00:00:00.000Z");

    const open = Array.from(container!.querySelectorAll("button"))
      .find((button) => button.textContent === "Open in Airtable");
    await act(async () => { open?.click(); await Promise.resolve(); });
    expect(openExternal).toHaveBeenCalledWith({ url: "https://airtable.com/appBase123/tblTable456" });
    expect(airtableRenderer.autoExpandOnResult).toBe(true);
    expect(airtableRenderer.sealedResultParser).toBe(true);
  });

  test("sends an exact read-only continuation through Genie once", async () => {
    await renderAirtableResult("airtable_list_records", {
      ...airtableReceipt,
      result: {
        records: [{ id: "recPageOne", fields: { Name: "Page one" } }],
        offset: "itrCursor/recPageOne",
      },
    }, {
      args: { baseId: "appBase123", tableIdOrName: "tblTable456", pageSize: 100 },
      event: {
        toolCallId: "call-airtable-page-one",
        toolName: "airtable_list_records",
        authorAgentId: "22222222-2222-4222-8222-222222222222",
        args: {},
        status: "ok",
        startedAt: 1,
        endedAt: 2,
      },
    });

    const load = Array.from(container!.querySelectorAll("button"))
      .find((button) => button.textContent === "Load next page");
    await act(async () => { load?.click(); await Promise.resolve(); });
    expect(sendOrdinaryRoomMessage).toHaveBeenCalledTimes(1);
    expect(sendOrdinaryRoomMessage).toHaveBeenCalledWith(apiStub, "room-1", {
      content: expect.stringContaining('"offset":"itrCursor/recPageOne"'),
      uiSelectedBotActorId: "22222222-2222-4222-8222-222222222222",
    });
    await act(async () => { load?.click(); await Promise.resolve(); });
    expect(sendOrdinaryRoomMessage).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain("Next page requested");
  });

  test("renders accessible bases with permission levels and individual Airtable links", async () => {
    await renderAirtableResult("airtable_list_bases", {
      ...airtableReceipt,
      operationId: "airtable.list_bases",
      result: {
        bases: [
          { id: "appMarketing123", name: "Marketing", permissionLevel: "create" },
          { id: "appRoadmap456", name: "Roadmap", permissionLevel: "read" },
        ],
        offset: null,
      },
    });
    expect(container?.querySelector('[data-testid="airtable-bases"]')).not.toBeNull();
    expect(container?.textContent).toContain("Marketing");
    expect(container?.textContent).toContain("Roadmap");
    expect(container?.textContent).toContain("create");
    expect(container?.querySelectorAll("button")).toHaveLength(2);
  });

  test("renders base schemas as expandable tables and fields", async () => {
    await renderAirtableResult("airtable_get_base_schema", {
      ...airtableReceipt,
      operationId: "airtable.get_base_schema",
      result: {
        tables: [{
          id: "tblProjects123",
          name: "Projects",
          description: "Current projects",
          fields: [
            { id: "fldName123", name: "Name", type: "singleLineText" },
            {
              id: "fldState456",
              name: "State",
              type: "singleSelect",
              options: { choices: [{ id: "selReady123", name: "Ready", color: "greenLight2" }] },
            },
          ],
          views: [{ id: "viwAll123", name: "All projects", type: "grid" }],
        }],
      },
    }, { args: { baseId: "appBase123" } });
    expect(container?.querySelector('[data-testid="airtable-tables"]')).not.toBeNull();
    expect(container?.textContent).toContain("Projects");
    expect(container?.textContent).toContain("2 fields · 1 view");
    const details = container?.querySelector("details");
    details?.setAttribute("open", "");
    expect(container?.textContent).toContain("singleLineText");
    expect(container?.textContent).toContain("fldState456");
    expect(container?.textContent).toContain("Field options");
    expect(container?.textContent).toContain("greenLight2");
    expect(container?.textContent).toContain("All projects");
    expect(container?.textContent).toContain("viwAll123");
  });

  test("shows an intentional empty state without dumping an empty provider envelope", async () => {
    await renderAirtableResult("airtable_list_records", {
      ...airtableReceipt,
      result: { records: [], offset: null },
    });
    expect(container?.textContent).toContain("No Airtable records matched this request");
    expect(container?.querySelector('[data-testid="airtable-result-details"]')).toBeNull();
  });

  test("shows the exact write and reconciliation receipts beside returned records", async () => {
    await renderAirtableResult("airtable_create_records", {
      ...airtableReceipt,
      operationId: "airtable.create_records",
      executionId: "write-execution-once",
      effect: "write",
      reconciliation: {
        status: "confirmed",
        operationId: "airtable.get_record",
        executionId: "readback-execution",
        errorCode: null,
      },
      result: { records: [{ id: "recCreated123", fields: { Name: "Nautilo acceptance" } }] },
    }, { args: { baseId: "appBase123", tableIdOrName: "tblTable456" } });
    expect(container?.textContent).toContain("Approved write completed in Airtable");
    expect(container?.textContent).toContain("Execution receipt: write-execution-once");
    expect(container?.textContent).toContain("Reconciled: readback-execution");
    expect(container?.textContent).toContain("Nautilo acceptance");
  });

  test("fails closed for another provider or malformed Airtable receipts", async () => {
    await renderAirtableResult("airtable_list_records", {
      ...airtableReceipt,
      providerId: "dropbox",
      result: { secret: "must-not-render" },
    });
    expect(container?.textContent).toContain("did not return a displayable result");
    expect(container?.textContent).not.toContain("must-not-render");
  });
});

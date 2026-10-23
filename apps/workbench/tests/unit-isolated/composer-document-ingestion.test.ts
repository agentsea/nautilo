import { afterEach, expect, mock, test } from "bun:test";
import { addAttachment, clearAttachments, getAttachments } from "../../src/adapters/composer-attachments-ref";

const workspaceUpload = mock(async () => ({ artifactId: "document-artifact" }));
const messageUpload = mock(async () => ({ attachmentId: "text-attachment", mimeType: "text/csv" }));
mock.module("../../src/lib/api", () => ({ apiClient: { createWorkspaceArtifact: workspaceUpload, uploadMessageAttachment: messageUpload } }));
const { uploadComposerBlob, uploadComposerAttachment } = await import("../../src/lib/composer-upload");
const { workspaceAttachmentsForSend } = await import("../../src/lib/composer-document-upload");
afterEach(() => { clearAttachments(); workspaceUpload.mockClear(); messageUpload.mockClear(); });

test("browser and native Office selection upload once as Room-scoped Workspace artifacts", async () => {
  for (const native of [false, true]) {
    clearAttachments(); workspaceUpload.mockClear();
    addAttachment({ id: "queued", name: "report.xlsx", path: "", rootPath: "", status: "pending" });
    if (native) await uploadComposerAttachment("queued", { name: "report.xlsx", base64: btoa("synthetic workbook") }, { roomId: "room-a" });
    else await uploadComposerBlob("queued", new Blob(["synthetic workbook"]), "report.xlsx", { roomId: "room-a" });
    expect(workspaceUpload).toHaveBeenCalledTimes(1);
    expect(messageUpload).not.toHaveBeenCalled();
    expect(getAttachments()[0]).toMatchObject({ status: "queued", workspaceArtifact: { artifactId: "document-artifact", roomId: "room-a" } });
    expect(getAttachments()[0]?.attachmentId).toBeUndefined();
    expect(workspaceAttachmentsForSend(getAttachments(), "room-a")).toEqual({ ok: true, refs: [{ kind: "workspace-artifact", artifactId: "document-artifact" }] });
    expect(workspaceAttachmentsForSend(getAttachments(), "room-b")).toEqual({ ok: false });
  }
});

test("missing Room and upload rejection retain an error chip and block send", async () => {
  addAttachment({ id: "queued", name: "report.docx", path: "", rootPath: "", status: "pending" });
  await uploadComposerBlob("queued", new Blob(["synthetic"]), "report.docx");
  expect(workspaceUpload).not.toHaveBeenCalled();
  expect(getAttachments()[0]).toMatchObject({ status: "error" });
  expect(workspaceAttachmentsForSend(getAttachments(), "room-a")).toEqual({ ok: false });
  workspaceUpload.mockRejectedValueOnce(new Error("Upload denied"));
  await uploadComposerBlob("queued", new Blob(["synthetic"]), "report.docx", { roomId: "room-a" });
  expect(getAttachments()[0]).toMatchObject({ status: "error", errorReason: "Upload denied" });
  expect(workspaceAttachmentsForSend(getAttachments(), "room-a")).toEqual({ ok: false });
});

test("CSV remains a text attachment and does not upload a Workspace document", async () => {
  addAttachment({ id: "csv", name: "table.csv", path: "", rootPath: "", status: "pending" });
  await uploadComposerBlob("csv", new Blob(["a,b\n1,2"]), "table.csv", { roomId: "room-a" });
  expect(workspaceUpload).not.toHaveBeenCalled();
  expect(messageUpload).toHaveBeenCalledTimes(1);
  expect(getAttachments()[0]).toMatchObject({ status: "queued", attachmentId: "text-attachment" });
  expect(getAttachments()[0]?.workspaceArtifact).toBeUndefined();
});

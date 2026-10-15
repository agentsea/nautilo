import { describe, expect, test } from "bun:test";
import { uploadComposerPdf, workspaceAttachmentsForSend } from "../../src/lib/composer-pdf-upload";
import { preflightComposerChatAttachment } from "../../src/lib/composer-attachment-preflight";

describe("PDF composer uploads", () => {
  test("PDFs use Room-scoped Workspace admission and never overwrite a filename", async () => {
    const uploads: unknown[] = [];
    const upload = async (_blob: Blob, options: unknown) => {
      uploads.push(options);
      return { artifactId: `artifact-${uploads.length}` };
    };
    const blob = new Blob(["synthetic PDF bytes"]);
    const first = await uploadComposerPdf({ id: "first", blob, filename: "sample.pdf", roomId: "room-a" }, upload);
    await uploadComposerPdf({ id: "second", blob, filename: "sample.pdf", roomId: "room-a" }, upload);
    expect(first).toEqual({ artifactId: "artifact-1", roomId: "room-a" });
    expect(uploads).toEqual([
      { path: "Attachments/first/sample.pdf", roomId: "room-a", mimeType: "application/pdf" },
      { path: "Attachments/second/sample.pdf", roomId: "room-a", mimeType: "application/pdf" },
    ]);
    await expect(uploadComposerPdf({ id: "missing-room", blob, filename: "sample.pdf" }, upload)).rejects.toThrow("Select a room");
    expect(uploads).toHaveLength(2);
  });

  test("upload and Workspace drop converge on the same focused-resource wire shape", () => {
    const attachment = { id: "upload", name: "sample.pdf", path: "", rootPath: "",
      status: "queued" as const, workspaceArtifact: { artifactId: "document-id", roomId: "room-a" } };
    expect(workspaceAttachmentsForSend([attachment], "room-a")).toEqual({ ok: true,
      refs: [{ kind: "workspace-artifact", artifactId: "document-id" }] });
    expect(workspaceAttachmentsForSend([attachment], "room-b")).toEqual({ ok: false });
    expect(workspaceAttachmentsForSend([{ ...attachment, status: "pending" }], "room-a")).toEqual({ ok: false });
    expect(workspaceAttachmentsForSend([{ ...attachment, status: "error" }], "room-a")).toEqual({ ok: false });
  });

  test("only composers with Workspace ingestion admit PDFs", () => {
    expect(preflightComposerChatAttachment("sample.PDF", { workspacePdf: true })).toEqual({ ok: true });
    expect(preflightComposerChatAttachment("sample.pdf").ok).toBe(false);
    expect(preflightComposerChatAttachment("sample.exe", { workspacePdf: true }).ok).toBe(false);
  });
});

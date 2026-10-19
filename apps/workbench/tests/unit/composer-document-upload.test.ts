import { describe, expect, test } from "bun:test";
import { uploadComposerDocument, workspaceAttachmentsForSend } from "../../src/lib/composer-document-upload";
import { preflightComposerChatAttachment } from "../../src/lib/composer-attachment-preflight";

describe("Document composer uploads", () => {
  test("PDFs use Room-scoped Workspace admission and never overwrite a filename", async () => {
    const uploads: unknown[] = [];
    const upload = async (_blob: Blob, options: unknown) => {
      uploads.push(options);
      return { artifactId: `artifact-${uploads.length}` };
    };
    const blob = new Blob(["synthetic PDF bytes"]);
    const first = await uploadComposerDocument({ id: "first", blob, filename: "sample.pdf", roomId: "room-a" }, upload);
    await uploadComposerDocument({ id: "second", blob, filename: "sample.pdf", roomId: "room-a" }, upload);
    expect(first).toEqual({ artifactId: "artifact-1", roomId: "room-a" });
    expect(uploads).toEqual([
      { path: "Attachments/first/sample.pdf", roomId: "room-a", mimeType: "application/pdf" },
      { path: "Attachments/second/sample.pdf", roomId: "room-a", mimeType: "application/pdf" },
    ]);
    const error = await uploadComposerDocument({ id: "missing-room", blob, filename: "sample.pdf" }, upload).catch((reason: unknown) => reason);
    expect(String(error)).toContain("Select a room");
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

  test("only composers with Workspace ingestion admit documents", () => {
    for (const name of ["sample.PDF", "sample.docx", "sample.xlsx", "sample.pptx"]) {
      expect(preflightComposerChatAttachment(name, { workspaceDocuments: true })).toEqual({ ok: true });
      expect(preflightComposerChatAttachment(name).ok).toBe(false);
    }
    for (const name of ["sample.csv", "sample.txt", "sample.png", "sample.wav"]) {
      expect(preflightComposerChatAttachment(name, { workspaceDocuments: true })).toEqual({ ok: true });
      expect(preflightComposerChatAttachment(name)).toEqual({ ok: true });
    }
    expect(preflightComposerChatAttachment("sample.exe", { workspaceDocuments: true }).ok).toBe(false);
  });
  test("Office selections preserve filename, MIME and Room-scoped artifact identity", async () => {
    for (const [extension, mimeType] of [
      ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ]) {
      const calls: unknown[] = [];
      const result = await uploadComposerDocument({ id: "selection", blob: new Blob(["synthetic"]), filename: `report.${extension}`, roomId: "room-a" },
        async (_blob, options) => { calls.push(options); return { artifactId: "office-artifact" }; });
      expect(calls).toEqual([{ path: `Attachments/selection/report.${extension}`, mimeType, roomId: "room-a" }]);
      expect(result).toEqual({ artifactId: "office-artifact", roomId: "room-a" });
      expect(workspaceAttachmentsForSend([{ id: "selection", name: `report.${extension}`, path: "", rootPath: "", status: "queued", workspaceArtifact: result }], "room-a"))
        .toEqual({ ok: true, refs: [{ kind: "workspace-artifact", artifactId: "office-artifact" }] });
    }
  });
});

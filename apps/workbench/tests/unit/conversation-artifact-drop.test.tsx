import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  classifyComposerDrop,
  localFileFocusedResourceLabel,
  NAUTILO_ARTIFACT_REF_MIME,
} from "../../src/lib/composer-paste-file";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const conversationSource = readFileSync(`${repoRoot}src/components/conversation.tsx`, "utf8");
const composerDropHandler = conversationSource.slice(
  conversationSource.indexOf("const handleComposerDrop"),
  conversationSource.indexOf("const handlePaperclipClick"),
);

describe("Conversation artifact drops", () => {
  test("browser composer keeps artifact drops and native file drops reachable", () => {
    expect(composerDropHandler).not.toMatch(/handleComposerDrop[\s\S]{0,180}\{\s*if \(!isDesktop\) return;/);
    expect(conversationSource).toContain('type="file"');
    expect(conversationSource).toContain('aria-label="Attach files"');
    expect(conversationSource).toContain("queueBrowserComposerFiles");
  });

  test("labels local-file focus as non-shareable context", () => {
    expect(localFileFocusedResourceLabel("mini-cloud-master-plan.md")).toBe(
      "@mini-cloud-master-plan.md · Agent context only",
    );
  });

  test("a drag carrying artifact MIME and FileList stays on the artifact path", () => {
    const artifactPayload = {
      kind: "artifact",
      artifactId: "workspace/notes.txt",
      path: "notes.txt",
      mimeType: "text/plain",
      size: 128,
    };
    const dataTransfer = {
      types: [NAUTILO_ARTIFACT_REF_MIME, "Files"],
      files: [{ name: "notes.txt", size: 128 }],
      getData: (type: string) =>
        type === NAUTILO_ARTIFACT_REF_MIME ? JSON.stringify(artifactPayload) : "",
    } as unknown as DataTransfer;

    expect(classifyComposerDrop(dataTransfer)).toEqual({
      kind: "artifact-ref",
      payload: artifactPayload,
    });

    const artifactBranch = composerDropHandler.indexOf('if (dispatch.kind === "artifact-ref")');
    const nativeFileBranch = composerDropHandler.indexOf("if (e.dataTransfer.files.length > 0)");

    expect(artifactBranch).toBeGreaterThanOrEqual(0);
    expect(nativeFileBranch).toBeGreaterThan(artifactBranch);

    const artifactHandling = composerDropHandler.slice(artifactBranch, nativeFileBranch);
    expect(artifactHandling).toContain("artifactId: dispatch.payload.artifactId");
    expect(artifactHandling).toContain("addFocusedResource");
    expect(artifactHandling).toContain("return;");
    expect(artifactHandling).not.toContain("preflightComposerChatAttachment");
    expect(artifactHandling).not.toContain("uploadComposerBlob");
  });

  test("internal Files MIME creates focus refs without D271 byte access", () => {
    const localBranch = composerDropHandler.slice(
      composerDropHandler.indexOf('if (dispatch.kind === "ignore")'),
    );
    expect(localBranch).toContain('kind: "local-file"');
    expect(localBranch).toContain("addFocusedResource");
    expect(localBranch).not.toContain("readFileBase64");
    expect(localBranch).not.toContain("uploadComposerAttachment");
    expect(localBranch).not.toContain("uploadComposerBlob");
  });
});

import { expect, test } from "bun:test";

test("source route owns the only mobile artifact save contract", async () => {
  const source = await Bun.file(
    new URL("../../app/files/artifact/edit/[id].tsx", import.meta.url),
  ).text();
  expect(source).toContain("content: session.buffer.current.current");
  expect(source).toContain("mimeType: document.artifact.mimeType");
  // The route retains roomId only to return to the same viewer/discussion;
  // save authority is deliberately aggregate, matching the editor admission.
  expect(source).not.toContain("roomId={roomId}");
  expect(source).not.toMatch(/loadArtifactForEdit\(\{[^}]*roomId/);
  expect(source).not.toContain("...(roomId ? { roomId } : {}),\n        checkpoint: true");
  expect(source).toContain("checkpoint: true");
  expect(source).toContain("sha256: ready.baseSha256");
  expect(source).toContain(
    "commitNativeSourceBaseline(session.buffer.current, result.acceptedContent)",
  );
  expect(source).toContain(
    'saveState={conflicted || writeCapabilityDenied ? "unavailable" : saveState}',
  );
  expect(source).toContain(
    "Clipboard.setStringAsync(session.buffer.current.current)",
  );
  expect(source).toContain('"Reload latest?"');
  expect(source).toContain("session.buffer.current.current !== captured");
  expect(source).toContain("controller.resolveConflictWithLatest");
  expect(source).toContain(
    "replaceNativeSourceDocument(session, latest.admission.content)",
  );
  expect(source).not.toMatch(
    /WriterArtifactEditor|ArtifactWriterSaveController|IosWriterEditor|serializeIosWriterEdit|EnrichedTextInput|WebView|forceSave/,
  );
});

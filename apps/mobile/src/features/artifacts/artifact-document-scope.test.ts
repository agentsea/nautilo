import { expect, test } from "bun:test";
import { artifactDocumentScope } from "./artifact-document-scope";

test("file authority changes reset the complete session even at an equal revision", () => {
  const base = artifactDocumentScope("server", "https://server.example", "alice", "artifact");
  expect(artifactDocumentScope("server", "https://server.example", "alice", "artifact")).toBe(base);
  for (const next of [
    artifactDocumentScope("other", "https://server.example", "alice", "artifact"),
    artifactDocumentScope("server", "https://other.example", "alice", "artifact"),
    artifactDocumentScope("server", "https://server.example", "bob", "artifact"),
    artifactDocumentScope("server", "https://server.example", "alice", "other"),
    artifactDocumentScope("server", "https://server.example", undefined, "artifact"),
  ]) expect(next).not.toBe(base);
});

test("scope components cannot collide through delimiter-containing identities", () => {
  expect(artifactDocumentScope("a:b", "c", "d", "e")).not.toBe(artifactDocumentScope("a", "b:c", "d", "e"));
});

test("the route keys all file state by authority and the native reader adds revision and attempt fences", async () => {
  const route = await Bun.file(new URL("../../app/files/artifact/[id].tsx", import.meta.url)).text();
  const native = await Bun.file(new URL("./artifact-document-preview.native.tsx", import.meta.url)).text();
  expect(route).toContain("<ArtifactViewerSession key={scope}");
  expect(route).toContain("<ArtifactDocumentPreview key={result.artifact.revision}");
  expect(native).toContain("liveGeneration.current === generation");
  expect(native).toContain("liveGeneration.current !== generation");
  expect(native).toContain("installed.source !== source");
  expect(native).toContain("<StaticDocument key={installed.generation}");
  // Fabric reads this as vector<string> on Android even though the public
  // iOS-facing prop type also admits a string. A string aborts the native app.
  expect(native).toContain('dataDetectorTypes={["none"]}');
  expect(native).not.toContain("injectedJavaScript");
  expect(native).not.toContain("onMessage=");
  for (const prop of ["javaScriptEnabled", "domStorageEnabled", "geolocationEnabled", "allowFileAccess", "allowFileAccessFromFileURLs", "allowUniversalAccessFromFileURLs", "sharedCookiesEnabled", "thirdPartyCookiesEnabled"]) expect(native).toContain(`${prop}={false}`);
});

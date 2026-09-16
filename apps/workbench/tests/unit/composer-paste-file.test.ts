import { afterEach, describe, expect, test } from "bun:test";
import {
  classifyComposerDrop,
  classifyComposerPathForChat,
  flattenNautiloFileRefs,
  NAUTILO_ARTIFACT_REF_MIME,
  NAUTILO_FILE_REF_MIME,
  parseNautiloArtifactRefDataTransfer,
  parseNautiloFileRefDataTransfer,
  queueFileAttachmentFromPath,
} from "../../src/lib/composer-paste-file";
import { clearAttachments, getAttachments } from "../../src/adapters/composer-attachments-ref";

function fakeDataTransfer(raw: string): DataTransfer {
  return {
    types: [NAUTILO_FILE_REF_MIME] as ReadonlyArray<string>,
    getData: (type: string) => (type === NAUTILO_FILE_REF_MIME ? raw : ""),
  } as unknown as DataTransfer;
}

function fakeArtifactDataTransfer(raw: string): DataTransfer {
  return {
    types: [NAUTILO_ARTIFACT_REF_MIME] as ReadonlyArray<string>,
    getData: (type: string) => (type === NAUTILO_ARTIFACT_REF_MIME ? raw : ""),
  } as unknown as DataTransfer;
}

function fakeBothDataTransfer(fileRaw: string, artifactRaw: string): DataTransfer {
  return {
    types: [NAUTILO_FILE_REF_MIME, NAUTILO_ARTIFACT_REF_MIME] as ReadonlyArray<string>,
    getData: (type: string) => {
      if (type === NAUTILO_FILE_REF_MIME) return fileRaw;
      if (type === NAUTILO_ARTIFACT_REF_MIME) return artifactRaw;
      return "";
    },
  } as unknown as DataTransfer;
}

describe("queueFileAttachmentFromPath", () => {
  afterEach(() => {
    clearAttachments();
  });

  test("does not chip unsupported extensions", async () => {
    const r = await queueFileAttachmentFromPath("/tmp/project/readme.pdf", "/tmp/project");
    expect(r.ok).toBe(false);
    if (!r.ok && "code" in r) {
      expect(r.code).toBe("unsupported");
    }
    expect(getAttachments().length).toBe(0);
  });

  test("queues supported markdown paths", async () => {
    const r = await queueFileAttachmentFromPath("/tmp/project/readme.md", "/tmp/project");
    expect(r.ok).toBe(true);
    expect(getAttachments().length).toBe(1);
  });
});

describe("composer file-ref payload parsing", () => {
  test("parses the legacy single-file payload", () => {
    const payload = parseNautiloFileRefDataTransfer(
      fakeDataTransfer(JSON.stringify({
        rootPath: "/tmp/project",
        path: "/tmp/project/README.md",
      })),
    );

    expect(payload).toEqual({
      rootPath: "/tmp/project",
      path: "/tmp/project/README.md",
    });
    expect(payload && flattenNautiloFileRefs(payload)).toEqual([
      { rootPath: "/tmp/project", path: "/tmp/project/README.md" },
    ]);
  });

  test("parses multi-file payloads and drops invalid paths", () => {
    const payload = parseNautiloFileRefDataTransfer(
      fakeDataTransfer(JSON.stringify({
        files: [
          { rootPath: "/tmp/project", path: "/tmp/project/a.md" },
          { rootPath: "/tmp/project", path: "/tmp/other/b.md" },
          { rootPath: "/tmp/project", path: "/tmp/project/c.ts" },
        ],
      })),
    );

    expect(payload && flattenNautiloFileRefs(payload)).toEqual([
      { rootPath: "/tmp/project", path: "/tmp/project/a.md" },
      { rootPath: "/tmp/project", path: "/tmp/project/c.ts" },
    ]);
  });

  test("rejects empty or malformed payloads", () => {
    expect(parseNautiloFileRefDataTransfer(fakeDataTransfer(""))).toBeNull();
    expect(parseNautiloFileRefDataTransfer(fakeDataTransfer("{bad"))).toBeNull();
    expect(
      parseNautiloFileRefDataTransfer(
        fakeDataTransfer(JSON.stringify({ files: [] })),
      ),
    ).toBeNull();
  });
});

describe("composer artifact-ref payload parsing (D356)", () => {
  const validPayload = {
    kind: "artifact",
    artifactId: "reports/q3.md",
    path: "reports/q3.md",
    mimeType: "text/markdown",
    size: 42,
  };

  test("parses a valid artifact-ref payload (external artifactId + metadata)", () => {
    const got = parseNautiloArtifactRefDataTransfer(
      fakeArtifactDataTransfer(JSON.stringify(validPayload)),
    );
    expect(got).toEqual(validPayload);
  });

  test("coerces missing optional fields (mime default, size 0, empty path)", () => {
    const got = parseNautiloArtifactRefDataTransfer(
      fakeArtifactDataTransfer(JSON.stringify({ kind: "artifact", artifactId: "id-only" })),
    );
    expect(got).toEqual({
      kind: "artifact",
      artifactId: "id-only",
      path: "",
      mimeType: "application/octet-stream",
      size: 0,
    });
  });

  test("returns null when MIME is absent (FS-only drag)", () => {
    expect(
      parseNautiloArtifactRefDataTransfer(
        fakeDataTransfer(JSON.stringify({ rootPath: "/x", path: "/x/a.md" })),
      ),
    ).toBeNull();
  });

  test("returns null for malformed payload / missing artifactId", () => {
    expect(parseNautiloArtifactRefDataTransfer(fakeArtifactDataTransfer(""))).toBeNull();
    expect(parseNautiloArtifactRefDataTransfer(fakeArtifactDataTransfer("{bad"))).toBeNull();
    expect(
      parseNautiloArtifactRefDataTransfer(
        fakeArtifactDataTransfer(JSON.stringify({ kind: "wrong", artifactId: "x" })),
      ),
    ).toBeNull();
    expect(
      parseNautiloArtifactRefDataTransfer(
        fakeArtifactDataTransfer(JSON.stringify({ kind: "artifact", artifactId: "" })),
      ),
    ).toBeNull();
  });
});

describe("classifyComposerDrop precedence (D356)", () => {
  const artifactPayload = JSON.stringify({
    kind: "artifact",
    artifactId: "a/1",
    path: "a/1.md",
    mimeType: "text/markdown",
    size: 7,
  });

  test("artifact-ref MIME → artifact-ref dispatch (no upload)", () => {
    const r = classifyComposerDrop(fakeArtifactDataTransfer(artifactPayload));
    expect(r.kind).toBe("artifact-ref");
    if (r.kind === "artifact-ref") {
      expect(r.payload.artifactId).toBe("a/1");
      expect(r.payload.path).toBe("a/1.md");
    }
  });

  test("FS-ref only → file-ref dispatch", () => {
    const r = classifyComposerDrop(
      fakeDataTransfer(JSON.stringify({ rootPath: "/p", path: "/p/a.md" })),
    );
    expect(r.kind).toBe("file-ref");
  });

  test("when BOTH MIMEs are present, artifact wins", () => {
    const r = classifyComposerDrop(
      fakeBothDataTransfer(JSON.stringify({ rootPath: "/p", path: "/p/a.md" }), artifactPayload),
    );
    expect(r.kind).toBe("artifact-ref");
  });

  test("neither MIME → ignore", () => {
    const r = classifyComposerDrop({
      types: [],
      getData: () => "",
    } as unknown as DataTransfer);
    expect(r).toEqual({ kind: "ignore" });
  });

  test("null DataTransfer → ignore", () => {
    expect(classifyComposerDrop(null)).toEqual({ kind: "ignore" });
  });

  test("artifact dispatch does NOT touch the attachment (upload) store", () => {
    clearAttachments();
    const r = classifyComposerDrop(fakeArtifactDataTransfer(artifactPayload));
    expect(r.kind).toBe("artifact-ref");
    expect(getAttachments().length).toBe(0);
  });
});

describe("classifyComposerPathForChat", () => {
  test("prefers workspace when the path is under both roots", () => {
    expect(
      classifyComposerPathForChat("/ws/nested/x.txt", "/ws", "/ws/nested"),
    ).toEqual({
      zone: "workspace",
      rootPath: "/ws",
      requestPath: "nested/x.txt",
    });
  });

  test("uses current folder when not under workspace", () => {
    expect(
      classifyComposerPathForChat("/task/foo.md", "/ws", "/task"),
    ).toEqual({
      zone: "current",
      rootPath: "/task",
      requestPath: "foo.md",
    });
  });

  test("uses absolute zone when under neither root", () => {
    expect(
      classifyComposerPathForChat("/other/z.md", "/ws", "/task"),
    ).toEqual({
      zone: "absolute",
      rootPath: "/other/z.md",
      requestPath: "/other/z.md",
    });
  });
});

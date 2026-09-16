/**
 * D356 — artifact reference parse guard. Pins the wire contract for
 * metadata-only "focus on these artifacts" refs: shape, bounds, control-char
 * rejection, and that identity is the EXTERNAL artifactId (not the internal
 * row uuid). The resolver is DB-backed, so this isolated suite also pins that
 * unavailable or unauthorized refs never become trusted prompt context.
 */
import { describe, expect, mock, test } from "bun:test";
import * as actualDb from "@nautilo/db";

const lookupCalls: Array<{ artifactId: string; readableNamespaceIds: string[] }> = [];
const findArtifactByIdForNamespacesMock = mock(
  async ({
    artifactId,
    readableNamespaceIds,
  }: {
    artifactId: string;
    readableNamespaceIds: string[];
  }) => {
    lookupCalls.push({ artifactId, readableNamespaceIds });
    if (artifactId === "permitted-artifact" && readableNamespaceIds.includes("namespace-readable")) {
      return {
        artifactId,
        path: "authoritative/report.pdf",
        mimeType: "application/pdf",
        size: 2048,
      };
    }
    if (artifactId === "unauthorized-artifact" && readableNamespaceIds.includes("namespace-private")) {
      return {
        artifactId,
        path: "authoritative/private.txt",
        mimeType: "text/plain",
        size: 512,
      };
    }
    return null;
  },
);

mock.module("@nautilo/db", () => ({
  ...actualDb,
  findArtifactByIdForNamespaces: findArtifactByIdForNamespacesMock,
}));

const { parseChatArtifactRefs, resolveChatArtifactRefs } = await import(
  "../../src/messaging/artifact-refs"
);

describe("parseChatArtifactRefs", () => {
  test("empty / null → []", () => {
    expect(parseChatArtifactRefs(undefined)).toEqual([]);
    expect(parseChatArtifactRefs(null)).toEqual([]);
  });

  test("parses well-formed refs and preserves external artifactId (may contain '/')", () => {
    const out = parseChatArtifactRefs([
      { artifactId: "reports/q3.xlsx", path: "reports/q3.xlsx", mimeType: "application/vnd.ms-excel", size: 1024 },
    ]);
    expect(out).toEqual([
      { artifactId: "reports/q3.xlsx", path: "reports/q3.xlsx", mimeType: "application/vnd.ms-excel", size: 1024 },
    ]);
  });

  test("non-array throws", () => {
    expect(() => parseChatArtifactRefs({ artifactId: "x" })).toThrow();
  });

  test("missing/empty artifactId throws", () => {
    expect(() => parseChatArtifactRefs([{ path: "p", mimeType: "text/plain", size: 1 }])).toThrow();
    expect(() => parseChatArtifactRefs([{ artifactId: "", path: "p", mimeType: "text/plain", size: 1 }])).toThrow();
  });

  test("control chars in artifactId throw", () => {
    expect(() =>
      parseChatArtifactRefs([{ artifactId: "bad\u0000id", path: "p", mimeType: "text/plain", size: 1 }]),
    ).toThrow();
  });

  test("over-cap array throws", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      artifactId: `a${i}`,
      path: `a${i}.txt`,
      mimeType: "text/plain",
      size: 1,
    }));
    expect(() => parseChatArtifactRefs(many)).toThrow();
  });

  test("missing optional fields are coerced (mime default, size 0)", () => {
    const out = parseChatArtifactRefs([{ artifactId: "id-only" }]);
    expect(out[0]).toEqual({
      artifactId: "id-only",
      path: "",
      mimeType: "application/octet-stream",
      size: 0,
    });
  });

  test("negative / non-finite size coerced to 0", () => {
    const out = parseChatArtifactRefs([
      { artifactId: "a", path: "a", mimeType: "text/plain", size: -5 },
    ]);
    expect(out[0]!.size).toBe(0);
  });

  test("drops missing and unreadable refs rather than trusting client metadata", async () => {
    lookupCalls.length = 0;
    const resolved = await resolveChatArtifactRefs({
      refs: [
        {
          artifactId: "permitted-artifact",
          path: "spoofed/allowed.pdf",
          mimeType: "text/html",
          size: 1,
        },
        {
          artifactId: "missing-artifact",
          path: "spoofed/missing.txt",
          mimeType: "text/html",
          size: 1,
        },
        {
          artifactId: "unauthorized-artifact",
          path: "spoofed/private.txt",
          mimeType: "text/html",
          size: 1,
        },
      ],
      readableNamespaceIds: ["namespace-readable"],
    });

    expect(lookupCalls).toEqual([
      { artifactId: "permitted-artifact", readableNamespaceIds: ["namespace-readable"] },
      { artifactId: "missing-artifact", readableNamespaceIds: ["namespace-readable"] },
      { artifactId: "unauthorized-artifact", readableNamespaceIds: ["namespace-readable"] },
    ]);
    expect(resolved).toEqual([
      {
        artifactId: "permitted-artifact",
        path: "authoritative/report.pdf",
        mimeType: "application/pdf",
        size: 2048,
      },
    ]);
    expect(resolved).not.toContainEqual(
      expect.objectContaining({ artifactId: "missing-artifact" }),
    );
    expect(resolved).not.toContainEqual(
      expect.objectContaining({ artifactId: "unauthorized-artifact" }),
    );
  });
});

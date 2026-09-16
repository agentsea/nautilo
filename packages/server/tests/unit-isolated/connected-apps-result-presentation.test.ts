import { describe, expect, test } from "bun:test";
import type { ConnectedAppResultPresentationContract } from "@nautilo/types";
import {
  ConnectedAppResultMediaError,
  ConnectedAppResultPresenter,
  deriveConnectedAppPreviewKey,
} from "../../src/connected-apps/result-presentation";

const SCOPE = {
  userId: "11111111-1111-4111-8111-111111111111",
  namespaceId: "22222222-2222-4222-8222-222222222222",
} as const;

const ENTITY_CONTRACT: ConnectedAppResultPresentationContract = {
  kind: "entity",
  titlePointer: "/design/title",
  fallbackTitle: "Canva design",
  subtitlePointer: "/design/id",
  image: {
    pointer: "/design/thumbnailUrl",
    allowedHosts: ["media.canva.com"],
    alt: "Design preview",
    widthPointer: "/design/thumbnailWidth",
    heightPointer: "/design/thumbnailHeight",
  },
  links: [
    { label: "Open in Canva", pointer: "/design/viewUrl", allowedHosts: ["www.canva.com"] },
    { label: "Edit in Canva", pointer: "/design/editUrl", allowedHosts: ["www.canva.com"] },
  ],
};

const ARTIFACT_CONTRACT: ConnectedAppResultPresentationContract = {
  kind: "artifact_import",
  identityPointer: "/job/id",
  statusPointer: "/job/status",
  readyValue: "success",
  failedValue: "failed",
  urlsPointer: "/job/urls",
  allowedHosts: ["export-download.canva.com"],
};

const TRANSIT_ARTIFACT_CONTRACT: ConnectedAppResultPresentationContract = {
  kind: "transit_artifact_import",
  filePointer: "/file",
  fileIdPointer: "/file/fileId",
  namePointer: "/file/name",
  mimeTypePointer: "/file/mimeType",
  sizeBytesPointer: "/file/sizeBytes",
};

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

describe("connected-app result presentation", () => {
  test("projects safe entity fields, hides the remote image URL, and binds preview access to exact scope", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const presenter = new ConnectedAppResultPresenter((async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: requestUrl(input), init });
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png", "content-length": "3" },
      });
    }) as unknown as typeof fetch);

    const projected = await presenter.project({
      scope: SCOPE,
      providerId: "canva",
      executionId: "execution-A",
      contract: ENTITY_CONTRACT,
      result: {
        design: {
          id: "DAH-test",
          title: "Launch graphic",
          thumbnailUrl: "https://media.canva.com/preview.png",
          thumbnailWidth: 640,
          thumbnailHeight: 480,
          viewUrl: "https://www.canva.com/design/DAH-test/view",
          editUrl: "https://www.canva.com/design/DAH-test/edit",
        },
      },
    });

    expect(JSON.stringify(projected.result)).not.toContain("media.canva.com");
    expect(projected.presentation).toMatchObject({
      kind: "entity",
      title: "Launch graphic",
      subtitle: "DAH-test",
      preview: { alt: "Design preview", width: 640, height: 480 },
      links: [
        { label: "Open in Canva", url: "https://www.canva.com/design/DAH-test/view" },
        { label: "Edit in Canva", url: "https://www.canva.com/design/DAH-test/edit" },
      ],
    });
    expect(calls).toHaveLength(0);
    if (projected.presentation.kind !== "entity" || !projected.presentation.preview) {
      throw new Error("expected an entity preview");
    }

    const media = await presenter.readPreview({ scope: SCOPE, ref: projected.presentation.preview.ref });
    expect(media.contentType).toBe("image/png");
    const bytes: number[] = [];
    for await (const chunk of media.chunks) bytes.push(...chunk);
    expect(bytes).toEqual([1, 2, 3]);
    expect(calls).toEqual([{
      url: "https://media.canva.com/preview.png",
      init: { method: "GET", redirect: "error", credentials: "omit" },
    }]);

    const denied = await presenter.readPreview({
      scope: { ...SCOPE, namespaceId: "33333333-3333-4333-8333-333333333333" },
      ref: projected.presentation.preview.ref,
    }).catch((cause: unknown) => cause);
    expect(denied).toBeInstanceOf(ConnectedAppResultMediaError);
    expect(denied).toMatchObject({ code: "connected_app_preview_not_found", status: 404 });
    expect(calls).toHaveLength(1);
  });

  test("keeps opaque preview references valid across presenter restarts with the deployment key", async () => {
    const fetchPreview = (async () => new Response(new Uint8Array([9, 8, 7]), {
      headers: { "content-type": "image/png" },
    })) as unknown as typeof fetch;
    const stableKey = deriveConnectedAppPreviewKey("test deployment secret with more than thirty-two bytes");
    const beforeRestart = new ConnectedAppResultPresenter(fetchPreview, stableKey);
    const projected = await beforeRestart.project({
      scope: SCOPE,
      providerId: "canva",
      executionId: "execution-restart",
      contract: ENTITY_CONTRACT,
      result: {
        design: {
          title: "Durable preview",
          thumbnailUrl: "https://media.canva.com/restart.png",
        },
      },
    });
    if (projected.presentation.kind !== "entity" || !projected.presentation.preview) {
      throw new Error("expected an entity preview");
    }

    const afterRestart = new ConnectedAppResultPresenter(fetchPreview, stableKey);
    const media = await afterRestart.readPreview({
      scope: SCOPE,
      ref: projected.presentation.preview.ref,
    });
    const bytes: number[] = [];
    for await (const chunk of media.chunks) bytes.push(...chunk);
    expect(bytes).toEqual([9, 8, 7]);

    const wrongDeployment = new ConnectedAppResultPresenter(
      fetchPreview,
      deriveConnectedAppPreviewKey("a different deployment secret with more than thirty-two bytes"),
    );
    const denied = await wrongDeployment.readPreview({
      scope: SCOPE,
      ref: projected.presentation.preview.ref,
    }).catch((cause: unknown) => cause);
    expect(denied).toMatchObject({ code: "connected_app_preview_not_found", status: 404 });
  });

  test("drops catalogue-mismatched remote hosts instead of creating fetchable capabilities", async () => {
    const presenter = new ConnectedAppResultPresenter((async () => {
      throw new Error("must not fetch");
    }) as unknown as typeof fetch);
    const projected = await presenter.project({
      scope: SCOPE,
      providerId: "canva",
      executionId: "execution-B",
      contract: ENTITY_CONTRACT,
      result: {
        design: {
          id: "DAH-host-mismatch",
          title: "Untrusted URLs",
          thumbnailUrl: "https://attacker.example/preview.png",
          viewUrl: "https://attacker.example/view",
          editUrl: "https://www.canva.com/design/DAH-host-mismatch/edit#fragment",
        },
      },
    });
    expect(projected.presentation).toMatchObject({ kind: "entity", preview: null, links: [] });
    expect(JSON.stringify(projected.result)).not.toContain("attacker.example/preview.png");
  });

  test("streams completed exports into the Room artifact lane and removes download URLs from the receipt", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const presenter = new ConnectedAppResultPresenter((async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({ url: requestUrl(input), init });
      return new Response(new Uint8Array([37, 80, 68, 70]), {
        headers: { "content-type": "application/pdf" },
      });
    }) as unknown as typeof fetch);
    const imports: Array<{ logicalPath: string; mimeType: string; bytes: number[] }> = [];

    const projected = await presenter.project({
      scope: SCOPE,
      providerId: "canva",
      executionId: "invocation-A",
      contract: ARTIFACT_CONTRACT,
      result: {
        job: {
          id: "job-A",
          status: "success",
          urls: ["https://export-download.canva.com/file.pdf"],
        },
      },
      artifactImporter: async ({ logicalPath, mimeType, chunks }) => {
        const bytes: number[] = [];
        for await (const chunk of chunks) bytes.push(...chunk);
        imports.push({ logicalPath, mimeType, bytes });
        return { artifactId: "artifact-A", path: logicalPath, mime: mimeType, bytes: bytes.length };
      },
    });

    expect(JSON.stringify(projected.result)).not.toContain("export-download.canva.com");
    expect(projected.result).toEqual({ job: { id: "job-A", status: "success" } });
    expect(projected.presentation).toEqual({
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
    });
    expect(imports).toEqual([{
      logicalPath: "connected-apps/canva/export-job-A-1.pdf",
      mimeType: "application/pdf",
      bytes: [37, 80, 68, 70],
    }]);
    expect(requests).toEqual([{
      url: "https://export-download.canva.com/file.pdf",
      init: { method: "GET", redirect: "error", credentials: "omit" },
    }]);
  });

  test("does not download pending exports and reports completed import failures truthfully", async () => {
    let requests = 0;
    const presenter = new ConnectedAppResultPresenter((async () => {
      requests += 1;
      return new Response("unavailable", { status: 502 });
    }) as unknown as typeof fetch);
    const pending = await presenter.project({
      scope: SCOPE,
      providerId: "canva",
      executionId: "job-pending",
      contract: ARTIFACT_CONTRACT,
      result: { job: { status: "in_progress", urls: ["https://export-download.canva.com/later.pdf"] } },
    });
    expect(pending.presentation).toMatchObject({ kind: "artifact_import", state: "pending", artifacts: [] });
    expect(requests).toBe(0);

    const failedImport = await presenter.project({
      scope: SCOPE,
      providerId: "canva",
      executionId: "job-complete",
      contract: ARTIFACT_CONTRACT,
      result: { job: { status: "success", urls: ["https://export-download.canva.com/missing.pdf"] } },
      artifactImporter: async () => null,
    });
    expect(failedImport.presentation).toMatchObject({
      kind: "artifact_import",
      state: "import_failed",
      errorCode: "connected_app_artifact_import_failed",
      artifacts: [],
    });
    expect(requests).toBe(1);
  });

  test("imports an OpenConnector transit file without exposing its temporary URL or bytes to Genie", async () => {
    const presenter = new ConnectedAppResultPresenter((async () => {
      throw new Error("public fetch must not run for local transit files");
    }) as unknown as typeof fetch);
    const observed: number[] = [];
    const disposed: string[] = [];
    const projected = await presenter.project({
      scope: SCOPE,
      providerId: "dropbox",
      executionId: "dropbox-download-A",
      contract: TRANSIT_ARTIFACT_CONTRACT,
      result: {
        fileId: "id:provider-file",
        name: "report.pdf",
        file: {
          fileId: "a".repeat(32) + ".pdf",
          downloadUrl: `http://127.0.0.1:3000/api/files/${"a".repeat(32)}.pdf`,
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4,
        },
      },
      transitFileReader: async ({ fileId }) => {
        expect(fileId).toBe("a".repeat(32) + ".pdf");
        return { chunks: (async function* () { yield Uint8Array.from([37, 80, 68, 70]); })() };
      },
      transitFileDisposer: async ({ fileId }) => { disposed.push(fileId); },
      artifactImporter: async ({ logicalPath, mimeType, chunks }) => {
        for await (const chunk of chunks) observed.push(...chunk);
        return { artifactId: "artifact-dropbox", path: logicalPath, mime: mimeType, bytes: observed.length };
      },
    });

    expect(projected.result).toEqual({ fileId: "id:provider-file", name: "report.pdf" });
    expect(projected.presentation).toEqual({
      version: 1,
      kind: "artifact_import",
      status: "ready",
      state: "ready",
      artifacts: [{
        artifactId: "artifact-dropbox",
        path: "connected-apps/dropbox/report.pdf",
        mime: "application/pdf",
        bytes: 4,
      }],
      errorCode: null,
    });
    expect(observed).toEqual([37, 80, 68, 70]);
    expect(disposed).toEqual(["a".repeat(32) + ".pdf"]);
    expect(JSON.stringify(projected)).not.toContain("downloadUrl");
  });

  test("fails a transit import when the streamed bytes do not match signed result metadata", async () => {
    const presenter = new ConnectedAppResultPresenter();
    const disposed: string[] = [];
    const projected = await presenter.project({
      scope: SCOPE,
      providerId: "dropbox",
      executionId: "dropbox-download-short",
      contract: TRANSIT_ARTIFACT_CONTRACT,
      result: {
        file: {
          fileId: "b".repeat(32),
          name: "short.bin",
          mimeType: "application/octet-stream",
          sizeBytes: 4,
        },
      },
      transitFileReader: async () => ({
        chunks: (async function* () { yield Uint8Array.from([1, 2, 3]); })(),
      }),
      transitFileDisposer: async ({ fileId }) => { disposed.push(fileId); },
      artifactImporter: async ({ chunks }) => {
        for await (const _chunk of chunks) { /* consume */ }
        return { artifactId: "must-not-return", path: "short.bin", mime: "application/octet-stream", bytes: 3 };
      },
    });
    expect(projected.presentation).toMatchObject({
      kind: "artifact_import",
      status: "import_failed",
      state: "import_failed",
      artifacts: [],
      errorCode: "connected_app_artifact_import_failed",
    });
    expect(disposed).toEqual(["b".repeat(32)]);
  });
});

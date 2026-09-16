/**
 * D144-P2 — `saveArtifactToDisk` + `downloadArtifact` (anchor / native branches).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { NautiloApiClient } from "@nautilo/api-client/browser";
import { saveArtifactToDisk } from "../../src/lib/save-to-disk";

// M126 follow-up: lazy-instantiate happy-dom inside `beforeAll`.
// Module-top-level `new HappyWindow()` pollutes globals during Bun's
// test-file collection phase (before any beforeAll/afterAll fires)
// and breaks subsequent test files' module evaluation on Linux Bun
// 1.3.11 with cascading "Export named X not found" errors against
// imported modules. The opt-in `tests/bun-dom-preload.ts` documents
// this; bringing this file in line.
let happyWindow: HappyWindow;

const priorGlobals: Record<string, unknown> = {};

beforeAll(() => {
  happyWindow = new HappyWindow({ url: "http://127.0.0.1:9/" });
  for (const k of ["window", "document"] as const) {
    priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
  });
});

afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) {
      delete g[key];
    } else {
      g[key] = priorGlobals[key];
    }
  }
});

describe("saveArtifactToDisk", () => {
  // happyWindow is constructed in the file-level `beforeAll`; bind to
  // document.createElement lazily inside each test rather than at
  // describe-time (which runs before beforeAll). Sibling URL.* binds
  // are static and safe at describe-time.
  let origCreateElement: typeof document.createElement;
  const origCreateObjectURL = URL.createObjectURL.bind(URL);
  const origRevokeObjectURL = URL.revokeObjectURL.bind(URL);

  test("uses showSaveDialog + writeFileBytes when both desktop bridges exist", async () => {
    const writes: Array<{ path: string; len: number }> = [];
    (happyWindow as unknown as { nautiloDesktop?: unknown }).nautiloDesktop = {
      dialog: {
        showSaveDialog: async () => ({ canceled: false, filePath: "/tmp/out.html" }),
      },
      fs: {
        writeFileBytes: async (path: string, data: ArrayBuffer) => {
          writes.push({ path, len: data.byteLength });
        },
      },
    };

    await saveArtifactToDisk(new Uint8Array([9, 8, 7]).buffer, "suggested.html");
    expect(writes).toEqual([{ path: "/tmp/out.html", len: 3 }]);
    delete (happyWindow as unknown as { nautiloDesktop?: unknown }).nautiloDesktop;
  });

  test("uses invisible anchor when desktop bridge is incomplete (dialog only)", async () => {
    origCreateElement = happyWindow.document.createElement.bind(happyWindow.document);
    (happyWindow as unknown as { nautiloDesktop?: unknown }).nautiloDesktop = {
      dialog: {
        showSaveDialog: async () => ({ canceled: false, filePath: "/x" }),
      },
    };

    let clickCount = 0;
    const anchor = happyWindow.document.createElement("a");
    anchor.click = () => {
      clickCount++;
    };
    happyWindow.document.createElement = ((tag: string) => {
      if (tag === "a") return anchor;
      return origCreateElement(tag);
    }) as typeof document.createElement;

    let created = "";
    URL.createObjectURL = () => {
      created = "blob:mock";
      return created;
    };
    let revoked = "";
    URL.revokeObjectURL = (u: string) => {
      revoked = u;
    };

    try {
      await saveArtifactToDisk(new Blob([new Uint8Array([1])]), "a.bin");
      expect(clickCount).toBe(1);
      expect(anchor.download).toBe("a.bin");
      expect(revoked).toBe("blob:mock");
      expect(created).toBe("blob:mock");
    } finally {
      happyWindow.document.createElement = origCreateElement;
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
      delete (happyWindow as unknown as { nautiloDesktop?: unknown }).nautiloDesktop;
    }
  });
});

describe("downloadArtifact (api client)", () => {
  test("GET /bytes with bearer then anchor-downloads suggested filename", async () => {
    const realFetch = globalThis.fetch;
    let bytesUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      const u = typeof input === "string" ? input : (input as URL).toString();
      if (u.includes("/bytes")) {
        bytesUrl = u;
        return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
      }
      return new Response("{}", { status: 500 });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    (happyWindow as unknown as { nautiloDesktop?: unknown }).nautiloDesktop = {};

    const origCreateElement = happyWindow.document.createElement.bind(happyWindow.document);
    let clickCount = 0;
    const anchor = happyWindow.document.createElement("a");
    anchor.click = () => {
      clickCount++;
    };
    happyWindow.document.createElement = ((tag: string) => {
      if (tag === "a") return anchor;
      return origCreateElement(tag);
    }) as typeof document.createElement;
    const origCreateObjectURL = URL.createObjectURL.bind(URL);
    const origRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = () => "blob:dl";
    URL.revokeObjectURL = () => {};

    try {
      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken("tok");
      await client.downloadArtifact("internal-99", "nice.html", { roomId: "r1" });
      expect(bytesUrl).toBe(
        "http://127.0.0.1:9/api/workspace/artifacts/internal-99/bytes?roomId=r1",
      );
      expect(clickCount).toBe(1);
      expect(anchor.download).toBe("nice.html");
    } finally {
      globalThis.fetch = realFetch;
      happyWindow.document.createElement = origCreateElement;
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
      delete (happyWindow as unknown as { nautiloDesktop?: unknown }).nautiloDesktop;
    }
  });
});

import { reapplyHappyDomGlobals } from "../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const getWorkspaceArtifact = mock(async (_id: string, _scope?: { roomId?: string }) => ({
  id: "11111111-1111-4111-8111-111111111111",
  path: "Design images/hero.png",
}));
const getWorkspaceArtifactBytes = mock(async (_id: string, _scope?: { roomId?: string }) => new Blob());
const createWorkspaceArtifact = mock(async (_file: Blob, options: { path: string; mimeType: string; roomId?: string }) => ({
  id: "11111111-1111-4111-8111-111111111111",
  path: options.path,
}));

mock.module("../lib/api", () => ({
  apiClient: {
    getWorkspaceArtifact,
    getWorkspaceArtifactBytes,
    createWorkspaceArtifact,
  },
}));

const {
  createAppImageAssets,
  parseImageAssetRef,
  rasterImageMime,
} = await import("./app-image-assets");

const PNG_BYTES = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
));

class TestFileReader {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((buffer) => {
      this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
      this.onload?.();
    }, () => this.onerror?.());
  }
}

class TestImage {
  src = "";
  naturalWidth = 1;
  naturalHeight = 1;
  async decode(): Promise<void> {
    if (imageDecodeError) throw imageDecodeError;
  }
}

let imageDecodeError: Error | null = null;

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
}

async function eventually(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw failure;
}

function uploadedFile(name: string, bytes = PNG_BYTES): File {
  const file = new Blob([bytes], { type: "application/octet-stream" }) as Blob & { name: string };
  file.name = name;
  return file as File;
}

function chooseFile(file: File): HTMLInputElement {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
  if (!input) throw new Error("The image input was not rendered.");
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.onchange?.(new Event("change"));
  return input;
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  (globalThis as { FileReader?: unknown }).FileReader = TestFileReader;
  (globalThis as { Image?: unknown }).Image = TestImage;
  imageDecodeError = null;
  getWorkspaceArtifact.mockClear();
  getWorkspaceArtifactBytes.mockClear();
  createWorkspaceArtifact.mockClear();
  getWorkspaceArtifact.mockImplementation(async (_id, _scope) => ({
    id: "11111111-1111-4111-8111-111111111111",
    path: "Design images/hero.png",
  }));
  getWorkspaceArtifactBytes.mockImplementation(async () => new Blob([PNG_BYTES]));
  createWorkspaceArtifact.mockImplementation(async (_file, options) => ({
    id: "11111111-1111-4111-8111-111111111111",
    path: options.path,
  }));
});

describe("image asset validation", () => {
  test("rejects spoofed references", () => {
    for (const ref of [
      "artifact:not-a-uuid:" + "0".repeat(64),
      "artifact:11111111-1111-0111-8111-111111111111:" + "0".repeat(64),
      "artifact:11111111-1111-4111-1111-111111111111:" + "0".repeat(64),
      "artifact:11111111-1111-4111-8111-111111111111:" + "A".repeat(64),
      "artifact:11111111-1111-4111-8111-111111111111:" + "0".repeat(64) + ":extra",
      "https://example.com/image.png",
    ]) {
      expect(() => parseImageAssetRef(ref)).toThrow("Invalid image reference");
    }
  });

  test("rejects content whose filename or declared type spoofs a raster signature", () => {
    expect(() => rasterImageMime(Uint8Array.from(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")))).toThrow(
      "Choose a PNG, JPEG, or WebP still image.",
    );
    expect(() => rasterImageMime(Uint8Array.from(Buffer.from("not really a jpeg")))).toThrow(
      "Choose a PNG, JPEG, or WebP still image.",
    );
  });

  test("accepts a complete still PNG and rejects PNG or WebP animation chunks", () => {
    expect(rasterImageMime(PNG_BYTES)).toBe("image/png");
    const animatedPng = new Uint8Array(PNG_BYTES.length + 12);
    animatedPng.set(PNG_BYTES.subarray(0, 33));
    animatedPng.set(Uint8Array.from(Buffer.from("\x00\x00\x00\x00acTL\x00\x00\x00\x00", "binary")), 33);
    animatedPng.set(PNG_BYTES.subarray(33), 45);
    expect(() => rasterImageMime(animatedPng)).toThrow("Animated images are not supported");

    const animatedWebp = Uint8Array.from(Buffer.from("RIFF\x0c\x00\x00\x00WEBPANIM\x00\x00\x00\x00", "binary"));
    expect(() => rasterImageMime(animatedWebp)).toThrow("Animated images are not supported");
    const flaggedWebp = Uint8Array.from(Buffer.from("524946460e0000005745425056503858020000000200", "hex"));
    expect(() => rasterImageMime(flaggedWebp)).toThrow("Animated images are not supported");
  });

  test("rejects raster chunk lengths that run beyond the supplied bytes", () => {
    const incompletePng = Uint8Array.from(Buffer.from("89504e470d0a1a0affffffff4948445200000000", "hex"));
    expect(() => rasterImageMime(incompletePng)).toThrow("The PNG is incomplete.");
    const incompleteWebp = Uint8Array.from(Buffer.from("524946460c0000005745425056503858ffffffff00", "hex"));
    expect(() => rasterImageMime(incompleteWebp)).toThrow("The WebP is incomplete.");
  });
});

describe("image asset authorization and placement", () => {
  test("does not upload a signature-only payload rejected by the image decoder", async () => {
    imageDecodeError = new Error("Image decode failed.");
    const assets = createAppImageAssets({ document });
    const picking = assets.pick();
    const input = chooseFile(uploadedFile(
      "spoofed.png",
      Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    ));
    await eventually(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toBe("Image decode failed.");
      expect(input.disabled).toBe(false);
    });
    expect(createWorkspaceArtifact).not.toHaveBeenCalled();
    (document.querySelector("button") as HTMLButtonElement).click();
    await expect(picking).resolves.toBeNull();
    assets.dispose();
  });

  test("canceling the chooser performs no upload or read", async () => {
    const assets = createAppImageAssets({ document });
    const picking = assets.pick();
    (document.querySelector("button") as HTMLButtonElement).click();
    await expect(picking).resolves.toBeNull();
    expect(createWorkspaceArtifact).not.toHaveBeenCalled();
    expect(getWorkspaceArtifact).not.toHaveBeenCalled();
    expect(getWorkspaceArtifactBytes).not.toHaveBeenCalled();
    assets.dispose();
  });

  test("disposing during local inspection prevents a later host upload", async () => {
    const assets = createAppImageAssets({ document });
    const picking = assets.pick();
    chooseFile(uploadedFile("closing.png"));
    assets.dispose();

    await expect(picking).resolves.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createWorkspaceArtifact).not.toHaveBeenCalled();
    expect(getWorkspaceArtifact).not.toHaveBeenCalled();
    expect(getWorkspaceArtifactBytes).not.toHaveBeenCalled();
  });

  test("rechecks authorization and exact bytes for every scoped read", async () => {
    const hash = await sha256(PNG_BYTES);
    const assets = createAppImageAssets({ roomId: "room-7", document });
    await expect(assets.read(`artifact:11111111-1111-4111-8111-111111111111:${hash}`)).resolves.toMatchObject({
      name: "Design images/hero.png",
      width: 1,
      height: 1,
      dataUrl: expect.stringContaining("data:image/png;base64,"),
    });
    expect(getWorkspaceArtifact).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", { roomId: "room-7" });
    expect(getWorkspaceArtifactBytes).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", { roomId: "room-7" });

    getWorkspaceArtifact.mockImplementationOnce(async () => null);
    await expect(assets.read(`artifact:11111111-1111-4111-8111-111111111111:${hash}`)).rejects.toThrow("deleted or is no longer accessible");
    expect(getWorkspaceArtifactBytes).toHaveBeenCalledTimes(1);
    assets.dispose();
  });

  test("rejects authorized bytes whose hash no longer matches the reference", async () => {
    const assets = createAppImageAssets({ document });
    await expect(assets.read(`artifact:11111111-1111-4111-8111-111111111111:${"0".repeat(64)}`)).rejects.toThrow(
      "This image changed in Workspace",
    );
    assets.dispose();
  });

  test("returns a placement only after upload readback verifies the stored bytes", async () => {
    const hash = await sha256(PNG_BYTES);
    const assets = createAppImageAssets({ roomId: "room-7", document });
    const picking = assets.pick();
    chooseFile(uploadedFile("hero.png"));

    await expect(picking).resolves.toEqual({
      ref: `artifact:11111111-1111-4111-8111-111111111111:${hash}`,
      name: "Design images/hero.png",
      width: 1,
      height: 1,
      dataUrl: `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`,
    });
    expect(createWorkspaceArtifact).toHaveBeenCalledTimes(1);
    expect(createWorkspaceArtifact.mock.calls[0]?.[1]).toMatchObject({
      path: expect.stringMatching(/^Design images\/[0-9a-f-]+\/hero\.png$/),
      mimeType: "image/png",
      roomId: "room-7",
    });
    expect(getWorkspaceArtifact).toHaveBeenCalledTimes(1);
    expect(getWorkspaceArtifactBytes).toHaveBeenCalledTimes(1);
    assets.dispose();
  });

  test("retries a confirmed upload readback without creating a duplicate artifact", async () => {
    createWorkspaceArtifact.mockImplementationOnce(async () => ({
      id: "11111111-1111-4111-8111-111111111111",
      path: "Canonical Design images/changed.png",
    }));
    getWorkspaceArtifactBytes.mockImplementationOnce(async () => new Blob([PNG_BYTES, Uint8Array.of(0)]));
    const assets = createAppImageAssets({ document });
    const picking = assets.pick();
    let settled = false;
    void picking.then(() => { settled = true; });
    const input = chooseFile(uploadedFile("changed.png"));

    await eventually(() => {
      const alert = document.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Image saved at Canonical Design images/changed.png");
      expect(alert?.textContent).toContain("placement could not finish");
      expect(input.disabled).toBe(true);
    });
    expect(settled).toBe(false);
    expect(createWorkspaceArtifact).toHaveBeenCalledTimes(1);
    const retry = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Retry placement");
    expect(retry).toBeDefined();
    (retry as HTMLButtonElement).click();
    await expect(picking).resolves.toMatchObject({
      ref: expect.stringContaining("artifact:11111111-1111-4111-8111-111111111111:"),
    });
    expect(createWorkspaceArtifact).toHaveBeenCalledTimes(1);
    expect(getWorkspaceArtifactBytes).toHaveBeenCalledTimes(2);
    assets.dispose();
  });

  test("does not offer a blind duplicate retry after a transport-uncertain upload failure", async () => {
    createWorkspaceArtifact.mockImplementationOnce(async () => {
      throw new Error("Connection closed before the response.");
    });
    const assets = createAppImageAssets({ document });
    const picking = assets.pick();
    let settled = false;
    void picking.then(() => { settled = true; });
    const input = chooseFile(uploadedFile("uncertain.png"));

    await eventually(() => {
      const alert = document.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("may have been saved at Design images/");
      expect(alert?.textContent).toContain("Check Workspace before uploading again");
      expect(input.disabled).toBe(true);
      expect((document.querySelector("button") as HTMLButtonElement).disabled).toBe(false);
    });
    expect(settled).toBe(false);
    expect(createWorkspaceArtifact).toHaveBeenCalledTimes(1);
    expect(getWorkspaceArtifact).not.toHaveBeenCalled();
    expect(getWorkspaceArtifactBytes).not.toHaveBeenCalled();
    (document.querySelector("button") as HTMLButtonElement).click();
    await expect(picking).resolves.toBeNull();
    assets.dispose();
  });
});

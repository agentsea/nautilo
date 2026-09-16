import { apiClient } from "../lib/api";

export type AppImageAsset = { ref: string; name: string; width: number; height: number; dataUrl: string };
const ASSET_REF = /^artifact:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([0-9a-f]{64})$/;

export function parseImageAssetRef(ref: string): { id: string; sha256: string } {
  const match = ASSET_REF.exec(ref);
  if (!match) throw new Error("Invalid image reference. Choose the image again.");
  return { id: match[1], sha256: match[2] };
}

/** Sniff raster MIME and reject animation before the browser decoder validates the pixels. */
export function rasterImageMime(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" {
  const word = (offset: number, length: number): string => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.length >= 8 && word(0, 8) === "\x89PNG\r\n\x1a\n") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      if (length > bytes.length - offset - 12) throw new Error("The PNG is incomplete.");
      if (word(offset + 4, 4) === "acTL") throw new Error("Animated images are not supported. Choose a still image.");
      offset += length + 12;
    }
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (word(0, 4) === "RIFF" && word(8, 4) === "WEBP") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const length = view.getUint32(offset + 4, true);
      if (length > bytes.length - offset - 8) throw new Error("The WebP is incomplete.");
      if (word(offset, 4) === "ANIM" || word(offset, 4) === "ANMF" || (word(offset, 4) === "VP8X" && ((bytes[offset + 8] ?? 0) & 2) !== 0)) throw new Error("Animated images are not supported. Choose a still image.");
      offset += 8 + length + (length % 2);
    }
    return "image/webp";
  }
  throw new Error("Choose a PNG, JPEG, or WebP still image.");
}

async function inspectBlob(blob: Blob): Promise<{ sha256: string; width: number; height: number; dataUrl: string; mimeType: string }> {
  const buffer = await blob.arrayBuffer();
  const mimeType = rasterImageMime(new Uint8Array(buffer));
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read image."));
    reader.onerror = () => reject(new Error("Could not read image."));
    reader.readAsDataURL(new Blob([buffer], { type: mimeType }));
  });
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  if (!image.naturalWidth || !image.naturalHeight) throw new Error("The image has no drawable pixels.");
  return { sha256, width: image.naturalWidth, height: image.naturalHeight, dataUrl, mimeType };
}

/** This object is installed only when the server verified the exact bundled app source. */
export function createAppImageAssets(options: { roomId?: string; document?: Document } = {}): {
  pick(): Promise<AppImageAsset | null>;
  read(ref: string): Promise<AppImageAsset>;
  dispose(): void;
} {
  const doc = options.document ?? document;
  const scope = options.roomId ? { roomId: options.roomId } : undefined;
  let disposed = false;
  let closePicker: (() => void) | null = null;
  const read = async (ref: string): Promise<AppImageAsset> => {
    if (disposed) throw new Error("The editor was closed.");
    const { id, sha256 } = parseImageAssetRef(ref);
    const artifact = await apiClient.getWorkspaceArtifact(id, scope);
    if (!artifact) throw new Error("This image was deleted or is no longer accessible. Replace it to continue.");
    // Bypass the viewer object-URL cache: each reopen/retry checks current authorization and bytes.
    const image = await inspectBlob(await apiClient.getWorkspaceArtifactBytes(id, scope));
    if (image.sha256 !== sha256) throw new Error("This image changed in Workspace. Replace it to use the new version.");
    if (disposed) throw new Error("The editor was closed.");
    return { ref, name: artifact.path, width: image.width, height: image.height, dataUrl: image.dataUrl };
  };
  return {
    read,
    dispose() { disposed = true; closePicker?.(); },
    pick() {
      if (disposed) return Promise.reject(new Error("The editor was closed."));
      if (closePicker) return Promise.reject(new Error("Finish choosing the current image first."));
      return new Promise<AppImageAsset | null>((resolve) => {
        const priorFocus = doc.activeElement;
        const dialog = doc.createElement("dialog");
        dialog.setAttribute("aria-label", "Place image");
        dialog.style.cssText = "position:fixed;inset:50% auto auto 50%;transform:translate(-50%,-50%);margin:0;background:var(--background-panel);color:var(--foreground);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;width:440px;box-shadow:0 18px 60px #0005;";
        const title = doc.createElement("h2"); title.textContent = "Place image"; title.style.cssText = "font-size:18px;font-weight:600;margin-bottom:12px;";
        const description = doc.createElement("p"); description.textContent = "Choose a PNG, JPEG, or WebP. The image is saved in Workspace so it stays available when you reopen your design.";
        description.style.cssText = "line-height:1.5;margin-bottom:16px;";
        const input = doc.createElement("input"); input.style.cssText = "width:100%;font-size:14px;"; input.type = "file"; input.accept = "image/png,image/jpeg,image/webp"; input.setAttribute("aria-label", "Choose image file");
        const status = doc.createElement("p"); status.style.cssText = "margin:16px 0;overflow-wrap:anywhere;"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
        const buttonStyle = "border:1px solid var(--border);background:var(--background-element);border-radius:6px;padding:8px 14px;font-size:14px;";
        const cancel = doc.createElement("button"); cancel.style.cssText = buttonStyle; cancel.type = "button"; cancel.textContent = "Cancel";
        let completed = false;
        let uploading = false;
        let attemptedPath: string | null = null;
        let savedImage: { ref: string; path: string } | null = null;
        const finish = (value: AppImageAsset | null) => {
          if (completed) return;
          completed = true; closePicker = null; dialog.close(); dialog.remove();
          if (priorFocus instanceof HTMLElement && priorFocus.isConnected) priorFocus.focus();
          resolve(value);
        };
        closePicker = () => finish(null);
        cancel.onclick = () => { if (!uploading) finish(null); };
        dialog.oncancel = (event) => { event.preventDefault(); if (!uploading) finish(null); };
        input.onchange = () => {
          const file = input.files?.[0]; if (!file || uploading) return;
          uploading = true; input.disabled = true; cancel.disabled = true;
          status.textContent = "Checking and saving image…";
          void (async () => {
            const image = await inspectBlob(file);
            if (disposed || completed) return;
            const basename = file.name.split(/[\\/]/).pop() || "image";
            const path = `Design images/${crypto.randomUUID()}/${basename}`;
            attemptedPath = path;
            const artifact = await apiClient.createWorkspaceArtifact(file, { path, mimeType: image.mimeType, ...scope });
            const ref = `artifact:${artifact.id}:${image.sha256}`;
            savedImage = { ref, path: artifact.path };
            // Read-back checks the canonical stored bytes before the consumer can commit a node.
            try { const asset = await read(ref); if (!completed) finish(asset); }
            catch (error) { throw new Error(`Image saved at ${artifact.path}, but placement could not finish: ${error instanceof Error ? error.message : "read failed"}`); }
          })().catch((error: unknown) => {
            if (completed) return;
            status.setAttribute("role", "alert");
            const message = error instanceof Error ? error.message : "Could not place the image.";
            status.textContent = attemptedPath && !savedImage
              ? `The image may have been saved at ${attemptedPath}. Check Workspace before uploading again. ${message}`
              : message;
            uploading = false; input.disabled = attemptedPath !== null; cancel.disabled = false;
            if (savedImage) {
              const retry = doc.createElement("button"); retry.style.cssText = buttonStyle + "margin-left:8px;"; retry.type = "button"; retry.textContent = "Retry placement";
              retry.onclick = () => {
                if (!savedImage || uploading) return;
                uploading = true; retry.disabled = true; cancel.disabled = true;
                void read(savedImage.ref).then((asset) => { if (!completed) finish(asset); }).catch((cause: unknown) => {
                  if (completed) return;
                  status.textContent = `Image saved at ${savedImage!.path}, but placement could not finish: ${cause instanceof Error ? cause.message : "read failed"}`;
                  uploading = false; retry.disabled = false; cancel.disabled = false;
                });
              };
              dialog.appendChild(retry);
            }
          });
        };
        dialog.append(title, description, input, status, cancel); doc.body.appendChild(dialog); dialog.showModal(); input.focus();
      });
    },
  };
}

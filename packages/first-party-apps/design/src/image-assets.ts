/** Durable host-custodied identity. Never a fetch URL, local path, or inline media. */
export function isDesignAssetRef(value: unknown): value is string {
  return typeof value === "string" && /^artifact:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{64}$/.test(value);
}

export type DesignImageAsset = {
  ref: string;
  name: string;
  width: number;
  height: number;
  /** Transient preview only; never copied into a DesignNode. */
  dataUrl: string;
};

export type ImagePreview = { status: "loading" } | { status: "ready"; dataUrl: string } | { status: "failed"; message: string };

/** One in-flight read per currently referenced asset; edits never wait for preview I/O. */
export class DesignImagePreviews {
  readonly entries = new Map<string, ImagePreview>();
  private disposed = false;
  constructor(private readonly read: (ref: string) => Promise<DesignImageAsset>, private readonly changed: () => void) {}
  reconcile(refs: Iterable<string>): void {
    if (this.disposed) return;
    const wanted = new Set(refs);
    for (const ref of this.entries.keys()) if (!wanted.has(ref)) this.entries.delete(ref);
    for (const ref of wanted) {
      if (this.entries.has(ref)) continue;
      const loading: ImagePreview = { status: "loading" };
      this.entries.set(ref, loading);
      void this.read(ref).then((asset) => {
        if (this.disposed || this.entries.get(ref) !== loading) return;
        if (asset.ref !== ref || !/^data:image\/(png|jpeg|webp);base64,/.test(asset.dataUrl)) throw new Error("The host returned an invalid image preview.");
        this.entries.set(ref, { status: "ready", dataUrl: asset.dataUrl });
        this.changed();
      }).catch((error: unknown) => {
        if (this.disposed || this.entries.get(ref) !== loading) return;
        this.entries.set(ref, { status: "failed", message: error instanceof Error ? error.message : "Image unavailable." });
        this.changed();
      });
    }
  }
  retry(ref: string): void { this.entries.delete(ref); }
  dispose(): void { this.disposed = true; this.entries.clear(); }
}

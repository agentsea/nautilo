export type BoardAssetResources = {
  assets?: { read(target: unknown): Promise<unknown> };
};

type UnknownRecord = Record<string, unknown>;
type PreparedBoardOperations = {
  operations: unknown[];
  receipts: Array<Record<string, unknown>>;
};

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as UnknownRecord;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function assetFailure(asset: UnknownRecord): Error {
  return Object.assign(new Error(typeof asset["message"] === "string" ? asset["message"] : "Image source could not be read"), {
    code: typeof asset["code"] === "string" ? asset["code"] : "asset_unavailable",
    phase: "resolve_asset",
    stateChanged: false,
    retrySafe: true,
    recoveryActions: ["inspect_source_asset", "choose_authorized_asset"],
  });
}

/** Resolve every authorized image before constructing any document mutation.
 * The host remains the sole authority for asset references and returned bytes. */
export async function prepareBoardAssetOperations(
  value: unknown,
  resources: BoardAssetResources,
): Promise<PreparedBoardOperations> {
  if (!Array.isArray(value) || value.length === 0) return { operations: value as unknown[], receipts: [] };
  const entries = (value as unknown[]).map((candidate, index) => ({ candidate, index }));
  const resolved = await Promise.all(entries.map(async ({ candidate, index }) => {
    try {
      const operation = record(candidate, `operations[${index}]`);
      if (operation["op"] !== "insert-image") return undefined;
      const extra = Object.keys(operation).find(key => !["op", "asset", "element", "atIndex"].includes(key));
      if (extra) throw new Error(`unknown insert-image field ${extra}`);
      if (!resources.assets) throw new Error("The host image resolver is unavailable; reconnect to an updated server.");
      const element = structuredClone<UnknownRecord>(record(operation["element"], "insert-image element"));
      if (Object.hasOwn(element, "id")) throw new Error("insert-image generates element.id; omit it and use the returned identity");
      if (Object.hasOwn(element, "type")) throw new Error("insert-image supplies element.type; omit it");
      const data = structuredClone<UnknownRecord>(record(element["data"] ?? {}, "insert-image element.data"));
      if (Object.hasOwn(data, "src")) throw new Error("insert-image resolves source bytes itself; omit element.data.src");
      const atIndex = operation["atIndex"];
      if (atIndex !== undefined && (!Number.isSafeInteger(atIndex) || (atIndex as number) < 0))
        throw new Error("insert-image atIndex must be a non-negative integer");
      const asset = record(await resources.assets.read(operation["asset"]), "resolved asset");
      if (asset["ok"] !== true) throw assetFailure(asset);
      const dataUrl = requiredString(asset["dataUrl"], "resolved data URL");
      const sha256 = requiredString(asset["sha256"], "resolved asset sha256");
      const mimeType = requiredString(asset["mimeType"], "resolved asset mimeType");
      const byteLength = asset["byteLength"];
      if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0) throw new Error("resolved asset byteLength must be a non-negative integer");
      return { element, data, dataUrl, sha256, mimeType, byteLength: byteLength as number, atIndex: atIndex as number | undefined };
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { batchOperationIndex: index });
    }
  }));
  const operations: unknown[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  entries.forEach(({ candidate }, index) => {
    const image = resolved[index];
    if (!image) { operations.push(candidate); return; }
    const elementId = crypto.randomUUID();
    const path = `/elements/${image.atIndex ?? "-"}`;
    operations.push({ op: "add", path, value: { ...image.element, id: elementId, type: "image", data: { ...image.data, src: image.dataUrl } } });
    receipts.push({ op: "insert-image", elementId, path, sourceSha256: image.sha256,
      sourceBytes: image.byteLength, mimeType: image.mimeType });
  });
  return { operations, receipts };
}

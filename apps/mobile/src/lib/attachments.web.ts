export type ImageUploadDescriptor = {
  uri: string;
  name: string;
  mimeType?: string;
};

export type BrowserPickedImageAsset = {
  uri: string;
  fileName?: string | null;
  mimeType?: string;
};

const UNAVAILABLE = "Browser attachment selection is unavailable in Mobile Web v1.";

export function descriptorFromPickerAsset(asset: BrowserPickedImageAsset): ImageUploadDescriptor {
  return {
    uri: asset.uri,
    name: asset.fileName && asset.fileName.length > 0 ? asset.fileName : "image.jpg",
    mimeType: asset.mimeType,
  };
}

export function pickImages(_remaining: number): Promise<readonly BrowserPickedImageAsset[]> {
  return Promise.resolve([]);
}

export function uploadImageAsset(
  _baseUrl: string,
  _roomId: string,
  _descriptor: ImageUploadDescriptor,
): Promise<never> {
  return Promise.reject(new Error(UNAVAILABLE));
}

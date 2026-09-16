// D382 Batch 2 — composer attach-image helpers.
// Pure-ish: permission + pick + upload. Caller (chat/[roomId].tsx) owns the
// pending-attachment state machine; this module hands back picked assets or
// throws on upload failure (caller marks the chip "failed").
//
// Upload wrinkle (Expo SDK 57): the global `fetch` is Expo's Winter runtime
// fetch, and the global `FormData` exposes `.entries()`. Winter fetch
// serializes a multipart part ONLY when the appended value is a string, a
// Winter `Blob`, or an object exposing `.bytes()` (see
// expo/src/winter/fetch/convertFormData.ts). RN's `{ uri, name, type }`
// descriptor and a plain web `Blob` both fail with
// "Unsupported FormDataPart implementation". Expo FS's `File` implements the
// Blob interface (incl. `.bytes()` + `.name`/`.type`), so appending it lets
// Winter fetch stream the real file bytes. That's the working path here.
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";

import { getApiClient } from "@/lib/api";

/** Minimal fields needed to re-upload (pick or retry) via Expo FS `File`. */
export type ImageUploadDescriptor = {
  uri: string;
  name: string;
  mimeType?: string;
};

function inferMimeType(name: string, mimeType?: string): string | undefined {
  if (mimeType && mimeType.length > 0) return mimeType;
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".heic") || lower.endsWith(".heif")) return "image/heic";
  return "image/jpeg";
}

export function descriptorFromPickerAsset(
  asset: ImagePicker.ImagePickerAsset,
): ImageUploadDescriptor {
  const name =
    asset.fileName && asset.fileName.length > 0 ? asset.fileName : "image.jpg";
  return {
    uri: asset.uri,
    name,
    mimeType: asset.mimeType ?? inferMimeType(name),
  };
}

/**
 * Request media-library permission and launch the image picker (multi-select).
 * `remaining` caps how many images the user may select (pass the open slots
 * left before MAX_CHAT_ATTACHMENTS_PER_MESSAGE). When `remaining` is 0 or
 * negative, returns `[]` without opening the picker.
 * Returns `[]` on cancel / permission denial.
 */
export async function pickImages(remaining: number): Promise<ImagePicker.ImagePickerAsset[]> {
  if (remaining <= 0) {
    return [];
  }
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    return [];
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.8,
    allowsMultipleSelection: true,
    selectionLimit: remaining,
  });
  if (result.canceled) return [];
  return result.assets;
}

/**
 * Upload an image to the active server and return the `attachmentId` the
 * server assigned. Errors throw — the caller marks the pending chip "failed".
 *
 * Implementation: wrap the file URI in an Expo FS `File` (Blob-shaped with
 * `.bytes()`) and hand it to the shared api-client's `uploadMessageAttachment`,
 * which does `form.append("file", file, filename)`. Expo's Winter fetch then
 * reads the bytes off the `File` and streams them — see the header note for
 * why a web Blob / `{ uri }` descriptor do not work.
 */
export async function uploadImageAsset(
  baseUrl: string,
  roomId: string,
  descriptor: ImageUploadDescriptor,
): Promise<string> {
  const filename =
    descriptor.name && descriptor.name.length > 0 ? descriptor.name : "image.jpg";
  // Cast: the shared (web-shaped) signature wants a Blob; Expo FS `File`
  // implements the Blob interface, which is what Winter fetch consumes.
  const file = new File(descriptor.uri) as unknown as Blob;
  const res = await getApiClient(baseUrl).uploadMessageAttachment(file, filename, { roomId });
  return res.attachmentId;
}

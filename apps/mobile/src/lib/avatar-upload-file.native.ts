import { File } from "expo-file-system";

export function createAvatarUploadFile(uri: string): Blob {
  return new File(uri) as unknown as Blob;
}
